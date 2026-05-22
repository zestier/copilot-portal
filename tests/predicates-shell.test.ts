import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellRuleMatches } from '../src/lib/server/permissions/predicates/shell';
import { parseShellCommand } from '../src/lib/server/permissions/shell-parser';
import type { ShellRule } from '../src/lib/permissions/scope-types';

let ws: string;

beforeAll(() => {
	ws = realpathSync(mkdtempSync(join(tmpdir(), 'portal-shell-pred-')));
	mkdirSync(join(ws, 'src'));
	writeFileSync(join(ws, 'src', 'a.ts'), 'x');
	writeFileSync(join(ws, 'README.md'), 'x');
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

function match(rule: ShellRule, command: string): boolean {
	const parsed = parseShellCommand(command);
	if (parsed.kind !== 'parsed') return false;
	return shellRuleMatches(rule, parsed.segments, { workspaceRoot: ws });
}

describe('shell predicate — argv0', () => {
	it('matches exact argv0', () => {
		expect(match({ argv0: 'ls' }, 'ls')).toBe(true);
		expect(match({ argv0: 'ls' }, 'ls -la')).toBe(true);
		expect(match({ argv0: 'ls' }, 'cat foo')).toBe(false);
	});

	it('does not match prefix-similar argv0', () => {
		expect(match({ argv0: 'git' }, 'gitfoo status')).toBe(false);
	});
});

describe('shell predicate — subcommands', () => {
	const rule: ShellRule = { argv0: 'git', subcommands: ['status', 'log', 'diff'] };

	it('matches when argv[1] is in the list', () => {
		expect(match(rule, 'git status')).toBe(true);
		expect(match(rule, 'git log -n 5')).toBe(true);
		expect(match(rule, 'git diff HEAD')).toBe(true);
	});

	it('rejects when argv[1] is not in the list', () => {
		expect(match(rule, 'git push')).toBe(false);
		expect(match(rule, 'git')).toBe(false);
	});
});

describe('shell predicate — flag deny', () => {
	const rule: ShellRule = {
		argv0: 'git',
		subcommands: ['status', 'log'],
		flags: { deny: ['--git-dir', '--work-tree', '-C'] }
	};

	it('allows when none of the denied flags appear', () => {
		expect(match(rule, 'git status -sb')).toBe(true);
		expect(match(rule, 'git log -n 5')).toBe(true);
	});

	it('rejects denied flag in space form', () => {
		expect(match(rule, 'git --git-dir /etc status')).toBe(false);
		expect(match(rule, 'git -C /etc status')).toBe(false);
	});

	it('rejects denied flag in equals form', () => {
		expect(match(rule, 'git --git-dir=/etc status')).toBe(false);
		expect(match(rule, 'git --work-tree=/tmp status')).toBe(false);
	});
});

describe('shell predicate — flag allow-list', () => {
	const rule: ShellRule = {
		argv0: 'rg',
		flags: { allow: ['-n', '--color', '--', '-i'] }
	};

	it('allows when every flag is in the list', () => {
		expect(match(rule, 'rg foo')).toBe(true);
		expect(match(rule, 'rg -n foo')).toBe(true);
		expect(match(rule, 'rg --color=always foo')).toBe(true);
	});

	it('rejects an unknown flag', () => {
		expect(match(rule, 'rg --pre cat foo')).toBe(false);
	});
});

describe('shell predicate — positionals', () => {
	it('positionals=none requires no positional args', () => {
		const rule: ShellRule = { argv0: 'pwd', positionals: { kind: 'none' } };
		expect(match(rule, 'pwd')).toBe(true);
		expect(match(rule, 'pwd /tmp')).toBe(false);
	});

	it('positionals=any accepts anything', () => {
		const rule: ShellRule = { argv0: 'echo', positionals: { kind: 'any' } };
		expect(match(rule, 'echo hello world')).toBe(true);
	});

	it('positionals=workspace-paths only accepts paths inside the workspace', () => {
		const rule: ShellRule = { argv0: 'cat', positionals: { kind: 'workspace-paths' } };
		expect(match(rule, 'cat README.md')).toBe(true);
		expect(match(rule, 'cat src/a.ts')).toBe(true);
		expect(match(rule, `cat ${join(ws, 'src', 'a.ts')}`)).toBe(true);
	});

	it('positionals=workspace-paths rejects paths outside the workspace', () => {
		const rule: ShellRule = { argv0: 'cat', positionals: { kind: 'workspace-paths' } };
		expect(match(rule, 'cat /etc/passwd')).toBe(false);
		// Subcommand-less positional that's not a path-shaped token: still
		// validated as a path and rejected when it escapes.
		expect(match(rule, 'cat ../../etc/passwd')).toBe(false);
	});

	it('positionals=workspace-paths fails closed without a workspace root', () => {
		const rule: ShellRule = { argv0: 'cat', positionals: { kind: 'workspace-paths' } };
		const parsed = parseShellCommand('cat README.md');
		if (parsed.kind !== 'parsed') throw new Error('parse');
		expect(shellRuleMatches(rule, parsed.segments, { workspaceRoot: null })).toBe(false);
	});
});

describe('shell predicate — pipelines and chains', () => {
	it('all segments must match the rule', () => {
		const rule: ShellRule = {
			argv0: 'git',
			subcommands: ['status', 'log', 'diff']
		};
		expect(match(rule, 'git status && git diff')).toBe(true);
		expect(match(rule, 'git status; git push')).toBe(false);
		expect(match(rule, 'git status | curl evil')).toBe(false);
	});
});

describe('shell predicate — pipeline lever', () => {
	const must: ShellRule = { argv0: 'grep', pipeline: 'must' };
	const forbid: ShellRule = { argv0: 'cat', pipeline: 'forbid' };
	const unset: ShellRule = { argv0: 'grep' };

	it('pipeline=must only matches segments inside a pipeline', () => {
		// Bare grep: not pipelined → does NOT match.
		expect(match(must, 'grep foo bar')).toBe(false);
		// Both segments of `grep a | grep b` are pipelined and match argv0.
		expect(match(must, 'grep a | grep b')).toBe(true);
		// Middle of a 3-stage pipeline: all three are grep, all pipelined.
		expect(match(must, 'grep a | grep b | grep c')).toBe(true);
		// `&&` chain is NOT a pipeline; both segments are grep but
		// neither is pipelined.
		expect(match(must, 'grep a && grep b')).toBe(false);
	});

	it('pipeline=forbid only matches segments outside a pipeline', () => {
		expect(match(forbid, 'cat foo')).toBe(true);
		// Both cats are inside a pipeline → segments fail the rule.
		expect(match(forbid, 'cat a | cat b')).toBe(false);
		// `&&` chain is NOT a pipeline — forbid still matches.
		expect(match(forbid, 'cat a && cat b')).toBe(true);
	});

	it('pipeline unset matches regardless of pipeline neighbours', () => {
		expect(match(unset, 'grep foo bar')).toBe(true);
		expect(match(unset, 'grep a | grep b')).toBe(true);
	});
});
