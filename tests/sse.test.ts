import { describe, it, expect, vi, afterEach } from 'vitest';
import { sseResponse } from '../src/lib/server/sse';

async function readAll(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let out = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	return out;
}

function parseDataFrames(text: string): unknown[] {
	return text
		.split('\n\n')
		.map((frame) => frame.trim())
		.filter((frame) => frame.startsWith('data: '))
		.map((frame) => JSON.parse(frame.slice('data: '.length)));
}

afterEach(() => {
	vi.useRealTimers();
});

describe('sseResponse', () => {
	it('sets the SSE response headers', async () => {
		async function* empty() {
			/* no events */
		}
		const res = sseResponse(empty());
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
		expect(res.headers.get('connection')).toBe('keep-alive');
		expect(res.headers.get('x-accel-buffering')).toBe('no');
		await readAll(res); // drain so the stream closes cleanly
	});

	it('serializes each yielded event as a JSON data frame in order', async () => {
		async function* events() {
			yield { type: 'a', n: 1 };
			yield { type: 'b', text: 'hi' };
			yield { type: 'c', done: true };
		}
		const text = await readAll(sseResponse(events()));
		expect(parseDataFrames(text)).toEqual([
			{ type: 'a', n: 1 },
			{ type: 'b', text: 'hi' },
			{ type: 'c', done: true }
		]);
	});

	it('closes the stream after the iterable completes', async () => {
		async function* events() {
			yield { type: 'only' };
		}
		const res = sseResponse(events());
		const reader = res.body!.getReader();
		// First read returns the data frame, second returns done.
		const first = await reader.read();
		expect(first.done).toBe(false);
		const second = await reader.read();
		expect(second.done).toBe(true);
	});

	it('emits a JSON error frame when the iterable throws', async () => {
		async function* events() {
			yield { type: 'ok' };
			throw new Error('boom');
		}
		const text = await readAll(sseResponse(events()));
		const frames = parseDataFrames(text) as Array<Record<string, unknown>>;
		expect(frames).toHaveLength(2);
		expect(frames[0]).toEqual({ type: 'ok' });
		expect(frames[1]).toEqual({ type: 'error', code: 'stream_failed', message: 'boom' });
	});

	it('writes a heartbeat comment when the iterable is idle', async () => {
		vi.useFakeTimers();
		let resolveGate: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});
		async function* events() {
			await gate;
			yield { type: 'after-heartbeat' };
		}
		const res = sseResponse(events());
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		// Advance past the 15s heartbeat interval; the comment should arrive
		// before any data frame.
		await vi.advanceTimersByTimeAsync(16_000);
		const beat = await reader.read();
		expect(beat.done).toBe(false);
		const beatText = decoder.decode(beat.value);
		expect(beatText.startsWith(': heartbeat ')).toBe(true);
		expect(beatText.endsWith('\n\n')).toBe(true);

		// Now let the iterable produce its event and finish.
		resolveGate!();
		vi.useRealTimers();
		let rest = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			rest += decoder.decode(value);
		}
		expect(parseDataFrames(rest)).toEqual([{ type: 'after-heartbeat' }]);
	});
});
