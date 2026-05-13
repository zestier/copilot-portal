// Pool of long-lived per-conversation sessions with idle reaping.

import { loadConfig } from '../config';
import { log } from '../log';
import { open, type BridgeOpenOptions, type ConversationSession } from './bridge';

interface Entry {
	session: ConversationSession;
	lastUsed: number;
}

const sessions = new Map<string, Entry>();
let reaperTimer: NodeJS.Timeout | null = null;

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
	if (reaperTimer) return;
	const cfg = loadConfig();
	const idleMs = cfg.IDLE_TIMEOUT_MIN * 60_000;
	reaperTimer = setInterval(async () => {
		const now = Date.now();
		for (const [id, entry] of sessions) {
			if (now - entry.lastUsed > idleMs) {
				log.info('copilot.pool.reap', { conversationId: id });
				sessions.delete(id);
				await entry.session.dispose().catch(() => undefined);
			}
		}
	}, 60_000);
	reaperTimer.unref?.();
}

export async function shutdown() {
	if (reaperTimer) {
		clearInterval(reaperTimer);
		reaperTimer = null;
	}
	const all = [...sessions.values()];
	sessions.clear();
	await Promise.all(all.map((e) => e.session.dispose().catch(() => undefined)));
}
