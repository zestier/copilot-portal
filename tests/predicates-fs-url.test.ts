import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsScopeMatches, tokenGlobMatches } from '../src/lib/server/permissions/predicates/fs';
import { urlScopeMatches } from '../src/lib/server/permissions/predicates/url';

let ws: string;

beforeAll(() => {
	ws = realpathSync(mkdtempSync(join(tmpdir(), 'portal-fs-url-pred-')));
	mkdirSync(join(ws, 'src'));
	writeFileSync(join(ws, 'src', 'a.ts'), 'x');
	writeFileSync(join(ws, 'src', 'b.ts'), 'x');
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe('fs predicate', () => {
	it('exact rule matches only the exact path', () => {
		const scope = { kind: 'fs' as const, rule: { kind: 'exact' as const, path: '/tmp/x' } };
		expect(
			fsScopeMatches(scope, { permissionKind: 'read', target: '/tmp/x', workspaceRoot: ws })
		).toBe(true);
		expect(
			fsScopeMatches(scope, { permissionKind: 'read', target: '/tmp/y', workspaceRoot: ws })
		).toBe(false);
	});

	it('workspace rule matches anything inside the workspace', () => {
		const scope = { kind: 'fs' as const, rule: { kind: 'workspace' as const } };
		expect(
			fsScopeMatches(scope, {
				permissionKind: 'read',
				target: join(ws, 'src', 'a.ts'),
				workspaceRoot: ws
			})
		).toBe(true);
		expect(
			fsScopeMatches(scope, {
				permissionKind: 'read',
				target: '/etc/passwd',
				workspaceRoot: ws
			})
		).toBe(false);
	});

	it('workspace-glob requires both containment and glob match', () => {
		const scope = {
			kind: 'fs' as const,
			rule: { kind: 'workspace-glob' as const, glob: 'src/**' }
		};
		expect(
			fsScopeMatches(scope, {
				permissionKind: 'read',
				target: join(ws, 'src', 'a.ts'),
				workspaceRoot: ws
			})
		).toBe(true);
		// File is in workspace but doesn't match the glob.
		writeFileSync(join(ws, 'top.txt'), 'x');
		expect(
			fsScopeMatches(scope, {
				permissionKind: 'read',
				target: join(ws, 'top.txt'),
				workspaceRoot: ws
			})
		).toBe(false);
	});

	it('perms filter restricts the request kinds the grant covers', () => {
		const scope = {
			kind: 'fs' as const,
			perms: ['read' as const],
			rule: { kind: 'workspace' as const }
		};
		const target = join(ws, 'src', 'a.ts');
		expect(fsScopeMatches(scope, { permissionKind: 'read', target, workspaceRoot: ws })).toBe(true);
		expect(fsScopeMatches(scope, { permissionKind: 'write', target, workspaceRoot: ws })).toBe(
			false
		);
	});

	it('workspace / workspace-glob fail closed without a workspace root', () => {
		expect(
			fsScopeMatches(
				{ kind: 'fs', rule: { kind: 'workspace' } },
				{ permissionKind: 'read', target: '/tmp/x', workspaceRoot: null }
			)
		).toBe(false);
		expect(
			fsScopeMatches(
				{ kind: 'fs', rule: { kind: 'workspace-glob', glob: '**' } },
				{ permissionKind: 'read', target: '/tmp/x', workspaceRoot: null }
			)
		).toBe(false);
	});

	describe('prefix rule', () => {
		let outside: string;
		beforeAll(() => {
			outside = realpathSync(mkdtempSync(join(tmpdir(), 'portal-fs-prefix-')));
			mkdirSync(join(outside, 'sub'));
			writeFileSync(join(outside, 'sub', 'a.txt'), 'x');
		});
		afterAll(() => rmSync(outside, { recursive: true, force: true }));

		it('matches the prefix itself and descendants', () => {
			const scope = { kind: 'fs' as const, rule: { kind: 'prefix' as const, path: outside } };
			expect(
				fsScopeMatches(scope, { permissionKind: 'read', target: outside, workspaceRoot: null })
			).toBe(true);
			expect(
				fsScopeMatches(scope, {
					permissionKind: 'read',
					target: join(outside, 'sub', 'a.txt'),
					workspaceRoot: null
				})
			).toBe(true);
		});

		it('rejects paths outside the prefix and sibling-prefix collisions', () => {
			const scope = { kind: 'fs' as const, rule: { kind: 'prefix' as const, path: outside } };
			expect(
				fsScopeMatches(scope, {
					permissionKind: 'read',
					target: '/etc/passwd',
					workspaceRoot: null
				})
			).toBe(false);
			// Sibling whose name shares the prefix's basename as a prefix
			// substring must not be treated as inside.
			expect(
				fsScopeMatches(scope, {
					permissionKind: 'read',
					target: `${outside}-evil/file`,
					workspaceRoot: null
				})
			).toBe(false);
		});

		it('handles not-yet-existing descendants via parent-fallback realpath', () => {
			const scope = { kind: 'fs' as const, rule: { kind: 'prefix' as const, path: outside } };
			expect(
				fsScopeMatches(scope, {
					permissionKind: 'write',
					target: join(outside, 'does-not-exist-yet', 'new.txt'),
					workspaceRoot: null
				})
			).toBe(true);
		});

		it('rejects relative prefix or target paths (no working directory anchor)', () => {
			const scope = { kind: 'fs' as const, rule: { kind: 'prefix' as const, path: 'relative' } };
			expect(
				fsScopeMatches(scope, { permissionKind: 'read', target: outside, workspaceRoot: null })
			).toBe(false);
			const absScope = {
				kind: 'fs' as const,
				rule: { kind: 'prefix' as const, path: outside }
			};
			expect(
				fsScopeMatches(absScope, {
					permissionKind: 'read',
					target: 'relative/path',
					workspaceRoot: null
				})
			).toBe(false);
		});

		it('honors the perms filter', () => {
			const scope = {
				kind: 'fs' as const,
				perms: ['read' as const],
				rule: { kind: 'prefix' as const, path: outside }
			};
			expect(
				fsScopeMatches(scope, {
					permissionKind: 'read',
					target: join(outside, 'sub', 'a.txt'),
					workspaceRoot: null
				})
			).toBe(true);
			expect(
				fsScopeMatches(scope, {
					permissionKind: 'write',
					target: join(outside, 'sub', 'a.txt'),
					workspaceRoot: null
				})
			).toBe(false);
		});
	});
});

describe('tokenGlobMatches', () => {
	it('* matches within one segment', () => {
		expect(tokenGlobMatches('src/*.ts', 'src/a.ts')).toBe(true);
		expect(tokenGlobMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
	});

	it('** matches any number of segments', () => {
		expect(tokenGlobMatches('src/**', 'src/a.ts')).toBe(true);
		expect(tokenGlobMatches('src/**', 'src/a/b/c.ts')).toBe(true);
		expect(tokenGlobMatches('src/**', 'other/a.ts')).toBe(false);
	});

	it('**/ allows zero leading segments', () => {
		expect(tokenGlobMatches('**/foo.ts', 'foo.ts')).toBe(true);
		expect(tokenGlobMatches('**/foo.ts', 'a/b/foo.ts')).toBe(true);
	});
});

describe('url predicate', () => {
	it('exact rule matches by full string', () => {
		const scope = {
			kind: 'url' as const,
			rule: { kind: 'exact' as const, url: 'https://api.github.com/x' }
		};
		expect(urlScopeMatches(scope, { url: 'https://api.github.com/x' })).toBe(true);
		expect(urlScopeMatches(scope, { url: 'https://api.github.com/y' })).toBe(false);
	});

	it('host rule matches just the host', () => {
		const scope = {
			kind: 'url' as const,
			rule: { kind: 'host' as const, host: 'api.github.com' }
		};
		expect(urlScopeMatches(scope, { url: 'https://api.github.com/a/b' })).toBe(true);
		expect(urlScopeMatches(scope, { url: 'https://example.com/x' })).toBe(false);
		expect(urlScopeMatches(scope, { url: 'not a url' })).toBe(false);
	});

	it('host-suffix matches the host and subdomains, not sibling hosts', () => {
		const scope = {
			kind: 'url' as const,
			rule: { kind: 'host-suffix' as const, suffix: 'github.com' }
		};
		expect(urlScopeMatches(scope, { url: 'https://github.com/a' })).toBe(true);
		expect(urlScopeMatches(scope, { url: 'https://api.github.com/a' })).toBe(true);
		expect(urlScopeMatches(scope, { url: 'https://evilgithub.com/a' })).toBe(false);
	});
});
