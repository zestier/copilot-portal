import { describe, it, expect } from 'vitest';
import { GrantInputSchema, permissionKindForTool } from '../src/lib/permissions/scope-schema';

const future = Date.now() + 60_000;

describe('GrantInputSchema — valid shapes', () => {
	it('shell with workspace-paths positionals', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: { argv0: 'cd', positionals: { kind: 'workspace-paths' } }
			}
		});
		expect(parsed.scope.kind).toBe('shell');
		if (parsed.scope.kind === 'shell') {
			expect(parsed.scope.rule.argv0).toBe('cd');
		}
		expect(parsed.expiresAt).toBeNull();
	});

	it('shell with flag deny-list', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: {
					argv0: 'git',
					subcommands: ['status', 'log'],
					flags: { deny: ['--git-dir', '-C'] }
				}
			}
		});
		expect(parsed.scope.kind).toBe('shell');
	});

	it('fs read with workspace-glob', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'workspace-glob', glob: 'src/**/*.ts' }
			}
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('fs read with omitted perms (covers all kinds)', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: { kind: 'fs', rule: { kind: 'workspace' } }
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('url with host-suffix', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'url',
			decision: 'allow',
			scope: { kind: 'url', rule: { kind: 'host-suffix', suffix: 'github.com' } }
		});
		expect(parsed.scope.kind).toBe('url');
	});

	it('with future expiry', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: { argv0: 'ls' } },
			expiresAt: future
		});
		expect(parsed.expiresAt).toBe(future);
	});
});

describe('GrantInputSchema — rejections', () => {
	it('rejects {kind:any} scope (no wildcard grants from form)', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'any' }
		});
		expect(r.success).toBe(false);
	});

	it('rejects tool/scope-kind mismatch (shell tool, fs scope)', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'fs', rule: { kind: 'workspace' } }
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.issues.some((i) => i.message.includes('requires scope.kind'))).toBe(true);
		}
	});

	it('rejects tool/scope-kind mismatch (read tool, shell scope)', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'read',
			decision: 'allow',
			scope: { kind: 'shell', rule: { argv0: 'ls' } }
		});
		expect(r.success).toBe(false);
	});

	it('rejects argv0 with a slash', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: { argv0: '/usr/bin/ls' } }
		});
		expect(r.success).toBe(false);
	});

	it('rejects fs.exact with a relative path', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'read',
			decision: 'allow',
			scope: { kind: 'fs', perms: ['read'], rule: { kind: 'exact', path: 'relative/foo' } }
		});
		expect(r.success).toBe(false);
	});

	it('rejects fs perms that do not include the chosen tool', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'write',
			decision: 'allow',
			scope: { kind: 'fs', perms: ['read'], rule: { kind: 'workspace' } }
		});
		expect(r.success).toBe(false);
	});

	it('rejects expiry in the past', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: { argv0: 'ls' } },
			expiresAt: Date.now() - 1000
		});
		expect(r.success).toBe(false);
	});

	it('rejects flag without leading dash', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: { argv0: 'git', flags: { deny: ['foo'] } }
			}
		});
		expect(r.success).toBe(false);
	});
});

describe('permissionKindForTool', () => {
	it('maps tool to permission kind 1:1', () => {
		expect(permissionKindForTool('shell')).toBe('shell');
		expect(permissionKindForTool('read')).toBe('read');
		expect(permissionKindForTool('write')).toBe('write');
		expect(permissionKindForTool('edit')).toBe('edit');
		expect(permissionKindForTool('url')).toBe('url');
	});
});
