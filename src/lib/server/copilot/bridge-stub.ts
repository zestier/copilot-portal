// In-process fake of the subset of `@github/copilot-sdk` we use, gated by the
// `COPILOT_STUB=1` env var. Lets e2e tests exercise the full turn-runner /
// SSE / persistence path without real Copilot credentials or network.
//
// Keep this faithful to the real SDK's event shape — see bridge.ts for the
// fields each event must carry.

import { ulid } from 'ulid';
import { loadConfig } from '../config';

type Listener = (e: unknown) => void;

class StubSession {
	readonly sessionId: string;
	readonly model: string;
	private listeners = new Map<string, Set<Listener>>();
	private aborted = false;
	private onPermissionRequest: ((req: unknown) => Promise<unknown>) | undefined;

	constructor(
		sessionId: string,
		model: string,
		onPermissionRequest?: (req: unknown) => Promise<unknown>
	) {
		this.sessionId = sessionId;
		this.model = model;
		this.onPermissionRequest = onPermissionRequest;
	}

	setPermissionHandler(fn: ((req: unknown) => Promise<unknown>) | undefined) {
		this.onPermissionRequest = fn;
	}

	on(event: string, listener: Listener) {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
	}

	off(event: string, listener: Listener) {
		this.listeners.get(event)?.delete(listener);
	}

	private emit(event: string, data: unknown) {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const l of set) {
			try {
				l({ data });
			} catch {
				// listeners should never throw in the real SDK either
			}
		}
	}

	async send(args: { prompt: string }): Promise<string> {
		this.aborted = false;
		const reply = `Stubbed reply to: ${args.prompt}`;
		// Stream the reply asynchronously so callers can subscribe to events
		// before the first delta lands, mirroring the real SDK.
		queueMicrotask(() => void this.run(reply));
		return reply;
	}

	private async run(reply: string) {
		const chunks = reply.match(/.{1,16}/g) ?? [reply];
		for (const chunk of chunks) {
			if (this.aborted) return;
			this.emit('assistant.message_delta', { deltaContent: chunk });
			await new Promise((r) => setTimeout(r, 5));
		}
		if (this.aborted) return;
		this.emit('assistant.message', { content: reply });
		this.emit('session.usage_info', {
			currentTokens: 100,
			tokenLimit: 200_000,
			messagesLength: 2,
			systemTokens: 50,
			conversationTokens: 50,
			toolDefinitionsTokens: 0,
			isInitial: false
		});
		this.emit('session.idle', {});
	}

	async abort() {
		this.aborted = true;
	}

	async disconnect() {
		this.listeners.clear();
	}
}

interface StubCreateOptions {
	model: string;
	sessionId: string;
	streaming?: boolean;
	onPermissionRequest?: (req: unknown) => Promise<unknown>;
}

export class StubCopilotClient {
	private sessions = new Map<string, StubSession>();

	async start() {}
	async stop() {}

	async getAuthStatus() {
		return {
			status: 'authenticated' as const,
			user: { login: 'stub-user' }
		};
	}

	async listModels() {
		return [
			{
				id: 'stub-model',
				name: 'Stub Model',
				vendor: 'stub',
				preview: false,
				billing: { multiplier: 0, restrictedToPlans: [] }
			}
		];
	}

	async getSessionMetadata(sessionId: string) {
		return this.sessions.has(sessionId) ? { sessionId } : undefined;
	}

	async createSession(opts: StubCreateOptions) {
		const s = new StubSession(opts.sessionId ?? ulid(), opts.model, opts.onPermissionRequest);
		this.sessions.set(s.sessionId, s);
		return s;
	}

	async resumeSession(
		sessionId: string,
		opts: { model: string; onPermissionRequest?: (req: unknown) => Promise<unknown> }
	) {
		let s = this.sessions.get(sessionId);
		if (!s) {
			s = new StubSession(sessionId, opts.model, opts.onPermissionRequest);
			this.sessions.set(sessionId, s);
		} else {
			s.setPermissionHandler(opts.onPermissionRequest);
		}
		return s;
	}
}

export function isStubMode(): boolean {
	return loadConfig().COPILOT_STUB;
}
