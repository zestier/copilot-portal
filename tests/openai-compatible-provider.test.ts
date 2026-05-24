import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/server/config';
import { openAICompatibleProvider } from '../src/lib/server/copilot/openai-compatible-provider';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';

const baseOpts: ProviderOpenOptions = {
	provider: 'openai-compatible',
	conversationId: 'conv-openai-compatible',
	userId: 'user-1',
	workingDirectory: '/tmp',
	model: 'local-model',
	policy: 'prompt'
};

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[i++]));
		}
	});
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function writeSse(res: ServerResponse, chunks: string[]) {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const chunk of chunks) res.write(chunk);
	res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startFakeStreamingServer(
	handler: (body: unknown, req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer(async (req, res) => {
		try {
			if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
				res.writeHead(404).end();
				return;
			}
			await handler(await readJson(req), req, res);
		} catch (e) {
			res
				.writeHead(500, { 'content-type': 'application/json' })
				.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve()))
			);
		}
	};
}

async function collect(iterable: AsyncIterable<PortalEvent>): Promise<PortalEvent[]> {
	const events: PortalEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

async function persistedOpts(
	overrides: Partial<ProviderOpenOptions> = {}
): Promise<ProviderOpenOptions> {
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const conversations = await import('../src/lib/server/db/repos/conversations');
	const user = ensureLocalUser();
	conversations.create(user.id, {
		id: baseOpts.conversationId,
		title: 'OpenAI-compatible test',
		workdir: baseOpts.workingDirectory,
		model: baseOpts.model,
		provider: baseOpts.provider
	});
	return { ...baseOpts, userId: user.id, ...overrides };
}

beforeEach(async () => {
	await setupLocalEnv('portal-openai-compatible-');
	process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234/v1';
	delete process.env.OPENAI_COMPATIBLE_API_KEY;
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.OPENAI_COMPATIBLE_BASE_URL;
	delete process.env.OPENAI_COMPATIBLE_API_KEY;
	delete process.env.OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS;
	resetConfigForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('openAICompatibleProvider', () => {
	it('documents Copilot runtime degradation for OpenAI-compatible sessions', () => {
		expect(openAICompatibleProvider.capabilities.controls).toEqual({
			mode: false,
			approveAll: true,
			resetSessionApprovals: false
		});
		expect(openAICompatibleProvider.capabilities.features).toMatchObject({
			modes: { supported: false, behavior: 'no-op' },
			approveAll: { supported: true, behavior: 'portal-enforced' },
			contextUsage: { supported: false, behavior: 'unsupported' },
			subagents: { supported: false, behavior: 'unsupported' },
			mcpInfoEvents: { supported: false, behavior: 'unsupported' },
			planExit: { supported: false, behavior: 'unsupported' },
			elicitation: { supported: false, behavior: 'unsupported' }
		});
		expect(openAICompatibleProvider.capabilities.optionalRuntimeFeatures).toMatchObject({
			contextWindowEvents: false,
			contextCompactionEvents: false,
			subagentLifecycleEvents: false,
			exitPlanModeCallbacks: false,
			elicitationCallbacks: false
		});
	});

	it('discovers models from an OpenAI-compatible /models endpoint with optional API key', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key';
		resetConfigForTests();
		const fetchMock = vi.fn(async () =>
			Response.json({ data: [{ id: 'local-chat-model', name: 'Local Chat Model' }] })
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(openAICompatibleProvider.listModels('user-1')).resolves.toEqual([
			{ id: 'local-chat-model', name: 'Local Chat Model' }
		]);
		expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/models', {
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer test-key'
			}
		});
	});

	it('falls back to manual model entry when model discovery is unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ error: { message: 'nope' } }, { status: 404 }))
		);

		await expect(openAICompatibleProvider.listModels('user-1')).resolves.toEqual([]);
	});

	it('streams chat completion chunks into PortalEvent messages', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: 'local-model',
				messages: [{ role: 'user', content: 'hello' }],
				tools: expect.arrayContaining([
					expect.objectContaining({
						type: 'function',
						function: expect.objectContaining({ name: 'git_status' })
					})
				]),
				tool_choice: 'auto',
				stream: true
			});
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'message.delta',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({ type: 'message.delta', text: 'Hel' });
		expect(events[2]).toMatchObject({ type: 'message.delta', text: 'lo' });
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:1234/v1/chat/completions',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('streams chat-only responses from an OpenAI-compatible fake server', async () => {
		const requests: unknown[] = [];
		const server = await startFakeStreamingServer((body, req, res) => {
			requests.push(body);
			expect(req.headers.authorization).toBe('Bearer fake-key');
			writeSse(res, [
				'data: {"choices":[{"delta":{"content":"network "}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		process.env.OPENAI_COMPATIBLE_BASE_URL = server.baseUrl;
		process.env.OPENAI_COMPATIBLE_API_KEY = 'fake-key';
		resetConfigForTests();
		try {
			const session = await openAICompatibleProvider.openSession(baseOpts);

			const events = await collect(session.send('hello network', new AbortController().signal));

			expect(events.map((event) => event.type)).toEqual([
				'message.start',
				'message.delta',
				'message.delta',
				'message.end',
				'done'
			]);
			expect(events.filter((event) => event.type === 'message.delta')).toEqual([
				expect.objectContaining({ text: 'network ' }),
				expect.objectContaining({ text: 'ok' })
			]);
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				model: 'local-model',
				messages: [{ role: 'user', content: 'hello network' }],
				tools: expect.arrayContaining([
					expect.objectContaining({
						type: 'function',
						function: expect.objectContaining({ name: 'git_status' })
					})
				]),
				tool_choice: 'auto',
				stream: true
			});
		} finally {
			await server.close();
		}
	});

	it('handles SSE comments, non-data fields, multiline data, and array text parts', async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse([
				': keep-alive\n',
				'event: ignored\n',
				'data: {"choices":[{"delta":{"content":[{"text":"Hel"}]}}]}\n\n',
				'data: {"choices":[\n',
				'data: {"delta":{"content":"lo"}}\n',
				'data: ]}\n\n',
				'data: [DONE]\n\n'
			])
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events.filter((event) => event.type === 'message.delta')).toEqual([
			expect.objectContaining({ text: 'Hel' }),
			expect.objectContaining({ text: 'lo' })
		]);
	});

	it('surfaces clear backend connection errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
		);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'send_failed',
				message: expect.stringContaining('Unable to connect to OpenAI compatible backend')
			})
		);
		expect(events.map((event) => event.type).slice(-2)).toEqual(['message.end', 'done']);
	});

	it('aborts an in-flight streaming request when the session is aborted', async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					expect(signal).toBeInstanceOf(AbortSignal);
					signal?.addEventListener(
						'abort',
						() => reject(new DOMException('aborted', 'AbortError')),
						{ once: true }
					);
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);
		const iter = session.send('hello', new AbortController().signal)[Symbol.asyncIterator]();

		expect((await iter.next()).value).toMatchObject({ type: 'message.start' });
		const next = iter.next();
		await session.abort();

		await expect(next).resolves.toMatchObject({
			value: { type: 'error', code: 'aborted' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'message.end' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'done' },
			done: false
		});
	});

	it('aborts immediately when the caller signal is already aborted', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect(init?.signal?.aborted).toBe(true);
			throw new DOMException('aborted', 'AbortError');
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);
		const ac = new AbortController();
		ac.abort();

		const events = await collect(session.send('hello', ac.signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'error',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({ type: 'error', code: 'aborted' });
	});

	it('executes requested portal tools and loops until a final assistant response', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(
			await persistedOpts({ policy: 'allow-all' })
		);

		const events = await collect(session.send('status please', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'tool.call',
			'tool.result',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({
			type: 'tool.call',
			toolCallId: 'call_git_status',
			tool: 'git_status',
			args: {}
		});
		expect(events[2]).toMatchObject({
			type: 'tool.result',
			toolCallId: 'call_git_status',
			ok: true
		});
		expect(events[3]).toMatchObject({ type: 'message.delta', text: 'done' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({
					role: 'assistant',
					tool_calls: [
						expect.objectContaining({
							id: 'call_git_status',
							function: expect.objectContaining({ name: 'git_status' })
						})
					]
				}),
				expect.objectContaining({ role: 'tool', tool_call_id: 'call_git_status' })
			])
		});
	});

	it('executes approved tool calls against an OpenAI-compatible fake server', async () => {
		const requests: unknown[] = [];
		const server = await startFakeStreamingServer((body, _req, res) => {
			requests.push(body);
			if (requests.length === 1) {
				writeSse(res, [
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
				return;
			}
			writeSse(res, [
				'data: {"choices":[{"delta":{"content":"approved"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		process.env.OPENAI_COMPATIBLE_BASE_URL = server.baseUrl;
		resetConfigForTests();
		try {
			const opts = await persistedOpts({ policy: 'prompt' });
			const settings = await import('../src/lib/server/db/repos/settings');
			settings.addGrant({
				userId: opts.userId,
				conversationId: opts.conversationId,
				tool: 'git_status',
				permissionKind: 'custom-tool',
				scope: { kind: 'any' },
				decision: 'allow'
			});
			const session = await openAICompatibleProvider.openSession(opts);

			const events = await collect(session.send('status please', new AbortController().signal));

			expect(events.map((event) => event.type)).toEqual([
				'message.start',
				'tool.call',
				'tool.result',
				'message.delta',
				'message.end',
				'done'
			]);
			expect(events[2]).toMatchObject({
				type: 'tool.result',
				toolCallId: 'call_git_status',
				ok: true
			});
			expect(events[3]).toMatchObject({ type: 'message.delta', text: 'approved' });
			expect(requests).toHaveLength(2);
			expect(requests[1]).toMatchObject({
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: 'assistant',
						tool_calls: [
							expect.objectContaining({
								id: 'call_git_status',
								function: expect.objectContaining({ name: 'git_status' })
							})
						]
					}),
					expect.objectContaining({ role: 'tool', tool_call_id: 'call_git_status' })
				])
			});
		} finally {
			await server.close();
		}
	});

	it('enforces permission callbacks before running portal tools', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_prompted","type":"function","function":{"name":"permission_capabilities","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"after permission"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const opts = await persistedOpts({ policy: 'deny-all' });
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId: opts.userId,
			conversationId: opts.conversationId,
			tool: 'permission_capabilities',
			permissionKind: 'custom-tool',
			scope: { kind: 'any' },
			decision: 'deny'
		});
		const session = await openAICompatibleProvider.openSession(opts);
		const iter = session
			.send('status please', new AbortController().signal)
			[Symbol.asyncIterator]();

		expect((await iter.next()).value).toMatchObject({ type: 'message.start' });
		expect((await iter.next()).value).toMatchObject({
			type: 'tool.call',
			toolCallId: 'call_prompted',
			tool: 'permission_capabilities'
		});
		expect((await iter.next()).value).toMatchObject({
			type: 'tool.result',
			toolCallId: 'call_prompted',
			ok: false,
			summary: expect.stringContaining('Permission denied')
		});
		expect((await iter.next()).value).toMatchObject({
			type: 'message.delta',
			text: 'after permission'
		});
	});

	it('keeps mode no-op at the provider API while approve-all remains portal-enforced', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(
			await persistedOpts({ policy: 'prompt' })
		);

		await session.setMode?.('plan');
		await session.setApproveAll?.(true);
		expect(session.resetSessionApprovals).toBeUndefined();

		const events = await collect(session.send('status please', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'tool.call',
			'tool.result',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'interactive.request' }));
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'session.settings' }));
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'context.usage' }));
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.lifecycle' }));
		const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(firstBody).toMatchObject({ model: 'local-model', stream: true, tool_choice: 'auto' });
		expect(firstBody).not.toHaveProperty('mode');
		expect(firstBody).not.toHaveProperty('approve_all');
		expect(firstBody).not.toHaveProperty('approveAllTools');
	});

	it('stops tool-calling with an explicit error at the configured max iterations', async () => {
		process.env.OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS = '1';
		resetConfigForTests();
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			return sseResponse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_loop","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(
			await persistedOpts({ policy: 'allow-all' })
		);

		const events = await collect(session.send('loop', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'max_tool_iterations',
				message: expect.stringContaining('1 tool-calling iterations')
			})
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects sends after the session is disposed', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		await session.dispose();
		const events = await collect(session.send('hello', new AbortController().signal));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'error',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({
			type: 'error',
			code: 'session_disposed',
			message: 'Session disposed.'
		});
	});

	it('aborts an in-flight streaming request when the session is disposed', async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					expect(signal).toBeInstanceOf(AbortSignal);
					signal?.addEventListener(
						'abort',
						() => reject(new DOMException('aborted', 'AbortError')),
						{ once: true }
					);
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);
		const iter = session.send('hello', new AbortController().signal)[Symbol.asyncIterator]();

		expect((await iter.next()).value).toMatchObject({ type: 'message.start' });
		const next = iter.next();
		await session.dispose();

		await expect(next).resolves.toMatchObject({
			value: { type: 'error', code: 'aborted' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'message.end' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'done' },
			done: false
		});
	});
});
