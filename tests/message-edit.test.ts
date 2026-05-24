import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

async function freshImports() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const usage = await import('../src/lib/server/db/repos/usage');
	const edit = await import('../src/lib/server/message-edit');
	const db = await import('../src/lib/server/db');
	return { users, convs, messages, usage, edit, db };
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
});
