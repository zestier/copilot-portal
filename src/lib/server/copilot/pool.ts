// Pool of long-lived per-conversation sessions with idle reaping.

import { loadConfig } from '../config';
import { log } from '../log';
import {
	getDefaultProviderId,
	open,
	type ProviderOpenOptions,
	type ProviderSession
} from '../providers';

interface Entry {
	session: ProviderSession;
	lastUsed: number;
}

// Stash on globalThis so Vite HMR re-imports of this module in dev don't
// orphan the live SDK sessions in the old module's closure. See the
// matching comment in turn-runner.ts.
const SESSIONS_KEY = Symbol.for('zap.pool.sessions');
const COMMAND_DECK_SESSIONS_KEY = Symbol.for('command-deck.pool.sessions');
const AGENT_PORTAL_SESSIONS_KEY = Symbol.for('agent-portal.pool.sessions');
const LEGACY_SESSIONS_KEY = Symbol.for('copilot-portal.pool.sessions');
const REAPER_KEY = Symbol.for('zap.pool.reaper');
const COMMAND_DECK_REAPER_KEY = Symbol.for('command-deck.pool.reaper');
const AGENT_PORTAL_REAPER_KEY = Symbol.for('agent-portal.pool.reaper');
const LEGACY_REAPER_KEY = Symbol.for('copilot-portal.pool.reaper');
type SessionsMap = Map<string, Entry>;
type InflightMap = Map<string, Promise<ProviderSession>>;
type GlobalSlot = Record<symbol, unknown>;
const sessions: SessionsMap =
	((globalThis as unknown as GlobalSlot)[SESSIONS_KEY] as SessionsMap | undefined) ??
	((globalThis as unknown as GlobalSlot)[COMMAND_DECK_SESSIONS_KEY] as SessionsMap | undefined) ??
	((globalThis as unknown as GlobalSlot)[AGENT_PORTAL_SESSIONS_KEY] as SessionsMap | undefined) ??
	((globalThis as unknown as GlobalSlot)[LEGACY_SESSIONS_KEY] as SessionsMap | undefined) ??
	(((globalThis as unknown as GlobalSlot)[SESSIONS_KEY] = new Map<string, Entry>()) as SessionsMap);
// In-flight `open()` promises, keyed by conversationId. Concurrent
// acquire() calls for the same conversation share one open(), avoiding
// the TOCTOU between `sessions.get` and `sessions.set` that would
// otherwise leak a second SDK subprocess.
const INFLIGHT_KEY = Symbol.for('zap.pool.inflight');
const COMMAND_DECK_INFLIGHT_KEY = Symbol.for('command-deck.pool.inflight');
const AGENT_PORTAL_INFLIGHT_KEY = Symbol.for('agent-portal.pool.inflight');
const LEGACY_INFLIGHT_KEY = Symbol.for('copilot-portal.pool.inflight');
const inflight: InflightMap =
	((globalThis as unknown as GlobalSlot)[INFLIGHT_KEY] as InflightMap | undefined) ??
	((globalThis as unknown as GlobalSlot)[COMMAND_DECK_INFLIGHT_KEY] as InflightMap | undefined) ??
	((globalThis as unknown as GlobalSlot)[AGENT_PORTAL_INFLIGHT_KEY] as InflightMap | undefined) ??
	((globalThis as unknown as GlobalSlot)[LEGACY_INFLIGHT_KEY] as InflightMap | undefined) ??
	(((globalThis as unknown as GlobalSlot)[INFLIGHT_KEY] = new Map<
		string,
		Promise<ProviderSession>
	>()) as InflightMap);
function getReaperTimer(): NodeJS.Timeout | null {
	return (
		((globalThis as unknown as GlobalSlot)[REAPER_KEY] as NodeJS.Timeout | null | undefined) ??
		((globalThis as unknown as GlobalSlot)[COMMAND_DECK_REAPER_KEY] as
			| NodeJS.Timeout
			| null
			| undefined) ??
		((globalThis as unknown as GlobalSlot)[AGENT_PORTAL_REAPER_KEY] as
			| NodeJS.Timeout
			| null
			| undefined) ??
		((globalThis as unknown as GlobalSlot)[LEGACY_REAPER_KEY] as
			| NodeJS.Timeout
			| null
			| undefined) ??
		null
	);
}
function setReaperTimer(t: NodeJS.Timeout | null) {
	(globalThis as unknown as GlobalSlot)[REAPER_KEY] = t;
}

