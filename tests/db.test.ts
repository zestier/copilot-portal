import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/lib/server/db';
import { resetConfigForTests } from '../src/lib/server/config';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import * as messages from '../src/lib/server/db/repos/messages';
import * as settings from '../src/lib/server/db/repos/settings';

function setupTmpDataDir() {
	const dir = mkdtempSync(join(tmpdir(), 'portal-test-'));
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'none';
	process.env.I_KNOW_THIS_IS_LOCAL = '1';
	delete process.env.SESSION_SECRET;
	resetConfigForTests();
	closeDb();
	return dir;
}

describe('db migrations + repos', () => {
	beforeEach(() => setupTmpDataDir());

	it('runs migrations on open and creates tables', () => {
		const db = getDb();
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'conversations',
				'file_edits',
				'messages',
				'permission_decisions',
				'permission_grants',
				'schema_migrations',
				'tool_calls',
				'user_settings',
				'user_tokens',
				'users'
			])
		);
	});

	it('ensures local user idempotently', () => {
		const a = users.ensureLocalUser();
		const b = users.ensureLocalUser();
		expect(a.id).toBe(b.id);
		expect(a.githubLogin).toBe('local');
	});

	it('round-trips a conversation with messages', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: 'm' });
		messages.append(c.id, { role: 'user', content: 'hello' });
		messages.append(c.id, { role: 'assistant', content: 'world' });
		const list = messages.listByConversation(c.id);
		expect(list.map((m) => m.content)).toEqual(['hello', 'world']);

		// Authorization: another user can't read it.
		const other = users.upsertGithub({
			githubLogin: 'other',
			githubId: 42,
			displayName: null,
			avatarUrl: null
		});
		expect(convs.get(c.id, other.id)).toBeNull();
		expect(convs.get(c.id, u.id)?.title).toBe('t');
	});

	it('permission grants scope by conversation and global', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		expect(settings.hasGrant(u.id, c.id, 'shell')).toBe(false);
		settings.addGrant(u.id, c.id, 'shell');
		expect(settings.hasGrant(u.id, c.id, 'shell')).toBe(true);
		// '*' wildcard
		settings.addGrant(u.id, null, '*');
		expect(settings.hasGrant(u.id, c.id, 'read')).toBe(true);
	});

	it('saves and loads settings with defaults', () => {
		const u = users.ensureLocalUser();
		const s = settings.getOrDefault(u.id);
		expect(s.defaultPolicy).toBe('prompt');
		settings.save(u.id, {
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultPolicy: 'allow-readonly',
			theme: 'light'
		});
		expect(settings.getOrDefault(u.id)).toEqual({
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultPolicy: 'allow-readonly',
			theme: 'light'
		});
	});
});
