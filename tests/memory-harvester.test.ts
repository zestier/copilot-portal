import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

const openMock = vi.fn();
const deleteProviderSessionMock = vi.fn();
vi.mock('../src/lib/server/providers', () => ({
	open: (...args: unknown[]) => openMock(...args),
	deleteProviderSession: (...args: unknown[]) => deleteProviderSessionMock(...args)
}));
vi.mock('../src/lib/server/copilot/bridge-stub', () => ({
	isStubMode: () => false
}));

function fakeSession(response: string, gate?: Promise<void>, reasoning?: string) {
	return {
		async *send(): AsyncIterable<PortalEvent> {
			if (gate) await gate;
			if (reasoning)
				yield { type: 'message.reasoning', messageId: 'harvest', segmentId: 'r1', text: reasoning };
			yield { type: 'message.delta', messageId: 'harvest', text: response };
			yield { type: 'done' };
		},
		async dispose() {}
	};
}

async function setupHarvester() {
	await setupLocalEnv('portal-memory-harvester-');
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const memory = await import('../src/lib/server/db/repos/memory');
	const messages = await import('../src/lib/server/db/repos/messages');
	const harvester = await import('../src/lib/server/copilot/memory-harvester');
	const user = users.ensureLocalUser();
	const otherUser = users.upsertGithub({
		githubLogin: 'memory-harvest-rival',
		githubId: 9191,
		displayName: null,
		avatarUrl: null
	});
	const conv = convs.create(user.id, {
		title: 'Memory harvester',
		workdir: makeTmpDir('portal-memory-harvester-wd-'),
		model: 'gpt-4'
	});
	return { user, otherUser, conv, memory, messages, harvester };
}

