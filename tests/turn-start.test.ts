import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupLocalEnv } from './helpers/env';

const startTurnMock = vi.fn();

vi.mock('../src/lib/server/runtime/turn-runner', () => ({
	startTurn: (...args: unknown[]) => startTurnMock(...args)
}));

async function freshImports() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const turnStart = await import('../src/lib/server/turn-start');
	return { users, convs, messages, turnStart };
}

describe('turn-start context prompts', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-turn-start-test-');
		startTurnMock.mockReset();
		startTurnMock.mockResolvedValue({
			id: 'turn-test',
			conversationId: 'conv-test',
			startedAt: Date.now(),
			endedAt: null,
			status: 'running',
			subscribe: async function* () {},
			abort: async () => {}
		});
	});

	it('injects prior complete conversation messages before an edited prompt', async () => {
		const { users, convs, messages, turnStart } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 'ctx', workdir: '/tmp', model: null });
		messages.append(conv.id, { role: 'user', content: 'first question' });
		messages.append(conv.id, { role: 'assistant', content: 'first answer' });
		const edited = messages.append(conv.id, { role: 'user', content: 'edited follow-up' });

		const prompt = turnStart.buildPromptWithPriorMessages(conv.id, edited);

		expect(prompt).toContain('<prior_conversation>');
		expect(prompt).toContain('USER:\nfirst question');
		expect(prompt).toContain('ASSISTANT:\nfirst answer');
		expect(prompt).toContain(
			'Continue the conversation by responding to this edited user message:'
		);
		expect(prompt.endsWith('edited follow-up')).toBe(true);
	});

	it('uses the raw prompt when there is no prior context', async () => {
		const { users, convs, messages, turnStart } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 'ctx', workdir: '/tmp', model: null });
		const first = messages.append(conv.id, { role: 'user', content: 'first question' });

		expect(turnStart.buildPromptWithPriorMessages(conv.id, first)).toBe('first question');
	});

	it('builds provider initial history before the current user message', async () => {
		const { users, convs, messages, turnStart } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'ctx',
			workdir: '/tmp',
			model: null,
			provider: 'openai-compatible'
		});
		messages.append(conv.id, { role: 'user', content: 'first question' });
		messages.append(conv.id, { role: 'assistant', content: 'first answer' });
		const current = messages.append(conv.id, { role: 'user', content: 'current question' });

		expect(turnStart.buildProviderInitialMessages(conv.id, current)).toMatchObject([
			{ role: 'user', content: 'first question', status: 'complete' },
			{ role: 'assistant', content: 'first answer', status: 'complete' }
		]);
	});

	it('persists provider session id changes through the turn-start callback', async () => {
		const { users, convs, messages, turnStart } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'lm',
			workdir: '/tmp',
			model: 'local-model',
			provider: 'lm-studio'
		});
		const current = messages.append(conv.id, { role: 'user', content: 'hello' });

		await turnStart.startTurnFromUserMessage(conv, current);

		const opts = startTurnMock.mock.calls[0][0] as {
			bridge: { onProviderSessionIdChange: (providerSessionId: string) => void | Promise<void> };
		};
		await opts.bridge.onProviderSessionIdChange('resp_new');
		expect(convs.get(conv.id, u.id)?.providerSessionId).toBe('resp_new');
	});

	it('fails provider session id callbacks when persistence cannot update the conversation', async () => {
		const { users, convs, messages, turnStart } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'lm',
			workdir: '/tmp',
			model: 'local-model',
			provider: 'lm-studio'
		});
		const current = messages.append(conv.id, { role: 'user', content: 'hello' });

		await turnStart.startTurnFromUserMessage(conv, current);
		convs.remove(conv.id, u.id);

		const opts = startTurnMock.mock.calls[0][0] as {
			bridge: { onProviderSessionIdChange: (providerSessionId: string) => void | Promise<void> };
		};
		await expect(
			Promise.resolve().then(() => opts.bridge.onProviderSessionIdChange('resp_new'))
		).rejects.toThrow('Failed to persist lm-studio provider session id');
	});
});
