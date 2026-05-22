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
	PermissionPolicy,
	SessionMode
} from '$lib/types';
import { AsyncQueue } from './async-queue';
import {
	register as registerInteractive,
	cancel as cancelInteractive,
	newRequestId,
	decideByPolicy
} from './interactive-requests';
import * as settingsRepo from '../db/repos/settings';
import * as conversationsRepo from '../db/repos/conversations';
import { deriveScopeKey } from '../permissions/matcher';
import {
	parseShellCommand,
	detectShellMisuse,
	type ParsedSegment
} from '../permissions/shell-parser';
import { ulid } from 'ulid';
import { log } from '../log';
import { StubCopilotClient, isStubMode } from './bridge-stub';

type RuntimeSessionMode = 'interactive' | 'plan' | 'autopilot';

// One CopilotClient per portal user. Sharing a single process-wide
// client would cause the SDK subprocess spawned for whichever user
// logged in first to handle every other user's turns too — which
// silently re-attributes Copilot API calls (billing, audit trail) to
// the wrong GitHub identity. With the documented multi-user allowlist
// (`ALLOWED_GITHUB_LOGINS`) that's a real cross-user bleed.
const clients = new Map<string, CopilotClient>();
const starting = new Map<string, Promise<CopilotClient>>();

export async function getClient(userId: string, authToken?: string): Promise<CopilotClient> {
	const existing = clients.get(userId);
	if (existing) return existing;
	const inflight = starting.get(userId);
	if (inflight) return inflight;
	const p = (async () => {
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
		clients.set(userId, client);
		log.info('copilot.client.started', { userId });
		return client;
	})();
	starting.set(userId, p);
	try {
		return await p;
	} finally {
		starting.delete(userId);
	}
}

export async function shutdownClient() {
	const all = [...clients.values()];
	clients.clear();
	starting.clear();
	for (const c of all) {
		try {
			await c.stop();
		} catch (e) {
			log.warn('copilot.client.stop_failed', { err: String(e) });
		}
	}
}

// Per-user listModels cache: entitlements (and therefore the list of
// available models) can differ between users.
const modelsCache = new Map<string, { at: number; models: ModelInfo[] }>();
const MODELS_TTL_MS = 5 * 60_000;

export async function fetchAuthStatus(
	userId: string,
	authToken?: string
): Promise<GetAuthStatusResponse> {
	const client = await getClient(userId, authToken);
	return client.getAuthStatus();
}

export async function fetchModels(userId: string, authToken?: string): Promise<ModelInfo[]> {
	const cached = modelsCache.get(userId);
	if (cached && Date.now() - cached.at < MODELS_TTL_MS) {
		return cached.models;
	}
	const client = await getClient(userId, authToken);
	const models = await client.listModels();
	modelsCache.set(userId, { at: Date.now(), models });
	return models;
}

export interface BridgeOpenOptions {
	conversationId: string;
	userId: string;
	workingDirectory: string;
	model: string;
	policy: PermissionPolicy;
	/** Initial session mode. Forwarded to the runtime after open. */
	mode?: SessionMode;
	/** When true, every tool-permission request is auto-approved for this
	 * session. Mirrored to the SDK via `permissions.setApproveAll`. */
	approveAllTools?: boolean;
	authToken?: string;
	onEvent?: (e: PortalEvent) => void;
}

export interface ConversationSession {
	conversationId: string;
	workingDirectory: string;
	send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	/** Switch the live session's mode. Persists nothing — the caller owns
	 * the DB row. No-op if the SDK rejects (preview / capability gap). */
	setMode(mode: SessionMode): Promise<void>;
	/** Toggle the in-bridge auto-approve short-circuit AND mirror the
	 * setting to the SDK so the model can adapt. */
	setApproveAll(enabled: boolean): Promise<void>;
	/** Clear every session-scoped grant the SDK has accumulated. Useful
	 * after the user turns approve-all off and wants a clean slate. */
	resetSessionApprovals(): Promise<void>;
	lastUsed: number;
}