describe('memory harvester', () => {
	beforeEach(async () => {
		openMock.mockReset();
		deleteProviderSessionMock.mockReset();
		deleteProviderSessionMock.mockResolvedValue(true);
		await setupLocalEnv('portal-memory-harvester-');
	});

	it('applies writes, updates, forgets, and scene endings', async () => {
		const { user, conv, memory, messages, harvester } = await setupHarvester();
		const existing = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'preference',
			entity: 'Mark',
			content: 'Mark likes tea.',
			source: 'model'
		});
		const forgotten = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			entity: 'Old',
			content: 'Forget this.',
			source: 'model'
		});
		memory.openScene(user.id, conv.id, 'Scene A');
		openMock.mockResolvedValue(
			fakeSession(
				JSON.stringify({
					writes: [
						{
							scope: 'scene',
							kind: 'scene_state',
							entity: 'story.character.mark.current',
							content: { wearing: 'gloves' }
						}
					],
					updates: [
						{
							entity: 'Mark',
							scope: 'session',
							content: { preference: 'coffee' },
							importance: 5
						}
					],
					forgets: [{ entity: 'Old', scope: 'session' }, { entity: 'not-owned' }],
					scene_end: true
				}),
				undefined,
				'Use the latest correction.'
			)
		);
		const updates: string[] = [];

		const assistant = messages.append(conv.id, { role: 'assistant', content: '' });
		const scheduled = harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				provider: conv.provider,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: assistant.id,
			userPrompt: 'Mark put on gloves.',
			assistantReply: 'x'.repeat(250),
			onUpdate: (record) => updates.push(record.status)
		});
		await scheduled?.finished;

		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ disableTools: true }));
		expect(updates).toEqual(['pending', 'applied']);
		expect(deleteProviderSessionMock).toHaveBeenCalledWith(
			conv.provider,
			expect.objectContaining({
				userId: user.id,
				providerSessionId: expect.any(String)
			})
		);
		expect(memory.get(existing.id, user.id, conv.id)?.content).toEqual({ preference: 'coffee' });
		expect(memory.get(existing.id, user.id, conv.id)?.importance).toBe(5);
		expect(memory.get(forgotten.id, user.id, conv.id)?.status).toBe('forgotten');
		expect(memory.query(user.id, conv.id, 'gloves', { includeArchived: true })[0]?.status).toBe(
			'archived'
		);
		expect(memory.currentScene(user.id, conv.id)).toBeNull();
		const harvest = messages
			.listByConversation(conv.id)
			.find((m) => m.id === assistant.id)?.memoryHarvest;
		expect(harvest).toMatchObject({
			status: 'applied',
			writes: 1,
			updates: 1,
			forgets: 1,
			sceneEnded: true,
			reasoning: 'Use the latest correction.'
		});
		expect(harvest?.prompt).toContain('Latest user message:\nMark put on gloves.');
		expect(harvest?.prompt).toContain(`source=model`);
		expect(harvest?.prompt).toContain('typed structured record');
		expect(harvest?.prompt).toContain('Use kind as the mutable record category');
		expect(harvest?.prompt).toContain('Use content as native JSON');
		expect(harvest?.prompt).toContain(
			'"kind":"character|plot_thread|scene_state|style|bugfix|..."'
		);
		expect(harvest?.prompt).toContain('To split a mixed-topic memory');
		expect(harvest?.response).toContain('coffee');
		expect(JSON.parse(harvest?.parsedJson ?? '{}')).toMatchObject({
			updates: [{ entity: 'Mark', content: { preference: 'coffee' }, importance: 5 }]
		});
		expect(JSON.parse(harvest?.changesJson ?? '[]')).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: 'update',
					status: 'applied',
					memoryId: existing.id,
					before: expect.objectContaining({ content: 'Mark likes tea.' }),
					after: expect.objectContaining({ content: { preference: 'coffee' } })
				}),
				expect.objectContaining({
					action: 'forget',
					status: 'skipped',
					reason: 'memory_not_found_or_not_owned',
					requested: expect.objectContaining({ entity: 'not-owned' })
				})
			])
		);
	});

	it('skips short replies and ignores malformed JSON', async () => {
		const { user, conv, memory, messages, harvester } = await setupHarvester();
		const shortAssistant = messages.append(conv.id, { role: 'assistant', content: '' });
		harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: shortAssistant.id,
			userPrompt: 'short',
			assistantReply: 'too short'
		});
		await harvester.waitForHarvestsForTests(conv.id);
		expect(openMock).not.toHaveBeenCalled();
		expect(
			messages.listByConversation(conv.id).find((m) => m.id === shortAssistant.id)?.memoryHarvest
		).toMatchObject({ status: 'skipped', reason: 'assistant_reply_too_short' });

		openMock.mockResolvedValue(fakeSession('not json'));
		const malformedAssistant = messages.append(conv.id, { role: 'assistant', content: '' });
		harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: malformedAssistant.id,
			userPrompt: 'long',
			assistantReply: 'x'.repeat(250)
		});
		await harvester.waitForHarvestsForTests(conv.id);
		expect(memory.list(user.id, conv.id)).toEqual([]);
		expect(
			messages.listByConversation(conv.id).find((m) => m.id === malformedAssistant.id)
				?.memoryHarvest
		).toMatchObject({ status: 'failed', reason: 'missing_json' });

		openMock.mockResolvedValue(
			fakeSession(
				JSON.stringify({
					writes: [{ scope: 'session', kind: 'fact', content: 'x'.repeat(9000) }]
				})
			)
		);
		const oversizedAssistant = messages.append(conv.id, { role: 'assistant', content: '' });
		harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: oversizedAssistant.id,
			userPrompt: 'long',
			assistantReply: 'x'.repeat(250)
		});
		await harvester.waitForHarvestsForTests(conv.id);
		expect(memory.list(user.id, conv.id)).toEqual([]);
		expect(
			messages.listByConversation(conv.id).find((m) => m.id === oversizedAssistant.id)
				?.memoryHarvest
		).toMatchObject({
			status: 'failed',
			reason: 'invalid_json_shape',
			error: expect.stringContaining('Content is too large')
		});
	});

	it('skips harvesting when the conversation memory level is below harvester', async () => {
		const { user, conv, harvester } = await setupHarvester();
		harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt',
				memoryLevel: 'injector'
			},
			assistantMessageId: 'assistant-disabled',
			userPrompt: 'remember this',
			assistantReply: 'x'.repeat(250)
		});
		await harvester.waitForHarvestsForTests(conv.id);

		expect(openMock).not.toHaveBeenCalled();
	});

	it('creates an active scene when harvesting a scene memory without one open', async () => {
		const { user, conv, memory, messages, harvester } = await setupHarvester();
		openMock.mockResolvedValue(
			fakeSession(
				JSON.stringify({
					writes: [
						{
							scope: 'scene',
							kind: 'scene_state',
							entity: 'story.character.mark.current',
							content: { wearing: 'gloves' }
						}
					]
				})
			)
		);

		const assistant = messages.append(conv.id, { role: 'assistant', content: '' });
		harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: assistant.id,
			userPrompt: 'Mark put on gloves.',
			assistantReply: 'x'.repeat(250)
		});
		await harvester.waitForHarvestsForTests(conv.id);

		const scene = memory.currentScene(user.id, conv.id);
		expect(scene).not.toBeNull();
		const sceneMemory = memory.query(user.id, conv.id, 'gloves')[0];
		expect(sceneMemory).toMatchObject({
			scope: 'scene',
			sceneId: scene?.id,
			content: { wearing: 'gloves' }
		});
		expect(
			messages.listByConversation(conv.id).find((m) => m.id === assistant.id)?.memoryHarvest
		).toMatchObject({
			status: 'applied',
			writes: 1
		});
	});

	it('serializes harvests per conversation', async () => {
		const { user, conv, memory, messages, harvester } = await setupHarvester();
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		openMock
			.mockResolvedValueOnce(
				fakeSession(
					JSON.stringify({
						writes: [{ scope: 'session', kind: 'fact', content: 'first memory' }]
					}),
					firstGate
				)
			)
			.mockResolvedValueOnce(
				fakeSession(
					JSON.stringify({
						writes: [{ scope: 'session', kind: 'fact', content: 'second memory' }]
					})
				)
			);
		const bridge = {
			conversationId: conv.id,
			userId: user.id,
			workingDirectory: conv.workdir,
			model: 'gpt-4',
			policy: 'prompt' as const
		};

		const firstAssistant = messages.append(conv.id, { role: 'assistant', content: '' });
		const secondAssistant = messages.append(conv.id, { role: 'assistant', content: '' });
		harvester.scheduleHarvest({
			bridge,
			assistantMessageId: firstAssistant.id,
			userPrompt: 'first',
			assistantReply: 'x'.repeat(250)
		});
		harvester.scheduleHarvest({
			bridge,
			assistantMessageId: secondAssistant.id,
			userPrompt: 'second',
			assistantReply: 'x'.repeat(250)
		});
		expect(openMock).toHaveBeenCalledTimes(0);
		await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
		releaseFirst();
		await harvester.waitForHarvestsForTests(conv.id);

		expect(memory.query(user.id, conv.id, 'first').map((row) => row.content)).toEqual([
			'first memory'
		]);
		expect(memory.query(user.id, conv.id, 'second').map((row) => row.content)).toEqual([
			'second memory'
		]);
	});

	it('does not overwrite memories changed after harvesting starts', async () => {
		const { user, conv, memory, messages, harvester } = await setupHarvester();
		const existing = memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'preference',
			entity: 'Mark',
			content: 'Mark likes tea.',
			source: 'model'
		});
		let releaseHarvest!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseHarvest = resolve;
		});
		openMock.mockResolvedValue(
			fakeSession(
				JSON.stringify({
					updates: [{ entity: 'Mark', scope: 'session', content: 'Stale harvester update.' }],
					forgets: [{ entity: 'Mark', scope: 'session' }]
				}),
				gate
			)
		);

		const assistant = messages.append(conv.id, { role: 'assistant', content: '' });
		harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: assistant.id,
			userPrompt: 'start',
			assistantReply: 'x'.repeat(250)
		});
		await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
		memory.update(existing.id, user.id, conv.id, { content: 'User corrected this.' });
		releaseHarvest();
		await harvester.waitForHarvestsForTests(conv.id);

		expect(memory.get(existing.id, user.id, conv.id)).toMatchObject({
			content: 'User corrected this.',
			status: 'active'
		});
	});

	it('does not apply harvest output for a user that does not own the conversation', async () => {
		const { otherUser, conv, memory, messages, harvester } = await setupHarvester();
		openMock.mockResolvedValue(
			fakeSession(
				JSON.stringify({ writes: [{ scope: 'session', kind: 'fact', content: 'wrong user' }] })
			)
		);

		const assistant = messages.append(conv.id, { role: 'assistant', content: '' });
		harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: otherUser.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: assistant.id,
			userPrompt: 'remember this',
			assistantReply: 'x'.repeat(250)
		});
		await harvester.waitForHarvestsForTests(conv.id);

		expect(memory.list(otherUser.id, conv.id)).toEqual([]);
	});

	it('runs onSettled only after the gated harvest applies, and gates waitForPendingHarvest', async () => {
		const { user, conv, memory, messages, harvester } = await setupHarvester();
		let releaseHarvest!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseHarvest = resolve;
		});
		openMock.mockResolvedValue(
			fakeSession(
				JSON.stringify({
					writes: [{ scope: 'session', kind: 'fact', entity: 'Mark', content: 'harvested' }]
				}),
				gate
			)
		);

		const assistant = messages.append(conv.id, { role: 'assistant', content: '' });
		let memoryAtSettle: string | undefined;
		const scheduled = harvester.scheduleHarvest({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: conv.workdir,
				model: 'gpt-4',
				policy: 'prompt'
			},
			assistantMessageId: assistant.id,
			userPrompt: 'remember this',
			assistantReply: 'x'.repeat(250),
			// onSettled must observe the harvested write, proving it runs after
			// the bank mutation lands rather than before/concurrently.
			onSettled: () => {
				memoryAtSettle = memory.list(user.id, conv.id).find((row) => row.entity === 'Mark')
					?.content as string | undefined;
			}
		});

		// While the harvest is gated, waitForPendingHarvest must not resolve and
		// onSettled must not have run.
		let pendingResolved = false;
		void harvester.waitForPendingHarvest(conv.id).then(() => {
			pendingResolved = true;
		});
		await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		expect(pendingResolved).toBe(false);
		expect(memoryAtSettle).toBeUndefined();

		releaseHarvest();
		await scheduled?.finished;
		await harvester.waitForPendingHarvest(conv.id);

		expect(memoryAtSettle).toBe('harvested');
		expect(pendingResolved).toBe(true);
	});
});
