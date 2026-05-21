// Thin wrapper around `@github/copilot-sdk`. Normalizes SDK events into the
// portal's PortalEvent shape, and bridges interactive callbacks via HTTP.
//
// NOTE: Pinned to @github/copilot-sdk ^1.0.0-beta. The SDK is in preview; if
// upgrading, audit the event names + interactive callback shapes used below.
// All coupling lives in this file.

import { CopilotClient, type GetAuthStatusResponse, type ModelInfo } from '@github/copilot-sdk';
import type {
	InteractiveKind,
	InteractiveRequestView,
	InteractiveRequestViewBody,
	InteractiveResponse,
	ElicitationSchema,
	PortalEvent,
	PermissionPolicy
} from '$lib/types';
import { AsyncQueue } from './async-queue';
import {
	register as registerInteractive,
	cancel as cancelInteractive,
	newRequestId,
	decideByPolicy
} from './interactive-requests';
import * as settingsRepo from '../db/repos/settings';
import { ulid } from 'ulid';
import { log } from '../log';
import { StubCopilotClient, isStubMode } from './bridge-stub';

let sharedClient: CopilotClient | null = null;
let starting: Promise<CopilotClient> | null = null;

export async function getClient(authToken?: string): Promise<CopilotClient> {
	if (sharedClient) return sharedClient;
	if (starting) return starting;
	starting = (async () => {
		const cliUrl = process.env.COPILOT_CLI_URL?.trim();
		const client = isStubMode()
			? (new StubCopilotClient() as unknown as CopilotClient)
			: cliUrl
				? new CopilotClient({ cliUrl, autoStart: false })
				: new CopilotClient({
						useStdio: true,
						autoStart: false,
						useLoggedInUser: true,
						gitHubToken: authToken
					});
		await client.start();
		sharedClient = client;
		log.info('copilot.client.started');
		return client;
	})();
	try {
		return await starting;
	} finally {
		starting = null;
	}
}

export async function shutdownClient() {
	if (!sharedClient) return;
	try {
		await sharedClient.stop();
	} catch (e) {
		log.warn('copilot.client.stop_failed', { err: String(e) });
	}
	sharedClient = null;
}

let modelsCache: { at: number; models: ModelInfo[] } | null = null;
const MODELS_TTL_MS = 5 * 60_000;

export async function fetchAuthStatus(authToken?: string): Promise<GetAuthStatusResponse> {
	const client = await getClient(authToken);
	return client.getAuthStatus();
}

export async function fetchModels(authToken?: string): Promise<ModelInfo[]> {
	if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
		return modelsCache.models;
	}
	const client = await getClient(authToken);
	const models = await client.listModels();
	modelsCache = { at: Date.now(), models };
	return models;
}

export interface BridgeOpenOptions {
	conversationId: string;
	userId: string;
	workingDirectory: string;
	model: string;
	policy: PermissionPolicy;
	authToken?: string;
	onEvent?: (e: PortalEvent) => void;
}

export interface ConversationSession {
	conversationId: string;
	send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	lastUsed: number;
}

interface SdkSession {
	on(event: string, listener: (e: unknown) => void): void;
	off?(event: string, listener: (e: unknown) => void): void;
	send(args: { prompt: string }): Promise<string>;
	abort?(): Promise<void>;
	disconnect(): Promise<void>;
}

interface PermissionRequestLike {
	kind?: string;
	toolName?: string;
	fileName?: string;
	fullCommandText?: string;
	args?: unknown;
}

