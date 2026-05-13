// Pool of long-lived per-conversation sessions with idle reaping.

import { loadConfig } from '../config';
import { log } from '../log';
import { open, type BridgeOpenOptions, type ConversationSession } from './bridge';

interface Entry {
	session: ConversationSession;
	lastUsed: number;
}

// Stash on globalThis so Vite HMR re-imports of this module in dev don't
// orphan the live SDK sessions in the old module's closure. See the
// matching comment in turn-runner.ts.
const SESSIONS_KEY = Symbol.for('copilot-portal.pool.sessions');
const REAPER_KEY = Symbol.for('copilot-portal.pool.reaper');
type SessionsMap = Map<string, Entry>;
type GlobalSlot = Record<symbol, unknown>;
const sessions: SessionsMap =
	((globalThis as unknown as GlobalSlot)[SESSIONS_KEY] as SessionsMap | undefined) ??
	(((globalThis as unknown as GlobalSlot)[SESSIONS_KEY] = new Map<string, Entry>()) as SessionsMap);
function getReaperTimer(): NodeJS.Timeout | null {
	return ((globalThis as unknown as GlobalSlot)[REAPER_KEY] as NodeJS.Timeout | null) ?? null;
}
function setReaperTimer(t: NodeJS.Timeout | null) {
	(globalThis as unknown as GlobalSlot)[REAPER_KEY] = t;
}

export async function acquire(opts: BridgeOpenOptions): Promise<ConversationSession> {
	const existing = sessions.get(opts.conversationId);
	if (existing) {
		existing.lastUsed = Date.now();
		return existing.session;
	}
	const cfg = loadConfig();
	if (sessions.size >= cfg.MAX_CONCURRENT_SESSIONS) {
		// Reap the oldest idle session if we can.
		const sorted = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const [oldestId, oldest] = sorted[0];
		log.info('copilot.pool.evict', { conversationId: oldestId });
		await oldest.session.dispose().catch(() => undefined);
		sessions.delete(oldestId);
	}
	const session = await open(opts);
	sessions.set(opts.conversationId, { session, lastUsed: Date.now() });
	return session;
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
	const all = [...sessions.values()];
	sessions.clear();
	await Promise.all(all.map((e) => e.session.dispose().catch(() => undefined)));
}
