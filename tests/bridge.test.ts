import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupLocalEnv } from './helpers/env';

// Shared mock SDK client/session instances. These are mutated per test.
const sdkSessionStub = {
	on: vi.fn(),
	off: vi.fn(),
	send: vi.fn(),
	abort: vi.fn(),
	disconnect: vi.fn(),
	rpc: {
		mode: {
			set: vi.fn()
		},
		permissions: {
			setApproveAll: vi.fn(),
			resetSessionApprovals: vi.fn()
		}
	}
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

beforeEach(async () => {
	// bridge.open() loads config (via bridge-stub.isStubMode → loadConfig)
	// so we need the same AUTH_MODE=none + HOST guards that real tests use.
	await setupLocalEnv('portal-bridge-test-');
	// Reset every stub so any test that re-implements one (e.g. the
	// usage_info test below mutates sdkSessionStub.send) can't leak its
	// implementation into the next test. Re-install default resolved
	// values for the methods bridge expects to be promise-returning.
	for (const fn of Object.values(clientStub)) fn.mockReset();
	for (const fn of [
		sdkSessionStub.on,
		sdkSessionStub.off,
		sdkSessionStub.send,
		sdkSessionStub.abort,
		sdkSessionStub.disconnect,
		sdkSessionStub.rpc.mode.set,
		sdkSessionStub.rpc.permissions.setApproveAll,
		sdkSessionStub.rpc.permissions.resetSessionApprovals
	])
		fn.mockReset();
	clientStub.start.mockResolvedValue(undefined);
	clientStub.stop.mockResolvedValue(undefined);
	clientStub.createSession.mockResolvedValue(sdkSessionStub);
	clientStub.resumeSession.mockResolvedValue(sdkSessionStub);
	clientStub.getAuthStatus.mockResolvedValue({ authenticated: true });
	clientStub.listModels.mockResolvedValue([]);
	clientStub.getSessionMetadata.mockResolvedValue(undefined);
	sdkSessionStub.abort.mockResolvedValue(undefined);
	sdkSessionStub.disconnect.mockResolvedValue(undefined);
	sdkSessionStub.rpc.mode.set.mockResolvedValue(undefined);
	sdkSessionStub.rpc.permissions.setApproveAll.mockResolvedValue({ success: true });
	sdkSessionStub.rpc.permissions.resetSessionApprovals.mockResolvedValue(undefined);
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

describe('bridge.open() session mode and permissions', () => {
	it('injects a request_mode_switch tool', async () => {
		const { open } = await importBridge();
		await open({ ...baseOpts, mode: 'best-effort' });

		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{
			name: string;
			description?: string;
		}>;
		expect(tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'request_mode_switch',
					description: expect.stringContaining('interactive mode')
				})
			])
		);
	});

	it('maps best-effort mode to autopilot on the runtime RPC', async () => {
		const { open } = await importBridge();
		const session = await open({ ...baseOpts, mode: 'best-effort' });

		await session.setMode('best-effort');

		expect(sdkSessionStub.rpc.mode.set).toHaveBeenCalledWith({ mode: 'autopilot' });
	});

	it('auto-rejects prompt-worthy permission requests in best-effort mode with the would-be prompt text', async () => {
		const { open } = await importBridge();
		await open({ ...baseOpts, mode: 'best-effort' });

		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: "printf 'best-effort demo\\n' > /tmp/copilot-best-effort-demo.txt"
		});

		expect(result).toEqual(
			expect.objectContaining({
				kind: 'reject',
				feedback: expect.stringContaining('best-effort')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('The user would have been asked to approve:')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('shell (shell)')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining(
					"printf 'best-effort demo\\n' > /tmp/copilot-best-effort-demo.txt"
				)
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('Reason: redirection')
			})
		);
	});

	it('does not auto-deny the request_mode_switch tool in best-effort mode', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/copilot/interactive-requests');
		const session = await open({ ...baseOpts, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'custom-tool',
				toolName: 'request_mode_switch',
				toolDescription:
					'Request switching this conversation to interactive mode when blocked by permissions.',
				args: { mode: 'interactive', reason: 'Need extra permission to continue.' }
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'request_mode_switch',
				permissionKind: 'custom-tool'
			}
		});
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});

	it('switches to interactive mode when request_mode_switch runs', async () => {
		const { open } = await importBridge();
		await open({ ...baseOpts, mode: 'best-effort' });

		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{
			name: string;
			handler: (args: unknown) => Promise<unknown>;
		}>;
		const tool = tools.find((t) => t.name === 'request_mode_switch');
		expect(tool).toBeTruthy();
		sdkSessionStub.rpc.mode.set.mockClear();

		const result = await tool!.handler({
			mode: 'interactive',
			reason: 'Need to request an additional permission.'
		});

		expect(sdkSessionStub.rpc.mode.set).toHaveBeenCalledWith({ mode: 'interactive' });
		expect(result).toBe(
			'Switched conversation to interactive mode. Reason: Need to request an additional permission.'
		);
	});
});