export async function acquire(opts: ProviderOpenOptions): Promise<ProviderSession> {
	const existing = sessions.get(opts.conversationId);
	const requestedProvider = opts.provider ?? getDefaultProviderId();
	if (existing) {
		const cachedProvider = existing.session.provider ?? getDefaultProviderId();
		if (
			existing.session.workingDirectory === opts.workingDirectory &&
			cachedProvider === requestedProvider
		) {
			existing.lastUsed = Date.now();
			return existing.session;
		}
		log.warn('copilot.pool.session_mismatch_recreate', {
			conversationId: opts.conversationId,
			cachedProvider,
			requestedProvider,
			cachedWorkdir: existing.session.workingDirectory,
			requestedWorkdir: opts.workingDirectory
		});
		await existing.session.dispose().catch(() => undefined);
		sessions.delete(opts.conversationId);
	}
	// Coalesce concurrent acquires for the same conversation. Without
	// this, two callers can both miss the cache, both await open(), and
	// the loser's session is orphaned (its subprocess stays alive but
	// nothing references it).
	const pending = inflight.get(opts.conversationId);
	if (pending) return pending;
	const cfg = loadConfig();
	if (sessions.size >= cfg.MAX_CONCURRENT_SESSIONS) {
		// Reap the oldest idle session if we can.
		const sorted = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const [oldestId, oldest] = sorted[0];
		log.info('copilot.pool.evict', { conversationId: oldestId });
		await oldest.session.dispose().catch(() => undefined);
		sessions.delete(oldestId);
	}
	const openPromise = open(opts).then(
		(session) => {
			sessions.set(opts.conversationId, { session, lastUsed: Date.now() });
			inflight.delete(opts.conversationId);
			return session;
		},
		(err) => {
			inflight.delete(opts.conversationId);
			throw err;
		}
	);
	inflight.set(opts.conversationId, openPromise);
	return openPromise;
}

/**
 * Return the live session for a conversation iff one is currently cached.
 * Used by the /session PATCH endpoint to push mode/approve-all changes to a
 * running SDK session without spinning a fresh one (which would require
 * an auth token, working directory, etc. the endpoint doesn't have at hand).
 */
export function getActive(conversationId: string): ProviderSession | null {
	return sessions.get(conversationId)?.session ?? null;
}

export function touch(conversationId: string) {
	const e = sessions.get(conversationId);
	if (e) e.lastUsed = Date.now();
}

export async function release(conversationId: string) {
	const e = sessions.get(conversationId);
	if (!e) return;
	sessions.delete(conversationId);
	await e.session.dispose().catch(() => undefined);
}

export function startIdleReaper() {
	if (getReaperTimer()) return;
	const cfg = loadConfig();
	const idleMs = cfg.IDLE_TIMEOUT_MIN * 60_000;
	const timer = setInterval(async () => {
		const now = Date.now();
		for (const [id, entry] of sessions) {
			if (now - entry.lastUsed > idleMs) {
				log.info('copilot.pool.reap', { conversationId: id });
				sessions.delete(id);
				await entry.session.dispose().catch(() => undefined);
			}
		}
	}, 60_000);
	timer.unref?.();
	setReaperTimer(timer);
}

export async function shutdown() {
	const timer = getReaperTimer();
	if (timer) {
		clearInterval(timer);
		setReaperTimer(null);
	}
	// Wait for any in-flight open() calls to settle (then dispose them
	// like any other live session) so shutdown doesn't race a half-built
	// session into a zombie subprocess.
	const pending = [...inflight.values()];
	inflight.clear();
	const built = await Promise.allSettled(pending);
	for (const r of built) {
		if (r.status === 'fulfilled') {
			await r.value.dispose().catch(() => undefined);
		}
	}
	const all = [...sessions.values()];
	sessions.clear();
	await Promise.all(all.map((e) => e.session.dispose().catch(() => undefined)));
}
