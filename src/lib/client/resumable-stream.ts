// Drives a resumable streaming consumer: opens a stream, forwards each event
// to a handler, and — if the stream ends without a terminal `done` event and
// the consumer hasn't been explicitly stopped — transparently reconnects
// with backoff. A built-in stall watchdog aborts the underlying request when
// no network activity has been seen for a while, so a silently-dead stream
// (proxy idle close, throttled tab, etc.) gets recovered automatically.
//
// All side-effects (timers, AbortController, network) are injectable so the
// logic can be unit-tested without a browser or real fetch.

export interface ResumableConnectArgs {
	attempt: number;
	signal: AbortSignal;
	onActivity: () => void;
	onStatus: (status: number) => void;
}

export interface ResumableInitial {
	method: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface ResumableStreamOptions<T> {
	// First-attempt request shape (typically a POST). Subsequent reconnects
	// always use GET (the server's resume endpoint).
	initial: ResumableInitial;
	// Opens the network stream for a given attempt. Implementations should
	// forward `signal` to fetch, and invoke `onStatus`/`onActivity` as the
	// response arrives. Should return an async iterable of events.
	connect: (req: ResumableInitial, args: ResumableConnectArgs) => AsyncIterable<T>;
	// Receives every event from the stream. May throw; thrown errors abort.
	onEvent: (ev: T) => void;
	// Returns true when an event signals end-of-turn. Iteration stops and no
	// reconnect is attempted.
	isDone: (ev: T) => boolean;
	// Returns true when the user has explicitly stopped (do not reconnect).
	isUserAborted: () => boolean;
	// Receives a synthetic error event when an unexpected network failure
	// occurs (not user abort, not stall). Optional.
	onNetworkError?: (err: unknown) => void;
	// Caps on retry behavior.
	maxAttempts?: number;
	stallThresholdMs?: number;
	stallCheckIntervalMs?: number;
	// Backoff in ms between reconnect attempts. attempt is 0-indexed.
	backoffMs?: (attempt: number) => number;
	// Injectable for tests.
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	setStallTimer?: (fn: () => void, ms: number) => () => void;
	createAbortController?: () => AbortController;
	// Aborts the per-attempt request from outside (e.g., page is closing).
	// If aborted, the helper exits without reconnecting.
	externalSignal?: AbortSignal;
}

export interface ResumableStreamResult {
	attempts: number;
	doneSeen: boolean;
	lastStatus: number;
	stoppedReason: 'done' | 'user-abort' | 'no-live-turn' | 'max-attempts' | 'external-abort';
}

const DEFAULTS = {
	maxAttempts: 8,
	stallThresholdMs: 40_000,
	stallCheckIntervalMs: 5_000,
	backoffMs: (attempt: number) => Math.min(500 * Math.pow(1.7, attempt), 4_000)
} as const;

export async function runResumableStream<T>(
	opts: ResumableStreamOptions<T>
): Promise<ResumableStreamResult> {
	const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
	const stallMs = opts.stallThresholdMs ?? DEFAULTS.stallThresholdMs;
	const stallCheckMs = opts.stallCheckIntervalMs ?? DEFAULTS.stallCheckIntervalMs;
	const backoff = opts.backoffMs ?? DEFAULTS.backoffMs;
	const now = opts.now ?? (() => Date.now());
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const setStallTimer =
		opts.setStallTimer ??
		((fn, ms) => {
			const h = setInterval(fn, ms);
			(h as unknown as { unref?: () => void }).unref?.();
			return () => clearInterval(h);
		});
	const makeAbort = opts.createAbortController ?? (() => new AbortController());

	let lastStatus = 0;
	let req: ResumableInitial = opts.initial;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (opts.isUserAborted()) {
			return { attempts: attempt, doneSeen: false, lastStatus, stoppedReason: 'user-abort' };
		}
		if (opts.externalSignal?.aborted) {
			return { attempts: attempt, doneSeen: false, lastStatus, stoppedReason: 'external-abort' };
		}

		const ac = makeAbort();
		const externalAbort = () => ac.abort();
		opts.externalSignal?.addEventListener('abort', externalAbort, { once: true });

		let lastActivity = now();
		const stopStall = setStallTimer(() => {
			if (opts.isUserAborted()) return;
			if (now() - lastActivity > stallMs) {
				// Force the in-flight request to abort; the loop will reconnect.
				ac.abort();
			}
		}, stallCheckMs);

		let sawDone = false;
		let attemptStatus = 0;
		try {
			const iter = opts.connect(req, {
				attempt,
				signal: ac.signal,
				onActivity: () => {
					lastActivity = now();
				},
				onStatus: (s) => {
					attemptStatus = s;
					lastStatus = s;
				}
			});
			for await (const ev of iter) {
				lastActivity = now();
				opts.onEvent(ev);
				if (opts.isDone(ev)) {
					sawDone = true;
					break;
				}
			}
		} catch (e) {
			if (!ac.signal.aborted) {
				opts.onNetworkError?.(e);
			}
		} finally {
			stopStall();
			opts.externalSignal?.removeEventListener('abort', externalAbort);
		}

		if (sawDone) {
			return { attempts: attempt + 1, doneSeen: true, lastStatus, stoppedReason: 'done' };
		}
		if (opts.isUserAborted()) {
			return { attempts: attempt + 1, doneSeen: false, lastStatus, stoppedReason: 'user-abort' };
		}
		if (opts.externalSignal?.aborted) {
			return {
				attempts: attempt + 1,
				doneSeen: false,
				lastStatus,
				stoppedReason: 'external-abort'
			};
		}
		// 204 means: no live turn on the server. Nothing to reconnect to.
		if (attemptStatus === 204) {
			return {
				attempts: attempt + 1,
				doneSeen: false,
				lastStatus,
				stoppedReason: 'no-live-turn'
			};
		}

		// No reason to sleep if we've used our last attempt.
		if (attempt + 1 >= maxAttempts) break;

		await sleep(backoff(attempt));
		if (opts.isUserAborted()) {
			return { attempts: attempt + 1, doneSeen: false, lastStatus, stoppedReason: 'user-abort' };
		}
		if (opts.externalSignal?.aborted) {
			return {
				attempts: attempt + 1,
				doneSeen: false,
				lastStatus,
				stoppedReason: 'external-abort'
			};
		}
		// Subsequent attempts always reattach via GET.
		req = { method: 'GET' };
	}

	return { attempts: maxAttempts, doneSeen: false, lastStatus, stoppedReason: 'max-attempts' };
}
