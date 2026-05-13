// Per-conversation "turn runner" that owns a single assistant turn.
//
// The runner consumes events from the underlying SDK session and:
//  - buffers them for any number of fan-out subscribers (replay + live),
//  - accumulates assistant text, tool calls, and file edits, and
//  - persists the assistant message at end of turn.
//
// Crucially, the runner's lifecycle is independent of any HTTP client:
// when the SSE consumer disconnects (e.g., the user refreshes the page),
// the runner keeps going so persistence is never lost. A subsequent GET
// can reattach and replay everything that already happened.

import { ulid } from 'ulid';
import { log } from '../log';
import * as messages from '../db/repos/messages';
import * as convs from '../db/repos/conversations';
import * as pool from './pool';
import { AsyncQueue } from './async-queue';
import type { BridgeOpenOptions } from './bridge';
import type { PortalEvent } from '$lib/types';

interface PendingTool {
	toolCallId: string;
	tool: string;
	argsJson: string;
	resultJson: string | null;
	status: 'pending' | 'ok' | 'error';
	startedAt: number;
	endedAt: number | null;
	textOffset: number;
}

interface PendingEdit {
	path: string;
	diff: string;
	textOffset: number;
}

export interface Turn {
	id: string;
	conversationId: string;
	startedAt: number;
	endedAt: number | null;
	status: 'running' | 'complete' | 'interrupted' | 'error';
	subscribe(signal?: AbortSignal): AsyncIterable<PortalEvent>;
	abort(): Promise<void>;
}

interface InternalTurn extends Turn {
	eventLog: PortalEvent[];
	subscribers: Set<AsyncQueue<PortalEvent>>;
	finishedPromise: Promise<void>;
}

// The turn registry is stashed on globalThis so that Vite HMR re-importing
// this module in dev does NOT wipe out the in-flight turns. Without this,
// a code edit during a turn would orphan the running turn in the old module
// closure: the new module's empty map would make `getTurn` return null, the
// client's resume-on-reload would get 204, and the UI would appear "stuck"
// with no assistant response while the orphaned turn quietly persisted to
// the DB minutes later. Same rationale as keeping the DB handle pinned.
const TURNS_KEY = Symbol.for('copilot-portal.turns');
type TurnRegistry = Map<string, InternalTurn>;
const turns: TurnRegistry = ((globalThis as unknown as Record<symbol, TurnRegistry>)[TURNS_KEY] ??=
	new Map<string, InternalTurn>());

// How long a finished turn lingers in the registry so that a slightly-late
// subscriber (e.g., a page that reloaded just as the turn completed) can
// still replay the full event log instead of missing it.
const FINISHED_GRACE_MS = 60_000;

export function getTurn(conversationId: string): Turn | null {
	return turns.get(conversationId) ?? null;
}

export interface StartTurnOptions {
	bridge: BridgeOpenOptions;
	prompt: string;
	conversationId: string;
}