export async function open(opts: BridgeOpenOptions): Promise<ConversationSession> {
	const client = await getClient(opts.authToken);

	let currentMessageId: string | null = null;
	let activeQueue: AsyncQueue<PortalEvent> | null = null;
	let currentReasoningSegmentId: string | null = null;
	let currentReasoningStartedAt = 0;

	function closeReasoning() {
		if (!activeQueue || !currentReasoningSegmentId || !currentMessageId) return;
		activeQueue.push({
			type: 'message.reasoning.end',
			messageId: currentMessageId,
			segmentId: currentReasoningSegmentId,
			durationMs: Date.now() - currentReasoningStartedAt
		});
		currentReasoningSegmentId = null;
		currentReasoningStartedAt = 0;
	}

	function emit(ev: PortalEvent) {
		activeQueue?.push(ev);
	}

	// --- Interactive callback handlers ---
	//
	// Each handler builds a kind-specific view, registers a deferred in the
	// interactive registry, emits an `interactive.request` PortalEvent to the
	// UI, and awaits the resolution. See interactive-requests.ts.

	async function askInteractive<R extends InteractiveResponse>(
		kind: InteractiveKind,
		view: InteractiveRequestViewBody
	): Promise<R> {
		const requestId = newRequestId();
		const full = { requestId, ...view } as InteractiveRequestView;
		return await new Promise<R>((resolve, reject) => {
			registerInteractive({
				requestId,
				conversationId: opts.conversationId,
				kind,
				view: full,
				resolve: (r) => resolve(r as R),
				reject,
				emit
			});
			emit({ type: 'interactive.request', request: full });
		});
	}

	const onPermissionRequest = async (req: PermissionRequestLike) => {
		const tool = req.toolName ?? req.kind ?? 'unknown';
		const permissionKind = req.kind ?? 'unknown';
		const summary = req.fullCommandText ?? req.fileName ?? tool;

		if (settingsRepo.hasGrant(opts.userId, opts.conversationId, tool)) {
			return { kind: 'approve-once' } as const;
		}

		const decision = decideByPolicy(opts.policy, 'permission', permissionKind);
		if (decision === 'approved') return { kind: 'approve-once' } as const;
		if (decision === 'denied') return { kind: 'reject' } as const;

		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
			'permission',
			{
				kind: 'permission',
				tool,
				permissionKind,
				summary,
				args: req.args ?? null
			}
		);
		if (response.decision === 'deny') return { kind: 'reject' } as const;
		return { kind: 'approve-once' } as const;
	};

	const onUserInputRequest = async (req: {
		question?: string;
		choices?: string[];
		allowFreeform?: boolean;
	}) => {
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'user_input' }>>(
			'user_input',
			{
				kind: 'user_input',
				question: req.question ?? 'The agent is requesting input.',
				choices: req.choices,
				allowFreeform: req.allowFreeform ?? true
			}
		);
		return { answer: response.answer, wasFreeform: response.wasFreeform ?? true };
	};

	const onElicitationRequest = async (ctx: {
		message?: string;
		requestedSchema?: unknown;
		mode?: 'form' | 'url';
		url?: string;
		elicitationSource?: string;
	}) => {
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'elicitation' }>>(
			'elicitation',
			{
				kind: 'elicitation',
				message: ctx.message ?? '',
				mode: ctx.mode ?? 'form',
				url: ctx.url,
				requestedSchema: ctx.requestedSchema as ElicitationSchema | undefined,
				elicitationSource: ctx.elicitationSource
			}
		);
		if (response.action === 'accept') {
			return { action: 'accept' as const, content: response.content ?? {} };
		}
		return { action: response.action };
	};

	const onExitPlanMode = async (req: {
		summary?: string;
		planContent?: string;
		actions?: string[];
		recommendedAction?: string;
	}) => {
		const actions = req.actions ?? ['continue'];
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'exit_plan_mode' }>>(
			'exit_plan_mode',
			{
				kind: 'exit_plan_mode',
				summary: req.summary ?? 'Exit plan mode and continue?',
				planContent: req.planContent,
				actions,
				recommendedAction: req.recommendedAction ?? actions[0] ?? 'continue'
			}
		);
		return {
			approved: response.approved,
			selectedAction: response.selectedAction,
			feedback: response.feedback
		};
	};

	const onAutoModeSwitch = async (req: { errorCode?: string; retryAfterSeconds?: number }) => {
		const response = await askInteractive<
			Extract<InteractiveResponse, { kind: 'auto_mode_switch' }>
		>('auto_mode_switch', {
			kind: 'auto_mode_switch',
			errorCode: req.errorCode,
			retryAfterSeconds: req.retryAfterSeconds
		});
		return response.decision;
	};

	let existingMetadata: unknown;
	try {
		existingMetadata = await client.getSessionMetadata(opts.conversationId);
	} catch (e) {
		log.warn('copilot.session.metadata_lookup_failed', {
			conversationId: opts.conversationId,
			err: (e as Error).message
		});
	}

	const sessionConfig = {
		model: opts.model,
		workingDirectory: opts.workingDirectory,
		streaming: true,
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanMode,
		onAutoModeSwitch
	};

	let sdkSession: SdkSession;
	if (existingMetadata) {
		try {
			sdkSession = (await client.resumeSession(
				opts.conversationId,
				sessionConfig
			)) as unknown as SdkSession;
		} catch (e) {
			log.warn('copilot.session.resume_failed_falling_back_to_create', {
				conversationId: opts.conversationId,
				err: (e as Error).message
			});
			sdkSession = (await client.createSession({
				...sessionConfig,
				sessionId: opts.conversationId
			})) as unknown as SdkSession;
		}
	} else {
		sdkSession = (await client.createSession({
			...sessionConfig,
			sessionId: opts.conversationId
		})) as unknown as SdkSession;
	}

	const onDelta = (e: unknown) => {
		const ev = e as { data?: { deltaContent?: string } };
		const text = ev?.data?.deltaContent ?? '';
		if (!text || !activeQueue) return;
		if (!currentMessageId) {
			currentMessageId = ulid();
			activeQueue.push({
				type: 'message.start',
				messageId: currentMessageId,
				role: 'assistant'
			});
		}
		closeReasoning();
		activeQueue.push({ type: 'message.delta', messageId: currentMessageId, text });
	};

	const onReasoningDelta = (e: unknown) => {
		const ev = e as { data?: { deltaContent?: string } };
		let text = ev?.data?.deltaContent ?? '';
		if (!text || !activeQueue) return;
		if (!currentMessageId) {
			currentMessageId = ulid();
			activeQueue.push({
				type: 'message.start',
				messageId: currentMessageId,
				role: 'assistant'
			});
		}
		if (!currentReasoningSegmentId) {
			currentReasoningSegmentId = ulid();
			currentReasoningStartedAt = Date.now();
			text = text.replace(/^\s+/, '');
			if (!text) return;
		}
		activeQueue.push({
			type: 'message.reasoning',
			messageId: currentMessageId,
			segmentId: currentReasoningSegmentId,
			text
		});
	};

	const onAssistantMessage = (e: unknown) => {
		const ev = e as { data?: { content?: string } };
		if (!activeQueue) return;
		if (!currentMessageId) {
			currentMessageId = ulid();
			activeQueue.push({
				type: 'message.start',
				messageId: currentMessageId,
				role: 'assistant'
			});
			const text = ev?.data?.content ?? '';
			if (text) {
				closeReasoning();
				activeQueue.push({ type: 'message.delta', messageId: currentMessageId, text });
			}
		}
	};

	const onToolStart = (e: unknown) => {
		const ev = e as {
			data?: { toolCallId?: string; toolName?: string; arguments?: unknown };
		};
		if (!activeQueue) return;
		closeReasoning();
		activeQueue.push({
			type: 'tool.call',
			toolCallId: ev?.data?.toolCallId ?? ulid(),
			tool: ev?.data?.toolName ?? 'unknown',
			args: ev?.data?.arguments ?? null
		});
	};

	const onToolComplete = (e: unknown) => {
		const ev = e as {
			data?: {
				toolCallId?: string;
				toolName?: string;
				success?: boolean;
				result?: unknown;
				error?: unknown;
			};
		};
		if (!activeQueue) return;
		const ok = ev?.data?.success !== false && !ev?.data?.error;
		activeQueue.push({
			type: 'tool.result',
			toolCallId: ev?.data?.toolCallId ?? ulid(),
			ok,
			summary: summarizeResult(ev?.data?.result, ev?.data?.error),
			output: ev?.data?.result ?? ev?.data?.error ?? null
		});
	};

	const onSessionIdle = () => {
		if (!activeQueue) return;
		closeReasoning();
		if (currentMessageId) {
			activeQueue.push({ type: 'message.end', messageId: currentMessageId });
			currentMessageId = null;
		}
		activeQueue.push({ type: 'done' });
		activeQueue.end();
		activeQueue = null;
	};

	const onUsageInfo = (e: unknown) => {
		const ev = e as {
			data?: {
				currentTokens?: number;
				tokenLimit?: number;
				messagesLength?: number;
				systemTokens?: number;
				conversationTokens?: number;
				toolDefinitionsTokens?: number;
				isInitial?: boolean;
			};
		};
		const d = ev?.data;
		if (!activeQueue || !d) return;
		if (typeof d.currentTokens !== 'number' || typeof d.tokenLimit !== 'number') return;
		activeQueue.push({
			type: 'context.usage',
			currentTokens: d.currentTokens,
			tokenLimit: d.tokenLimit,
			messagesLength: d.messagesLength ?? 0,
			systemTokens: d.systemTokens,
			conversationTokens: d.conversationTokens,
			toolDefinitionsTokens: d.toolDefinitionsTokens,
			isInitial: d.isInitial
		});
	};

	const onCompactionStart = () => {
		if (!activeQueue) return;
		activeQueue.push({ type: 'context.compaction', phase: 'start' });
	};

	const onCompactionComplete = (e: unknown) => {
		const ev = e as { data?: { tokensRemoved?: number; messagesRemoved?: number } };
		if (!activeQueue) return;
		activeQueue.push({
			type: 'context.compaction',
			phase: 'complete',
			tokensRemoved: ev?.data?.tokensRemoved,
			messagesRemoved: ev?.data?.messagesRemoved
		});
	};

	// --- Informational interactive events ---
	//
	// The SDK fires these to ask the user to look at something out-of-band
	// (an MCP OAuth dance in the browser, an MCP-driven sampling call, an
	// external tool invocation handled by another client). The SDK does not
	// expose a public responder in 1.0.0-beta.4 — the runtime resolves them
	// itself once the side-channel completes. We surface them as interactive
	// requests so the user knows what's happening, and dismiss them on the
	// corresponding `*.completed` event.

	const trackedInfoIds = new Map<string, string>(); // sdkRequestId -> our requestId

	function emitInfoRequest(
		kind: 'sampling' | 'mcp_oauth' | 'external_tool',
		sdkRequestId: string,
		view: InteractiveRequestViewBody
	) {
		if (!activeQueue || !sdkRequestId) return;
		const requestId = newRequestId();
		const full = { requestId, ...view } as InteractiveRequestView;
		trackedInfoIds.set(sdkRequestId, requestId);
		registerInteractive({
			requestId,
			conversationId: opts.conversationId,
			kind,
			view: full,
			resolve: () => undefined,
			reject: () => undefined,
			emit
		});
		emit({ type: 'interactive.request', request: full });
	}

	function dismissInfoRequest(sdkRequestId: string) {
		const requestId = trackedInfoIds.get(sdkRequestId);
		if (!requestId) return;
		trackedInfoIds.delete(sdkRequestId);
		cancelInteractive(requestId, 'sdk_resolved');
	}

	const onSamplingRequested = (e: unknown) => {
		const d = (e as { data?: { requestId?: string; serverName?: string } })?.data;
		if (!d?.requestId) return;
		emitInfoRequest('sampling', d.requestId, {
			kind: 'sampling',
			mcpServerName: d.serverName,
			summary: `MCP server "${d.serverName ?? 'unknown'}" is requesting an LLM sampling call.`
		});
	};
	const onSamplingCompleted = (e: unknown) => {
		const d = (e as { data?: { requestId?: string } })?.data;
		if (d?.requestId) dismissInfoRequest(d.requestId);
	};

	const onMcpOauthRequired = (e: unknown) => {
		const d = (
			e as {
				data?: { requestId?: string; serverName?: string; serverUrl?: string };
			}
		)?.data;
		if (!d?.requestId) return;
		emitInfoRequest('mcp_oauth', d.requestId, {
			kind: 'mcp_oauth',
			mcpServerName: d.serverName,
			authorizationUrl: d.serverUrl,
			summary: `MCP server "${d.serverName ?? 'unknown'}" requires OAuth authentication. Complete the flow in your browser to continue.`
		});
	};
	const onMcpOauthCompleted = (e: unknown) => {
		const d = (e as { data?: { requestId?: string } })?.data;
		if (d?.requestId) dismissInfoRequest(d.requestId);
	};

	const onExternalToolRequested = (e: unknown) => {
		const d = (e as { data?: { requestId?: string; toolName?: string } })?.data;
		if (!d?.requestId) return;
		emitInfoRequest('external_tool', d.requestId, {
			kind: 'external_tool',
			toolName: d.toolName ?? 'unknown',
			summary: `Waiting for external tool "${d.toolName ?? 'unknown'}" to complete.`
		});
	};
	const onExternalToolCompleted = (e: unknown) => {
		const d = (e as { data?: { requestId?: string } })?.data;
		if (d?.requestId) dismissInfoRequest(d.requestId);
	};

	sdkSession.on('assistant.message_delta', onDelta);
	sdkSession.on('assistant.reasoning_delta', onReasoningDelta);
	sdkSession.on('assistant.message', onAssistantMessage);
	sdkSession.on('tool.execution_start', onToolStart);
	sdkSession.on('tool.execution_complete', onToolComplete);
	sdkSession.on('session.idle', onSessionIdle);
	sdkSession.on('session.usage_info', onUsageInfo);
	sdkSession.on('session.compaction_start', onCompactionStart);
	sdkSession.on('session.compaction_complete', onCompactionComplete);
	sdkSession.on('sampling.requested', onSamplingRequested);
	sdkSession.on('sampling.completed', onSamplingCompleted);
	sdkSession.on('mcp.oauth_required', onMcpOauthRequired);
	sdkSession.on('mcp.oauth_completed', onMcpOauthCompleted);
	sdkSession.on('external_tool.requested', onExternalToolRequested);
	sdkSession.on('external_tool.completed', onExternalToolCompleted);

	const session: ConversationSession = {
		conversationId: opts.conversationId,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			if (activeQueue) throw new Error('session busy: a turn is already in progress');
			const q = new AsyncQueue<PortalEvent>();
			activeQueue = q;
			currentMessageId = null;
			const onAbort = () => {
				q.push({ type: 'error', code: 'aborted', message: 'Aborted by client.' });
				q.end();
				if (sdkSession.abort) sdkSession.abort().catch(() => undefined);
			};
			signal.addEventListener('abort', onAbort, { once: true });

			try {
				await sdkSession.send({ prompt });
			} catch (err) {
				q.push({
					type: 'error',
					code: 'send_failed',
					message: err instanceof Error ? err.message : String(err)
				});
				q.end();
			}
			try {
				for await (const ev of q) {
					opts.onEvent?.(ev);
					yield ev;
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				if (activeQueue === q) activeQueue = null;
				this.lastUsed = Date.now();
			}
		},
		async abort() {
			if (sdkSession.abort) await sdkSession.abort();
		},
		async dispose() {
			try {
				await sdkSession.disconnect();
			} catch (e) {
				log.warn('copilot.session.disconnect_failed', {
					conversationId: opts.conversationId,
					err: String(e)
				});
			}
		}
	};

	return session;
}

function summarizeResult(result: unknown, error: unknown): string {
	if (error) return typeof error === 'string' ? error : 'error';
	if (typeof result === 'string') return result.slice(0, 200);
	if (result && typeof result === 'object') {
		try {
			return JSON.stringify(result).slice(0, 200);
		} catch {
			return 'object';
		}
	}
	return 'ok';
}
