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
import * as usageRepo from '../db/repos/usage';
import * as pool from './pool';
import { deriveTitle, isDefaultTitle } from '../title';
import { AsyncQueue } from './async-queue';
import { snapshot as takeSnapshot } from '../snapshots';
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

// A single event in the turn's transcript, paired with its monotonic id.
// `id` corresponds to the event's index in `eventLog`, which is what the
// SSE layer writes as `id:` and what clients send back as `Last-Event-ID`
// on reconnect.
export interface IdentifiedEvent {
	id: number;
	event: PortalEvent;
}

export interface SubscribeOptions {
	signal?: AbortSignal;
	// If provided, replay only events strictly after this id. Used by SSE
	// reconnects to skip what the client already received.
	sinceId?: number;
}

export interface Turn {
	id: string;
	conversationId: string;
	startedAt: number;
	endedAt: number | null;
	status: 'running' | 'complete' | 'interrupted' | 'error';
	subscribe(opts?: SubscribeOptions): AsyncIterable<IdentifiedEvent>;
	abort(): Promise<void>;
}

interface InternalTurn extends Turn {
	eventLog: PortalEvent[];
	subscribers: Set<AsyncQueue<IdentifiedEvent>>;
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

// Look up a turn by its own id (the ulid in `turn.id`), scoped to a
// conversation. Used by the streaming endpoint, which keys URLs by
// `turnId` so reconnects always land on the same logical stream even
// if a new turn replaced the registry slot.
export function getTurnById(conversationId: string, turnId: string): Turn | null {
	const t = turns.get(conversationId);
	return t && t.id === turnId ? t : null;
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
	const subscribers = new Set<AsyncQueue<IdentifiedEvent>>();
	const turnAc = new AbortController();

	// Append an event to the log and fan it out to live subscribers with
	// its monotonic id (= index in `eventLog`). All paths that need to
	// surface an event MUST go through here so that ids stay contiguous
	// and aligned with the replay buffer.
	function emit(ev: PortalEvent) {
		const id = eventLog.length;
		eventLog.push(ev);
		const wrapped: IdentifiedEvent = { id, event: ev };
		for (const q of subscribers) q.push(wrapped);
	}

	const turn: InternalTurn = {
		id: ulid(),
		conversationId: opts.conversationId,
		startedAt: Date.now(),
		endedAt: null,
		status: 'running',
		eventLog,
		subscribers,
		finishedPromise: undefined as unknown as Promise<void>,
		subscribe(subOpts?: SubscribeOptions) {
			return subscribe(turn, subOpts);
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
	let reasoningBuf = '';
	let reasoningStartedAt: number | null = null;
	let reasoningEndedAt: number | null = null;
	const pendingTools = new Map<string, PendingTool>();
	const pendingEdits: PendingEdit[] = [];

	function dispatch(ev: PortalEvent) {
		// Suppress the SDK's `done` event: we always emit our own terminal
		// `done` in the finally block, after the auto-title `conversation.update`
		// has been pushed. Otherwise clients (which break their stream loop on
		// the first `done`) would miss the title update.
		if (ev.type === 'done') return;

		emit(ev);

		if (ev.type === 'message.start') assistantId = ev.messageId;
		else if (ev.type === 'message.delta') {
			assistantBuf += ev.text;
			// First visible token closes out the reasoning timing window.
			if (reasoningStartedAt !== null && reasoningEndedAt === null) {
				reasoningEndedAt = Date.now();
			}
		} else if (ev.type === 'message.reasoning') {
			if (reasoningStartedAt === null) reasoningStartedAt = Date.now();
			reasoningBuf += ev.text;
		} else if (ev.type === 'tool.call') {
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
		} else if (ev.type === 'context.usage') {
			try {
				usageRepo.upsert(opts.conversationId, {
					currentTokens: ev.currentTokens,
					tokenLimit: ev.tokenLimit,
					messagesLength: ev.messagesLength,
					systemTokens: ev.systemTokens,
					conversationTokens: ev.conversationTokens,
					toolDefinitionsTokens: ev.toolDefinitionsTokens
				});
			} catch (usageErr) {
				log.warn('turn.usage.persist_failed', {
					conversationId: opts.conversationId,
					err: String(usageErr)
				});
			}
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
			let persistedAssistantId: string | null = null;
			try {
				if (
					assistantBuf ||
					assistantId ||
					pendingTools.size ||
					pendingEdits.length ||
					reasoningBuf
				) {
					const durationMs =
						reasoningStartedAt !== null
							? (reasoningEndedAt ?? Date.now()) - reasoningStartedAt
							: null;
					const persisted = messages.append(opts.conversationId, {
						role: 'assistant',
						content: assistantBuf,
						status,
						reasoning: reasoningBuf || null,
						reasoningDurationMs: durationMs
					});
					persistedAssistantId = persisted.id;
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

				// Auto-title: on the first turn of a conversation whose title is
				// still the placeholder, derive a short name from the user's
				// prompt and notify subscribers so the UI can update in place.
				try {
					const conv = convs.get(opts.conversationId, opts.bridge.userId);
					if (conv && isDefaultTitle(conv.title)) {
						const newTitle = deriveTitle(opts.prompt);
						if (newTitle && newTitle !== conv.title) {
							const renamed = convs.rename(opts.conversationId, opts.bridge.userId, newTitle);
							if (renamed) {
								emit({
									type: 'conversation.update',
									conversationId: opts.conversationId,
									title: newTitle
								});
							}
						}
					}
				} catch (titleErr) {
					log.warn('turn.autotitle.failed', {
						conversationId: opts.conversationId,
						err: String(titleErr)
					});
				}
			} catch (persistErr) {
				log.error('turn.persist.failed', {
					conversationId: opts.conversationId,
					err: String(persistErr)
				});
			}

			// Post-turn workdir snapshot, bound to the assistant message
			// id. Used by "fork after this reply" affordances and for
			// post-turn diff views. Non-fatal on failure.
			if (persistedAssistantId) {
				try {
					await takeSnapshot(opts.bridge.workingDirectory, persistedAssistantId, 'post');
				} catch (snapErr) {
					log.warn('snapshot.post.failed', {
						conversationId: opts.conversationId,
						messageId: persistedAssistantId,
						err: String(snapErr)
					});
				}
			}

			turn.status = status === 'interrupted' ? 'interrupted' : 'complete';
			turn.endedAt = Date.now();

			// Make sure subscribers see a terminal event even if the SDK
			// didn't emit `done` (e.g., on abort path).
			if (!eventLog.some((e) => e.type === 'done')) {
				emit({ type: 'done' });
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

async function* subscribe(
	turn: InternalTurn,
	opts: SubscribeOptions = {}
): AsyncIterable<IdentifiedEvent> {
	const { signal, sinceId } = opts;

	// Replay buffered events from (sinceId, end]. `sinceId` is the last id
	// the client successfully received — we resume from sinceId+1. If
	// undefined, send everything from the start.
	// Note: the for-loop reads turn.eventLog.length each iteration, so any
	// events appended by dispatch between yields are picked up before we
	// fall through to the live subscription. No gap, no duplicates.
	const startIdx = sinceId === undefined ? 0 : sinceId + 1;
	for (let i = startIdx; i < turn.eventLog.length; i++) {
		if (signal?.aborted) return;
		yield { id: i, event: turn.eventLog[i] };
	}

	// If the turn already finished, we're done after the replay.
	if (turn.status !== 'running') return;

	// Subscribe to live events. Adding q to `subscribers` is synchronous
	// with the loop exit above (no awaits between them), so dispatch can't
	// slip an event in unobserved.
	const q = new AsyncQueue<IdentifiedEvent>();
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