interface SdkSession {
	on(event: string, listener: (e: unknown) => void): void;
	off?(event: string, listener: (e: unknown) => void): void;
	send(args: { prompt: string }): Promise<string>;
	abort?(): Promise<void>;
	disconnect(): Promise<void>;
	/** Public typed RPC surface exposed by the SDK's CopilotSession. We
	 * narrow it to just the methods we touch so a preview-version drift
	 * surfaces as a compile error here rather than a runtime mystery. */
	rpc?: {
		mode?: {
			set?: (params: { mode: RuntimeSessionMode }) => Promise<void>;
		};
		permissions?: {
			setApproveAll?: (params: { enabled: boolean }) => Promise<{ success: boolean }>;
			resetSessionApprovals?: () => Promise<unknown>;
		};
	};
}

interface PermissionRequestLike {
	kind?: string;
	toolName?: string;
	toolDescription?: string;
	fileName?: string;
	fullCommandText?: string;
	// Newer SDK shapes use kind-specific fields instead of fileName/args:
	//   - read:  { path, intention }
	//   - url:   { url, intention }
	// We accept them here so deriveScopeKey / summary / workspace
	// auto-approval all work without forcing a translation layer.
	path?: string;
	url?: string;
	intention?: string;
	args?: unknown;
}

export async function open(opts: BridgeOpenOptions): Promise<ConversationSession> {
	const client = await getClient(opts.userId, opts.authToken);

	let currentMessageId: string | null = null;
	let activeQueue: AsyncQueue<PortalEvent> | null = null;
	let currentReasoningSegmentId: string | null = null;
	let currentReasoningStartedAt = 0;
	// Maps a sub-agent's `agentId` (set on every event the SDK emits from a
	// child agent) to the `toolCallId` of the outer `task` tool call that
	// spawned it. We populate this on `subagent.started` and use it to
	// thread child reasoning / tool calls / file edits back to their
	// originating subagent invocation in the UI. Cleaned up on
	// `subagent.completed` / `subagent.failed`.
	const subagentParentByAgentId = new Map<string, string>();

	// A child agent's reasoning lives in its own segment-id namespace. The
	// outer turn already has its own currentReasoningSegmentId / currentMessageId,
	// so we track child reasoning state per-agentId to avoid the streams
	// stepping on each other.
	interface ChildReasoningState {
		segmentId: string | null;
		startedAt: number;
	}
	const childReasoning = new Map<string, ChildReasoningState>();

	function parentToolCallId(ev: { agentId?: string }): string | undefined {
		const agentId = ev.agentId;
		if (!agentId) return undefined;
		return subagentParentByAgentId.get(agentId);
	}

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

	// Mutable session-level state. Mirrors the conversation row in the
	// DB; the /session PATCH endpoint flips these via setMode/setApproveAll
	// on the live ConversationSession so a turn already in flight picks up
	// the change without a recreate.
	let approveAllTools = opts.approveAllTools === true;
	let currentMode: SessionMode = opts.mode ?? 'interactive';

	const onPermissionRequest = async (req: PermissionRequestLike) => {
		const tool = req.toolName ?? req.kind ?? 'unknown';
		const permissionKind = req.kind ?? 'unknown';
		const summary = summarizePermissionRequest(req, tool);
		const scopeKey = deriveScopeKey(permissionKind, req);
		const isModeSwitchToolRequest =
			permissionKind === 'custom-tool' && req.toolName === 'request_mode_switch';

		// Helper to keep the audit panel honest: every silent decision is
		// recorded as `auto-allow` / `auto-deny` so the user can see what
		// the policy + stored grants are doing on their behalf.
		const audit = (decision: 'auto-allow' | 'auto-deny') => {
			try {
				settingsRepo.recordDecision(opts.conversationId, tool, summary, decision);
			} catch (e) {
				log.warn('copilot.permission_audit_failed', {
					conversationId: opts.conversationId,
					err: String(e)
				});
			}
		};

		// Per-session bypass: the user enabled "approve all tool calls"
		// for this conversation. Short-circuit before anything else (grants,
		// policy, dialog) so the audit log records a clean `auto-allow`
		// row tagged to the live setting, even if the SDK's own
		// `setApproveAll` call failed or isn't supported by this runtime.
		if (approveAllTools) {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}

		// Parse once: shared between the structured matcher (per-grant
		// predicate) and any future audit text that wants tokenized argv.
		// `parseShellCommand` refuses anything it can't model safely; when
		// it rejects, structured shell grants can't match and we fall
		// through to legacy patterns / policy / interactive prompt.
		let shellSegments: ParsedSegment[] | null = null;
		let shellAnalysis: import('$lib/types').ShellAnalysisView | undefined = undefined;
		if (permissionKind === 'shell' && typeof scopeKey === 'string') {
			// Hardcoded misuse short-circuit: unambiguously-wrong shell
			// shapes (e.g. `cat > file`) get rejected before any grant
			// lookup or user prompt. Not configurable by design — the
			// portal always wants the agent to use the structured
			// `create`/`edit` tools for these cases.
			const misuse = detectShellMisuse(scopeKey);
			if (misuse) {
				audit('auto-deny');
				return { kind: 'reject', feedback: misuse.feedback } as const;
			}
			const parsed = parseShellCommand(scopeKey);
			if (parsed.kind === 'parsed') {
				shellSegments = parsed.segments;
				shellAnalysis = {
					kind: 'parsed',
					segments: parsed.segments.map((s) => ({
						argv: s.argv,
						followingOp: s.followingOp
					}))
				};
			} else {
				shellAnalysis = { kind: 'unsafe', reason: parsed.reason };
			}
		}

		const target =
			permissionKind === 'read' || permissionKind === 'write' || permissionKind === 'edit'
				? scopeKey
				: null;
		const url = permissionKind === 'url' ? scopeKey : null;

		// Grants override policy (the user explicitly trusted/blocked this).
		// `deny` grants beat `allow` grants; the matcher enforces precedence.
		const grant = settingsRepo.matchGrantDetailed(
			opts.userId,
			opts.conversationId,
			tool,
			permissionKind,
			scopeKey,
			{
				shellSegments,
				target,
				url,
				workspaceRoot: opts.workingDirectory ?? null
			}
		);
		if (grant.outcome === 'allow') {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (grant.outcome === 'deny') {
			audit('auto-deny');
			// Forward the matched deny grant's reason (when set) as
			// `feedback` on the SDK reject. The SDK passes this through
			// to the agent's tool-failure payload so the model can read
			// *why* its call was rejected (e.g. "use the `grep` tool
			// instead of bare `grep`") and pick a different approach
			// without bothering the user.
			if (grant.denyReason) {
				return { kind: 'reject', feedback: grant.denyReason } as const;
			}
			return { kind: 'reject' } as const;
		}

		const decision = decideByPolicy(opts.policy, 'permission', permissionKind, {
			scopeKey,
			workspaceRoot: opts.workingDirectory
		});
		if (decision === 'approved') {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (decision === 'denied') {
			audit('auto-deny');
			return { kind: 'reject' } as const;
		}
		if (currentMode === 'best-effort' && !isModeSwitchToolRequest) {
			audit('auto-deny');
			return {
				kind: 'reject',
				feedback: bestEffortPermissionFeedback({
					tool,
					permissionKind,
					summary,
					args: req.args ?? null,
					shellAnalysis
				})
			} as const;
		}

		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
			'permission',
			{
				kind: 'permission',
				tool,
				permissionKind,
				summary,
				args: req.args ?? null,
				userPolicy: opts.policy,
				shellAnalysis
			}
		);
		if (response.decision === 'deny' || response.decision === 'deny-always')
			return { kind: 'reject' } as const;
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
		tools: [
			{
				name: 'request_mode_switch',
				description:
					'Request switching this conversation to interactive mode when you are blocked in best-effort mode because a needed permission keeps being denied. Use only after trying reasonable alternatives.',
				parameters: {
					type: 'object',
					properties: {
						mode: {
							type: 'string',
							enum: ['interactive'],
							description: 'The target mode to switch to.'
						},
						reason: {
							type: 'string',
							description: 'Why the mode switch is needed.'
						}
					},
					required: ['mode', 'reason'],
					additionalProperties: false
				},
				async handler(args: unknown) {
					const req = parseModeSwitchToolArgs(args);
					if (currentMode === 'interactive') {
						return 'Conversation is already in interactive mode.';
					}
					const persisted = conversationsRepo.updateSessionSettings(
						opts.conversationId,
						opts.userId,
						{
							mode: 'interactive'
						}
					);
					if (!persisted) {
						log.warn('copilot.request_mode_switch.persist_failed', {
							conversationId: opts.conversationId
						});
					}
					await applyMode('interactive');
					emit({
						type: 'session.settings',
						conversationId: opts.conversationId,
						mode: 'interactive',
						source: 'agent'
					});
					return `Switched conversation to interactive mode. Reason: ${req.reason}`;
				}
			}
		],
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
		const ev = e as { agentId?: string; data?: { deltaContent?: string } };
		// Sub-agent message text is also surfaced to the host as the final
		// `tool.result` for the outer `task` call. Suppress the deltas so they
		// don't get appended to the outer assistant's message buffer.
		if (ev.agentId) return;
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
		const ev = e as { agentId?: string; data?: { deltaContent?: string } };
		let text = ev?.data?.deltaContent ?? '';
		if (!text || !activeQueue) return;
		const parent = parentToolCallId(ev);
		if (parent) {
			// Child reasoning: emit as a child reasoning event tagged with the
			// outer tool call id; the turn-runner persists it under that
			// parent and the UI renders it inside the SubagentCall card.
			if (!currentMessageId) return; // child reasoning before any host message
			let state = childReasoning.get(ev.agentId!);
			if (!state || !state.segmentId) {
				state = { segmentId: ulid(), startedAt: Date.now() };
				childReasoning.set(ev.agentId!, state);
				text = text.replace(/^\s+/, '');
				if (!text) return;
			}
			const segmentId = state.segmentId!;
			activeQueue.push({
				type: 'message.reasoning',
				messageId: currentMessageId,
				segmentId,
				text,
				parentToolCallId: parent
			});
			return;
		}
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
		const ev = e as { agentId?: string; data?: { content?: string } };
		// Child-agent final messages are captured by tool.result; ignore here.
		if (ev.agentId) {
			// Close any open child reasoning segment so durations get recorded.
			const state = childReasoning.get(ev.agentId);
			if (state?.segmentId && currentMessageId && activeQueue) {
				const parent = parentToolCallId(ev);
				activeQueue.push({
					type: 'message.reasoning.end',
					messageId: currentMessageId,
					segmentId: state.segmentId,
					durationMs: Date.now() - state.startedAt,
					parentToolCallId: parent
				});
				state.segmentId = null;
			}
			return;
		}
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
			agentId?: string;
			data?: { toolCallId?: string; toolName?: string; arguments?: unknown };
		};
		if (!activeQueue) return;
		const parent = parentToolCallId(ev);
		// Close child reasoning before its tool call, mirroring the outer
		// closeReasoning() pattern so the UI doesn't show the thinking box
		// continuing across the tool invocation.
		if (parent && ev.agentId) {
			const state = childReasoning.get(ev.agentId);
			if (state?.segmentId && currentMessageId) {
				activeQueue.push({
					type: 'message.reasoning.end',
					messageId: currentMessageId,
					segmentId: state.segmentId,
					durationMs: Date.now() - state.startedAt,
					parentToolCallId: parent
				});
				state.segmentId = null;
			}
		} else {
			closeReasoning();
		}
		activeQueue.push({
			type: 'tool.call',
			toolCallId: ev?.data?.toolCallId ?? ulid(),
			tool: ev?.data?.toolName ?? 'unknown',
			args: ev?.data?.arguments ?? null,
			parentToolCallId: parent
		});
	};

	const onToolComplete = (e: unknown) => {
		const ev = e as {
			agentId?: string;
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
			output: ev?.data?.result ?? ev?.data?.error ?? null,
			parentToolCallId: parentToolCallId(ev)
		});
	};

	const onToolPartialResult = (e: unknown) => {
		const ev = e as {
			agentId?: string;
			data?: { toolCallId?: string; partialOutput?: string };
		};
		if (!activeQueue) return;
		const id = ev?.data?.toolCallId;
		const out = ev?.data?.partialOutput;
		if (!id || typeof out !== 'string' || out.length === 0) return;
		activeQueue.push({
			type: 'tool.partial_output',
			toolCallId: id,
			output: out,
			parentToolCallId: parentToolCallId(ev)
		});
	};

	const onToolProgress = (e: unknown) => {
		const ev = e as {
			agentId?: string;
			data?: { toolCallId?: string; progressMessage?: string };
		};
		if (!activeQueue) return;
		const id = ev?.data?.toolCallId;
		const msg = ev?.data?.progressMessage;
		if (!id || typeof msg !== 'string' || msg.length === 0) return;
		activeQueue.push({
			type: 'tool.progress',
			toolCallId: id,
			message: msg,
			parentToolCallId: parentToolCallId(ev)
		});
	};

	const onSubagentStarted = (e: unknown) => {
		const ev = e as { agentId?: string; data?: { toolCallId?: string } };
		if (ev.agentId && ev.data?.toolCallId) {
			subagentParentByAgentId.set(ev.agentId, ev.data.toolCallId);
		}
	};
	const onSubagentEnded = (e: unknown) => {
		const ev = e as { agentId?: string };
		if (!ev.agentId) return;
		// Flush any still-open child reasoning so its duration is recorded.
		const state = childReasoning.get(ev.agentId);
		if (state?.segmentId && currentMessageId && activeQueue) {
			activeQueue.push({
				type: 'message.reasoning.end',
				messageId: currentMessageId,
				segmentId: state.segmentId,
				durationMs: Date.now() - state.startedAt,
				parentToolCallId: subagentParentByAgentId.get(ev.agentId)
			});
		}
		childReasoning.delete(ev.agentId);
		subagentParentByAgentId.delete(ev.agentId);
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

	const onModeChanged = (e: unknown) => {
		// The runtime can flip mode out from under us (the agent itself
		// can call `mode.set` — that's how `exit_plan_mode` lands). Sync
		// our cache and broadcast so the UI's mode picker tracks.
		const raw = (e as { data?: { newMode?: string } })?.data?.newMode;
		const next = isRuntimeSessionMode(raw) ? raw : null;
		if (!next || next === toRuntimeMode(currentMode)) return;
		currentMode = next;
		activeQueue?.push({
			type: 'session.settings',
			conversationId: opts.conversationId,
			mode: next,
			source: 'agent'
		});
	};

	sdkSession.on('assistant.message_delta', onDelta);
	sdkSession.on('assistant.reasoning_delta', onReasoningDelta);
	sdkSession.on('assistant.message', onAssistantMessage);
	sdkSession.on('tool.execution_start', onToolStart);
	sdkSession.on('tool.execution_complete', onToolComplete);
	sdkSession.on('tool.execution_partial_result', onToolPartialResult);
	sdkSession.on('tool.execution_progress', onToolProgress);
	sdkSession.on('subagent.started', onSubagentStarted);
	sdkSession.on('subagent.completed', onSubagentEnded);
	sdkSession.on('subagent.failed', onSubagentEnded);
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
	sdkSession.on('mode.changed', onModeChanged);

	// Push initial mode + approve-all to the runtime. Best-effort: the
	// `rpc` surface is preview API and may be missing on stub clients;
	// skipping the call is fine because the bridge enforces approve-all
	// itself in `onPermissionRequest`, and a missing mode RPC just means
	// the agent runs in its default mode (still safe).
	async function applyMode(mode: SessionMode): Promise<void> {
		const runtimeMode = toRuntimeMode(mode);
		try {
			await sdkSession.rpc?.mode?.set?.({ mode: runtimeMode });
			currentMode = mode;
		} catch (e) {
			log.warn('copilot.session.mode_set_failed', {
				conversationId: opts.conversationId,
				mode,
				runtimeMode,
				err: (e as Error).message
			});
		}
	}
	async function applyApproveAll(enabled: boolean): Promise<void> {
		approveAllTools = enabled;
		try {
			await sdkSession.rpc?.permissions?.setApproveAll?.({ enabled });
		} catch (e) {
			log.warn('copilot.session.set_approve_all_failed', {
				conversationId: opts.conversationId,
				enabled,
				err: (e as Error).message
			});
		}
	}
	// Fire-and-forget: callers don't need to await initialization. A turn
	// posted before these resolve will still see the cached `approveAllTools`
	// value (we set it synchronously above) and a worst-case slightly-late
	// mode change which the agent will pick up on the next message.
	if (currentMode !== 'interactive') void applyMode(currentMode);
	if (approveAllTools) void applyApproveAll(true);

	const session: ConversationSession = {
		conversationId: opts.conversationId,
		workingDirectory: opts.workingDirectory,
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
		async setMode(mode: SessionMode) {
			await applyMode(mode);
		},
		async setApproveAll(enabled: boolean) {
			await applyApproveAll(enabled);
		},
		async resetSessionApprovals() {
			try {
				await sdkSession.rpc?.permissions?.resetSessionApprovals?.();
			} catch (e) {
				log.warn('copilot.session.reset_session_approvals_failed', {
					conversationId: opts.conversationId,
					err: (e as Error).message
				});
			}
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

function toRuntimeMode(mode: SessionMode): RuntimeSessionMode {
	return mode === 'best-effort' ? 'autopilot' : mode;
}

function isRuntimeSessionMode(value: string | undefined): value is RuntimeSessionMode {
	return value === 'interactive' || value === 'plan' || value === 'autopilot';
}

function bestEffortPermissionFeedback(view: {
	tool: string;
	permissionKind: string;
	summary: string;
	args: unknown;
	shellAnalysis?: import('$lib/types').ShellAnalysisView;
}): string {
	const promptText = permissionPromptText(view);
	const alternative = bestEffortAlternativeHint(view.permissionKind);
	return (
		'This conversation is in `best-effort` mode, so permission prompts are auto-rejected instead of shown to the user. ' +
		`The user would have been asked to approve:\n\n${promptText}\n\n${alternative} If no workable alternative exists, stop and explain which permission is missing.`
	);
}

function permissionPromptText(view: {
	tool: string;
	permissionKind: string;
	summary: string;
	args: unknown;
	shellAnalysis?: import('$lib/types').ShellAnalysisView;
}): string {
	const lines = [`${view.tool} (${view.permissionKind})`, view.summary];
	if (view.permissionKind === 'shell' && view.shellAnalysis?.kind === 'unsafe') {
		lines.push(
			`Reason: ${view.shellAnalysis.reason}. Constructs like subshells, redirection, command substitution, or variable expansion can hide arbitrary commands, so structured "always" grants won't apply here.`
		);
	}
	return lines.join('\n');
}

function bestEffortAlternativeHint(permissionKind: string): string {
	switch (permissionKind) {
		case 'shell':
			return 'Try a structured tool or another already-allowed approach first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		case 'read':
			return 'Try the structured read/search tools or existing workspace context first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		case 'write':
		case 'edit':
			return 'Try a structured workspace edit/create workflow or another already-allowed path first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		case 'url':
			return 'Try a local source or another non-network approach first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		default:
			return 'Try another approach that stays within the current permission set first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
	}
}

function summarizePermissionRequest(req: PermissionRequestLike, tool: string): string {
	return req.fullCommandText ?? req.fileName ?? req.path ?? req.url ?? req.toolDescription ?? tool;
}

function parseModeSwitchToolArgs(args: unknown): { mode: 'interactive'; reason: string } {
	if (!args || typeof args !== 'object') {
		throw new Error('request_mode_switch requires object arguments.');
	}
	const mode = (args as Record<string, unknown>).mode;
	const reason = (args as Record<string, unknown>).reason;
	if (mode !== 'interactive') {
		throw new Error('request_mode_switch only supports switching to interactive mode.');
	}
	if (typeof reason !== 'string' || reason.trim().length === 0) {
		throw new Error('request_mode_switch requires a non-empty reason.');
	}
	return { mode, reason: reason.trim() };
}
