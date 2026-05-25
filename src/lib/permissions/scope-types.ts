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

export interface ShellOptionRules {
	allow?: ShellOptionSpec[];
	deny?: string[];
}

export type ShellOptionSpec =
	| { name: string; kind: 'flag' }
	| { name: string; kind: 'option'; value: ShellOptionValueRule };

export type ShellOptionValueRule = { kind: 'any' } | { kind: 'workspace-path' };

export interface ShellRule {
	/** argv[0] — exact match, no globs. Required. */
	argv0: string;
	/**
	 * If set, matches only when the invocation's resolved subcommand is in
	 * this list. When `preSubcommandOptions.allow` is omitted, known global
	 * options for supported command families (currently `git`) are skipped
	 * heuristically first, so `git --no-pager status` still resolves to
	 * subcommand `status`.
	 */
	subcommands?: string[];
	/**
	 * Option rules that apply before subcommand discovery. `allow` specs
	 * consume known leading options so the matcher can locate the
	 * subcommand and avoid misclassifying consumed values as positionals.
	 * `deny` remains name-based because rejecting the option does not need
	 * value-shape knowledge.
	 */
	preSubcommandOptions?: ShellOptionRules;
	/**
	 * Option rules that apply after the subcommand (or immediately after
	 * argv0 when no subcommand constraint is present). `allow` specs are
	 * value-aware; `deny` is name-based.
	 */
	options?: ShellOptionRules;
	/**
	 * What positional arguments (non-flag tokens other than argv[0], the
	 * resolved subcommand when constrained, and values consumed by matched
	 * option specs) are allowed.
	 *   none             — every positional must be absent
	 *   any              — anything goes
	 *   workspace-paths          — every positional must resolve to a path
	 *                              inside the conversation's workspace root
	 *   session-workspace-paths  — every positional must resolve to a path
	 *                              inside the SDK session workspace
	 */
	positionals?: PositionalsRule;
	/**
	 * Whether this segment must / must not be part of a shell pipeline
	 * (i.e. connected to a neighboring command by `|`). Omitted = no
	 * constraint. Used by the seed prompt grants for commands like `cat`
	 * / `grep` whose stdout is the human-visible output when run bare,
	 * but which are legitimate inside `cmd | grep ...`.
	 *   must    — this segment must be in a pipeline
	 *   forbid  — this segment must NOT be in a pipeline
	 */
	pipeline?: 'must' | 'forbid';
}

export type PositionalsRule =
	| { kind: 'none' }
	| { kind: 'any' }
	| { kind: 'workspace-paths' }
	| { kind: 'session-workspace-paths' };

/** Matches `read` / `write` / `edit` permission requests. */
export interface FsScope {
	kind: 'fs';
	/** Which kinds this grant covers. Empty = all three. */
	perms?: FsPermission[];
	rule: FsRule;
}

export const FS_PERMISSIONS = ['read', 'write', 'edit'] as const;
export type FsPermission = (typeof FS_PERMISSIONS)[number];

export const FS_RULE_ROOTS = ['workspace', 'session-workspace', 'absolute'] as const;
export type FsRuleRoot = (typeof FS_RULE_ROOTS)[number];

export const FS_RULE_CONTAINER_ROOTS = ['workspace', 'session-workspace'] as const;
export type FsRuleContainerRoot = (typeof FS_RULE_CONTAINER_ROOTS)[number];

export const FS_RULE_BEHAVIORS_WITH_VALUE = ['exact', 'prefix', 'glob'] as const;
export type FsRuleBehaviorWithValue = (typeof FS_RULE_BEHAVIORS_WITH_VALUE)[number];

export type FsRule =
	/**
	 * Composable path rule. `root` chooses the coordinate system, `behavior`
	 * chooses the matcher, and `value` is required for exact / prefix / glob.
	 *
	 *   workspace / session-workspace — value is relative to that root
	 *   absolute                      — value is an absolute path or glob
	 */
	| { kind: 'path'; root: FsRuleContainerRoot; behavior: 'any' }
	| { kind: 'path'; root: FsRuleRoot; behavior: FsRuleBehaviorWithValue; value: string };

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
