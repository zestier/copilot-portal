// Thin wrapper around `@github/copilot-sdk`. Owns SDK client/session lifecycle;
// event normalization and interactive callbacks live in sibling adapters.
//
// NOTE: Pinned to @github/copilot-sdk ^1.0.0-beta. The SDK is in preview; if
// upgrading, audit bridge.ts plus sdk-events.ts / interactive-adapter.ts.

import { CopilotClient, type GetAuthStatusResponse, type ModelInfo } from '@github/copilot-sdk';
import type { PortalEvent, PermissionPolicy, SessionMode } from '$lib/types';
import { AsyncQueue } from './async-queue';
import { createInteractiveCallbacks } from './interactive-adapter';
import { SdkEventAdapter, toRuntimeMode, type RuntimeSessionMode } from './sdk-events';
import * as conversationsRepo from '../db/repos/conversations';
import * as messagesRepo from '../db/repos/messages';
import { log } from '../log';
import { StubCopilotClient, isStubMode } from './bridge-stub';
import { buildGitTools } from '../tools/git';
import { buildTicketTools } from '../tools/tickets';
import { buildPermissionTools } from '../tools/permissions';
import { ticketWorkspaceFromConversation } from '../ticket-workspace';

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
	/** SDK-provided infinite-session workspace (e.g. ~/.copilot/session-state/<id>). */
	workspacePath?: string;
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

export async function open(opts: BridgeOpenOptions): Promise<ConversationSession> {
	const client = await getClient(opts.userId, opts.authToken);

	let activeQueue: AsyncQueue<PortalEvent> | null = null;

	function emit(ev: PortalEvent) {
		activeQueue?.push(ev);
	}

	// Mutable session-level state. Mirrors the conversation row in the
	// DB; the /session PATCH endpoint flips these via setMode/setApproveAll
	// on the live ConversationSession so a turn already in flight picks up
	// the change without a recreate.
	let approveAllTools = opts.approveAllTools === true;
	let currentMode: SessionMode = opts.mode ?? 'interactive';
	let sessionWorkspacePath: string | null = null;
	const toolPermissionBehavior = new Map<string, 'normal' | 'always-prompt'>();

	const eventAdapter = new SdkEventAdapter({
		conversationId: opts.conversationId,
		getQueue: () => activeQueue,
		setQueue: (q) => {
			activeQueue = q;
		},
		getMode: () => currentMode,
		setMode: (mode) => {
			currentMode = mode;
		},
		onSubagentLifecycle: (ev) => {
			messagesRepo.updateBackgroundAgentLifecycle(ev.toolCallId, ev.agentId, ev.status);
		}
	});
	const {
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanMode,
		onAutoModeSwitch
	} = createInteractiveCallbacks({
		conversationId: opts.conversationId,
		userId: opts.userId,
		workingDirectory: opts.workingDirectory,
		policy: opts.policy,
		emit,
		getApproveAll: () => approveAllTools,
		getMode: () => currentMode,
		getSessionWorkspacePath: () => sessionWorkspacePath,
		getPermissionBehavior: (tool) => toolPermissionBehavior.get(tool) ?? 'normal'
	});

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
			...buildGitTools(opts.workingDirectory),
			...buildTicketTools({
				userId: opts.userId,
				workspaceKey: ticketWorkspaceFromConversation(opts.workingDirectory),
				conversationId: opts.conversationId
			}),
			...buildPermissionTools({
				userId: opts.userId,
				conversationId: opts.conversationId,
				policy: opts.policy,
				getMode: () => currentMode
			}),
			{
				name: 'request_mode_switch',
				permissionBehavior: 'always-prompt',
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
	for (const tool of sessionConfig.tools) {
		if (tool.permissionBehavior === 'always-prompt' || tool.permissionBehavior === 'normal') {
			toolPermissionBehavior.set(tool.name, tool.permissionBehavior);
		}
	}

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
	sessionWorkspacePath = normalizeSessionWorkspacePath(sdkSession.workspacePath);

	eventAdapter.attach(sdkSession);

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
			eventAdapter.resetTurn();
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

function normalizeSessionWorkspacePath(path: string | undefined): string | null {
	const trimmed = path?.trim();
	if (!trimmed) return null;
	return trimmed;
}
