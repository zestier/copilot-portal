import { describe, it, expect } from 'vitest';
import {
	runResumableStream,
	type ResumableConnectArgs,
	type ResumableInitial
} from '../src/lib/client/resumable-stream';

// Helpers --------------------------------------------------------------

// A controllable in-memory clock + queue-based sleep that lets tests drive
// time deterministically. `advance(ms)` resolves all sleeps whose deadline
// has been reached.
function makeClock(start = 0) {
	let nowMs = start;
	const pending: Array<{ deadline: number; resolve: () => void }> = [];
	return {
		now: () => nowMs,
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				pending.push({ deadline: nowMs + ms, resolve });
			}),
		advance: async (ms: number) => {
			nowMs += ms;
			const ready = pending.filter((p) => p.deadline <= nowMs);
			for (const r of ready) {
				pending.splice(pending.indexOf(r), 1);
				r.resolve();
			}
			// Let microtasks settle.
			await Promise.resolve();
			await Promise.resolve();
		},
		pendingCount: () => pending.length
	};
}

// Yields events from a queue; awaits the next one when empty. Caller can
// push events, push errors, or end the stream. Optionally fires onActivity
// for "heartbeat-only" ticks that don't produce events.
function makeControllableStream<T>() {
	type Cmd =
		| { kind: 'event'; value: T }
		| { kind: 'activity' }
		| { kind: 'end' }
		| { kind: 'error'; err: unknown };
	const queue: Cmd[] = [];
	const waiters: Array<() => void> = [];
	const wake = () => {
		while (waiters.length) waiters.shift()!();
	};
	let lastConnectArgs: ResumableConnectArgs | null = null;

	const stream: AsyncIterable<T> = {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<T>> {
					for (;;) {
						if (queue.length === 0) {
							await new Promise<void>((r) => waiters.push(r));
							continue;
						}
						const c = queue.shift()!;
						if (c.kind === 'event') return { value: c.value, done: false };
						if (c.kind === 'end') return { value: undefined as unknown as T, done: true };
						if (c.kind === 'error') throw c.err;
						// 'activity' — call onActivity and keep waiting
						lastConnectArgs?.onActivity();
					}
				}
			};
		}
	};

	return {
		stream,
		captureArgs(args: ResumableConnectArgs) {
			lastConnectArgs = args;
		},
		pushEvent(value: T) {
			queue.push({ kind: 'event', value });
			wake();
		},
		pushActivity() {
			queue.push({ kind: 'activity' });
			wake();
		},
		pushError(err: unknown) {
			queue.push({ kind: 'error', err });
			wake();
		},
		end() {
			queue.push({ kind: 'end' });
			wake();
		}
	};
}

type Ev = { type: string; text?: string };
const isDone = (ev: Ev) => ev.type === 'done';

// Tests ----------------------------------------------------------------

