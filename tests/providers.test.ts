import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/server/config';
import { openAICompatibleProvider } from '../src/lib/server/copilot/openai-compatible-provider';
import type { ProviderSession } from '../src/lib/server/copilot/provider';
import {
	fetchAuthStatus,
	fetchModels,
	getDefaultProviderId,
	getProvider,
	listProviders,
	open
} from '../src/lib/server/copilot/providers';
import { setupLocalEnv } from './helpers/env';

beforeEach(async () => {
	await setupLocalEnv('portal-providers-test-');
	delete process.env.DEFAULT_BACKEND_PROVIDER;
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.DEFAULT_BACKEND_PROVIDER;
	resetConfigForTests();
	vi.restoreAllMocks();
});

describe('provider registry', () => {
	it('lists and normalizes configured backend providers', () => {
		expect(listProviders().map((provider) => provider.id)).toEqual([
			'copilot',
			'openai-compatible'
		]);
		expect(getProvider('openai-compatible')).toBe(openAICompatibleProvider);
		expect(getProvider('unknown').id).toBe('copilot');
		expect(getDefaultProviderId()).toBe('copilot');

		process.env.DEFAULT_BACKEND_PROVIDER = 'openai-compatible';
		resetConfigForTests();

		expect(getDefaultProviderId()).toBe('openai-compatible');
	});

	it('delegates auth, model, and session calls to the requested provider', async () => {
		const session: ProviderSession = {
			provider: 'openai-compatible',
			conversationId: 'conv-provider',
			workingDirectory: '/tmp',
			lastUsed: 1,
			send: async function* () {},
			abort: async () => {},
			dispose: async () => {}
		};
		const authSpy = vi
			.spyOn(openAICompatibleProvider, 'fetchAuthStatus')
			.mockResolvedValue({ isAuthenticated: true, authType: 'none' });
		const modelsSpy = vi
			.spyOn(openAICompatibleProvider, 'listModels')
			.mockResolvedValue([{ id: 'local-model', name: 'Local Model' }]);
		const openSpy = vi.spyOn(openAICompatibleProvider, 'openSession').mockResolvedValue(session);

		await expect(fetchAuthStatus('user-1', 'token', 'openai-compatible')).resolves.toEqual({
			isAuthenticated: true,
			authType: 'none'
		});
		await expect(fetchModels('user-1', 'token', 'openai-compatible')).resolves.toEqual([
			{ id: 'local-model', name: 'Local Model' }
		]);
		await expect(
			open({
				provider: 'openai-compatible',
				conversationId: 'conv-provider',
				userId: 'user-1',
				workingDirectory: '/tmp',
				model: 'local-model',
				policy: 'prompt'
			})
		).resolves.toBe(session);

		expect(authSpy).toHaveBeenCalledWith('user-1', 'token');
		expect(modelsSpy).toHaveBeenCalledWith('user-1', 'token');
		expect(openSpy).toHaveBeenCalledWith(
			expect.objectContaining({ provider: 'openai-compatible', conversationId: 'conv-provider' })
		);
	});
});
