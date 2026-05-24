import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	fetchAuthStatus,
	fetchModels,
	getDefaultProviderId,
	listProviders
} from '$lib/server/providers';
import { providerAuthToken } from '$lib/server/providers/auth';
import { log } from '$lib/server/log';
import { requireUserId } from '$lib/server/auth/require';

export const GET: RequestHandler = async ({ locals }) => {
	const userId = requireUserId(locals);
	const defaultProvider = getDefaultProviderId();
	const providerCredential = providerAuthToken(defaultProvider, userId);

	try {
		const [auth, models] = await Promise.all([
			fetchAuthStatus(userId, providerCredential, defaultProvider),
			fetchModels(userId, providerCredential, defaultProvider)
		]);
		return json({
			provider: defaultProvider,
			providers: providerSummaries(),
			auth,
			models
		});
	} catch (e) {
		log.warn('provider.status.failed', { provider: defaultProvider, err: String(e) });
		return json(
			{
				provider: defaultProvider,
				providers: providerSummaries(),
				auth: { isAuthenticated: false, statusMessage: String(e) },
				models: []
			},
			{ status: 200 }
		);
	}
};

function providerSummaries() {
	return listProviders().map((provider) => ({
		id: provider.id,
		displayName: provider.displayName,
		ui: provider.ui,
		capabilities: provider.capabilities
	}));
}