describe('runResumableStream', () => {
	it('returns on terminal `done` event without reconnecting', async () => {
		const clock = makeClock();
		const stream = makeControllableStream<Ev>();
		const events: Ev[] = [];
		const connects: ResumableInitial[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST', body: 'hi' },
			isDone,
			isUserAborted: () => false,
			onEvent: (e) => events.push(e),
			connect: (req, args) => {
				connects.push(req);
				stream.captureArgs(args);
				return stream.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {} // disabled
		});

		stream.pushEvent({ type: 'message.delta', text: 'hi' });
		await Promise.resolve();
		stream.pushEvent({ type: 'done' });
		const result = await runP;

		expect(result.stoppedReason).toBe('done');
		expect(result.doneSeen).toBe(true);
		expect(result.attempts).toBe(1);
		expect(events.map((e) => e.type)).toEqual(['message.delta', 'done']);
		expect(connects).toEqual([{ method: 'POST', body: 'hi' }]);
	});

	it('reconnects via GET when the stream ends without `done`', async () => {
		const clock = makeClock();
		const s1 = makeControllableStream<Ev>();
		const s2 = makeControllableStream<Ev>();
		const streams = [s1, s2];
		const connects: ResumableInitial[] = [];
		const events: Ev[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST', body: 'hi' },
			isDone,
			isUserAborted: () => false,
			onEvent: (e) => events.push(e),
			connect: (req, args) => {
				connects.push(req);
				const s = streams.shift()!;
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {},
			backoffMs: () => 100
		});

		// First stream emits one delta then ends (no `done`).
		s1.pushEvent({ type: 'message.delta', text: 'a' });
		await Promise.resolve();
		s1.end();
		await Promise.resolve();
		await Promise.resolve();

		// Now in backoff sleep. Advance time to unblock.
		await clock.advance(100);

		// Second stream emits a delta and then `done`.
		s2.pushEvent({ type: 'message.delta', text: 'b' });
		await Promise.resolve();
		s2.pushEvent({ type: 'done' });
		const result = await runP;

		expect(result.stoppedReason).toBe('done');
		expect(result.attempts).toBe(2);
		expect(connects).toEqual([{ method: 'POST', body: 'hi' }, { method: 'GET' }]);
		expect(events.map((e) => e.text)).toEqual(['a', 'b', undefined]);
	});

	it('stops without reconnecting when status is 204 (no live turn)', async () => {
		const clock = makeClock();
		const s = makeControllableStream<Ev>();
		let connects = 0;

		const runP = runResumableStream<Ev>({
			initial: { method: 'GET' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			connect: (_req, args) => {
				connects++;
				args.onStatus(204);
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {}
		});

		s.end();
		const result = await runP;
		expect(result.stoppedReason).toBe('no-live-turn');
		expect(result.lastStatus).toBe(204);
		expect(connects).toBe(1);
	});

	it('stops without reconnecting when the user aborts mid-stream', async () => {
		const clock = makeClock();
		const s = makeControllableStream<Ev>();
		let userAborted = false;
		let connects = 0;

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST' },
			isDone,
			isUserAborted: () => userAborted,
			onEvent: () => {},
			connect: (_req, args) => {
				connects++;
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {}
		});

		s.pushEvent({ type: 'message.delta', text: 'a' });
		await Promise.resolve();
		userAborted = true;
		s.end();
		const result = await runP;

		expect(result.stoppedReason).toBe('user-abort');
		expect(connects).toBe(1);
	});

	it('aborts the in-flight request when the stall threshold is exceeded', async () => {
		const clock = makeClock();
		const s1 = makeControllableStream<Ev>();
		const s2 = makeControllableStream<Ev>();
		const streams = [s1, s2];
		const stallFn: { fn: (() => void) | null } = { fn: null };
		const aborts: AbortSignal[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			connect: (_req, args) => {
				aborts.push(args.signal);
				const s = streams.shift()!;
				s.captureArgs(args);
				args.signal.addEventListener('abort', () => {
					// Mimic fetch behavior: when the signal aborts, the
					// stream throws.
					s.pushError(new DOMException('aborted', 'AbortError'));
				});
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			stallThresholdMs: 1000,
			stallCheckIntervalMs: 100,
			backoffMs: () => 50,
			setStallTimer: (fn) => {
				stallFn.fn = fn;
				return () => {
					stallFn.fn = null;
				};
			}
		});

		// No events flow. Simulate time passing past the stall threshold.
		await clock.advance(1500);
		// Trigger the stall check.
		stallFn.fn?.();
		await Promise.resolve();
		await Promise.resolve();
		// First connection should now be aborted.
		expect(aborts[0].aborted).toBe(true);

		// Past backoff, then second stream completes with `done`.
		await clock.advance(50);
		await Promise.resolve();
		s2.pushEvent({ type: 'done' });
		const result = await runP;

		expect(result.stoppedReason).toBe('done');
		expect(result.attempts).toBe(2);
	});

	it('treats activity ticks as keeping the stream alive (no stall abort)', async () => {
		const clock = makeClock();
		const s = makeControllableStream<Ev>();
		const stallFn: { fn: (() => void) | null } = { fn: null };
		const aborts: AbortSignal[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			connect: (_req, args) => {
				aborts.push(args.signal);
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			stallThresholdMs: 1000,
			stallCheckIntervalMs: 100,
			setStallTimer: (fn) => {
				stallFn.fn = fn;
				return () => {
					stallFn.fn = null;
				};
			}
		});

		// Halfway to stall, fire an activity tick.
		await clock.advance(600);
		s.pushActivity();
		await Promise.resolve();
		await Promise.resolve();
		// Now check the stall — should NOT abort because activity reset the clock.
		await clock.advance(600); // total 1200ms, but only 600ms since activity
		stallFn.fn?.();
		await Promise.resolve();
		expect(aborts[0].aborted).toBe(false);

		s.pushEvent({ type: 'done' });
		const result = await runP;
		expect(result.stoppedReason).toBe('done');
		expect(result.attempts).toBe(1);
	});

	it('forwards network errors to onNetworkError (only when not a self-abort)', async () => {
		const clock = makeClock();
		const s1 = makeControllableStream<Ev>();
		const s2 = makeControllableStream<Ev>();
		const streams = [s1, s2];
		const errors: unknown[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			onNetworkError: (e) => errors.push(e),
			connect: (_req, args) => {
				const s = streams.shift()!;
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {},
			backoffMs: () => 10
		});

		// First connection throws a non-abort error.
		s1.pushError(new Error('boom'));
		await Promise.resolve();
		await Promise.resolve();
		await clock.advance(10);

		// Second connection completes cleanly.
		s2.pushEvent({ type: 'done' });
		const result = await runP;

		expect(result.stoppedReason).toBe('done');
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe('boom');
	});

	it('does not call onNetworkError when the abort came from the stall watchdog', async () => {
		const clock = makeClock();
		const s1 = makeControllableStream<Ev>();
		const s2 = makeControllableStream<Ev>();
		const streams = [s1, s2];
		const errors: unknown[] = [];
		const stallFn: { fn: (() => void) | null } = { fn: null };

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			onNetworkError: (e) => errors.push(e),
			connect: (_req, args) => {
				const s = streams.shift()!;
				s.captureArgs(args);
				args.signal.addEventListener('abort', () => {
					s.pushError(new DOMException('aborted', 'AbortError'));
				});
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			stallThresholdMs: 100,
			stallCheckIntervalMs: 50,
			backoffMs: () => 10,
			setStallTimer: (fn) => {
				stallFn.fn = fn;
				return () => {
					stallFn.fn = null;
				};
			}
		});

		await clock.advance(200);
		stallFn.fn?.();
		await Promise.resolve();
		await Promise.resolve();
		await clock.advance(10);

		s2.pushEvent({ type: 'done' });
		const result = await runP;

		expect(result.stoppedReason).toBe('done');
		expect(errors).toEqual([]);
	});

	it('gives up after maxAttempts (refined)', async () => {
		const clock = makeClock();
		const connected: ReturnType<typeof makeControllableStream<Ev>>[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			connect: (_req, args) => {
				const s = makeControllableStream<Ev>();
				connected.push(s);
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {},
			maxAttempts: 3,
			backoffMs: () => 10
		});

		// End each stream as it's opened, then advance through the backoff.
		for (let i = 0; i < 3; i++) {
			// Wait for connect() to be invoked.
			while (connected.length < i + 1) await Promise.resolve();
			connected[i].end();
			await Promise.resolve();
			await Promise.resolve();
			if (i < 2) await clock.advance(10);
		}

		const result = await runP;
		expect(result.stoppedReason).toBe('max-attempts');
		expect(result.attempts).toBe(3);
		expect(result.doneSeen).toBe(false);
		expect(connected).toHaveLength(3);
	});

	it('stops when externalSignal aborts during backoff', async () => {
		const clock = makeClock();
		const ext = new AbortController();
		const s = makeControllableStream<Ev>();

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST' },
			externalSignal: ext.signal,
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			connect: (_req, args) => {
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {},
			backoffMs: () => 1000
		});

		// End the first stream without `done` so we enter backoff.
		s.end();
		await Promise.resolve();
		await Promise.resolve();
		// Abort externally during the backoff window.
		ext.abort();
		await clock.advance(1000);
		const result = await runP;
		expect(result.stoppedReason).toBe('external-abort');
		expect(result.attempts).toBe(1);
	});

	it('does not consume attempts while paused, and resets the budget on wake', async () => {
		const clock = makeClock();
		let paused = true;
		const wakers: Array<() => void> = [];
		const waitForWake = () =>
			new Promise<void>((resolve) => {
				wakers.push(resolve);
			});
		const connected: ReturnType<typeof makeControllableStream<Ev>>[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST', body: 'hi' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			connect: (_req, args) => {
				const s = makeControllableStream<Ev>();
				connected.push(s);
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {},
			maxAttempts: 2,
			backoffMs: () => 10,
			isPaused: () => paused,
			waitForWake
		});

		// Initially paused → no connection yet, one waker registered.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(connected).toHaveLength(0);
		expect(wakers).toHaveLength(1);

		// Wake: attempt budget resets, first connection opens.
		paused = false;
		wakers.shift()!();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(connected).toHaveLength(1);

		// End stream 1 while paused: the post-failure sleep is skipped
		// and the next iteration enters the pause gate.
		paused = true;
		connected[0].end();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(wakers).toHaveLength(1);

		// Wake: budget reset means another two attempts are available.
		paused = false;
		wakers.shift()!();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(connected).toHaveLength(2);

		connected[1].end();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		await clock.advance(10);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		// Without the budget reset, we'd already be at max-attempts after
		// stream 1's end. The reset lets us reach a third connection.
		expect(connected).toHaveLength(3);

		connected[2].pushEvent({ type: 'done' });
		const result = await runP;
		expect(result.stoppedReason).toBe('done');
	});

	it('reattaches via GET on the post-pause reconnect (no POST body replay)', async () => {
		const clock = makeClock();
		let paused = false;
		const wakers: Array<() => void> = [];
		const connects: ResumableInitial[] = [];
		const streams: ReturnType<typeof makeControllableStream<Ev>>[] = [];

		const runP = runResumableStream<Ev>({
			initial: { method: 'POST', body: 'hello' },
			isDone,
			isUserAborted: () => false,
			onEvent: () => {},
			connect: (req, args) => {
				connects.push(req);
				const s = makeControllableStream<Ev>();
				streams.push(s);
				s.captureArgs(args);
				return s.stream;
			},
			now: clock.now,
			sleep: clock.sleep,
			setStallTimer: () => () => {},
			backoffMs: () => 5,
			isPaused: () => paused,
			waitForWake: () =>
				new Promise<void>((resolve) => {
					wakers.push(resolve);
				})
		});

		// First attempt connects with POST.
		await Promise.resolve();
		await Promise.resolve();
		expect(connects[0]).toEqual({ method: 'POST', body: 'hello' });

		// Stream ends without `done`; pause kicks in before the next attempt.
		paused = true;
		streams[0].end();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(wakers).toHaveLength(1);

		// Wake up.
		paused = false;
		wakers.shift()!();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		// Post-wake reconnect must use GET, not replay the POST body.
		expect(connects[1]).toEqual({ method: 'GET' });

		streams[1].pushEvent({ type: 'done' });
		const result = await runP;
		expect(result.stoppedReason).toBe('done');
	});
});
