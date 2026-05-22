// Seed grants: the curated set of structured permission grants that
// every user starts with. Inserted on user creation and idempotently
// backfilled for existing users; visible in the settings page so users
// can audit / revoke them.
//
// These replace the old hand-curated shell safe-list (which lived in
// code, was invisible to users, and ran *before* the matcher). By
// expressing the safe behavior as real grants we get one code path
// instead of two, and users can disable any seed they don't trust.

import type { GrantScope, ShellRule } from '$lib/permissions/scope-types';
import { addGrant, listGrantsForUser } from '../db/repos/settings';

interface SeedSpec {
	tool: string;
	permissionKind: string | null;
	scope: GrantScope;
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

/** git flags that redirect operations to another repo or run external
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

function shellGrant(rule: ShellRule): SeedSpec {
	return { tool: 'shell', permissionKind: 'shell', scope: { kind: 'shell', rule } };
}

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
			flags: { deny: GIT_DANGEROUS_FLAGS }
		})
	);

	// rg / grep / find: read-only by default, but their command-running
	// flags must be denied. We don't constrain positionals because users
	// commonly search for patterns whose syntax overlaps with paths.
	seeds.push(
		shellGrant({
			argv0: 'rg',
			flags: { deny: ['--pre', '--pre-glob', '--hostname-bin', '--no-config'] }
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
			flags: { deny: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf'] }
		})
	);

	return seeds;
}

/**
 * Insert the default seed grants for `userId` iff they're not already
 * present. We key dedup on (tool, permission_kind, scope_json) — the
 * structured representation uniquely identifies the seed, so a user
 * who has manually deleted one won't see it return on next login.
 *
 * Re-running this function is a no-op when the user already has all
 * seeds. To restore a deleted seed, the user re-adds it from the UI.
 */
export function ensureSeedGrantsForUser(userId: string): number {
	const existing = listGrantsForUser(userId);
	const haveKey = new Set<string>();
	for (const g of existing) {
		if (g.scope) haveKey.add(seedKey(g.tool, g.permissionKind, g.scope));
	}

	let inserted = 0;
	for (const seed of defaultSeedGrants()) {
		const key = seedKey(seed.tool, seed.permissionKind, seed.scope);
		if (haveKey.has(key)) continue;
		addGrant({
			userId,
			conversationId: null,
			tool: seed.tool,
			permissionKind: seed.permissionKind,
			scope: seed.scope
		});
		haveKey.add(key);
		inserted += 1;
	}
	return inserted;
}

function seedKey(tool: string, kind: string | null, scope: GrantScope): string {
	return `${tool}\u0000${kind ?? ''}\u0000${JSON.stringify(scope)}`;
}
