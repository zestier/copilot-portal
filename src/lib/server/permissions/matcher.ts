// Pure helpers for the permission-grant matcher. SQL lives in the
// settings repo; this module only knows about pattern shapes and
// precedence rules so it can be exercised by unit tests without a DB.

export type GrantDecision = 'allow' | 'deny';
export type MatchOutcome = 'allow' | 'deny' | 'none';

export interface GrantRow {
	tool: string;
	permissionKind: string | null;
	scopePattern: string | null;
	decision: GrantDecision;
	expiresAt: number | null;
	/**
	 * NULL = user-global grant. Used by callers that mix conversation-scoped
	 * and user-global rows; matchGrants does not itself filter on this.
	 */
	conversationId: string | null;
}

export interface MatchQuery {
	tool: string;
	permissionKind: string;
	/** The runtime scope to test the pattern against (e.g. `git status`,
	 * `./src/foo.ts`, `https://api.github.com/...`). NULL when the caller
	 * couldn't derive one; only wildcard grants will match. */
	scopeKey: string | null;
	/** Unix ms. Grants with `expiresAt < now` are ignored. */
	now: number;
}

/**
 * Decide allow / deny / none against an in-memory list of candidate
 * grants. Precedence:
 *
 *   1. Any matching `deny` grant wins.
 *   2. Otherwise any matching `allow` grant wins.
 *   3. Otherwise `none` — caller falls back to policy.
 *
 * "Match" means tool matches (exact or wildcard `*`), permission_kind
 * matches (exact, NULL = any, or `*`), and the scope pattern matches
 * the supplied scopeKey (NULL pattern = any, glob with `*` otherwise).
 * Expired grants are skipped.
 */
export function matchGrants(rows: GrantRow[], q: MatchQuery): MatchOutcome {
	let sawAllow = false;
	for (const r of rows) {
		if (r.expiresAt !== null && r.expiresAt < q.now) continue;
		if (!toolMatches(r.tool, q.tool)) continue;
		if (!kindMatches(r.permissionKind, q.permissionKind)) continue;
		if (!scopeMatches(r.scopePattern, q.scopeKey)) continue;
		if (r.decision === 'deny') return 'deny';
		sawAllow = true;
	}
	return sawAllow ? 'allow' : 'none';
}

function toolMatches(grant: string, want: string): boolean {
	return grant === '*' || grant === want;
}

function kindMatches(grant: string | null, want: string): boolean {
	if (grant === null || grant === '*') return true;
	return grant === want;
}

function scopeMatches(pattern: string | null, scopeKey: string | null): boolean {
	if (pattern === null || pattern === '' || pattern === '*') return true;
	if (scopeKey === null) return false;
	return globToRegex(pattern).test(scopeKey);
}

const GLOB_CACHE = new Map<string, RegExp>();

/**
 * Tiny glob → RegExp. `*` matches any run of characters (including
 * empty, including `/`); everything else is a literal. We deliberately
 * keep it minimal — the scope vocabulary is shell commands, file paths,
 * and URLs, and users want simple "starts with" patterns like
 * `git status*`, `./src/*`, `https://api.github.com/*`. A richer
 * minimatch-style grammar can come later if there's demand.
 */
export function globToRegex(pattern: string): RegExp {
	const cached = GLOB_CACHE.get(pattern);
	if (cached) return cached;
	let re = '^';
	for (const ch of pattern) {
		if (ch === '*') re += '.*';
		else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
	}
	re += '$';
	const r = new RegExp(re);
	GLOB_CACHE.set(pattern, r);
	return r;
}

/**
 * Derive a scope key from the SDK's permission-request payload. Returns
 * null if no meaningful scope can be extracted; the matcher will then
 * only fire for wildcard-pattern grants.
 *
 * Kept here (not in bridge.ts) so the same derivation can be reused by
 * the dialog's "suggest a narrow scope" UI in Tier 2 phase C.
 */
export function deriveScopeKey(
	permissionKind: string,
	req: {
		fullCommandText?: string;
		fileName?: string;
		args?: unknown;
	}
): string | null {
	switch (permissionKind) {
		case 'shell':
			return req.fullCommandText ?? null;
		case 'write':
		case 'edit':
		case 'read':
			return req.fileName ?? readArgString(req.args, 'path') ?? null;
		case 'url': {
			const url =
				readArgString(req.args, 'url') ?? readArgString(req.args, 'href') ?? req.fullCommandText;
			return url ?? null;
		}
		default:
			return null;
	}
}

function readArgString(args: unknown, key: string): string | null {
	if (!args || typeof args !== 'object') return null;
	const v = (args as Record<string, unknown>)[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}
