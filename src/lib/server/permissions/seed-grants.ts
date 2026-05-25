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
//   1. `allow` (Approve in the UI) seeds make safe shell calls
//      (read-only utilities, git read-only subcommands) pass without prompting.
//   2. `prompt` seeds with feedback + `pipeline: 'forbid'` nudge the
//      agent toward structured tools (view / grep / glob) for terminal reads
//      like `cat foo`, while still allowing a human escalation path when the
//      structured tools genuinely do not fit.

import { FS_PERMISSIONS, type GrantScope, type ShellRule } from '$lib/permissions/scope-types';
import { stableScopeKey } from '$lib/permissions/scope-codec';
import { addGrant, listGrantsForUser, revokeGrant } from '../db/repos/settings';

interface SeedSpec {
	tool: string;
	permissionKind: string | null;
	scope: GrantScope;
	decision?: 'allow' | 'deny' | 'prompt';
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

const GIT_STRUCTURED_TOOLS = [
	'git_status',
	'git_diff',
	'git_log',
	'git_show_commit',
	'git_show_file'
];
const TICKET_STRUCTURED_TOOLS = ['ticket_add', 'ticket_list', 'ticket_get', 'ticket_update'];
const PERMISSION_STRUCTURED_TOOLS = ['permission_capabilities'];

function shellGrant(rule: ShellRule): SeedSpec {
	return { tool: 'shell', permissionKind: 'shell', scope: { kind: 'shell', rule } };
}

function shellPrompt(rule: ShellRule, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule },
		decision: 'prompt',
		denyReason: reason
	};
}

/**
 * Terminal-usage nudges: each entry adds a `pipeline: 'forbid'` prompt rule
 * for `argv0`, paired with feedback pointing the agent at the
 * structured tool that does the job. Pipelined usage (`cmd | argv0
 * ...`) is NOT covered by the prompt rule and falls through to the matching
 * allow seed (or to the user's policy / prompt). The intent is to
 * teach via tool-failure feedback rather than via a static prelude.
 */
const NUDGE_PROMPTS: { argv0: string; reason: string }[] = [
	{
		argv0: 'cat',
		reason: 'Bare `cat` requires a prompt. Use `view` for file reads. Piped `cat` is allowed.'
	},
	{
		argv0: 'head',
		reason: 'Bare `head` requires a prompt. Use `view` with `view_range`. Piped `head` is allowed.'
	},
	{
		argv0: 'tail',
		reason: 'Bare `tail` requires a prompt. Use `view` with `view_range`. Piped `tail` is allowed.'
	},
	{
		argv0: 'grep',
		reason:
			'Bare `grep` requires a prompt. Use the structured `grep` tool. Piped `grep` is allowed.'
	},
	{
		argv0: 'rg',
		reason: 'Bare `rg` requires a prompt. Use the structured `grep` tool. Piped `rg` is allowed.'
	},
	{
		argv0: 'find',
		reason:
			'Bare `find` requires a prompt. Use `glob` for file-pattern matching. Piped `find` is allowed.'
	},
	{
		argv0: 'ls',
		reason: 'Bare `ls` requires a prompt. Use `glob` to enumerate files. Piped `ls` is allowed.'
	}
];

export function defaultSeedGrants(): SeedSpec[] {
	const seeds: SeedSpec[] = [];

	for (const argv0 of PURE_UTILS) {
		seeds.push(shellGrant({ argv0, positionals: { kind: 'any' } }));
	}
	for (const argv0 of FS_READ_TOOLS) {
		seeds.push(shellGrant({ argv0, positionals: { kind: 'workspace-paths' } }));
		seeds.push(shellGrant({ argv0, positionals: { kind: 'session-workspace-paths' } }));
	}
	for (const tool of GIT_STRUCTURED_TOOLS) {
		seeds.push({ tool, permissionKind: 'custom-tool', scope: { kind: 'any' } });
	}
	for (const tool of TICKET_STRUCTURED_TOOLS) {
		seeds.push({ tool, permissionKind: 'custom-tool', scope: { kind: 'any' } });
	}
	for (const tool of PERMISSION_STRUCTURED_TOOLS) {
		seeds.push({ tool, permissionKind: 'custom-tool', scope: { kind: 'any' } });
	}
	for (const perm of FS_PERMISSIONS) {
		seeds.push({
			tool: perm,
			permissionKind: perm,
			scope: {
				kind: 'fs',
				perms: [perm],
				rule: { kind: 'path', root: 'session-workspace', behavior: 'any' }
			}
		});
	}

	seeds.push(
		shellPrompt(
			{ argv0: 'git' },
			'Shell `git` requires a prompt. Use `permission_capabilities` to find allowed alternatives, then use an available structured Git tool instead.'
		)
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

	// Structured-tool nudges. Each prompt is `pipeline: 'forbid'`, so it
	// fires only when the command is the *only* command of its pipeline
	// (i.e. its stdout is what the agent wanted to read). Paired with
	// the allow seeds above, this means `cmd | grep foo` keeps working
	// while bare `grep foo` requires a prompt with feedback explaining
	// the structured replacement.
	for (const { argv0, reason } of NUDGE_PROMPTS) {
		seeds.push(shellPrompt({ argv0, pipeline: 'forbid' }, reason));
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
			denyReason: seed.denyReason ?? null,
			source: 'seed'
		});
		haveKey.add(key);
		inserted += 1;
	}
	return inserted;
}

/**
 * Replace every identifiable user-global default seed grant with the current
 * default set. This powers the Settings "Restore default seed grants" button:
 * unlike login-time seeding, it intentionally removes stale default rows first
 * so old seed shapes (for example deny nudges that are now prompt nudges) do not
 * keep winning by matcher precedence.
 */
export function restoreSeedGrantsForUser(userId: string): { removed: number; inserted: number } {
	const defaultKeys = restoreSeedKeys();
	let removed = 0;
	for (const grant of listGrantsForUser(userId)) {
		if (grant.conversationId !== null) continue;
		if (!grant.scope) continue;
		if (grant.argsHash) continue;
		if (grant.source !== 'seed') {
			if (
				!defaultKeys.has(seedKey(grant.tool, grant.permissionKind, grant.scope, grant.decision))
			) {
				continue;
			}
		}
		if (revokeGrant(userId, grant.id)) removed += 1;
	}
	return { removed, inserted: ensureSeedGrantsForUser(userId) };
}

function seedKey(tool: string, kind: string | null, scope: GrantScope, decision: string): string {
	return `${tool}\u0000${kind ?? ''}\u0000${decision}\u0000${stableScopeKey(scope)}`;
}

function restoreSeedKeys(): Set<string> {
	const keys = new Set<string>();
	for (const seed of defaultSeedGrants()) {
		const decision = seed.decision ?? 'allow';
		keys.add(seedKey(seed.tool, seed.permissionKind, seed.scope, decision));
		if (decision === 'prompt') {
			keys.add(seedKey(seed.tool, seed.permissionKind, seed.scope, 'deny'));
		}
	}
	return keys;
}
