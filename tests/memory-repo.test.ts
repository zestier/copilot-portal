import { beforeEach, describe, expect, it } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

async function setup() {
	await setupLocalEnv('portal-memory-');
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const memory = await import('../src/lib/server/db/repos/memory');
	const messages = await import('../src/lib/server/db/repos/messages');
	const user = users.ensureLocalUser();
	const otherUser = users.upsertGithub({
		githubLogin: 'memory-rival',
		githubId: 8181,
		displayName: null,
		avatarUrl: null
	});
	const conv = convs.create(user.id, {
		title: 'Memory test',
		workdir: makeTmpDir('portal-memory-wd-'),
		model: 'gpt-4'
	});
	const other = convs.create(user.id, {
		title: 'Other memory test',
		workdir: makeTmpDir('portal-memory-wd-'),
		model: 'gpt-4'
	});
	return { memory, messages, user, otherUser, conv, other };
}

describe('memory repo', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-memory-');
	});

	it('upserts by entity, addresses by handle, updates, forgets, and supersedes', async () => {
		const { memory, user, conv, other } = await setup();

		const first = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'contract',
			entity: 'api',
			content: { response_case: 'snake_case' },
			tags: ['api', 'contract', 'api'],
			importance: 4,
			source: 'model'
		});
		// Re-writing the same scope+entity refines the existing row in place.
		const refined = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'contract',
			entity: 'api',
			content: { response_case: 'camelCase' },
			source: 'harvester'
		});
		expect(refined.id).toBe(first.id);
		expect(memory.list(user.id, conv.id).map((row) => row.id)).toEqual([first.id]);
		expect(memory.get(first.id, user.id, conv.id)).toMatchObject({
			content: { response_case: 'camelCase' },
			source: 'harvester'
		});
		expect(first.tags).toEqual(['api', 'contract']);

		expect(
			memory.updateByEntity(user.id, other.id, 'api', 'session', { content: 'Nope.' })
		).toBeNull();
		const updated = memory.updateByEntity(user.id, conv.id, 'api', 'session', {
			content: 'Responses use camelCase.',
			importance: 5
		});
		expect(updated?.content).toBe('Responses use camelCase.');
		expect(updated?.importance).toBe(5);

		const replacement = memory.supersede(first.id, user.id, conv.id, {
			scope: 'session',
			kind: 'contract',
			entity: 'api',
			content: 'Responses use PascalCase.',
			source: 'model'
		});
		expect(replacement.supersedesId).toBe(first.id);
		expect(memory.get(first.id, user.id, conv.id)?.status).toBe('superseded');
		expect(memory.list(user.id, conv.id).map((row) => row.id)).toEqual([replacement.id]);

		expect(memory.forgetByEntity(user.id, conv.id, 'api', 'session')).toBe(true);
		expect(memory.list(user.id, conv.id).map((row) => row.id)).toEqual([]);
		expect(memory.list(user.id, conv.id, { status: 'forgotten' }).map((row) => row.id)).toEqual([
			replacement.id
		]);
	});

	it('auto-slugs a missing entity and can change kind in place', async () => {
		const { memory, user, conv } = await setup();

		const row = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'bugfix',
			content: 'Off-by-one in pager.',
			source: 'model'
		});
		expect(row.entity).toMatch(/^auto\.bugfix\.[0-9a-f]+$/);
		const handle = row.entity ?? '';

		const recategorized = memory.updateByEntity(user.id, conv.id, handle, 'session', {
			kind: 'decision'
		});
		expect(recategorized?.id).toBe(row.id);
		expect(recategorized?.kind).toBe('decision');
		expect(memory.list(user.id, conv.id)).toHaveLength(1);

		const stillAddressable = memory.update(row.id, user.id, conv.id, { entity: null });
		expect(stillAddressable?.id).toBe(row.id);
		expect(stillAddressable?.entity).toMatch(/^auto\.decision\.[0-9a-f]+$/);
	});

	it('requires a scope to resolve a handle active in more than one scope', async () => {
		const { memory, user, conv } = await setup();
		memory.openScene(user.id, conv.id, 'Now');
		memory.write(user.id, conv.id, {
			scope: 'scene',
			kind: 'scene_state',
			entity: 'mark',
			content: 'Mark stands by the door.',
			source: 'model'
		});
		memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'character',
			entity: 'mark',
			content: 'Mark is terse.',
			source: 'model'
		});

		expect(() => memory.resolveActive(user.id, conv.id, 'mark')).toThrow('specify scope');
		expect(memory.resolveActive(user.id, conv.id, 'mark', 'session')?.content).toBe(
			'Mark is terse.'
		);
	});

	it('archives scene memories when a scene closes', async () => {
		const { memory, user, conv } = await setup();

		const scene = memory.openScene(user.id, conv.id, 'Gloves');
		const sceneMemory = memory.write(user.id, conv.id, {
			scope: 'scene',
			kind: 'scene_state',
			entity: 'Mark',
			content: 'Mark is wearing gloves.',
			source: 'model'
		});
		const sessionMemory = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'preference',
			entity: 'Mark',
			content: 'Mark prefers terse status updates.',
			source: 'model'
		});

		expect(sceneMemory.sceneId).toBe(scene.id);
		const closed = memory.closeScene(user.id, conv.id);
		expect(closed).toMatchObject({ sceneId: scene.id, archived: 1 });
		expect(memory.get(sceneMemory.id, user.id, conv.id)?.status).toBe('archived');
		expect(memory.get(sceneMemory.id, user.id, conv.id)?.expiresAt).toBeTypeOf('number');
		expect(memory.get(sessionMemory.id, user.id, conv.id)?.status).toBe('active');
		expect(memory.currentScene(user.id, conv.id)).toBeNull();
	});

	it('isolates memories by conversation and user and validates explicit scene ids', async () => {
		const { memory, user, otherUser, conv, other } = await setup();
		const scene = memory.openScene(user.id, other.id, 'Other scene');
		const row = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			content: 'Only the first conversation can see this.',
			source: 'model'
		});

		expect(memory.list(user.id, other.id)).toEqual([]);
		expect(memory.query(user.id, other.id, 'first conversation')).toEqual([]);
		expect(memory.get(row.id, user.id, other.id)).toBeNull();
		expect(memory.forget(row.id, user.id, other.id)).toBe(false);
		expect(memory.list(otherUser.id, conv.id)).toEqual([]);
		expect(memory.get(row.id, otherUser.id, conv.id)).toBeNull();

		expect(() =>
			memory.write(user.id, conv.id, {
				scope: 'scene',
				sceneId: scene.id,
				kind: 'scene_state',
				content: 'This should not attach to another conversation scene.',
				source: 'model'
			})
		).toThrow('Memory scene not found');
	});

	it('queries FTS and builds a budgeted digest by scope, importance, and recency', async () => {
		const { memory, user, conv } = await setup();
		const scene = memory.openScene(user.id, conv.id, 'Now');
		const low = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			entity: 'low',
			content: 'low priority zebra detail',
			importance: 1,
			source: 'model'
		});
		const high = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			entity: 'high',
			content: 'high priority zebra detail',
			importance: 5,
			source: 'model'
		});
		const sceneRow = memory.write(user.id, conv.id, {
			scope: 'scene',
			kind: 'scene_state',
			entity: 'scene',
			content: 'scene zebra detail',
			importance: 1,
			source: 'model'
		});

		expect(memory.query(user.id, conv.id, 'zebra').map((row) => row.id)).toEqual([
			sceneRow.id,
			high.id,
			low.id
		]);
		memory.closeScene(user.id, conv.id);
		expect(memory.query(user.id, conv.id, 'scene zebra').map((row) => row.id)).toEqual([]);
		expect(
			memory.query(user.id, conv.id, 'scene zebra', { includeArchived: true }).map((row) => row.id)
		).toEqual([sceneRow.id]);

		const digest = memory.getActiveDigest(user.id, conv.id, 60);
		expect(digest.map((row) => row.id)).toContain(high.id);
		expect(digest.map((row) => row.id)).not.toContain(low.id);
		expect(scene.id).toBeTruthy();
	});

	it('snapshots and restores the full memory-bank state for a message', async () => {
		const { memory, messages, user, conv } = await setup();
		const assistant = messages.append(conv.id, { role: 'assistant', content: 'first reply' });
		const scene = memory.openScene(user.id, conv.id, 'Scene A');
		const sceneMemory = memory.write(user.id, conv.id, {
			scope: 'scene',
			kind: 'scene_state',
			entity: 'scene',
			content: 'Scene fact.',
			source: 'model'
		});
		const sessionMemory = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'preference',
			entity: 'prefs',
			content: 'Use terse replies.',
			source: 'harvester'
		});
		memory.snapshotForMessage(user.id, conv.id, assistant.id);

		memory.closeScene(user.id, conv.id);
		memory.update(sessionMemory.id, user.id, conv.id, { content: 'Use verbose replies.' });
		memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			content: 'Future-only fact.',
			source: 'model'
		});

		expect(memory.restoreSnapshotToConversation(user.id, conv.id, assistant.id)).toBe(true);
		expect(memory.currentScene(user.id, conv.id)).toMatchObject({
			id: scene.id,
			label: 'Scene A'
		});
		expect(memory.get(sceneMemory.id, user.id, conv.id)).toMatchObject({
			status: 'active',
			content: 'Scene fact.'
		});
		expect(memory.get(sessionMemory.id, user.id, conv.id)).toMatchObject({
			status: 'active',
			content: 'Use terse replies.'
		});
		expect(memory.query(user.id, conv.id, 'Future-only', { includeArchived: true })).toEqual([]);
	});
});
