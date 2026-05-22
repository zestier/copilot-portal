// Seed grants: the curated set of structured permission grants that
// every user starts with. Inserted on user creation and idempotently
// backfilled for existing users; visible in the settings page so users
// can audit / revoke them.
//
// These replace the old hand-curated shell safe-list (which lived in
// code, was invisible to users, and ran *before* the matcher). By
// expressing the safe behavior as real grants we get one code path
// instead of two, and users can disable any seed they don't trust.
//
// Two flavors of seed:
//   1. `allow` seeds make safe shell calls (read-only utilities, git
//      read-only subcommands) pass without prompting.
//   2. `deny` seeds with `denyReason` + `pipeline: 'forbid'` nudge the
//      agent toward structured tools (view / grep / glob) for terminal
//      reads like `cat foo`, while still allowing the same commands
//      inside a pipeline (`cmd | grep ...`). The deny's `denyReason`
//      is surfaced to the agent as `feedback` on the SDK reject, so
//      the next call learns immediately without a user prompt.

import type { GrantScope, ShellRule, ShellOptionSpec } from '$lib/permissions/scope-types';
import { addGrant, listGrantsForUser } from '../db/repos/settings';

interface SeedSpec {
	tool: string;
	permissionKind: string | null;
	scope: GrantScope;
	decision?: 'allow' | 'deny';
	denyReason?: string;
}

/**
 * Shell tools with no path arguments (pure stdout-only utilities). Safe
 * to allow with any positionals because they don't touch the filesystem
 * beyond reading their own argv.
 */
const PURE_UTILS = [
	'echo',
	'printf',
	'pwd',
	'date',
	'whoami',
	'hostname',
	'uname',
	'true',
	'false',
	'basename',
	'dirname',
	'yes'
];

/**
 * Read-only file tools. Locked to positionals inside the workspace so
 * `cat /etc/passwd` still prompts. Note: a user who wants to read
 * outside the workspace can add their own grant; we don't ship one.
 */
const FS_READ_TOOLS = [
	'cat',
	'head',
	'tail',
	'wc',
	'file',
	'stat',
	'ls',
	'sort',
	'uniq',
	'cut',
	'tr',
	'realpath',
	'readlink',
	'md5sum',
	'sha1sum',
	'sha256sum'
];

/** git subcommands we consider read-only. */
const GIT_READ_SUBCOMMANDS = [
	'status',
	'log',
	'diff',
	'show',
	'rev-parse',
	'ls-files',
	'ls-tree',
	'cat-file',
	'blame',
	'shortlog',
	'describe',
	'branch',
	'tag',
	'remote',
	'config',
	'stash',
	'reflog',
	'symbolic-ref',
	'for-each-ref'
];

/** git options that redirect operations to another repo or run external
 * helpers. Always denied on the seed git grant — users who genuinely
 * need them can grant a broader rule. */
const GIT_DANGEROUS_FLAGS = [
	'--git-dir',
	'--work-tree',
	'--namespace',
	'-C',
	'--exec-path',
	'--man-path',
	'--info-path',
	'--super-prefix'
];

const GIT_PRE_SUBCOMMAND_ALLOW: ShellOptionSpec[] = [
	{ name: '--paginate', kind: 'flag' },
	{ name: '--no-pager', kind: 'flag' },
	{ name: '--bare', kind: 'flag' },
	{ name: '--no-replace-objects', kind: 'flag' },
	{ name: '--literal-pathspecs', kind: 'flag' },
	{ name: '--glob-pathspecs', kind: 'flag' },
	{ name: '--noglob-pathspecs', kind: 'flag' },
	{ name: '--icase-pathspecs', kind: 'flag' },
	{ name: '--no-lazy-fetch', kind: 'flag' },
	{ name: '--no-optional-locks', kind: 'flag' },
	{ name: '-c', kind: 'option', value: { kind: 'any' } },
	{ name: '-C', kind: 'option', value: { kind: 'any' } },
	{ name: '--git-dir', kind: 'option', value: { kind: 'any' } },
	{ name: '--work-tree', kind: 'option', value: { kind: 'any' } },
	{ name: '--namespace', kind: 'option', value: { kind: 'any' } },
	{ name: '--config-env', kind: 'option', value: { kind: 'any' } }
];

function shellGrant(rule: ShellRule): SeedSpec {
	return { tool: 'shell', permissionKind: 'shell', scope: { kind: 'shell', rule } };
}

function shellDeny(rule: ShellRule, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule },
		decision: 'deny',
		denyReason: reason
	};
}

/**
 * Terminal-usage nudges: each entry adds a `pipeline: 'forbid'` deny
 * for `argv0`, paired with a `denyReason` pointing the agent at the
 * structured tool that does the job. Pipelined usage (`cmd | argv0
 * ...`) is NOT covered by the deny and falls through to the matching
 * allow seed (or to the user's policy / prompt). The intent is to
 * teach via tool-failure feedback rather than via a static prelude.
 */
