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
import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../global-singleton';
import * as messages from '../db/repos/messages';
import * as convs from '../db/repos/conversations';
import * as memoryRepo from '../db/repos/memory';
import * as usageRepo from '../db/repos/usage';
import * as pool from './pool';
import * as interactiveRequests from './interactive-requests';
import { scheduleHarvest, waitForPendingHarvest } from './memory-harvester';
import { buildMemoryBlockFromRows, buildPortalPrelude } from './portal-prelude';
import {
	memorySupportsHarvester,
	memorySupportsInjector,
	type MemoryContextRecord,
	type MemoryHarvestRecord,
	type PortalEvent
} from '$lib/types';
import { isStubMode } from './bridge-stub';
import { AsyncQueue } from '../runtime/async-queue';
import { snapshot as takeSnapshot } from '../snapshots';
import type { ProviderOpenOptions } from '../providers';

interface PendingTool {
	toolCallId: string;
	tool: string;
	argsJson: string;
	resultJson: string | null;
	status: 'pending' | 'ok' | 'error';
	startedAt: number;
	endedAt: number | null;
	textOffset: number | null;
	parentToolCallId: string | null;
}

interface PendingReasoning {
	id: string;
	segmentIndex: number;
	text: string;
	textOffset: number | null;
	startedAt: number;
	durationMs: number | null;
	parentToolCallId: string | null;
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
const TURNS_KEYS = appGlobalSymbols('turns');
type TurnRegistry = Map<string, InternalTurn>;
const turns: TurnRegistry = getOrCreateGlobalSingleton(TURNS_KEYS, () => new Map());

// Background turns run independently of the user-facing turn slot above:
// the post-turn memory harvester drives one so its pending ->
// applied/empty/failed transition streams live without occupying the
// conversation's single primary slot (which would block the user's next
// message). Kept in a separate registry, but reuses the same event-log /
// fan-out / replay machinery and the same stream endpoint.
const BG_TURNS_KEYS = appGlobalSymbols('turns.background');
const backgroundTurns: TurnRegistry = getOrCreateGlobalSingleton(BG_TURNS_KEYS, () => new Map());

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
// if a new turn replaced the registry slot. Checks the primary registry
// first, then the background registry, so a single stream URL shape can
// serve both kinds of turn.
export function getTurnById(conversationId: string, turnId: string): Turn | null {
	const t = turns.get(conversationId);
	if (t && t.id === turnId) return t;
	const bg = backgroundTurns.get(conversationId);
	return bg && bg.id === turnId ? bg : null;
}

// The currently-running background turn for a conversation, if any. Used by
// page load / conversation GET so a reload mid-harvest can reattach its
// stream (mirrors getTurn for the primary slot).
export function getBackgroundTurn(conversationId: string): Turn | null {
	const t = backgroundTurns.get(conversationId);
	return t && t.status === 'running' ? t : null;
}

// Append an event to a turn's log and fan it out to live subscribers with
// its monotonic id (= index in the log). All paths that surface an event
// MUST go through here so ids stay contiguous and aligned with the replay
// buffer. Live-only events (per-tool partial output, progress) fan out but
// are not logged: reconnects don't replay them; the authoritative final
// state comes from `tool.result`.
function emitTo(turn: InternalTurn, ev: PortalEvent) {
	if (ev.type === 'tool.partial_output' || ev.type === 'tool.progress') {
		const wrapped: IdentifiedEvent = { id: -1, event: ev };
		for (const q of turn.subscribers) q.push(wrapped);
		return;
	}
	const id = turn.eventLog.length;
	turn.eventLog.push(ev);
	const wrapped: IdentifiedEvent = { id, event: ev };
	for (const q of turn.subscribers) q.push(wrapped);
}

// Evict a finished turn from its registry after a grace window so a
// slightly-late subscriber can still replay it.
function scheduleEviction(registry: TurnRegistry, conversationId: string, turn: InternalTurn) {
	const t = setTimeout(() => {
		if (registry.get(conversationId) === turn) registry.delete(conversationId);
	}, FINISHED_GRACE_MS);
	(t as { unref?: () => void }).unref?.();
}

// A minimal event sink the harvester drives to stream its progress on a
// dedicated background turn. `emit` surfaces a `memory.harvest` record;
// `finish` ends the stream with a terminal `done`.
export interface HarvestSink {
	turnId: string;
	emit(record: MemoryHarvestRecord): void;
	finish(): void;
	// Tear down a sink that was created speculatively but won't be used
	// (e.g. the harvester declined to run), without emitting anything.
	discard(): void;
}

// Create and register a background turn for a conversation, returning a sink
// the harvester emits through. Replaces any prior background turn in the
// slot (the previous one has already finished; the harvest chain serializes
// passes per conversation).
export function createBackgroundHarvestTurn(
	conversationId: string,
	messageId: string
): HarvestSink {
	const eventLog: PortalEvent[] = [];
	const subscribers = new Set<AsyncQueue<IdentifiedEvent>>();
	const turn: InternalTurn = {
		id: ulid(),
		conversationId,
		startedAt: Date.now(),
		endedAt: null,
		status: 'running',
		eventLog,
		subscribers,
		finishedPromise: Promise.resolve(),
		subscribe(subOpts?: SubscribeOptions) {
			return subscribe(turn, subOpts);
		},
		async abort() {
			/* background turns are not user-abortable */
		}
	};
	backgroundTurns.set(conversationId, turn);
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		turn.status = 'complete';
		turn.endedAt = Date.now();
		if (!eventLog.some((e) => e.type === 'done')) emitTo(turn, { type: 'done' });
		for (const q of subscribers) q.end();
		subscribers.clear();
		scheduleEviction(backgroundTurns, conversationId, turn);
	};
	return {
		turnId: turn.id,
		emit: (record: MemoryHarvestRecord) =>
			emitTo(turn, { type: 'memory.harvest', messageId, harvest: record }),
		finish,
		discard: () => {
			finished = true;
			if (backgroundTurns.get(conversationId) === turn) backgroundTurns.delete(conversationId);
			for (const q of subscribers) q.end();
			subscribers.clear();
		}
	};
}

