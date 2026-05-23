import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	fetchAuthStatus,
	fetchModels,
	getDefaultProviderId,
	listProviders
} from '$lib/server/copilot/providers';
import { loadConfig } from '$lib/server/config';
import * as tokens from '$lib/server/db/repos/tokens';
import { log } from '$lib/server/log';
import { requireUserId } from '$lib/server/auth/require';

export const GET: RequestHandler = async ({ locals }) => {
	const userId = requireUserId(locals);
	const cfg = loadConfig();
	const authToken = tokens.getGithubToken(userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;
	const defaultProvider = getDefaultProviderId();

	try {
		const [auth, models] = await Promise.all([
			fetchAuthStatus(userId, authToken, defaultProvider),
			fetchModels(userId, authToken, defaultProvider)
		]);
		return json({
			provider: defaultProvider,
			providers: listProviders().map((provider) => ({
				id: provider.id,
				displayName: provider.displayName
			})),
			auth,
			models
		});
	} catch (e) {
		log.warn('copilot.status.failed', { err: String(e) });
		return json(
			{
				provider: defaultProvider,
				providers: listProviders().map((provider) => ({
					id: provider.id,
					displayName: provider.displayName
				})),
				auth: { isAuthenticated: false, statusMessage: String(e) },
				models: []
			},
			{ status: 200 }
		);
	}
};
