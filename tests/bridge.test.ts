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
	clientStub.start.mockClear();
	clientStub.createSession.mockReset().mockResolvedValue(sdkSessionStub);
	clientStub.resumeSession.mockReset().mockResolvedValue(sdkSessionStub);
	clientStub.getSessionMetadata.mockReset();
	sdkSessionStub.on.mockClear();
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
