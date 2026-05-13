// Thin wrapper around `@github/copilot-sdk`. Normalizes SDK events into the
// portal's PortalEvent shape, and bridges permission requests via HTTP.
//
// NOTE: Pinned to @github/copilot-sdk ^0.3.0. The SDK is in preview; if
// upgrading, audit the event names and PermissionRequest shape used below.
// All coupling lives in this file.

import { CopilotClient, type PermissionRequestResult } from '@github/copilot-sdk';
import type { PortalEvent, PermissionPolicy, PermissionDecision } from '$lib/types';
import { AsyncQueue } from './async-queue';
import { register as registerPermission, newRequestId, decideByPolicy } from './permissions';
import * as settingsRepo from '../db/repos/settings';
import { ulid } from 'ulid';
import { log } from '../log';

let sharedClient: CopilotClient | null = null;
let starting: Promise<CopilotClient> | null = null;

export async function getClient(authToken?: string): Promise<CopilotClient> {
	if (sharedClient) return sharedClient;
	if (starting) return starting;
	starting = (async () => {
		const client = new CopilotClient({
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

export interface BridgeOpenOptions {
	conversationId: string;
	userId: string;
	workingDirectory: string;
	model: string;
	policy: PermissionPolicy;
	authToken?: string;
	onEvent: (e: PortalEvent) => void;
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

	const sdkSession = (await client.createSession({
		model: opts.model,
		sessionId: opts.conversationId,
		streaming: true,
		onPermissionRequest: async (req) => {
			return await handlePermission(req as PermissionRequestLike, opts);
		}
	})) as unknown as SdkSession;

	let currentMessageId: string | null = null;

	let activeQueue: AsyncQueue<PortalEvent> | null = null;

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
		activeQueue.push({ type: 'message.delta', messageId: currentMessageId, text });
	};

	const onReasoningDelta = (e: unknown) => {
		const ev = e as { data?: { deltaContent?: string } };
		const text = ev?.data?.deltaContent ?? '';
		if (text && activeQueue && currentMessageId) {
			activeQueue.push({ type: 'message.reasoning', messageId: currentMessageId, text });
		}
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
			if (text) activeQueue.push({ type: 'message.delta', messageId: currentMessageId, text });
		}
	};

	const onToolStart = (e: unknown) => {
		const ev = e as {
			data?: {
				invocationId?: string;
				toolName?: string;
				args?: unknown;
			};
		};
		if (!activeQueue) return;
		activeQueue.push({
			type: 'tool.call',
			toolCallId: ev?.data?.invocationId ?? ulid(),
			tool: ev?.data?.toolName ?? 'unknown',
			args: ev?.data?.args ?? null
		});
	};

	const onToolComplete = (e: unknown) => {
		const ev = e as {
			data?: {
				invocationId?: string;
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
			toolCallId: ev?.data?.invocationId ?? ulid(),
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
		if (currentMessageId) {
			activeQueue.push({ type: 'message.end', messageId: currentMessageId });
			currentMessageId = null;
		}
		activeQueue.push({ type: 'done' });
		activeQueue.end();
		activeQueue = null;
	};

	sdkSession.on('assistant.message_delta', onDelta);
	sdkSession.on('assistant.reasoning_delta', onReasoningDelta);
	sdkSession.on('assistant.message', onAssistantMessage);
	sdkSession.on('tool.execution_start', onToolStart);
	sdkSession.on('tool.execution_complete', onToolComplete);
	sdkSession.on('session.idle', onSessionIdle);

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
					opts.onEvent(ev);
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
	opts: BridgeOpenOptions
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
			createdAt: Date.now()
		});
		opts.onEvent({
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