describe('bridge.open() reasoning segmentation', () => {
	it('opens a new reasoning segment after a visible delta or tool call, and emits .end on close', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			// Reasoning -> tool -> reasoning -> delta -> reasoning -> idle.
			// Three distinct segments expected, each closed by .end.
			handlers.get('assistant.reasoning_delta')?.({ data: { deltaContent: 'think A' } });
			handlers.get('tool.execution_start')?.({
				data: { toolCallId: 't1', toolName: 'noop', arguments: {} }
			});
			handlers.get('tool.execution_complete')?.({
				data: { toolCallId: 't1', success: true, result: null }
			});
			handlers.get('assistant.reasoning_delta')?.({ data: { deltaContent: 'think B' } });
			handlers.get('assistant.message_delta')?.({ data: { deltaContent: 'hello' } });
			handlers.get('assistant.reasoning_delta')?.({ data: { deltaContent: 'think C' } });
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: { type: string; segmentId?: string; text?: string; durationMs?: number }[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev as { type: string; segmentId?: string; text?: string; durationMs?: number });
			if (ev.type === 'done') break;
		}

		const reasonings = events.filter((e) => e.type === 'message.reasoning');
		const ends = events.filter((e) => e.type === 'message.reasoning.end');
		// Three contiguous reasoning bursts -> three unique segment ids.
		const segIds = Array.from(new Set(reasonings.map((r) => r.segmentId!)));
		expect(segIds.length).toBe(3);
		expect(reasonings.map((r) => r.text)).toEqual(['think A', 'think B', 'think C']);
		// Each closed segment emits a .end with a numeric duration.
		expect(ends.map((e) => e.segmentId)).toEqual(segIds);
		for (const e of ends) expect(typeof e.durationMs).toBe('number');

		// .end for segment 1 must precede tool.call; .end for segment 2 must
		// precede the first message.delta. Ordering is what powers the
		// interleaved render.
		const idx = (predicate: (e: { type: string; segmentId?: string }) => boolean) =>
			events.findIndex(predicate);
		const firstEndIdx = idx((e) => e.type === 'message.reasoning.end' && e.segmentId === segIds[0]);
		const toolCallIdx = idx((e) => e.type === 'tool.call');
		const secondEndIdx = idx(
			(e) => e.type === 'message.reasoning.end' && e.segmentId === segIds[1]
		);
		const firstDeltaIdx = idx((e) => e.type === 'message.delta');
		expect(firstEndIdx).toBeGreaterThanOrEqual(0);
		expect(firstEndIdx).toBeLessThan(toolCallIdx);
		expect(secondEndIdx).toBeGreaterThanOrEqual(0);
		expect(secondEndIdx).toBeLessThan(firstDeltaIdx);
	});
});

describe('bridge.open() tool live-streaming events', () => {
	it('forwards tool.execution_partial_result and tool.execution_progress as portal events', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			handlers.get('tool.execution_start')?.({
				data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'echo hi' } }
			});
			handlers.get('tool.execution_progress')?.({
				data: { toolCallId: 't1', progressMessage: 'Connecting…' }
			});
			handlers.get('tool.execution_partial_result')?.({
				data: { toolCallId: 't1', partialOutput: 'hi\n' }
			});
			handlers.get('tool.execution_partial_result')?.({
				data: { toolCallId: 't1', partialOutput: 'world\n' }
			});
			handlers.get('tool.execution_complete')?.({
				data: { toolCallId: 't1', success: true, result: { content: 'hi\nworld\n' } }
			});
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: { type: string; toolCallId?: string; output?: string; message?: string }[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev as (typeof events)[number]);
			if (ev.type === 'done') break;
		}

		const partials = events.filter((e) => e.type === 'tool.partial_output');
		expect(partials.map((p) => p.output)).toEqual(['hi\n', 'world\n']);
		const progress = events.find((e) => e.type === 'tool.progress');
		expect(progress?.message).toBe('Connecting…');

		// Order: progress + partials must arrive between tool.call and tool.result.
		const callIdx = events.findIndex((e) => e.type === 'tool.call');
		const resultIdx = events.findIndex((e) => e.type === 'tool.result');
		const progressIdx = events.findIndex((e) => e.type === 'tool.progress');
		const firstPartialIdx = events.findIndex((e) => e.type === 'tool.partial_output');
		expect(callIdx).toBeGreaterThanOrEqual(0);
		expect(resultIdx).toBeGreaterThan(callIdx);
		expect(progressIdx).toBeGreaterThan(callIdx);
		expect(progressIdx).toBeLessThan(resultIdx);
		expect(firstPartialIdx).toBeGreaterThan(progressIdx);
		expect(firstPartialIdx).toBeLessThan(resultIdx);
	});

	it('drops empty partial_output and progress payloads', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			handlers.get('tool.execution_start')?.({
				data: { toolCallId: 't1', toolName: 'bash', arguments: {} }
			});
			handlers.get('tool.execution_partial_result')?.({
				data: { toolCallId: 't1', partialOutput: '' }
			});
			handlers.get('tool.execution_progress')?.({
				data: { toolCallId: 't1', progressMessage: '' }
			});
			handlers.get('tool.execution_complete')?.({
				data: { toolCallId: 't1', success: true, result: null }
			});
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: { type: string }[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev as { type: string });
			if (ev.type === 'done') break;
		}
		expect(events.find((e) => e.type === 'tool.partial_output')).toBeUndefined();
		expect(events.find((e) => e.type === 'tool.progress')).toBeUndefined();
	});
});
