// Structured permission grant scopes.
//
// A grant row stores `scope_json` describing what the grant covers.
// Legacy v2 rows store the old `scope_pattern` (substring glob over the
// derived scope-key) and have `scope_json = NULL`; new writes only emit
// scope_json. The matcher dispatches on the structured shape per
// permission kind.
//
// Shapes are intentionally narrow: each rule has a small fixed set of
// constraints, no free-form regex/glob over command strings. Adding a
// new lever is a typed change with predicate + UI + tests, not a string
// the user has to author.

export type GrantScope = ShellScope | FsScope | UrlScope | AnyScope;

/** Matches `shell` permission requests. */
export interface ShellScope {
	kind: 'shell';
	rule: ShellRule;
}

export interface ShellRule {
	/** argv[0] — exact match, no globs. Required. */
	argv0: string;
	/** If set, matches only when argv[1] is in this list. */
	subcommands?: string[];
	/**
	 * Token-level flag constraints. `deny` flags reject the invocation if
	 * any argv token equals the flag OR starts with `flag + '='` (so
	 * `--git-dir /etc` and `--git-dir=/etc` are both caught).
	 *
	 * `allow` is an allow-list: if set, every flag-shaped token (starting
	 * with `-`) must be in the list. Positional args are unconstrained
	 * here — see `positionals`.
	 */
	flags?: {
		allow?: string[];
		deny?: string[];
	};
	/**
	 * What positional arguments (non-flag tokens after argv[0] / argv[1])
	 * are allowed.
	 *   none             — every positional must be absent
	 *   any              — anything goes
	 *   workspace-paths  — every positional must resolve to a path inside
	 *                      the conversation's workspace root
	 */
	positionals?: PositionalsRule;
}

export type PositionalsRule = { kind: 'none' } | { kind: 'any' } | { kind: 'workspace-paths' };

/** Matches `read` / `write` / `edit` permission requests. */
export interface FsScope {
	kind: 'fs';
	/** Which kinds this grant covers. Empty = all three. */
	perms?: ('read' | 'write' | 'edit')[];
	rule: FsRule;
}

export type FsRule =
	/** Exact absolute path equality (after realpath). */
	| { kind: 'exact'; path: string }
	/** Any path resolving inside the conversation's workspace root. */
	| { kind: 'workspace' }
	/**
	 * Glob relative to the workspace root, token-aware (`*` matches a path
	 * segment, `**` matches any number of segments). The path must be
	 * inside the workspace AND match the glob.
	 */
	| { kind: 'workspace-glob'; glob: string }
	/**
	 * Any path equal to `path` or resolving inside it (after realpath on
	 * both sides). Intended for "I trust this directory" grants on
	 * out-of-workspace targets — e.g. allowing reads under `~/.config/foo`
	 * without granting access to the entire filesystem. `path` should be
	 * absolute; relative paths will not match.
	 */
	| { kind: 'prefix'; path: string };

/** Matches `url` permission requests. */
export interface UrlScope {
	kind: 'url';
	rule: UrlRule;
}

export type UrlRule =
	| { kind: 'exact'; url: string }
	| { kind: 'host'; host: string }
	/** Match host iff it equals `suffix` or ends with `'.' + suffix`. */
	| { kind: 'host-suffix'; suffix: string };

/** Catch-all for v2-era rows we migrate without conversion ("Allow always"
 * with no kind/pattern). The matcher treats this as "any request for the
 * grant's tool". */
export interface AnyScope {
	kind: 'any';
}
