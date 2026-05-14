import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortalEvent } from '../src/lib/types';
import type { ConversationSession } from '../src/lib/server/copilot/bridge';

// Build a fake session whose `send()` yields a fixed sequence of events.
function makeFakeSession(events: PortalEvent[]): ConversationSession {
	return {
		conversationId: 'conv-x',
		async *send(): AsyncIterable<PortalEvent> {
			for (const e of events) yield e;
		},
		async abort() {},
		async dispose() {},
		lastUsed: Date.now()
	};
}

// Mock the session pool so turn-runner doesn't try to spin up the real SDK.
const acquireMock = vi.fn();
vi.mock('../src/lib/server/copilot/pool', () => ({
	acquire: (...args: unknown[]) => acquireMock(...args)
}));

function setupTmpDataDir() {
	const dir = mkdtempSync(join(tmpdir(), 'portal-test-'));
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'none';
	process.env.I_KNOW_THIS_IS_LOCAL = '1';
	delete process.env.SESSION_SECRET;
	return dir;
}

async function freshImports() {
	vi.resetModules();
	setupTmpDataDir();
	const { resetConfigForTests } = await import('../src/lib/server/config');
	resetConfigForTests();
	const { closeDb } = await import('../src/lib/server/db');
	closeDb();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const turnRunner = await import('../src/lib/server/copilot/turn-runner');
	return { users, convs, turnRunner };
}

describe('turn-runner', () => {
	beforeEach(() => {
		acquireMock.mockReset();
	});

	it('emits conversation.update before the terminal done so clients see the auto-title', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = mkdtempSync(join(tmpdir(), 'portal-wd-'));
		const conv = convs.create(user.id, {
			title: 'New chat',
			workdir: wd,
			model: 'gpt-4'
		});

		// SDK emits its own `done` mid-stream. Before the fix, this `done`
		// reached subscribers and the client would break out of its SSE loop
		// before the auto-title `conversation.update` was sent.
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
			conversationId: conv.id
		});

		const received: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			received.push(event);
			if (event.type === 'done') break;
		}

		// Exactly one terminal `done`, and it must come last.
		const doneIndices = received.map((e, i) => (e.type === 'done' ? i : -1)).filter((i) => i >= 0);
		expect(doneIndices).toEqual([received.length - 1]);

		// The conversation.update must arrive before `done`, with the derived title.
		const updateIdx = received.findIndex((e) => e.type === 'conversation.update');
		expect(updateIdx).toBeGreaterThanOrEqual(0);
		expect(updateIdx).toBeLessThan(received.length - 1);
		const update = received[updateIdx];
		if (update.type !== 'conversation.update') throw new Error('unreachable');
		expect(update.conversationId).toBe(conv.id);
		expect(update.title).toBeTruthy();
		expect(update.title).not.toBe('New chat');

		// The DB row was actually renamed.
		const reloaded = convs.get(conv.id, user.id);
		expect(reloaded?.title).toBe(update.title);
	});

	it('does not emit conversation.update when the title is already set', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = mkdtempSync(join(tmpdir(), 'portal-wd-'));
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
		const wd = mkdtempSync(join(tmpdir(), 'portal-wd-'));
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
		const wd = mkdtempSync(join(tmpdir(), 'portal-wd-'));
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
});