const NUDGE_DENIES: { argv0: string; reason: string }[] = [
	{
		argv0: 'cat',
		reason:
			'Bare `cat` is denied in this portal — use the structured `view` tool for file reads (supports `view_range` for slicing). Piped use (e.g. `cmd | cat -A`) is allowed.'
	},
	{
		argv0: 'head',
		reason:
			'Bare `head` is denied — use the `view` tool with `view_range` for top-of-file reads. Piped use (e.g. `cmd | head -n 5`) is allowed.'
	},
	{
		argv0: 'tail',
		reason:
			'Bare `tail` is denied — use the `view` tool with `view_range` for bottom-of-file reads. Piped use (`cmd | tail -n 50`) is allowed but still stalls SSE output until upstream exits; prefer redirecting to a file and reading it back.'
	},
	{
		argv0: 'grep',
		reason:
			'Bare `grep` is denied — use the `grep` tool (ripgrep-backed, supports `glob`, `output_mode`, `head_limit`). Piped use (`cmd | grep ...`) is allowed.'
	},
	{
		argv0: 'rg',
		reason:
			'Bare `rg` is denied — use the `grep` tool (it wraps ripgrep with structured output). Piped use is allowed.'
	},
	{
		argv0: 'find',
		reason:
			'Bare `find` is denied — use the `glob` tool for file-pattern matching. Piped use is allowed for unusual cases.'
	},
	{
		argv0: 'ls',
		reason:
			'Bare `ls` is denied — use the `glob` tool to enumerate files. Piped use is allowed when you genuinely need ls-specific output like permissions or symlinks.'
	}
];

export function defaultSeedGrants(): SeedSpec[] {
	const seeds: SeedSpec[] = [];

	for (const argv0 of PURE_UTILS) {
		seeds.push(shellGrant({ argv0, positionals: { kind: 'any' } }));
	}
	for (const argv0 of FS_READ_TOOLS) {
		seeds.push(shellGrant({ argv0, positionals: { kind: 'workspace-paths' } }));
	}

	// git read-only — no positional containment (refs / commit hashes are
	// not paths) but flag-deny prevents `--git-dir=/etc`.
	seeds.push(
		shellGrant({
			argv0: 'git',
			subcommands: GIT_READ_SUBCOMMANDS,
			preSubcommandOptions: { allow: GIT_PRE_SUBCOMMAND_ALLOW, deny: GIT_DANGEROUS_FLAGS }
		})
	);

	// rg / grep / find: read-only by default, but their command-running
	// options must be denied. We don't constrain positionals because users
	// commonly search for patterns whose syntax overlaps with paths.
	seeds.push(
		shellGrant({
			argv0: 'rg',
			options: { deny: ['--pre', '--pre-glob', '--hostname-bin', '--no-config'] }
		})
	);
	seeds.push(
		shellGrant({
			argv0: 'grep',
			positionals: { kind: 'any' }
		})
	);
	seeds.push(
		shellGrant({
			argv0: 'find',
			options: {
				deny: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf']
			}
		})
	);

	// Structured-tool nudges. Each deny is `pipeline: 'forbid'`, so it
	// fires only when the command is the *only* command of its pipeline
	// (i.e. its stdout is what the agent wanted to read). Paired with
	// the allow seeds above, this means `cmd | grep foo` keeps working
	// while bare `grep foo` is rejected with feedback explaining the
	// structured replacement.
	for (const { argv0, reason } of NUDGE_DENIES) {
		seeds.push(shellDeny({ argv0, pipeline: 'forbid' }, reason));
	}

	return seeds;
}

/**
 * Insert the default seed grants for `userId` iff they're not already
 * present. We key dedup on (tool, permission_kind, scope_json, decision)
 * — the structured representation uniquely identifies the seed, so a
 * user who has manually deleted one won't see it return on next login.
 *
 * Re-running this function is a no-op when the user already has all
 * seeds. To restore a deleted seed, the user re-adds it from the UI.
 */
export function ensureSeedGrantsForUser(userId: string): number {
	const existing = listGrantsForUser(userId);
	const haveKey = new Set<string>();
	for (const g of existing) {
		if (g.scope) haveKey.add(seedKey(g.tool, g.permissionKind, g.scope, g.decision));
	}

	let inserted = 0;
	for (const seed of defaultSeedGrants()) {
		const decision = seed.decision ?? 'allow';
		const key = seedKey(seed.tool, seed.permissionKind, seed.scope, decision);
		if (haveKey.has(key)) continue;
		addGrant({
			userId,
			conversationId: null,
			tool: seed.tool,
			permissionKind: seed.permissionKind,
			scope: seed.scope,
			decision,
			denyReason: seed.denyReason ?? null
		});
		haveKey.add(key);
		inserted += 1;
	}
	return inserted;
}

function seedKey(tool: string, kind: string | null, scope: GrantScope, decision: string): string {
	return `${tool}\u0000${kind ?? ''}\u0000${decision}\u0000${JSON.stringify(scope)}`;
}
