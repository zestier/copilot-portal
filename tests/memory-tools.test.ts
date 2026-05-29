import { beforeEach, describe, expect, it } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

async function setupTools() {
	await setupLocalEnv('portal-memory-tools-');
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const memory = await import('../src/lib/server/db/repos/memory');
	const { buildMemoryTools } = await import('../src/lib/server/tools/memory');
	const user = users.ensureLocalUser();
	const otherUser = users.upsertGithub({
		githubLogin: 'memory-tools-rival',
		githubId: 9090,
		displayName: null,
		avatarUrl: null
	});
	const conv = convs.create(user.id, {
		title: 'Memory tools',
		workdir: makeTmpDir('portal-memory-tools-wd-'),
		model: 'gpt-4'
	});
	const tools = buildMemoryTools({ userId: user.id, conversationId: conv.id });
	const rivalTools = buildMemoryTools({ userId: otherUser.id, conversationId: conv.id });
	return { memory, user, conv, tools, rivalTools };
}

describe('memory tools', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-memory-tools-');
	});

	it('writes, queries, updates, forgets, and manages scenes', async () => {
		const { memory, user, conv, tools } = await setupTools();
		const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

		expect(byName.memory_write.description).toContain('typed structured memory');
		expect(JSON.stringify(byName.memory_write.parameters)).toContain('story.protagonist.mara');

		await expect(
			byName.memory_write.handler({
				scope: 'session',
				kind: 'preference',
				entity: 'user.pref.drink',
				content: { subject: 'Mark', likes: 'tea' }
			})
		).resolves.toContain('Recorded memory');
		const [row] = memory.list(user.id, conv.id);
		expect(row.kind).toBe('preference');
		expect(row.entity).toBe('user.pref.drink');
		expect(row.content).toEqual({ subject: 'Mark', likes: 'tea' });

		await expect(byName.memory_query.handler({ q: 'tea' })).resolves.toContain('"likes":"tea"');
		await expect(byName.memory_update.handler({ entity: row.entity })).rejects.toThrow(
			'No fields to update'
		);
		await expect(
			byName.memory_update.handler({
				entity: row.entity,
				kind: 'contract',
				content: { subject: 'Mark', likes: 'coffee' },
				importance: 5
			})
		).resolves.toContain('"likes":"coffee"');
		expect(memory.get(row.id, user.id, conv.id)?.importance).toBe(5);
		expect(memory.get(row.id, user.id, conv.id)?.kind).toBe('contract');

		await expect(byName.memory_scene_end.handler({})).resolves.toBe('No memory scene is open.');
		await expect(byName.memory_scene_start.handler({ label: 'Scene A' })).resolves.toContain(
			'Started memory scene'
		);
		await byName.memory_write.handler({
			scope: 'scene',
			kind: 'scene_state',
			entity: 'Mark',
			content: { wearing: 'gloves' }
		});
		await expect(byName.memory_scene_end.handler({})).resolves.toContain('archived 1');

		await expect(byName.memory_forget.handler({ entity: row.entity })).resolves.toContain(
			'Forgot memory'
		);
		expect(memory.get(row.id, user.id, conv.id)?.status).toBe('forgotten');
		await expect(byName.memory_query.handler({ q: 'nonexistent' })).resolves.toBe(
			'(no memory matches)'
		);
	});

	it('auto-generates an entity handle when none is supplied and updates by handle', async () => {
		const { memory, user, conv, tools } = await setupTools();
		const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

		await byName.memory_write.handler({
			scope: 'session',
			kind: 'bugfix',
			content: 'Off-by-one in pagination.'
		});
		const [row] = memory.list(user.id, conv.id);
		expect(row.entity).toMatch(/^auto\.bugfix\.[0-9a-f]+$/);

		await expect(
			byName.memory_update.handler({ entity: row.entity, content: 'Fixed in pager.ts.' })
		).resolves.toContain('Fixed in pager.ts.');
		expect(memory.list(user.id, conv.id)).toHaveLength(1);
	});

	it('rejects tools when the user does not own the conversation', async () => {
		const { rivalTools } = await setupTools();
		const byName = Object.fromEntries(rivalTools.map((tool) => [tool.name, tool]));

		await expect(
			byName.memory_write.handler({ scope: 'session', kind: 'fact', content: 'Should not write.' })
		).rejects.toThrow('Conversation not found');
		await expect(byName.memory_scene_start.handler({ label: 'Nope' })).rejects.toThrow(
			'Conversation not found'
		);
		await expect(byName.memory_query.handler({ q: 'anything' })).resolves.toBe(
			'(no memory matches)'
		);
	});
});
