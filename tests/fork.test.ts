import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setupLocalEnv } from './helpers/env';

async function freshImports() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const snapshots = await import('../src/lib/server/snapshots');
	const fork = await import('../src/lib/server/fork');
	return { users, convs, messages, snapshots, fork };
}

describe('fork.forkAtMessage', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await setupLocalEnv('portal-fork-test-');
	});

	function workdirFor(convId: string): string {
		const dir = resolve(dataDir, 'workspaces', convId);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	it('clones prior history + the edited message and shares the source workdir', async () => {
		const { users, convs, messages, snapshots, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('shared');
		const sourceConv = convs.create(u.id, { title: 'src', workdir: wd, model: 'gpt-4' });

		// Turn 1: pre-snapshot then assistant reply.
		writeFileSync(join(wd, 'state.txt'), 'v1\n');
		const u1 = messages.append(sourceConv.id, { role: 'user', content: 'first' });
		await snapshots.snapshot(wd, u1.id, 'pre');
		messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });

		// Turn 2: workdir mutates, pre-snapshot, assistant reply.
		writeFileSync(join(wd, 'state.txt'), 'v2\n');
		const u2 = messages.append(sourceConv.id, { role: 'user', content: 'second' });
		await snapshots.snapshot(wd, u2.id, 'pre');
		messages.append(sourceConv.id, { role: 'assistant', content: 'reply 2' });

		// Workdir evolves further after the source thread.
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

		// Forked conversation shares the source workdir (no materialize).
		expect(newConv.workdir).toBe(sourceConv.workdir);
		// And the workdir is NOT rolled back — it still reflects the live state.
		expect(readFileSync(join(wd, 'state.txt'), 'utf8')).toBe('v3\n');

		// The new conversation has: u1, a1 (cloned) + the edited u2 (fresh).
		const cloned = messages.listByConversation(newConv.id);
		expect(cloned).toHaveLength(3);
		expect(cloned[0]).toMatchObject({ role: 'user', content: 'first' });
		expect(cloned[1]).toMatchObject({ role: 'assistant', content: 'reply 1' });
		expect(cloned[2]).toMatchObject({ role: 'user', content: 'second (edited)' });

		// IDs are fresh, not reused from source.
		const sourceIds = new Set(messages.listByConversation(sourceConv.id).map((m) => m.id));
		for (const m of cloned) expect(sourceIds.has(m.id)).toBe(false);

		// Source is untouched.
		expect(messages.listByConversation(sourceConv.id)).toHaveLength(4);
	});

	it('rejects edits on assistant messages when newContent is provided', async () => {
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
		).rejects.toMatchObject({ reason: 'content_not_allowed' });
	});

	it('requires newContent when editing a user message', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		const m = messages.append(conv.id, { role: 'user', content: 'hi' });
		await expect(
			fork.forkAtMessage({
				userId: u.id,
				sourceConversationId: conv.id,
				messageId: m.id,
				newContent: null
			})
		).rejects.toMatchObject({ reason: 'content_required' });
	});

	it('retries from an assistant message: clones up to and including it, no new user msg', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('shared-retry');
		const sourceConv = convs.create(u.id, { title: 'src', workdir: wd, model: null });

		messages.append(sourceConv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });
		messages.append(sourceConv.id, { role: 'user', content: 'second' });

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: a1.id,
			newContent: null
		});

		const newConv = result.conversation;
		expect(newConv.forkedFromMessageId).toBe(a1.id);
		expect(newConv.workdir).toBe(sourceConv.workdir);
		const cloned = messages.listByConversation(newConv.id);
		expect(cloned).toHaveLength(2);
		expect(cloned[0]).toMatchObject({ role: 'user', content: 'first' });
		expect(cloned[1]).toMatchObject({ role: 'assistant', content: 'reply 1' });
	});
});
