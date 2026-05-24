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

	it('shell with session-workspace-paths positionals', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: { argv0: 'cat', positionals: { kind: 'session-workspace-paths' } }
			}
		});
		expect(parsed.scope.kind).toBe('shell');
	});

	it('shell with pre-subcommand and post-subcommand option rules', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: {
					argv0: 'git',
					subcommands: ['status', 'log'],
					preSubcommandOptions: {
						allow: [{ name: '-C', kind: 'option', value: { kind: 'any' } }],
						deny: ['--git-dir']
					},
					options: {
						allow: [{ name: '--oneline', kind: 'flag' }],
						deny: ['--format']
					}
				}
			}
		});
		expect(parsed.scope.kind).toBe('shell');
	});

	it('fs read with workspace glob path rule', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'workspace', behavior: 'glob', value: 'src/**/*.ts' }
			}
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('fs read with absolute glob path rule', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'glob', value: '/tmp/**/*.ts' }
			}
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('fs read with omitted perms (covers all kinds)', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: { kind: 'fs', rule: { kind: 'path', root: 'workspace', behavior: 'any' } }
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('fs read with session-workspace rule', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'session-workspace', behavior: 'any' }
			}
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

	it('accepts prompt grants without denyReason', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'prompt',
			scope: { kind: 'shell', rule: { argv0: 'npm' } }
		});
		expect(parsed.decision).toBe('prompt');
		expect(parsed.denyReason).toBeNull();
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
			scope: { kind: 'fs', rule: { kind: 'path', root: 'workspace', behavior: 'any' } }
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

	it('rejects fs absolute exact with a relative path', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'exact', value: 'relative/foo' }
			}
		});
		expect(r.success).toBe(false);
	});

	it('rejects fs workspace glob with an absolute value', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'workspace', behavior: 'glob', value: '/tmp/**/*.ts' }
			}
		});
		expect(r.success).toBe(false);
	});

	it('rejects fs perms that do not include the chosen tool', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'write',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'workspace', behavior: 'any' }
			}
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

	it('rejects option name without leading dash', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: { argv0: 'git', options: { deny: ['foo'] } }
			}
		});
		expect(r.success).toBe(false);
	});

	it('rejects denyReason on an allow grant', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: { argv0: 'ls' } },
			denyReason: 'this should not be settable on an allow'
		});
		expect(r.success).toBe(false);
	});

	it('rejects denyReason on a prompt grant', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'prompt',
			scope: { kind: 'shell', rule: { argv0: 'npm' } },
			denyReason: 'prompt grants should not reject directly'
		});
		expect(r.success).toBe(false);
	});

	it('rejects pipeline value that is not "must"/"forbid"', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: { argv0: 'grep', pipeline: 'sometimes' } }
		});
		expect(r.success).toBe(false);
	});
});

describe('GrantInputSchema — denyReason + pipeline', () => {
	it('accepts denyReason on a deny grant and trims it', () => {
		const r = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'deny',
			scope: { kind: 'shell', rule: { argv0: 'cat', pipeline: 'forbid' } },
			denyReason: '  prefer the view tool  '
		});
		expect(r.denyReason).toBe('prefer the view tool');
		if (r.scope.kind === 'shell') {
			expect(r.scope.rule.pipeline).toBe('forbid');
		}
	});

	it('normalizes empty / whitespace / undefined / null denyReason to null', () => {
		for (const reason of [undefined, null, '', '   ']) {
			const r = GrantInputSchema.parse({
				tool: 'shell',
				decision: 'deny',
				scope: { kind: 'shell', rule: { argv0: 'rm' } },
				denyReason: reason
			});
			expect(r.denyReason).toBeNull();
		}
	});

	it('rejects denyReason over 500 chars', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'deny',
			scope: { kind: 'shell', rule: { argv0: 'rm' } },
			denyReason: 'x'.repeat(501)
		});
		expect(r.success).toBe(false);
	});

	it('accepts pipeline=must', () => {
		const r = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: { argv0: 'grep', pipeline: 'must' } }
		});
		if (r.scope.kind === 'shell') {
			expect(r.scope.rule.pipeline).toBe('must');
		}
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
