import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/server/config';
import { lmStudioProvider } from '../src/lib/server/providers/lm-studio-provider';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';

const baseOpts: ProviderOpenOptions = {
	provider: 'lm-studio',
	conversationId: 'conv-lm-studio',
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

async function collect(iterable: AsyncIterable<PortalEvent>): Promise<PortalEvent[]> {
	const events: PortalEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

beforeEach(async () => {
	await setupLocalEnv('portal-lm-studio-');
	process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';
	delete process.env.LMSTUDIO_API_KEY;
	delete process.env.LMSTUDIO_REASONING;
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.LMSTUDIO_BASE_URL;
	delete process.env.LMSTUDIO_API_KEY;
	delete process.env.LMSTUDIO_REASONING;
	resetConfigForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('lmStudioProvider', () => {
	it('does not expose unsupported live control methods', async () => {
		expect(lmStudioProvider.capabilities.controls).toEqual({
			mode: false,
			approveAll: false,
			resetSessionApprovals: false
		});
		expect(lmStudioProvider.capabilities.features.mcpInfoEvents).toMatchObject({
			supported: false,
			behavior: 'unsupported'
		});

		const session = await lmStudioProvider.openSession(baseOpts);

		expect(session.setMode).toBeUndefined();
		expect(session.setApproveAll).toBeUndefined();
		expect(session.resetSessionApprovals).toBeUndefined();
	});

	it('discovers native LM Studio models with context metadata and optional API token', async () => {
		process.env.LMSTUDIO_API_KEY = 'lm-token';
		resetConfigForTests();
		const fetchMock = vi.fn(async () =>
			Response.json({
				models: [
					{
						type: 'llm',
						key: 'publisher/model',
						display_name: 'Local Model',
						max_context_length: 131072,
						loaded_instances: [{ id: 'publisher/model', config: { context_length: 8192 } }]
					},
					{ type: 'embedding', key: 'embedder', display_name: 'Embedder' }
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(lmStudioProvider.listModels('user-1')).resolves.toEqual([
			{
				id: 'publisher/model',
				name: 'Local Model',
				capabilities: { limits: { max_context_window_tokens: 8192 } }
			}
		]);
		expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1234/api/v1/models', {
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer lm-token'
			}
		});
	});

	it('streams native chat events, reasoning, MCP tool results, usage, and stores response ids', async () => {
		process.env.LMSTUDIO_REASONING = 'on';
		resetConfigForTests();
		const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
			void _init;
			const href = String(url);
			if (href.endsWith('/api/v1/models')) {
				return Response.json({
					models: [
						{
							type: 'llm',
							key: 'local-model',
							display_name: 'Local Model',
							max_context_length: 8192
						}
					]
				});
			}
			return sseResponse([
				'event: reasoning.start\n',
				'data: {"type":"reasoning.start"}\n\n',
				'event: reasoning.delta\n',
				'data: {"type":"reasoning.delta","content":"thinking"}\n\n',
				'event: reasoning.end\n',
				'data: {"type":"reasoning.end"}\n\n',
				'event: tool_call.success\n',
				'data: {"type":"tool_call.success","tool":"browser_navigate","arguments":{"url":"https://lmstudio.ai"},"output":"ok"}\n\n',
				'event: message.delta\n',
				'data: {"type":"message.delta","content":"Hello"}\n\n',
				'event: chat.end\n',
				'data: {"type":"chat.end","result":{"response_id":"resp_abc","stats":{"input_tokens":42,"total_output_tokens":3,"reasoning_output_tokens":1}}}\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const user = (await import('../src/lib/server/db/repos/users')).ensureLocalUser();
		const convs = await import('../src/lib/server/db/repos/conversations');
		convs.create(user.id, {
			id: baseOpts.conversationId,
			title: 'LM Studio test',
			workdir: baseOpts.workingDirectory,
			model: baseOpts.model,
			provider: 'lm-studio'
		});
		const session = await lmStudioProvider.openSession({
			...baseOpts,
			userId: user.id,
			onProviderSessionIdChange: (providerSessionId) => {
				convs.setProviderSessionId(baseOpts.conversationId, user.id, providerSessionId);
			}
		});

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'message.reasoning',
			'message.reasoning.end',
			'tool.call',
			'tool.result',
			'message.delta',
			'context.usage',
			'message.end',
			'done'
		]);
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'message.delta', text: 'Hello' })
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'tool.call', tool: 'lm_studio:browser_navigate' })
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'context.usage', currentTokens: 45, tokenLimit: 8192 })
		);
		expect(session.providerSessionId).toBe('resp_abc');
		expect(convs.get(baseOpts.conversationId, user.id)?.providerSessionId).toBe('resp_abc');
		const chatCall = fetchMock.mock.calls.find(([, init]) => init?.body);
		expect(JSON.parse(String(chatCall?.[1]?.body))).toMatchObject({
			model: 'local-model',
			input: 'hello',
			stream: true,
			store: true,
			temperature: 0.8,
			reasoning: 'on'
		});
		expect(JSON.parse(String(chatCall?.[1]?.body))).not.toHaveProperty('context_length');
	});

	it('derives context usage token limit from model metadata when no context override is set', async () => {
		const opts = { ...baseOpts, model: 'local-model-large' };
		const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
			void _init;
			const href = String(url);
			if (href.endsWith('/api/v1/models')) {
				return Response.json({
					models: [
						{
							type: 'llm',
							key: opts.model,
							display_name: 'Local Model',
							max_context_length: 131072,
							loaded_instances: [{ id: opts.model, config: { context_length: 16384 } }]
						}
					]
				});
			}
			return sseResponse([
				'event: message.delta\n',
				'data: {"type":"message.delta","content":"Hello"}\n\n',
				'event: chat.end\n',
				'data: {"type":"chat.end","result":{"response_id":"resp_ctx","stats":{"input_tokens":100,"total_output_tokens":25}}}\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await lmStudioProvider.openSession(opts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({ type: 'context.usage', currentTokens: 125, tokenLimit: 16384 })
		);
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).not.toHaveProperty(
			'context_length'
		);
	});

	it('continues server-backed chats with previous_response_id', async () => {
		const fetchMock = vi.fn(async (..._args: [string | URL | Request, RequestInit?]) => {
			void _args;
			return sseResponse([
				'event: message.delta\n',
				'data: {"type":"message.delta","content":"continued"}\n\n',
				'event: chat.end\n',
				'data: {"type":"chat.end","result":{"response_id":"resp_next"}}\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await lmStudioProvider.openSession({
			...baseOpts,
			providerSessionId: 'resp_prev'
		});

		await collect(session.send('follow up', new AbortController().signal));

		const chatCall = fetchMock.mock.calls.find(([, init]) => init?.body);
		expect(JSON.parse(String(chatCall?.[1]?.body))).toMatchObject({
			input: 'follow up',
			previous_response_id: 'resp_prev'
		});
		expect(session.providerSessionId).toBe('resp_next');
	});

	it('fails the turn and keeps in-memory response id unchanged when persistence callback fails', async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse([
				'event: message.delta\n',
				'data: {"type":"message.delta","content":"ok"}\n\n',
				'event: chat.end\n',
				'data: {"type":"chat.end","result":{"response_id":"resp_next"}}\n\n'
			])
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await lmStudioProvider.openSession({
			...baseOpts,
			providerSessionId: 'resp_prev',
			onProviderSessionIdChange: async () => {
				throw new Error('db unavailable');
			}
		});

		const events = await collect(session.send('follow up', new AbortController().signal));

		expect(session.providerSessionId).toBe('resp_prev');
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'send_failed',
				message: 'db unavailable'
			})
		);
	});

	it('maps invalid native tool calls from metadata', async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse([
				'event: tool_call.failure\n',
				'data: {"type":"tool_call.failure","reason":"Cannot find tool","metadata":{"type":"invalid_name","tool_name":"missing_tool","arguments":{"x":1}}}\n\n',
				'event: chat.end\n',
				'data: {"type":"chat.end","result":{"response_id":"resp_tool_failure"}}\n\n'
			])
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await lmStudioProvider.openSession(baseOpts);

		const events = await collect(session.send('call missing tool', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool.call',
				tool: 'lm_studio:missing_tool',
				args: { x: 1 }
			})
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool.result',
				ok: false,
				summary: 'Cannot find tool'
			})
		);
	});

	it('surfaces clear connection errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
		);
		const session = await lmStudioProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'send_failed',
				message: expect.stringContaining('Unable to connect to LM Studio backend')
			})
		);
	});
});
