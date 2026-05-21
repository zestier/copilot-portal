import { ulid } from '../ids';
import { getDb } from '../index';
import type { UserSettings, PermissionPolicy } from '$lib/types';

interface SettingsRow {
	user_id: string;
	default_model: string | null;
	default_workdir: string | null;
	default_policy: string;
	theme: string;
	updated_at: number;
}

function rowToSettings(r: SettingsRow): UserSettings {
	const raw = r.default_policy;
	// Migration 008 rewrites 'allow-readonly' → 'prompt', but be defensive
	// against any straggler rows (e.g., a connection that opened before the
	// migration ran in dev HMR).
	const policy: PermissionPolicy = raw === 'allow-all' || raw === 'deny-all' ? raw : 'prompt';
	return {
		defaultModel: r.default_model,
		defaultWorkdir: r.default_workdir,
		defaultPolicy: policy,
		theme: r.theme === 'light' ? 'light' : r.theme === 'system' ? 'system' : 'dark'
	};
}

export function get(userId: string): UserSettings | null {
	const r = getDb().prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as
		| SettingsRow
		| undefined;
	return r ? rowToSettings(r) : null;
}

/**
 * Default settings for users who have never saved a preference. Callers
 * typically use `settings.get(userId) ?? settings.defaults()` rather than
 * a synthetic-default `getOrDefault` (per the repo convention: `getX → X | null`).
 */
export function defaults(): UserSettings {
	return {
		defaultModel: null,
		defaultWorkdir: null,
		defaultPolicy: 'prompt',
		theme: 'system'
	};
}

export function save(userId: string, s: UserSettings) {
	getDb()
		.prepare(
			`INSERT INTO user_settings(user_id, default_model, default_workdir, default_policy, theme, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   default_model = excluded.default_model,
			   default_workdir = excluded.default_workdir,
			   default_policy = excluded.default_policy,
			   theme = excluded.theme,
			   updated_at = excluded.updated_at`
		)
		.run(userId, s.defaultModel, s.defaultWorkdir, s.defaultPolicy, s.theme, Date.now());
}

// --- Permission grants ---

export function hasGrant(userId: string, conversationId: string, tool: string): boolean {
	const db = getDb();
	const r1 = db
		.prepare(
			'SELECT 1 FROM permission_grants WHERE user_id = ? AND conversation_id = ? AND (tool = ? OR tool = ?)'
		)
		.get(userId, conversationId, tool, '*');
	if (r1) return true;
	const r2 = db
		.prepare(
			'SELECT 1 FROM permission_grants WHERE user_id = ? AND conversation_id IS NULL AND (tool = ? OR tool = ?)'
		)
		.get(userId, tool, '*');
	return !!r2;
}

export function addGrant(userId: string, conversationId: string | null, tool: string) {
	getDb()
		.prepare(
			`INSERT OR IGNORE INTO permission_grants(user_id, conversation_id, tool, granted_at)
			 VALUES (?, ?, ?, ?)`
		)
		.run(userId, conversationId, tool, Date.now());
}

export function recordDecision(
	conversationId: string,
	tool: string,
	argsSummary: string,
	decision: 'allow-once' | 'allow-always' | 'deny'
) {
	const id = ulid();
	getDb()
		.prepare(
			`INSERT INTO permission_decisions(id, conversation_id, tool, args_summary, decision, decided_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(id, conversationId, tool, argsSummary, decision, Date.now());
}

export interface PermissionDecisionRecord {
	id: string;
	conversationId: string;
	conversationTitle: string | null;
	tool: string;
	argsSummary: string | null;
	decision: 'allow-once' | 'allow-always' | 'deny';
	decidedAt: number;
}

/**
 * Most recent permission decisions across all conversations owned by
 * `userId`. Used by the settings page audit panel so users can see what
 * tools they've been approving (or denying) without spelunking SQLite.
 */
export function listRecentDecisionsForUser(userId: string, limit = 50): PermissionDecisionRecord[] {
	const rows = getDb()
		.prepare(
			`SELECT pd.id, pd.conversation_id, c.title AS conversation_title,
			        pd.tool, pd.args_summary, pd.decision, pd.decided_at
			 FROM permission_decisions pd
			 JOIN conversations c ON c.id = pd.conversation_id
			 WHERE c.user_id = ?
			 ORDER BY pd.decided_at DESC, pd.id DESC
			 LIMIT ?`
		)
		.all(userId, limit) as Array<{
		id: string;
		conversation_id: string;
		conversation_title: string | null;
		tool: string;
		args_summary: string | null;
		decision: string;
		decided_at: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		conversationId: r.conversation_id,
		conversationTitle: r.conversation_title,
		tool: r.tool,
		argsSummary: r.args_summary,
		decision: r.decision as 'allow-once' | 'allow-always' | 'deny',
		decidedAt: r.decided_at
	}));
}
