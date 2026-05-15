import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock SDK client/session instances. These are mutated per test.
const sdkSessionStub = {
	on: vi.fn(),
	off: vi.fn(),
	send: vi.fn(),
	abort: vi.fn(),
	disconnect: vi.fn()
};

const clientStub = {
	start: vi.fn().mockResolvedValue(undefined),
	stop: vi.fn().mockResolvedValue(undefined),
	getAuthStatus: vi.fn(),
	listModels: vi.fn(),
	createSession: vi.fn().mockResolvedValue(sdkSessionStub),
	resumeSession: vi.fn().mockResolvedValue(sdkSessionStub),
	getSessionMetadata: vi.fn()
};

vi.mock('@github/copilot-sdk', () => {
	class CopilotClient {
		constructor() {
			return clientStub as unknown as CopilotClient;
		}
	}
	return { CopilotClient };
});

// Import after the mock is registered. The bridge module caches the client
// in a module-level `sharedClient`, so we use vi.resetModules between tests
// to force a fresh import (and a fresh `new CopilotClient(...)` call which
// still returns our stub).
async function importBridge() {
	vi.resetModules();
	return await import('../src/lib/server/copilot/bridge');
}

const baseOpts = {
	conversationId: 'conv-123',
	userId: 'user-1',
	workingDirectory: '/tmp',
	model: 'gpt-4',
	policy: 'prompt' as const
};

beforeEach(() => {
	// Reset every stub so any test that re-implements one (e.g. the
	// usage_info test below mutates sdkSessionStub.send) can't leak its
	// implementation into the next test. Re-install default resolved
	// values for the methods bridge expects to be promise-returning.
	for (const fn of Object.values(clientStub)) fn.mockReset();
	for (const fn of Object.values(sdkSessionStub)) fn.mockReset();
	clientStub.start.mockResolvedValue(undefined);
	clientStub.stop.mockResolvedValue(undefined);
	clientStub.createSession.mockResolvedValue(sdkSessionStub);
	clientStub.resumeSession.mockResolvedValue(sdkSessionStub);
	clientStub.getAuthStatus.mockResolvedValue({ authenticated: true });
	clientStub.listModels.mockResolvedValue([]);
	clientStub.getSessionMetadata.mockResolvedValue(undefined);
	sdkSessionStub.abort.mockResolvedValue(undefined);
	sdkSessionStub.disconnect.mockResolvedValue(undefined);
});

describe('bridge.open() session resume behavior', () => {
	it('creates a new SDK session when no prior metadata exists', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.getSessionMetadata).toHaveBeenCalledWith('conv-123');
		expect(clientStub.resumeSession).not.toHaveBeenCalled();
		expect(clientStub.createSession).toHaveBeenCalledTimes(1);
		const arg = clientStub.createSession.mock.calls[0][0];
		expect(arg.sessionId).toBe('conv-123');
		expect(arg.model).toBe('gpt-4');
		expect(arg.streaming).toBe(true);
	});

	it('resumes the SDK session when prior metadata exists', async () => {
		clientStub.getSessionMetadata.mockResolvedValue({ sessionId: 'conv-123' });
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.resumeSession).toHaveBeenCalledTimes(1);
		expect(clientStub.resumeSession.mock.calls[0][0]).toBe('conv-123');
		const cfg = clientStub.resumeSession.mock.calls[0][1];
		expect(cfg.model).toBe('gpt-4');
		expect(cfg.streaming).toBe(true);
		// resumeSession's config type does not accept sessionId; passing it
		// would be a type error and confuse the SDK.
		expect(cfg).not.toHaveProperty('sessionId');
		expect(clientStub.createSession).not.toHaveBeenCalled();
	});

	it('falls back to createSession when resumeSession throws', async () => {
		clientStub.getSessionMetadata.mockResolvedValue({ sessionId: 'conv-123' });
		clientStub.resumeSession.mockRejectedValueOnce(new Error('session gone'));
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.resumeSession).toHaveBeenCalledTimes(1);
		expect(clientStub.createSession).toHaveBeenCalledTimes(1);
		expect(clientStub.createSession.mock.calls[0][0].sessionId).toBe('conv-123');
	});

	it('falls back to createSession when getSessionMetadata throws', async () => {
		clientStub.getSessionMetadata.mockRejectedValueOnce(new Error('rpc failed'));
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.resumeSession).not.toHaveBeenCalled();
		expect(clientStub.createSession).toHaveBeenCalledTimes(1);
		expect(clientStub.createSession.mock.calls[0][0].sessionId).toBe('conv-123');
	});
});

describe('bridge.open() context-usage event translation', () => {
	it('subscribes to session.usage_info and compaction events', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();
		await open(baseOpts);

		const subscribed = sdkSessionStub.on.mock.calls.map((c) => c[0]);
		expect(subscribed).toEqual(
			expect.arrayContaining([
				'session.usage_info',
				'session.compaction_start',
				'session.compaction_complete'
			])
		);
	});

	it('translates session.usage_info into a context.usage PortalEvent during a turn', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		// `send()` is invoked inside the bridge's session.send wrapper. We
		// resolve it on a microtask so the bridge sets up its activeQueue
		// before we synthesize the SDK event.
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			// fire the SDK event after the bridge has installed its handlers
			// and activeQueue is set.
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			handlers.get('session.usage_info')?.({
				data: {
					currentTokens: 1234,
					tokenLimit: 100_000,
					messagesLength: 4,
					systemTokens: 700,
					conversationTokens: 500,
					toolDefinitionsTokens: 34,
					isInitial: true
				}
			});
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: unknown[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev);
			if ((ev as { type: string }).type === 'done') break;
		}

		const usage = events.find((e) => (e as { type: string }).type === 'context.usage') as
			| { currentTokens: number; tokenLimit: number; isInitial?: boolean }
			| undefined;
		expect(usage).toBeTruthy();
		expect(usage!.currentTokens).toBe(1234);
		expect(usage!.tokenLimit).toBe(100_000);
		expect(usage!.isInitial).toBe(true);
	});
});