export async function startTurn(opts: StartTurnOptions): Promise<Turn> {
	const existing = turns.get(opts.conversationId);
	if (existing && existing.status === 'running') {
		throw new Error('turn already in progress for this conversation');
	}
	if (existing) {
		// Replace a finished-but-still-cached turn with the new one.
		turns.delete(opts.conversationId);
	}

	const session = await pool.acquire(opts.bridge);

	const eventLog: PortalEvent[] = [];
	const subscribers = new Set<AsyncQueue<PortalEvent>>();
	const turnAc = new AbortController();

	const turn: InternalTurn = {
		id: ulid(),
		conversationId: opts.conversationId,
		startedAt: Date.now(),
		endedAt: null,
		status: 'running',
		eventLog,
		subscribers,
		finishedPromise: undefined as unknown as Promise<void>,
		subscribe(signal?: AbortSignal) {
			return subscribe(turn, signal);
		},
		async abort() {
			turnAc.abort();
			try {
				await session.abort();
			} catch {
				/* ignore */
			}
		}
	};

	turns.set(opts.conversationId, turn);

	// Accumulators for persistence.
	let assistantBuf = '';
	let assistantId: string | null = null;
	const pendingTools = new Map<string, PendingTool>();
	const pendingEdits: PendingEdit[] = [];

	function dispatch(ev: PortalEvent) {
		eventLog.push(ev);
		for (const q of subscribers) q.push(ev);

		if (ev.type === 'message.start') assistantId = ev.messageId;
		else if (ev.type === 'message.delta') assistantBuf += ev.text;
		else if (ev.type === 'tool.call') {
			pendingTools.set(ev.toolCallId, {
				toolCallId: ev.toolCallId,
				tool: ev.tool,
				argsJson: safeJson(ev.args),
				resultJson: null,
				status: 'pending',
				startedAt: Date.now(),
				endedAt: null,
				textOffset: assistantBuf.length
			});
		} else if (ev.type === 'tool.result') {
			const tc = pendingTools.get(ev.toolCallId);
			if (tc) {
				tc.status = ev.ok ? 'ok' : 'error';
				tc.resultJson = safeJson(ev.output ?? ev.summary);
				tc.endedAt = Date.now();
			}
		} else if (ev.type === 'file.edit') {
			pendingEdits.push({
				path: ev.path,
				diff: ev.diff,
				textOffset: assistantBuf.length
			});
		}
	}

	turn.finishedPromise = (async () => {
		try {
			for await (const ev of session.send(opts.prompt, turnAc.signal)) {
				dispatch(ev);
			}
		} catch (e) {
			log.warn('turn.stream.failed', {
				conversationId: opts.conversationId,
				err: String(e)
			});
			dispatch({
				type: 'error',
				code: 'stream_failed',
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			const status: 'interrupted' | 'complete' = turnAc.signal.aborted ? 'interrupted' : 'complete';

			// Persist assistant message + tool calls + file edits.
			try {
				if (assistantBuf || assistantId || pendingTools.size || pendingEdits.length) {
					const persisted = messages.append(opts.conversationId, {
						role: 'assistant',
						content: assistantBuf,
						status
					});
					for (const t of pendingTools.values()) {
						messages.insertToolCall(persisted.id, {
							id: t.toolCallId,
							tool: t.tool,
							argsJson: t.argsJson,
							resultJson: t.resultJson,
							status: t.status === 'pending' ? 'error' : t.status,
							startedAt: t.startedAt,
							endedAt: t.endedAt,
							textOffset: t.textOffset
						});
					}
					for (const e of pendingEdits) {
						messages.insertFileEdit(persisted.id, e.path, e.diff, e.textOffset);
					}
				}
				convs.touch(opts.conversationId);
			} catch (persistErr) {
				log.error('turn.persist.failed', {
					conversationId: opts.conversationId,
					err: String(persistErr)
				});
			}

			turn.status = status === 'interrupted' ? 'interrupted' : 'complete';
			turn.endedAt = Date.now();

			// Make sure subscribers see a terminal event even if the SDK
			// didn't emit `done` (e.g., on abort path).
			if (!eventLog.some((e) => e.type === 'done')) {
				const terminal: PortalEvent = { type: 'done' };
				eventLog.push(terminal);
				for (const q of subscribers) q.push(terminal);
			}
			for (const q of subscribers) q.end();
			subscribers.clear();

			// Keep the finished turn around briefly so that a subscriber that
			// races with completion still gets the full replay.
			const t = setTimeout(() => {
				if (turns.get(opts.conversationId) === turn) {
					turns.delete(opts.conversationId);
				}
			}, FINISHED_GRACE_MS);
			(t as { unref?: () => void }).unref?.();
		}
	})();

	return turn;
}

async function* subscribe(turn: InternalTurn, signal?: AbortSignal): AsyncIterable<PortalEvent> {
	// Replay buffered events first.
	for (const ev of turn.eventLog) {
		if (signal?.aborted) return;
		yield ev;
	}

	// If the turn already finished, we're done after the replay.
	if (turn.status !== 'running') return;

	// Subscribe to live events.
	const q = new AsyncQueue<PortalEvent>();
	turn.subscribers.add(q);

	const onAbort = () => {
		// Unsubscribe only; do NOT cancel the turn.
		turn.subscribers.delete(q);
		q.end();
	};
	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	}

	try {
		for await (const ev of q) {
			yield ev;
		}
	} finally {
		signal?.removeEventListener('abort', onAbort);
		turn.subscribers.delete(q);
	}
}

function safeJson(v: unknown): string {
	try {
		return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}