export interface StartTurnOptions {
	bridge: ProviderOpenOptions;
	prompt: string;
	conversationId: string;
	beforeSend?: () => Promise<void>;
	initialEvents?: PortalEvent[];
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

	const eventLog: PortalEvent[] = [];
	const subscribers = new Set<AsyncQueue<IdentifiedEvent>>();
	const turnAc = new AbortController();
	let session: Awaited<ReturnType<typeof pool.acquire>> | null = null;

	// Append an event to the log and fan it out to live subscribers (see
	// `emitTo`). All paths that need to surface an event for this turn MUST
	// go through here so ids stay contiguous and aligned with the replay
	// buffer.
	function emit(ev: PortalEvent) {
		emitTo(turn, ev);
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
			interactiveRequests.cancelConversation(opts.conversationId, 'turn_aborted');
			try {
				await session?.abort();
			} catch {
				/* ignore */
			}
		}
	};

	turns.set(opts.conversationId, turn);
	for (const ev of opts.initialEvents ?? []) emit(ev);

	// Accumulators for persistence.
	let assistantBuf = '';
	let assistantId: string | null = null;
	let persistedAssistantId: string | null = null;
	const pendingTools = new Map<string, PendingTool>();
	// Reasoning segments keyed by the segmentId minted in the bridge. Order
	// of insertion matches stream order, which is what we persist.
	const pendingReasoning = new Map<string, PendingReasoning>();
	const persistedFileEditKeys = new Set<string>();
	let nextReasoningIndex = 0;

	function ensurePersistedAssistant(): string {
		if (persistedAssistantId) return persistedAssistantId;
		const persisted = messages.append(opts.conversationId, {
			role: 'assistant',
			content: assistantBuf,
			status: 'streaming'
		});
		persistedAssistantId = persisted.id;
		return persisted.id;
	}

	function dispatch(ev: PortalEvent) {
		// Suppress the SDK's `done` event: we always emit our own terminal
		// `done` in the finally block after persistence work completes.
		if (ev.type === 'done') return;

		if (ev.type === 'message.start') {
			const id = ensurePersistedAssistant();
			emit({
				...ev,
				messageId: id,
				memoryContextEnabled,
				memoryContext: memoryContextForMessage(id)
			});
			assistantId = ev.messageId;
		} else if (ev.type === 'message.delta') {
			const id = ensurePersistedAssistant();
			emit({ ...ev, messageId: id });
			assistantBuf += ev.text;
			messages.updateContentOnly(id, assistantBuf);
		} else if (ev.type === 'message.reasoning') {
			const persistedId = ensurePersistedAssistant();
			emit({ ...ev, messageId: persistedId });
			let seg = pendingReasoning.get(ev.segmentId);
			if (!seg) {
				const isChild = !!ev.parentToolCallId;
				seg = {
					id: ev.segmentId,
					segmentIndex: nextReasoningIndex++,
					text: '',
					// Child reasoning isn't anchored to the outer assistant text;
					// it's rendered inside the SubagentCall card instead.
					textOffset: isChild ? null : assistantBuf.length,
					startedAt: Date.now(),
					durationMs: null,
					parentToolCallId: ev.parentToolCallId ?? null
				};
				pendingReasoning.set(ev.segmentId, seg);
			}
			seg.text += ev.text;
			messages.upsertReasoningBlock(persistedId, seg);
		} else if (ev.type === 'message.reasoning.end') {
			const persistedId = ensurePersistedAssistant();
			emit({ ...ev, messageId: persistedId });
			const seg = pendingReasoning.get(ev.segmentId);
			if (seg) {
				seg.durationMs = ev.durationMs;
				messages.upsertReasoningBlock(persistedId, seg);
			}
		} else if (ev.type === 'message.end') {
			emit({ ...ev, messageId: ensurePersistedAssistant() });
		} else if (ev.type === 'tool.call') {
			emit(ev);
			const isChild = !!ev.parentToolCallId;
			const persistedId = ensurePersistedAssistant();
			const tool: PendingTool = {
				toolCallId: ev.toolCallId,
				tool: ev.tool,
				argsJson: safeJson(ev.args),
				resultJson: null,
				status: 'pending',
				startedAt: Date.now(),
				endedAt: null,
				textOffset: isChild ? null : assistantBuf.length,
				parentToolCallId: ev.parentToolCallId ?? null
			};
			pendingTools.set(ev.toolCallId, tool);
			messages.upsertToolCall(persistedId, {
				id: tool.toolCallId,
				tool: tool.tool,
				argsJson: tool.argsJson,
				resultJson: tool.resultJson,
				status: tool.status,
				startedAt: tool.startedAt,
				endedAt: tool.endedAt,
				textOffset: tool.textOffset,
				parentToolCallId: tool.parentToolCallId
			});
		} else if (ev.type === 'tool.result') {
			emit(ev);
			const tc = pendingTools.get(ev.toolCallId);
			if (tc) {
				tc.status = ev.ok ? 'ok' : 'error';
				tc.resultJson = safeJson(ev.output ?? ev.summary);
				tc.endedAt = Date.now();
				messages.updateToolCall(ev.toolCallId, {
					status: tc.status,
					resultJson: tc.resultJson,
					endedAt: tc.endedAt
				});
			}
		} else if (ev.type === 'subagent.lifecycle') {
			emit(ev);
			messages.updateBackgroundAgentLifecycle(ev.toolCallId, ev.agentId, ev.status);
		} else if (ev.type === 'file.edit') {
			emit(ev);
			const isChild = !!ev.parentToolCallId;
			const textOffset = isChild ? null : assistantBuf.length;
			const parentToolCallId = ev.parentToolCallId ?? null;
			const key = JSON.stringify([ev.path, ev.diff, textOffset, parentToolCallId]);
			if (!persistedFileEditKeys.has(key)) {
				persistedFileEditKeys.add(key);
				messages.insertFileEdit(
					ensurePersistedAssistant(),
					ev.path,
					ev.diff,
					textOffset,
					parentToolCallId
				);
			}
		} else if (ev.type === 'context.usage') {
			emit(ev);
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
		} else {
			emit(ev);
		}
	}

	// Prepend a portal-context block telling the agent it's running through
	// a permission gateway and that reject `feedback` is authoritative.
	// The user's message itself is preserved verbatim after the block;
	// this only changes what the agent sees, not what we persist (the raw
	// user content was already stored by the turns route before we got
	// here).
	//
	// Skip in stub mode: the deterministic test stub echoes whatever it
	// receives, so dumping the prelude into its reply breaks tests that
	// assert on the literal user prompt and wastes tokens against a
	// fixed-string responder that wouldn't act on the guidance anyway.
	const prelude = isStubMode() ? '' : buildPortalPrelude(opts.bridge.memoryLevel);
	const memoryContextEnabled = !isStubMode() && memorySupportsInjector(opts.bridge.memoryLevel);
	// The injected memory digest and final prompt are built inside the turn
	// body (below), after any in-progress background harvest from the prior
	// turn settles, so the model sees the harvested memory state instead of
	// racing it. `memoryContextInputs` and `promptToSend` are populated there
	// before the provider session is sent to.
	let memoryContextInputs: messages.MemoryContextInput[] = [];
	const memoryContextForMessage = (messageId: string): MemoryContextRecord[] =>
		memoryContextInputs.map((row, sortIndex) => ({
			messageId,
			...row,
			sortIndex
		}));
	let promptToSend = opts.prompt;

	turn.finishedPromise = (async () => {
		try {
			await opts.beforeSend?.();
			// Gate on any in-progress background memory harvest from the prior
			// turn so the injected digest reflects the harvested memory state
			// and the prior turn's snapshot has settled before we mutate again.
			await waitForPendingHarvest(opts.conversationId);
			let injectedMemoryRows: memoryRepo.MemoryRow[] = [];
			if (memoryContextEnabled) {
				injectedMemoryRows = memoryRepo.getActiveDigest(
					opts.bridge.userId,
					opts.conversationId,
					4000
				);
				memoryContextInputs = injectedMemoryRows.map((row) => ({
					memoryId: row.id,
					scope: row.scope,
					kind: row.kind,
					entity: row.entity,
					content: row.content,
					tags: row.tags,
					importance: row.importance
				}));
			}
			const memoryBlock =
				injectedMemoryRows.length === 0
					? ''
					: buildMemoryBlockFromRows(
							injectedMemoryRows,
							memoryRepo.currentScene(opts.bridge.userId, opts.conversationId)
						);
			promptToSend = [prelude, memoryBlock, opts.prompt].filter(Boolean).join('\n\n');
			session = await pool.acquire(opts.bridge);
			if (turnAc.signal.aborted) {
				await session.abort();
				return;
			}
			for await (const ev of session.send(promptToSend, turnAc.signal)) {
				dispatch(ev);
			}
		} catch (e) {
			if (turnAc.signal.aborted) return;
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

			try {
				if (persistedAssistantId || assistantBuf || assistantId || pendingTools.size) {
					const id = ensurePersistedAssistant();
					messages.updateContent(id, assistantBuf, status);
					if (memoryContextEnabled) {
						messages.replaceMemoryContext(id, memoryContextInputs);
					}
					for (const t of pendingTools.values()) {
						if (t.status === 'pending') {
							t.status = 'error';
							t.endedAt = Date.now();
							messages.updateToolCall(t.toolCallId, {
								resultJson: t.resultJson,
								status: t.status,
								endedAt: t.endedAt
							});
						}
					}
				}
				convs.touch(opts.conversationId);
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
			const takeMemorySnapshot = () => {
				if (!persistedAssistantId) return;
				try {
					memoryRepo.snapshotForMessage(
						opts.bridge.userId,
						opts.conversationId,
						persistedAssistantId
					);
				} catch (snapshotErr) {
					log.warn('memory.snapshot.failed', {
						conversationId: opts.conversationId,
						messageId: persistedAssistantId,
						err: String(snapshotErr)
					});
				}
			};

			// Schedule the post-turn harvester as a true background pass on its
			// own background turn: we do NOT await it, so the visible turn
			// completes immediately. The harvester emits its `memory.harvest`
			// updates and a terminal `done` on that background turn, which the
			// client opens as a second stream (announced via the
			// `memory.harvest.started` event below) so the live pending ->
			// applied/empty/failed transition is visible without blocking. The
			// memory-bank snapshot for this message is taken once the harvest
			// settles (onSettled) so it captures the harvested state, and the
			// next turn's memory injection waits on the harvest chain via
			// waitForPendingHarvest(). When no harvester runs, the snapshot is
			// taken inline below.
			let snapshotDeferredToHarvester = false;
			let harvestTurnId: string | null = null;
			if (
				persistedAssistantId &&
				status === 'complete' &&
				assistantBuf.trim() &&
				memorySupportsHarvester(opts.bridge.memoryLevel)
			) {
				const harvestMessageId = persistedAssistantId;
				if (!eventLog.some((e) => e.type === 'message.end' && e.messageId === harvestMessageId)) {
					emit({ type: 'message.end', messageId: harvestMessageId });
				}
				const sink = createBackgroundHarvestTurn(opts.conversationId, harvestMessageId);
				const harvest = scheduleHarvest({
					bridge: opts.bridge,
					assistantMessageId: harvestMessageId,
					userPrompt: opts.prompt,
					assistantReply: assistantBuf,
					onUpdate: (record) => sink.emit(record),
					// Snapshot post-harvest state, then close the background
					// turn's stream. Runs once the harvest settles (applied,
					// empty, skipped, or failed) and its writes are committed.
					onSettled: () => {
						takeMemorySnapshot();
						sink.finish();
					}
				});
				if (harvest) {
					snapshotDeferredToHarvester = true;
					harvestTurnId = sink.turnId;
				} else {
					// Harvester declined to run (e.g. stub mode): drop the
					// speculative background turn without announcing it.
					sink.discard();
				}
			}
			if (persistedAssistantId && status === 'complete' && !snapshotDeferredToHarvester) {
				takeMemorySnapshot();
			}

			turn.status = status === 'interrupted' ? 'interrupted' : 'complete';
			turn.endedAt = Date.now();

			// Announce the background harvest turn before the terminal `done`
			// so the client can open its stream as this one closes.
			if (harvestTurnId && persistedAssistantId) {
				emit({
					type: 'memory.harvest.started',
					messageId: persistedAssistantId,
					harvestTurnId
				});
			}

			// Make sure subscribers see a terminal event even if the SDK
			// didn't emit `done` (e.g., on abort path).
			if (!eventLog.some((e) => e.type === 'done')) {
				emit({ type: 'done' });
			}
			for (const q of subscribers) q.end();
			subscribers.clear();

			// Keep the finished turn around briefly so that a subscriber that
			// races with completion still gets the full replay.
			scheduleEviction(turns, opts.conversationId, turn);
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
