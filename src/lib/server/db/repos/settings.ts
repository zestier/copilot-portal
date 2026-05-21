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
//
// Schema is `permission_grants(user_id, conversation_id, tool,
// permission_kind, scope_pattern, decision, expires_at, granted_at)`
// after migration 009. `conversation_id` NULL means a user-global grant.
// All the matching precedence (deny beats allow, expiry, wildcards) lives
// in the pure matcher module so it's testable without a DB.

import {
	matchGrants,
	type GrantDecision,
	type GrantRow,
	type MatchOutcome
} from '../../permissions/matcher';

interface GrantDbRow {
	user_id: string;
	conversation_id: string | null;
	tool: string;
	permission_kind: string | null;
	scope_pattern: string | null;
	decision: string;
	expires_at: number | null;
	granted_at: number;
}

function dbRowToGrant(r: GrantDbRow): GrantRow {
	return {
		tool: r.tool,
		permissionKind: r.permission_kind,
		scopePattern: r.scope_pattern,
		decision: r.decision === 'deny' ? 'deny' : 'allow',
		expiresAt: r.expires_at,
		conversationId: r.conversation_id
	};
}

/**
 * Pre-filter at the SQL level: return every grant for this user that
 * could possibly apply to (conversationId, tool). Filtering by kind /
 * pattern / expiry happens in app code so the matcher stays pure and
 * testable.
 */
function loadCandidateGrants(userId: string, conversationId: string, tool: string): GrantRow[] {
	const rows = getDb()
		.prepare(
			`SELECT user_id, conversation_id, tool, permission_kind, scope_pattern,
			        decision, expires_at, granted_at
			 FROM permission_grants
			 WHERE user_id = ?
			   AND (conversation_id = ? OR conversation_id IS NULL)
			   AND (tool = ? OR tool = '*')`
		)
		.all(userId, conversationId, tool) as GrantDbRow[];
	return rows.map(dbRowToGrant);
}

/**
 * Resolve a permission request against the user's stored grants.
 * Returns 'allow' / 'deny' / 'none'; callers fall back to the policy
 * table when 'none'.
 */
export function matchGrant(
	userId: string,
	conversationId: string,
	tool: string,
	permissionKind: string,
	scopeKey: string | null,
	now: number = Date.now()
): MatchOutcome {
	const rows = loadCandidateGrants(userId, conversationId, tool);
	return matchGrants(rows, { tool, permissionKind, scopeKey, now });
}

/**
 * @deprecated Backwards-compat wrapper. Returns true iff a wildcard
 * "allow this tool for anything" grant exists. New code should call
 * `matchGrant` with the runtime kind + scopeKey.
 */
export function hasGrant(userId: string, conversationId: string, tool: string): boolean {
	// Legacy callers don't know about kinds/patterns; pretend the request
	// is for whatever the grant covers by passing a wildcard scope.
	return matchGrant(userId, conversationId, tool, '*', null) === 'allow';
}

export interface AddGrantOptions {
	userId: string;
	/** NULL = user-global. */
	conversationId: string | null;
	tool: string;
	/** NULL = any kind. */
	permissionKind?: string | null;
	/** NULL = any scope. */
	scopePattern?: string | null;
	decision?: GrantDecision;
	/** Unix ms; NULL/undefined = never expires. */
	expiresAt?: number | null;
}

export function addGrant(opts: AddGrantOptions) {
	getDb()
		.prepare(
			`INSERT INTO permission_grants(
			   user_id, conversation_id, tool, permission_kind,
			   scope_pattern, decision, expires_at, granted_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.userId,
			opts.conversationId,
			opts.tool,
			opts.permissionKind ?? null,
			opts.scopePattern ?? null,
			opts.decision ?? 'allow',
			opts.expiresAt ?? null,
			Date.now()
		);
}

export interface GrantSummary {
	id: number;
	conversationId: string | null;
	conversationTitle: string | null;
	tool: string;
	permissionKind: string | null;
	scopePattern: string | null;
	decision: GrantDecision;
	expiresAt: number | null;
	grantedAt: number;
}

/**
 * Every grant the user owns, oldest expiry / newest grant first. Joins
 * `conversations` so the UI can show "in <title>" for conversation-scoped
 * rows; user-global rows return `conversationTitle = null`.
 *
 * Uses SQLite's implicit `rowid` as a stable per-row id for revocation
 * (the table has no other unique key — two identical-shape grants are
 * legal, just redundant).
 */
export function listGrantsForUser(userId: string): GrantSummary[] {
	const rows = getDb()
		.prepare(
			`SELECT pg.rowid AS id, pg.conversation_id, c.title AS conversation_title,
			        pg.tool, pg.permission_kind, pg.scope_pattern, pg.decision,
			        pg.expires_at, pg.granted_at
			 FROM permission_grants pg
			 LEFT JOIN conversations c ON c.id = pg.conversation_id
			 WHERE pg.user_id = ?
			 ORDER BY pg.granted_at DESC, pg.rowid DESC`
		)
		.all(userId) as Array<{
		id: number;
		conversation_id: string | null;
		conversation_title: string | null;
		tool: string;
		permission_kind: string | null;
		scope_pattern: string | null;
		decision: string;
		expires_at: number | null;
		granted_at: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		conversationId: r.conversation_id,
		conversationTitle: r.conversation_title,
		tool: r.tool,
		permissionKind: r.permission_kind,
		scopePattern: r.scope_pattern,
		decision: r.decision === 'deny' ? 'deny' : 'allow',
		expiresAt: r.expires_at,
		grantedAt: r.granted_at
	}));
}

/**
 * Delete a single grant by rowid. Scoped to `userId` so users can only
 * revoke their own. Returns true iff a row was removed.
 */
export function revokeGrant(userId: string, id: number): boolean {
	const r = getDb()
		.prepare(`DELETE FROM permission_grants WHERE rowid = ? AND user_id = ?`)
		.run(id, userId);
	return r.changes > 0;
}

/**
 * Drop grants past their TTL. The matcher already ignores expired rows at
 * read time, so this is purely housekeeping — keeping the settings page
 * from accumulating dead rows.
 */
export function pruneExpiredGrants(now: number = Date.now()): number {
	const r = getDb()
		.prepare(`DELETE FROM permission_grants WHERE expires_at IS NOT NULL AND expires_at < ?`)
		.run(now);
	return r.changes;
}

export function recordDecision(
	conversationId: string,
	tool: string,
	argsSummary: string,
	decision: 'allow-once' | 'allow-always' | 'deny' | 'deny-always'
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
	decision: 'allow-once' | 'allow-always' | 'deny' | 'deny-always';
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
		decision: r.decision as PermissionDecisionRecord['decision'],
		decidedAt: r.decided_at
	}));
}
