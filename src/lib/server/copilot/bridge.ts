// Thin wrapper around `@github/copilot-sdk`. Normalizes SDK events into the
// portal's PortalEvent shape, and bridges permission requests via HTTP.
//
// NOTE: Pinned to @github/copilot-sdk ^0.3.0. The SDK is in preview; if
// upgrading, audit the event names and PermissionRequest shape used below.
// All coupling lives in this file.

import {
	CopilotClient,
	type PermissionRequestResult,
	type GetAuthStatusResponse,
	type ModelInfo
} from '@github/copilot-sdk';
import type { PortalEvent, PermissionPolicy, PermissionDecision } from '$lib/types';
import { AsyncQueue } from './async-queue';
import { register as registerPermission, newRequestId, decideByPolicy } from './permissions';
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
				? // Connect to an externally-managed `copilot --headless --port N`
					// process. That process owns its own auth (run `copilot login`
					// there); `useLoggedInUser`/`gitHubToken` are rejected by the
					// SDK when `cliUrl` is set.
					new CopilotClient({ cliUrl, autoStart: false })
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

// --- Status / introspection helpers ---
//
// listModels() is rate-limited upstream and the SDK already caches per-client;
// we still cache here so that repeated UI loads don't hit the SDK at all.
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
	/**
	 * Optional sink for every event the bridge emits during a turn. Receives
	 * events on the server even if the iterable consumer has stopped pulling.
	 *
	 * NOTE: New code should subscribe to the per-turn event log in
	 * `turn-runner.ts` instead — that decouples persistence from any one
	 * consumer's lifecycle. This hook remains for backward-compatible callers.
	 */
	onEvent?: (e: PortalEvent) => void;
}

// Per-conversation session wrapper.
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

export async function open(opts: BridgeOpenOptions): Promise<ConversationSession> {
	const client = await getClient(opts.authToken);

	let currentMessageId: string | null = null;
	let activeQueue: AsyncQueue<PortalEvent> | null = null;
	// Track an in-flight reasoning segment so we can mint a new id whenever
	// reasoning resumes after a visible token or a tool boundary. Closed by
	// closeReasoning() which emits message.reasoning.end with the elapsed
	// duration.
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

	const onPermissionRequest = async (req: unknown) => {
		return await handlePermission(req as PermissionRequestLike, opts, (ev) => {
			activeQueue?.push(ev);
		});
	};

	// Resume the SDK-side session if it already exists so the agent keeps its
	// in-session state (conversation memory, per-session SQL store such as
	// todos/inbox_entries, etc.) across portal server restarts. The portal's
	// in-memory pool is cleared on restart, but the SDK persists per-session
	// state by id and only rehydrates it via resumeSession.
	let existingMetadata: unknown;
	try {
		existingMetadata = await client.getSessionMetadata(opts.conversationId);
	} catch (e) {
		log.warn('copilot.session.metadata_lookup_failed', {
			conversationId: opts.conversationId,
			err: (e as Error).message
		});
	}

	let sdkSession: SdkSession;
	if (existingMetadata) {
		try {
			sdkSession = (await client.resumeSession(opts.conversationId, {
				model: opts.model,
				workingDirectory: opts.workingDirectory,
				streaming: true,
				onPermissionRequest
			})) as unknown as SdkSession;
		} catch (e) {
			log.warn('copilot.session.resume_failed_falling_back_to_create', {
				conversationId: opts.conversationId,
				err: (e as Error).message
			});
			sdkSession = (await client.createSession({
				model: opts.model,
				sessionId: opts.conversationId,
				workingDirectory: opts.workingDirectory,
				streaming: true,
				onPermissionRequest
			})) as unknown as SdkSession;
		}
	} else {
		sdkSession = (await client.createSession({
			model: opts.model,
			sessionId: opts.conversationId,
			workingDirectory: opts.workingDirectory,
			streaming: true,
			onPermissionRequest
		})) as unknown as SdkSession;
	}

	// --- SDK event subscriptions: stable across many turns. ---
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
		// First visible token after a reasoning burst closes that segment.
		closeReasoning();
		activeQueue.push({ type: 'message.delta', messageId: currentMessageId, text });
	};

	const onReasoningDelta = (e: unknown) => {
		const ev = e as { data?: { deltaContent?: string } };
		let text = ev?.data?.deltaContent ?? '';
		if (!text || !activeQueue) return;
		// Reasoning can arrive before the first visible token. Open the
		// assistant message early so we don't silently drop the opening
		// thought tokens.
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
			// The SDK emits space-prefixed tokens (e.g. " plan", " think")
			// so the first delta of every segment otherwise starts with a
			// stray leading space. Strip it once per segment to keep the
			// rendered block flush-left.
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
		// If streaming wasn't producing deltas, emit the full content as one chunk.
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
			data?: {
				toolCallId?: string;
				toolName?: string;
				arguments?: unknown;
			};
		};
		if (!activeQueue) return;
		// Reasoning that preceded a tool call belongs to *that* tool call's
		// position in the transcript; close the segment now so the runner can
		// anchor it to the current text offset.
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
		// File edits — best effort: if the tool wrote a file, the SDK reports
		// the diff in the result. We don't try to parse arbitrary tool output;
		// we just surface tool.result. A dedicated file-edit event can be added
		// once the SDK exposes one in a stable shape.
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
		const ev = e as {
			data?: { tokensRemoved?: number; messagesRemoved?: number };
		};
		if (!activeQueue) return;
		activeQueue.push({
			type: 'context.compaction',
			phase: 'complete',
			tokensRemoved: ev?.data?.tokensRemoved,
			messagesRemoved: ev?.data?.messagesRemoved
		});
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

// --- Permission handling ---

interface PermissionRequestLike {
	kind?: string;
	toolName?: string;
	fileName?: string;
	fullCommandText?: string;
	args?: unknown;
}

async function handlePermission(
	req: PermissionRequestLike,
	opts: BridgeOpenOptions,
	emit: (ev: PortalEvent) => void
): Promise<PermissionRequestResult> {
	const tool = req.toolName ?? req.kind ?? 'unknown';
	const kind = req.kind ?? 'unknown';

	// 1) Existing grant?
	if (settingsRepo.hasGrant(opts.userId, opts.conversationId, tool)) {
		return { kind: 'approve-once' };
	}

	// 2) Default policy fast path.
	const decision = decideByPolicy(opts.policy, kind);
	if (decision === 'approved') return { kind: 'approve-once' };
	if (decision === 'denied') return { kind: 'reject' };

	// 3) Ask the user. Surface a tool.permission event and wait for the HTTP
	//    callback to resolve our deferred.
	const requestId = newRequestId();
	const summary = req.fullCommandText ?? req.fileName ?? tool;
	const userDecision = await new Promise<PermissionDecision>((resolve, reject) => {
		registerPermission({
			requestId,
			conversationId: opts.conversationId,
			tool,
			kind,
			summary,
			args: req.args ?? null,
			resolve,
			reject,
			createdAt: Date.now(),
			emit
		});
		emit({
			type: 'tool.permission',
			requestId,
			tool,
			kind,
			summary,
			args: req.args ?? null
		});
	});

	if (userDecision === 'deny') return { kind: 'reject' };
	return { kind: 'approve-once' };
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
