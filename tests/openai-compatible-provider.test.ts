import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/server/config';
import { openAICompatibleProvider } from '../src/lib/server/copilot/openai-compatible-provider';
import type { ProviderOpenOptions } from '../src/lib/server/copilot/provider';
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

async function collect(iterable: AsyncIterable<PortalEvent>): Promise<PortalEvent[]> {
	const events: PortalEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
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
	resetConfigForTests();
	vi.restoreAllMocks();
});

describe('openAICompatibleProvider', () => {
	it('discovers models from an OpenAI-compatible /models endpoint with optional API key', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key';
		resetConfigForTests();
		const fetchMock = vi.fn(async () =>
			Response.json({ data: [{ id: 'lmstudio-model', name: 'LM Studio Model' }] })
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(openAICompatibleProvider.listModels('user-1')).resolves.toEqual([
			{ id: 'lmstudio-model', name: 'LM Studio Model' }
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
