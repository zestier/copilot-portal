import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

const mocks = vi.hoisted(() => ({
	release: vi.fn(),
	deleteProviderSession: vi.fn(),
	providerAuthToken: vi.fn()
}));

vi.mock('$lib/server/runtime/pool', () => ({
	release: (...args: unknown[]) => mocks.release(...args)
}));

vi.mock('$lib/server/providers', () => ({
	deleteProviderSession: (...args: unknown[]) => mocks.deleteProviderSession(...args)
}));

vi.mock('$lib/server/providers/auth', () => ({
	providerAuthToken: (...args: unknown[]) => mocks.providerAuthToken(...args)
}));

describe('conversation deletion', () => {
	beforeEach(async () => {
		mocks.release.mockReset();
		mocks.release.mockResolvedValue(undefined);
		mocks.deleteProviderSession.mockReset();
		mocks.deleteProviderSession.mockResolvedValue(true);
		mocks.providerAuthToken.mockReset();
		mocks.providerAuthToken.mockReturnValue('provider-token');
		await setupLocalEnv('portal-conversation-delete-');
	});

	it('attempts provider session deletion before removing the SQLite conversation', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const { DELETE } = await import('../src/routes/api/conversations/[id]/+server');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'Delete me',
			workdir: makeTmpDir('portal-conversation-delete-wd-'),
			provider: 'copilot',
			model: 'gpt-4',
			providerSessionId: 'provider-session-123'
		});

		const response = await DELETE({
			params: { id: conv.id },
			locals: { userId: user.id }
		} as Parameters<typeof DELETE>[0]);

		expect(response.status).toBe(200);
		expect(mocks.release).toHaveBeenCalledWith(conv.id);
		expect(mocks.providerAuthToken).toHaveBeenCalledWith('copilot', user.id);
		expect(mocks.deleteProviderSession).toHaveBeenCalledWith('copilot', {
			userId: user.id,
			providerSessionId: 'provider-session-123',
			providerAuthToken: 'provider-token'
		});
		expect(convs.get(conv.id, user.id)).toBeNull();
	});

	it('still removes the SQLite conversation when provider deletion fails', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const { DELETE } = await import('../src/routes/api/conversations/[id]/+server');
		mocks.deleteProviderSession.mockRejectedValueOnce(new Error('provider unavailable'));
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'Delete locally',
			workdir: makeTmpDir('portal-conversation-delete-wd-'),
			provider: 'copilot',
			model: 'gpt-4',
			providerSessionId: 'provider-session-456'
		});

		const response = await DELETE({
			params: { id: conv.id },
			locals: { userId: user.id }
		} as Parameters<typeof DELETE>[0]);

		expect(response.status).toBe(200);
		expect(convs.get(conv.id, user.id)).toBeNull();
	});
});
