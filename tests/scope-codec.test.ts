import { describe, it, expect } from 'vitest';
import { decodeScope, encodeScope, stableScopeKey } from '../src/lib/permissions/scope-codec';
import type { GrantScope } from '../src/lib/permissions/scope-types';

function roundtrip(scope: GrantScope) {
	const enc = encodeScope(scope);
	const dec = decodeScope(enc);
	expect(dec).toEqual(scope);
}

describe('scope-codec roundtrip', () => {
	it('any', () => {
		roundtrip({ kind: 'any' });
	});

	it('shell minimal', () => {
		roundtrip({ kind: 'shell', rule: { argv0: 'ls' } });
	});

	it('shell full', () => {
		roundtrip({
			kind: 'shell',
			rule: {
				argv0: 'git',
				subcommands: ['status', 'log', 'diff'],
				preSubcommandOptions: {
					allow: [{ name: '-C', kind: 'option', value: { kind: 'any' } }],
					deny: ['--git-dir']
				},
				options: {
					allow: [
						{ name: '-n', kind: 'flag' },
						{ name: '--oneline', kind: 'flag' }
					],
					deny: ['--format']
				},
				positionals: { kind: 'workspace-paths' }
			}
		});
	});

	it('shell with pipeline=must', () => {
		roundtrip({ kind: 'shell', rule: { argv0: 'grep', pipeline: 'must' } });
	});

	it('shell with pipeline=forbid', () => {
		roundtrip({
			kind: 'shell',
			rule: { argv0: 'cat', pipeline: 'forbid', positionals: { kind: 'any' } }
		});
	});

	it('shell with session-workspace-paths positionals', () => {
		roundtrip({
			kind: 'shell',
			rule: { argv0: 'cat', positionals: { kind: 'session-workspace-paths' } }
		});
	});

	it('decodes legacy flags into the new option-rule fields', () => {
		expect(
			decodeScope(
				JSON.stringify({
					kind: 'shell',
					rule: {
						argv0: 'git',
						subcommands: ['status'],
						flags: { allow: ['--no-pager'], deny: ['-C'] }
					}
				})
			)
		).toEqual({
			kind: 'shell',
			rule: {
				argv0: 'git',
				subcommands: ['status'],
				preSubcommandOptions: {
					allow: [{ name: '--no-pager', kind: 'flag' }],
					deny: ['-C']
				},
				options: {
					allow: [{ name: '--no-pager', kind: 'flag' }],
					deny: ['-C']
				}
			}
		});
	});

	it('fs variants', () => {
		roundtrip({ kind: 'fs', rule: { kind: 'workspace' }, perms: ['read'] });
		roundtrip({ kind: 'fs', rule: { kind: 'session-workspace' }, perms: ['read'] });
		roundtrip({ kind: 'fs', rule: { kind: 'exact', path: '/tmp/x' } });
		roundtrip({
			kind: 'fs',
			rule: { kind: 'workspace-glob', glob: 'src/**' },
			perms: ['read', 'write']
		});
		roundtrip({
			kind: 'fs',
			rule: { kind: 'prefix', path: '/home/me/.config/foo' },
			perms: ['read']
		});
	});

	it('url variants', () => {
		roundtrip({ kind: 'url', rule: { kind: 'exact', url: 'https://a' } });
		roundtrip({ kind: 'url', rule: { kind: 'host', host: 'api.github.com' } });
		roundtrip({ kind: 'url', rule: { kind: 'host-suffix', suffix: 'github.com' } });
	});
});

describe('stableScopeKey', () => {
	it('ignores object key insertion order', () => {
		const a: GrantScope = { kind: 'fs', perms: ['read'], rule: { kind: 'session-workspace' } };
		const b = {
			kind: 'fs',
			rule: { kind: 'session-workspace' },
			perms: ['read']
		} as GrantScope;
		expect(stableScopeKey(a)).toBe(stableScopeKey(b));
	});
});

describe('scope-codec decode — rejects malformed input', () => {
	it.each([
		null,
		'',
		'not json',
		'[]',
		'{}',
		'{"kind":"shell"}',
		'{"kind":"shell","rule":{}}',
		'{"kind":"shell","rule":{"argv0":""}}',
		'{"kind":"shell","rule":{"argv0":"/bin/ls"}}',
		'{"kind":"shell","rule":{"argv0":"./ls"}}',
		'{"kind":"shell","rule":{"argv0":"git","subcommands":[1]}}',
		'{"kind":"shell","rule":{"argv0":"git","options":{"allow":[1]}}}',
		'{"kind":"shell","rule":{"argv0":"git","options":{"allow":[{"name":"-C","kind":"option","value":{"kind":"weird"}}]}}}',
		'{"kind":"shell","rule":{"argv0":"git","positionals":{"kind":"foo"}}}',
		'{"kind":"fs","rule":{"kind":"exact"}}',
		'{"kind":"fs","rule":{"kind":"workspace-glob"}}',
		'{"kind":"fs","rule":{"kind":"workspace"},"perms":["delete"]}',
		'{"kind":"fs","rule":{"kind":"prefix"}}',
		'{"kind":"fs","rule":{"kind":"prefix","path":""}}',
		'{"kind":"url","rule":{"kind":"exact"}}',
		'{"kind":"url","rule":{"kind":"host","host":""}}',
		'{"kind":"weird"}'
	])('rejects %j', (input) => {
		expect(decodeScope(input as string)).toBeNull();
	});
});
