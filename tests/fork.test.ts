import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function setupTmpDataDir() {
	const dir = mkdtempSync(join(tmpdir(), 'portal-fork-test-'));
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'none';
	process.env.I_KNOW_THIS_IS_LOCAL = '1';
	delete process.env.SESSION_SECRET;
	return dir;
}

async function freshImports() {
	const { resetConfigForTests } = await import('../src/lib/server/config');
	resetConfigForTests();
	const { closeDb } = await import('../src/lib/server/db');
	closeDb();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const snapshots = await import('../src/lib/server/snapshots');
	const fork = await import('../src/lib/server/fork');
	return { users, convs, messages, snapshots, fork };
}

describe('fork.forkAtMessage', () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = setupTmpDataDir();
	});

	function managedWorkdirFor(convId: string): string {
		const dir = resolve(dataDir, 'workspaces', convId);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	it('creates a fork seeded with prior history, restored workdir, and the edited message', async () => {
		const { users, convs, messages, snapshots, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const sourceConv = convs.create(u.id, {
			title: 'src',
			workdir: '', // placeholder, set below
			model: 'gpt-4'
		});
		const wd = managedWorkdirFor(sourceConv.id);
		// Patch workdir column to the managed path.
		const { getDb } = await import('../src/lib/server/db');
		getDb().prepare('UPDATE conversations SET workdir = ? WHERE id = ?').run(wd, sourceConv.id);

		// Turn 1: user → assistant. We capture a pre-snapshot before turn 1.
		writeFileSync(join(wd, 'state.txt'), 'v1\n');
		const u1 = messages.append(sourceConv.id, { role: 'user', content: 'first' });
		await snapshots.snapshot(wd, u1.id, 'pre');
		messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });

		// Workdir evolves; turn 2 starts.
		writeFileSync(join(wd, 'state.txt'), 'v2\n');
		const u2 = messages.append(sourceConv.id, { role: 'user', content: 'second' });
		await snapshots.snapshot(wd, u2.id, 'pre');
		messages.append(sourceConv.id, { role: 'assistant', content: 'reply 2' });

		// Workdir evolves again post-turn.
		writeFileSync(join(wd, 'state.txt'), 'v3\n');

		// Edit turn 2's user message.
		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: u2.id,
			newContent: 'second (edited)'
		});

		const newConv = result.conversation;
		expect(newConv.forkedFromConversationId).toBe(sourceConv.id);
		expect(newConv.forkedFromMessageId).toBe(u2.id);

		// The new workdir exists and has the state captured at u2's pre-snapshot.
		expect(existsSync(newConv.workdir)).toBe(true);
		expect(readFileSync(join(newConv.workdir, 'state.txt'), 'utf8')).toBe('v2\n');

		// The new conversation has: u1, a1 (cloned) + the edited u2 (fresh).
		const cloned = messages.listByConversation(newConv.id);
		expect(cloned).toHaveLength(3);
		expect(cloned[0].role).toBe('user');
		expect(cloned[0].content).toBe('first');
		expect(cloned[1].role).toBe('assistant');
		expect(cloned[1].content).toBe('reply 1');
		expect(cloned[2].role).toBe('user');
		expect(cloned[2].content).toBe('second (edited)');

		// IDs are fresh, not reused from source.
		const sourceIds = new Set(messages.listByConversation(sourceConv.id).map((m) => m.id));
		for (const m of cloned) expect(sourceIds.has(m.id)).toBe(false);

		// Source is untouched.
		expect(messages.listByConversation(sourceConv.id)).toHaveLength(4);
		expect(readFileSync(join(wd, 'state.txt'), 'utf8')).toBe('v3\n');
	});

	it('rejects forks from assistant messages', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		const a = messages.append(conv.id, { role: 'assistant', content: 'reply' });
		await expect(
			fork.forkAtMessage({
				userId: u.id,
				sourceConversationId: conv.id,
				messageId: a.id,
				newContent: 'nope'
			})
		).rejects.toMatchObject({ reason: 'not_user_message' });
	});

	it('rejects forks when no snapshot exists for the target message', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		const m = messages.append(conv.id, { role: 'user', content: 'hi' });
		await expect(
			fork.forkAtMessage({
				userId: u.id,
				sourceConversationId: conv.id,
				messageId: m.id,
				newContent: 'edit'
			})
		).rejects.toMatchObject({ reason: 'no_snapshot' });
	});

	it('rejects forks for unmanaged (BYO) workdirs', async () => {
		const { users, convs, messages, snapshots, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = mkdtempSync(join(tmpdir(), 'byo-'));
		const conv = convs.create(u.id, { title: 't', workdir: wd, model: null });
		const m = messages.append(conv.id, { role: 'user', content: 'hi' });
		writeFileSync(join(wd, 'x.txt'), 'x\n');
		await snapshots.snapshot(wd, m.id, 'pre');
		await expect(
			fork.forkAtMessage({
				userId: u.id,
				sourceConversationId: conv.id,
				messageId: m.id,
				newContent: 'edit'
			})
		).rejects.toMatchObject({ reason: 'unsupported_workdir' });
	});
});
