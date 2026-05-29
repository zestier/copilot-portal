import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import { makeFakeSession } from './helpers/fake-session';

// Mock the session pool so turn-runner doesn't try to spin up the real SDK.
const acquireMock = vi.fn();
vi.mock('../src/lib/server/copilot/pool', () => ({
	acquire: (...args: unknown[]) => acquireMock(...args)
}));

// Mock the provider surface the background harvester opens, so a full
// harvest pass can run in-process without real credentials.
const harvestOpenMock = vi.fn();
const deleteProviderSessionMock = vi.fn().mockResolvedValue(true);
vi.mock('../src/lib/server/providers', () => ({
	open: (...args: unknown[]) => harvestOpenMock(...args),
	deleteProviderSession: (...args: unknown[]) => deleteProviderSessionMock(...args)
}));

function fakeHarvestSession(response: string) {
	return {
		async *send(): AsyncIterable<PortalEvent> {
			yield { type: 'message.delta', messageId: 'harvest', text: response };
			yield { type: 'done' };
		},
		async dispose() {}
	};
}

async function freshImports() {
	vi.resetModules();
	await setupLocalEnv();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const turnRunner = await import('../src/lib/server/runtime/turn-runner');
	return { users, convs, turnRunner };
}

describe('turn-runner', () => {
	beforeEach(() => {
		acquireMock.mockReset();
		harvestOpenMock.mockReset();
		deleteProviderSessionMock.mockReset();
		deleteProviderSessionMock.mockResolvedValue(true);
	});

	it('marks a turn running before opening the provider session', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'Custom title',
			workdir: wd,
			model: 'gpt-4'
		});
		let resolveAcquire: (session: ReturnType<typeof makeFakeSession>) => void = () => {};
		acquireMock.mockReturnValue(
			new Promise((resolve) => {
				resolveAcquire = resolve;
			})
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		expect(turnRunner.getTurn(conv.id)).toBe(turn);
		await expect(
			turnRunner.startTurn({
				bridge: {
					conversationId: conv.id,
					userId: user.id,
					workingDirectory: wd,
					model: 'gpt-4',
					policy: 'prompt'
				},
				prompt: 'second',
				conversationId: conv.id
			})
		).rejects.toThrow('turn already in progress');

		resolveAcquire(makeFakeSession([{ type: 'done' }], conv.id, wd));
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}
	});

	it('replays initial conversation.update before the terminal done', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'New chat',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'hi' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'Help me write a haiku about TypeScript',
			conversationId: conv.id,
			initialEvents: [
				{
					type: 'conversation.update',
					conversationId: conv.id,
					title: 'Help me write a haiku'
				}
			]
		});

		const received: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			received.push(event);
			if (event.type === 'done') break;
		}

		// Exactly one terminal `done`, and it must come last.
		const doneIndices = received.map((e, i) => (e.type === 'done' ? i : -1)).filter((i) => i >= 0);
		expect(doneIndices).toEqual([received.length - 1]);

		// The initial conversation.update must arrive before `done`.
		const updateIdx = received.findIndex((e) => e.type === 'conversation.update');
		expect(updateIdx).toBeGreaterThanOrEqual(0);
		expect(updateIdx).toBeLessThan(received.length - 1);
		const update = received[updateIdx];
		if (update.type !== 'conversation.update') throw new Error('unreachable');
		expect(update.conversationId).toBe(conv.id);
		expect(update.title).toBe('Help me write a haiku');
		expect(convs.get(conv.id, user.id)?.title).toBe('New chat');
	});

	it('only injects active memories when the memory level includes the injector', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const memory = await import('../src/lib/server/db/repos/memory');
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'memory levels',
			workdir: wd,
			model: 'gpt-4'
		});
		memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'contract',
			content: 'The response format uses snake_case.',
			source: 'model'
		});
		const sentPrompts: string[] = [];
		let sendCount = 0;
		acquireMock.mockResolvedValue({
			conversationId: conv.id,
			workingDirectory: wd,
			model: 'gpt-4',
			async *send(prompt: string): AsyncIterable<PortalEvent> {
				sendCount += 1;
				const messageId = `assistant-${sendCount}`;
				sentPrompts.push(prompt);
				yield { type: 'message.start', messageId, role: 'assistant' };
				yield { type: 'message.delta', messageId, text: `reply ${sendCount}` };
				yield { type: 'done' };
			},
			async abort() {},
			async dispose() {},
			lastUsed: Date.now()
		});

		const toolsOnly = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt',
				memoryLevel: 'tools'
			},
			prompt: 'hi',
			conversationId: conv.id
		});
		for await (const { event } of toolsOnly.subscribe()) {
			if (event.type === 'done') break;
		}
		const withInjector = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt',
				memoryLevel: 'injector'
			},
			prompt: 'hi',
			conversationId: conv.id
		});
		for await (const { event } of withInjector.subscribe()) {
			if (event.type === 'done') break;
		}

		expect(sentPrompts[0]).not.toContain('[Memory bank');
		expect(sentPrompts[0]).not.toContain('snake_case');
		expect(sentPrompts[1]).toContain('[Memory bank');
		expect(sentPrompts[1]).toContain('snake_case');
		const assistantMessages = messages
			.listByConversation(conv.id)
			.filter((m) => m.role === 'assistant');
		expect(assistantMessages[0]?.memoryContextEnabled).toBe(false);
		expect(assistantMessages[0]?.memoryContext).toEqual([]);
		expect(assistantMessages[1]?.memoryContextEnabled).toBe(true);
		expect(assistantMessages[1]?.memoryContext?.[0]).toMatchObject({
			scope: 'session',
			content: 'The response format uses snake_case.'
		});
	});

	it('records an empty memory context when injection is enabled with no active memories', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'empty memory context',
			workdir: wd,
			model: 'gpt-4'
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'hi' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt',
				memoryLevel: 'injector'
			},
			prompt: 'hi',
			conversationId: conv.id
		});
		const events: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			events.push(event);
			if (event.type === 'done') break;
		}

		const start = events.find((event) => event.type === 'message.start');
		expect(start).toMatchObject({
			type: 'message.start',
			memoryContextEnabled: true,
			memoryContext: []
		});
		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.memoryContextEnabled).toBe(true);
		expect(assistant?.memoryContext).toEqual([]);
	});

	it('streams memory harvest skip status on a background turn after done', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'harvest status',
			workdir: wd,
			model: 'gpt-4'
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'short reply' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt',
				memoryLevel: 'harvester'
			},
			prompt: 'hi',
			conversationId: conv.id
		});
		const events: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			events.push(event);
			if (event.type === 'done') break;
		}

		const start = events.find((event) => event.type === 'message.start');
		expect(start).toMatchObject({ type: 'message.start', role: 'assistant' });
		// The harvest itself no longer streams on the primary turn; instead the
		// primary turn announces a background harvest turn just before `done`.
		expect(events.find((event) => event.type === 'memory.harvest')).toBeUndefined();
		const started = events.find((event) => event.type === 'memory.harvest.started');
		if (start?.type !== 'message.start' || started?.type !== 'memory.harvest.started') {
			throw new Error('expected live message start and harvest.started events');
		}
		const delta = events.find((event) => event.type === 'message.delta');
		expect(delta).toMatchObject({ type: 'message.delta', messageId: start.messageId });
		expect(started.messageId).toBe(start.messageId);
		const end = events.find((event) => event.type === 'message.end');
		expect(end).toMatchObject({ type: 'message.end', messageId: start.messageId });
		expect(events.findIndex((event) => event.type === 'memory.harvest.started')).toBeLessThan(
			events.findIndex((event) => event.type === 'done')
		);

		// The background turn carries the skipped harvest record and its own
		// terminal `done`, and is reachable by its announced id.
		const bg = turnRunner.getTurnById(conv.id, started.harvestTurnId);
		if (!bg) throw new Error('expected background harvest turn to be registered');
		const bgEvents: PortalEvent[] = [];
		for await (const { event } of bg.subscribe()) {
			bgEvents.push(event);
			if (event.type === 'done') break;
		}
		const harvest = bgEvents.find((event) => event.type === 'memory.harvest');
		expect(harvest).toMatchObject({
			type: 'memory.harvest',
			messageId: start.messageId,
			harvest: { status: 'skipped', reason: 'assistant_reply_too_short' }
		});
		expect(bgEvents[bgEvents.length - 1].type).toBe('done');

		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.id).toBe(start.messageId);
		expect(assistant?.memoryHarvest).toMatchObject({
			status: 'skipped',
			reason: 'assistant_reply_too_short'
		});
	});

	it('streams the full harvest pass on the background turn after the primary done', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const memory = await import('../src/lib/server/db/repos/memory');
		const messages = await import('../src/lib/server/db/repos/messages');
		const harvester = await import('../src/lib/server/copilot/memory-harvester');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'background harvest',
			workdir: wd,
			model: 'gpt-4'
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'x'.repeat(250) },
				{ type: 'done' }
			])
		);
		harvestOpenMock.mockResolvedValue(
			fakeHarvestSession(
				JSON.stringify({
					writes: [{ scope: 'session', kind: 'fact', entity: 'Mark', content: 'harvested' }]
				})
			)
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt',
				memoryLevel: 'harvester'
			},
			prompt: 'remember Mark',
			conversationId: conv.id
		});
		const events: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			events.push(event);
			if (event.type === 'done') break;
		}

		// Primary turn announces the background turn and ends without waiting
		// on the harvest.
		const started = events.find((event) => event.type === 'memory.harvest.started');
		if (started?.type !== 'memory.harvest.started') {
			throw new Error('expected harvest.started on the primary turn');
		}
		expect(events.findIndex((event) => event.type === 'memory.harvest.started')).toBeLessThan(
			events.findIndex((event) => event.type === 'done')
		);

		// The background turn streams pending -> applied and its own done.
		const bg = turnRunner.getTurnById(conv.id, started.harvestTurnId);
		if (!bg) throw new Error('expected background harvest turn to be registered');
		const bgEvents: PortalEvent[] = [];
		for await (const { event } of bg.subscribe()) {
			bgEvents.push(event);
			if (event.type === 'done') break;
		}
		await harvester.waitForPendingHarvest(conv.id);
		const statuses = bgEvents
			.filter((event) => event.type === 'memory.harvest')
			.map((event) => (event.type === 'memory.harvest' ? event.harvest.status : ''));
		expect(statuses).toEqual(['pending', 'applied']);
		expect(bgEvents[bgEvents.length - 1].type).toBe('done');

		// The harvested write landed and the persisted record reflects applied.
		expect(memory.query(user.id, conv.id, 'harvested').map((row) => row.content)).toEqual([
			'harvested'
		]);
		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.memoryHarvest).toMatchObject({ status: 'applied', writes: 1 });
	});

	it('snapshots memory state after a completed assistant turn', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const memory = await import('../src/lib/server/db/repos/memory');
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'memory snapshot',
			workdir: wd,
			model: 'gpt-4'
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'hi' },
				{ type: 'done' }
			])
		);
		const beforeSend = async () => {
			memory.write(user.id, conv.id, {
				scope: 'session',
				kind: 'fact',
				content: 'Memory written during the turn.',
				source: 'model'
			});
		};

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt',
				memoryLevel: 'tools'
			},
			prompt: 'hi',
			conversationId: conv.id,
			beforeSend
		});
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}
		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		if (!assistant) throw new Error('assistant missing');
		memory.write(user.id, conv.id, {
			scope: 'session',
			kind: 'fact',
			content: 'Future memory.',
			source: 'model'
		});

		expect(memory.restoreSnapshotToConversation(user.id, conv.id, assistant.id)).toBe(true);
		expect(memory.query(user.id, conv.id, 'during the turn')).toHaveLength(1);
		expect(memory.query(user.id, conv.id, 'Future', { includeArchived: true })).toEqual([]);
	});

	it('does not emit conversation.update when the title is already set', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'Custom title',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'hi' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'Anything goes here',
			conversationId: conv.id
		});

		const received: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			received.push(event);
			if (event.type === 'done') break;
		}

		expect(received.find((e) => e.type === 'conversation.update')).toBeUndefined();
		expect(convs.get(conv.id, user.id)?.title).toBe('Custom title');
	});

	it('assigns monotonic ids and replays from Last-Event-ID via sinceId', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'Custom title',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'a' },
				{ type: 'message.delta', messageId: 'm1', text: 'b' },
				{ type: 'message.delta', messageId: 'm1', text: 'c' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		// Drain the full transcript; ids must be 0..N-1 contiguous.
		const all: { id: number; event: PortalEvent }[] = [];
		for await (const item of turn.subscribe()) {
			all.push(item);
			if (item.event.type === 'done') break;
		}
		expect(all.length).toBeGreaterThan(0);
		expect(all.map((x) => x.id)).toEqual(all.map((_, i) => i));
		expect(all[all.length - 1].event.type).toBe('done');

		// Re-subscribe with `sinceId` = id of the second delta. We should
		// receive everything strictly after that id, and only that.
		const secondDeltaId = all.findIndex(
			(x) => x.event.type === 'message.delta' && x.event.text === 'b'
		);
		expect(secondDeltaId).toBeGreaterThan(0);

		const replayed: { id: number; event: PortalEvent }[] = [];
		for await (const item of turn.subscribe({ sinceId: secondDeltaId })) {
			replayed.push(item);
			if (item.event.type === 'done') break;
		}
		expect(replayed[0].id).toBe(secondDeltaId + 1);
		expect(replayed.map((x) => x.id)).toEqual(all.slice(secondDeltaId + 1).map((x) => x.id));
	});

	it('getTurnById returns null when the turn id does not match', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 't',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(makeFakeSession([{ type: 'done' }]));

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		expect(turnRunner.getTurnById(conv.id, turn.id)).toBeTruthy();
		expect(turnRunner.getTurnById(conv.id, 'nonexistent')).toBeNull();
		expect(turnRunner.getTurnById('other-conversation', turn.id)).toBeNull();
	});

	it('persists interleaved reasoning segments anchored to their text offsets', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'reasoning',
			workdir: wd,
			model: 'gpt-4'
		});

		// Two reasoning bursts: one before any visible text, one after the
		// first chunk of text. The bridge would emit message.reasoning.end
		// when the segment transitions to non-reasoning, so we mirror that
		// here.
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's1', text: 'plan ' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's1', text: 'first' },
				{ type: 'message.reasoning.end', messageId: 'm1', segmentId: 's1', durationMs: 100 },
				{ type: 'message.delta', messageId: 'm1', text: 'hello' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's2', text: 'second ' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's2', text: 'thought' },
				{ type: 'message.reasoning.end', messageId: 'm1', segmentId: 's2', durationMs: 200 },
				{ type: 'message.delta', messageId: 'm1', text: ' world' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const persisted = messages.listByConversation(conv.id);
		const assistant = persisted.find((m) => m.role === 'assistant');
		expect(assistant?.content).toBe('hello world');
		const blocks = assistant?.reasoningBlocks ?? [];
		expect(blocks.length).toBe(2);
		// Segment indexes monotonic, in stream order.
		expect(blocks.map((b) => b.segmentIndex)).toEqual([0, 1]);
		// First segment opened at offset 0 (before any text); second opened
		// after "hello" was already buffered.
		expect(blocks[0].textOffset).toBe(0);
		expect(blocks[0].text).toBe('plan first');
		expect(blocks[0].durationMs).toBe(100);
		expect(blocks[1].textOffset).toBe('hello'.length);
		expect(blocks[1].text).toBe('second thought');
		expect(blocks[1].durationMs).toBe(200);
	});

	it('persists assistant content and tool calls before the turn completes', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'incremental',
			workdir: wd,
			model: 'gpt-4'
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		acquireMock.mockResolvedValue({
			conversationId: conv.id,
			workingDirectory: wd,
			async *send(): AsyncIterable<PortalEvent> {
				yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
				yield { type: 'message.delta', messageId: 'm1', text: 'partial' };
				yield {
					type: 'tool.call',
					toolCallId: 'tool-1',
					tool: 'bash',
					args: { command: 'echo hi', forcePermissionPrompt: 'because this is a test' }
				};
				await gate;
				yield {
					type: 'tool.result',
					toolCallId: 'tool-1',
					ok: true,
					summary: 'ok',
					output: 'hi\n'
				};
			},
			async abort() {},
			async dispose() {},
			async setMode() {},
			async setApproveAll() {},
			async resetSessionApprovals() {},
			lastUsed: Date.now()
		});

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'tool.call') break;
		}

		const midTurn = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(midTurn).toBeTruthy();
		expect(midTurn?.status).toBe('streaming');
		expect(midTurn?.content).toBe('partial');
		expect(midTurn?.toolCalls?.[0]).toMatchObject({
			id: 'tool-1',
			tool: 'bash',
			status: 'pending'
		});
		expect(midTurn?.toolCalls?.[0]?.argsJson).toContain('forcePermissionPrompt');

		release();
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}
		const done = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(done?.status).toBe('complete');
		expect(done?.toolCalls?.[0]).toMatchObject({
			id: 'tool-1',
			status: 'ok',
			resultJson: 'hi\n'
		});
	});

	it('dedupes repeated file edit events during incremental persistence', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'file edits',
			workdir: wd,
			model: 'gpt-4'
		});
		const edit: PortalEvent = {
			type: 'file.edit',
			path: 'src/a.ts',
			diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b'
		};
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				edit,
				edit,
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.fileEdits).toHaveLength(1);
		expect(assistant?.fileEdits?.[0]).toMatchObject({ path: 'src/a.ts', diff: edit.diff });
	});

	it('persists background subagent lifecycle events during a turn', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'subagent lifecycle',
			workdir: wd,
			model: 'gpt-4'
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{
					type: 'tool.call',
					toolCallId: 'task-1',
					tool: 'task',
					args: { mode: 'background', prompt: 'do work' }
				},
				{
					type: 'tool.result',
					toolCallId: 'task-1',
					ok: true,
					summary: 'launched',
					output: { agent_id: 'agent-1', content: 'launched' }
				},
				{
					type: 'subagent.lifecycle',
					toolCallId: 'task-1',
					agentId: 'agent-1',
					status: 'running'
				},
				{
					type: 'subagent.lifecycle',
					toolCallId: 'task-1',
					agentId: 'agent-1',
					status: 'completed'
				},
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.toolCalls?.[0]).toMatchObject({
			id: 'task-1',
			status: 'ok',
			backgroundAgentStatus: 'completed',
			backgroundAgentId: 'agent-1',
			backgroundAgentStartedAt: expect.any(Number),
			backgroundAgentEndedAt: expect.any(Number)
		});
	});

	it('persists manual rerun tool calls as separate attempts without overwriting the original', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'rerun',
			workdir: wd,
			model: 'gpt-4'
		});
		const originalMsg = messages.append(conv.id, { role: 'assistant', content: '' });
		const args = { command: 'echo approved' };
		messages.insertToolCall(originalMsg.id, {
			id: 'tc-original',
			tool: 'bash',
			argsJson: JSON.stringify(args),
			resultJson: JSON.stringify('Permission denied'),
			status: 'denied',
			startedAt: Date.now() - 100,
			endedAt: Date.now() - 50,
			textOffset: 0,
			parentToolCallId: null
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'tool.call', toolCallId: 'tc-rerun', tool: 'bash', args },
				{ type: 'tool.result', toolCallId: 'tc-rerun', ok: true, summary: 'ok', output: 'ok' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'rerun',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const toolCalls = messages.listByConversation(conv.id).flatMap((m) => m.toolCalls ?? []);
		expect(toolCalls.find((t) => t.id === 'tc-original')).toMatchObject({
			status: 'denied'
		});
		expect(toolCalls.find((t) => t.id === 'tc-rerun')).toMatchObject({
			status: 'ok'
		});
	});
});
