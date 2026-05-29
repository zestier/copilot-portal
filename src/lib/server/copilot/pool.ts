// Pool of long-lived per-conversation sessions with idle reaping.

import { loadConfig } from '../config';
import {
	appGlobalSymbols,
	clearGlobalSingletonValues,
	getGlobalSingletonValue,
	getOrCreateGlobalSingleton,
	setGlobalSingletonValue
} from '../global-singleton';
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
const SESSIONS_KEYS = appGlobalSymbols('pool.sessions');
const REAPER_KEYS = appGlobalSymbols('pool.reaper');
type SessionsMap = Map<string, Entry>;
type InflightMap = Map<string, Promise<ProviderSession>>;
const sessions: SessionsMap = getOrCreateGlobalSingleton(
	SESSIONS_KEYS,
	() => new Map<string, Entry>()
);
// In-flight `open()` promises, keyed by conversationId. Concurrent
// acquire() calls for the same conversation share one open(), avoiding
// the TOCTOU between `sessions.get` and `sessions.set` that would
// otherwise leak a second SDK subprocess.
const INFLIGHT_KEYS = appGlobalSymbols('pool.inflight');
const inflight: InflightMap = getOrCreateGlobalSingleton(
	INFLIGHT_KEYS,
	() => new Map<string, Promise<ProviderSession>>()
);
function getReaperTimer(): NodeJS.Timeout | null {
	return getGlobalSingletonValue<NodeJS.Timeout>(REAPER_KEYS);
}
function setReaperTimer(t: NodeJS.Timeout | null) {
	setGlobalSingletonValue(REAPER_KEYS, t);
}

async function disposeSession(
	session: ProviderSession,
	context: { conversationId: string; reason: string }
): Promise<void> {
	try {
		await session.dispose();
	} catch (err) {
		log.warn('copilot.pool.dispose_failed', {
			...context,
			provider: session.provider,
			err: err instanceof Error ? (err.stack ?? err.message) : String(err)
		});
	}
}

export async function acquire(opts: ProviderOpenOptions): Promise<ProviderSession> {
	const existing = sessions.get(opts.conversationId);
	const requestedProvider = opts.provider ?? getDefaultProviderId();
	const requestedProviderSessionId = opts.providerSessionId ?? opts.conversationId;
	if (existing) {
		const cachedProvider = existing.session.provider ?? getDefaultProviderId();
		const cachedProviderSessionId =
			existing.session.providerSessionId ?? existing.session.conversationId;
		if (
			existing.session.workingDirectory === opts.workingDirectory &&
			existing.session.model === opts.model &&
			cachedProviderSessionId === requestedProviderSessionId &&
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
			requestedWorkdir: opts.workingDirectory,
			cachedModel: existing.session.model,
			requestedModel: opts.model,
			cachedProviderSessionId,
			requestedProviderSessionId
		});
		await disposeSession(existing.session, {
			conversationId: opts.conversationId,
			reason: 'session_mismatch'
		});
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
		await disposeSession(oldest.session, { conversationId: oldestId, reason: 'capacity_evict' });
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
	await disposeSession(e.session, { conversationId, reason: 'release' });
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
				await disposeSession(entry.session, { conversationId: id, reason: 'idle_reap' });
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
		clearGlobalSingletonValues(REAPER_KEYS);
	}
	// Wait for any in-flight open() calls to settle (then dispose them
	// like any other live session) so shutdown doesn't race a half-built
	// session into a zombie subprocess.
	const pending = [...inflight.values()];
	inflight.clear();
	const built = await Promise.allSettled(pending);
	for (const r of built) {
		if (r.status === 'fulfilled') {
			await disposeSession(r.value, {
				conversationId: r.value.conversationId,
				reason: 'shutdown_inflight'
			});
		}
	}
	const all = [...sessions.values()];
	sessions.clear();
	await Promise.all(
		all.map((e) =>
			disposeSession(e.session, { conversationId: e.session.conversationId, reason: 'shutdown' })
		)
	);
}
