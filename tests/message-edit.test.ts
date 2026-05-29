import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

async function freshImports() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const memory = await import('../src/lib/server/db/repos/memory');
	const messages = await import('../src/lib/server/db/repos/messages');
	const usage = await import('../src/lib/server/db/repos/usage');
	const edit = await import('../src/lib/server/message-edit');
	const db = await import('../src/lib/server/db');
	return { users, convs, memory, messages, usage, edit, db };
}

describe('message-edit.inlineEditMessage', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-message-edit-test-');
	});

	it('updates the selected user message and transactionally removes later dependent rows', async () => {
		const { users, convs, messages, usage, edit, db } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 'src', workdir: '/tmp', model: null });
		const originalProviderSessionId = conv.providerSessionId;

		const u1 = messages.append(conv.id, { role: 'user', content: 'original' });
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply 1' });
		messages.insertToolCall(a1.id, {
			id: 'tool-later',
			tool: 'task',
			argsJson: '{}',
			resultJson: null,
			status: 'ok',
			startedAt: Date.now(),
			endedAt: Date.now(),
			textOffset: 0,
			parentToolCallId: null
		});
		messages.updateBackgroundAgentLifecycle('tool-later', 'agent-later', 'running');
		messages.insertFileEdit(a1.id, 'file.txt', 'diff', 0);
		messages.insertReasoningBlock(a1.id, {
			id: 'reason-later',
			segmentIndex: 0,
			text: 'thinking',
			textOffset: 0,
			startedAt: Date.now(),
			durationMs: 10,
			parentToolCallId: null
		});
		messages.append(conv.id, { role: 'user', content: 'later user' });
		usage.upsert(conv.id, {
			currentTokens: 9000,
			tokenLimit: 128_000,
			messagesLength: 3
		});

		const result = edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: u1.id,
			newContent: 'edited'
		});

		expect(result.userMessage).toMatchObject({ id: u1.id, content: 'edited', role: 'user' });
		expect(result.conversation.providerSessionId).not.toBe(originalProviderSessionId);
		expect(messages.listByConversation(conv.id)).toMatchObject([
			{ id: u1.id, role: 'user', content: 'edited' }
		]);
		expect(usage.get(conv.id)).toBeNull();

		const database = db.getDb();
		expect(database.prepare('SELECT count(*) AS n FROM tool_calls').get()).toMatchObject({ n: 0 });
		expect(database.prepare('SELECT count(*) AS n FROM file_edits').get()).toMatchObject({ n: 0 });
		expect(database.prepare('SELECT count(*) AS n FROM reasoning_blocks').get()).toMatchObject({
			n: 0
		});
		expect(
			database.prepare('SELECT count(*) AS n FROM background_agent_lifecycles').get()
		).toMatchObject({ n: 0 });
	});

	it('rejects assistant messages', async () => {
		const { users, convs, messages, edit } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 'src', workdir: '/tmp', model: null });
		const assistant = messages.append(conv.id, { role: 'assistant', content: 'reply' });

		expect(() =>
			edit.inlineEditMessage({
				userId: u.id,
				conversationId: conv.id,
				messageId: assistant.id,
				newContent: 'edited'
			})
		).toThrowError(expect.objectContaining({ reason: 'not_user_message' }));
	});

	it('restores memory state to before the edited user turn', async () => {
		const { users, convs, memory, messages, edit } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 'src', workdir: '/tmp', model: null });

		messages.append(conv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply 1' });
		const kept = memory.write(u.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			content: 'Kept memory.',
			source: 'model'
		});
		memory.snapshotForMessage(u.id, conv.id, a1.id);

		const u2 = messages.append(conv.id, { role: 'user', content: 'second' });
		messages.append(conv.id, { role: 'assistant', content: 'reply 2' });
		memory.update(kept.id, u.id, conv.id, { content: 'Mutated later memory.' });
		memory.write(u.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			content: 'Future memory.',
			source: 'harvester'
		});

		edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: u2.id,
			newContent: 'second edited'
		});

		expect(memory.query(u.id, conv.id, 'Future', { includeArchived: true })).toEqual([]);
		expect(memory.get(kept.id, u.id, conv.id)).toMatchObject({
			content: 'Kept memory.',
			status: 'active'
		});
	});
});
