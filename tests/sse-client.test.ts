import { describe, it, expect, afterEach, vi } from 'vitest';
import { streamSse } from '../src/lib/client/sse';

// Build a fake Response whose body streams the given chunks in order.
function fakeResponse(opts: { status: number; chunks?: string[]; contentType?: string }): Response {
	const { status, chunks = [], contentType = 'text/event-stream' } = opts;
	if (status === 204 || chunks.length === 0) {
		return new Response(null, { status, headers: { 'content-type': contentType } });
	}
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
	return new Response(body, { status, headers: { 'content-type': contentType } });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('streamSse', () => {
	it('parses data events and yields them in order', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				fakeResponse({
					status: 200,
					chunks: [
						'data: {"type":"message.delta","messageId":"m1","text":"hi"}\n\n',
						'data: {"type":"done"}\n\n'
					]
				})
			)
		);
		const seen: unknown[] = [];
		for await (const ev of streamSse('/x')) seen.push(ev);
		expect(seen).toEqual([
			{ type: 'message.delta', messageId: 'm1', text: 'hi' },
			{ type: 'done' }
		]);
	});

	it('invokes onStatus with the HTTP status code', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => fakeResponse({ status: 204 }))
		);
		const statuses: number[] = [];
		const it = streamSse('/x', { onStatus: (s) => statuses.push(s) })[Symbol.asyncIterator]();
		await it.next();
		expect(statuses).toEqual([204]);
	});

	it('onStatus fires before iteration begins so 204 is detectable without events', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => fakeResponse({ status: 204 }))
		);
		let status = 0;
		let eventCount = 0;
		for await (const ev of streamSse('/x', {
			onStatus: (s) => {
				status = s;
			}
		})) {
			void ev;
			eventCount++;
		}
		expect(status).toBe(204);
		expect(eventCount).toBe(0);
	});

	it('onActivity fires for every chunk, including heartbeat-only chunks', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				fakeResponse({
					status: 200,
					chunks: [
						': heartbeat 1\n\n',
						'data: {"type":"message.delta","messageId":"m","text":"a"}\n\n',
						': heartbeat 2\n\n',
						'data: {"type":"done"}\n\n'
					]
				})
			)
		);
		let activity = 0;
		const events: unknown[] = [];
		for await (const ev of streamSse('/x', { onActivity: () => activity++ })) {
			events.push(ev);
		}
		// Two data events, but four chunks of network activity (heartbeats included).
		expect(events).toHaveLength(2);
		expect(activity).toBe(4);
	});

	it('throws on non-ok responses and still reports status via onStatus', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('boom', { status: 500 }))
		);
		let status = 0;
		await expect(async () => {
			for await (const ev of streamSse('/x', {
				onStatus: (s) => {
					status = s;
				}
			})) {
				void ev;
			}
		}).rejects.toThrow(/500/);
		expect(status).toBe(500);
	});

	it('handles multiple events arriving in a single chunk', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				fakeResponse({
					status: 200,
					chunks: [
						'data: {"type":"message.delta","messageId":"m","text":"a"}\n\ndata: {"type":"message.delta","messageId":"m","text":"b"}\n\n'
					]
				})
			)
		);
		const seen: unknown[] = [];
		for await (const ev of streamSse('/x')) seen.push(ev);
		expect(seen).toEqual([
			{ type: 'message.delta', messageId: 'm', text: 'a' },
			{ type: 'message.delta', messageId: 'm', text: 'b' }
		]);
	});

	it('handles events split across chunk boundaries', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				fakeResponse({
					status: 200,
					chunks: [
						'data: {"type":"message.delta","messa',
						'geId":"m","text":"abc"}\n\n',
						'data: {"type":"done"}\n\n'
					]
				})
			)
		);
		const seen: unknown[] = [];
		for await (const ev of streamSse('/x')) seen.push(ev);
		expect(seen).toEqual([
			{ type: 'message.delta', messageId: 'm', text: 'abc' },
			{ type: 'done' }
		]);
	});

	it('does not forward onStatus/onActivity into the underlying fetch init', async () => {
		let capturedInit: RequestInit | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				capturedInit = init;
				return Promise.resolve(fakeResponse({ status: 204 }));
			})
		);
		for await (const ev of streamSse('/x', {
			method: 'GET',
			onStatus: () => {},
			onActivity: () => {}
		})) {
			void ev;
		}
		const init = capturedInit as
			| (RequestInit & { onStatus?: unknown; onActivity?: unknown })
			| undefined;
		expect(init?.method).toBe('GET');
		expect(init?.onStatus).toBeUndefined();
		expect(init?.onActivity).toBeUndefined();
	});
});
