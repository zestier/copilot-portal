import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchAuthStatus, fetchModels } from '$lib/server/copilot/bridge';
import { loadConfig } from '$lib/server/config';
import * as tokens from '$lib/server/db/repos/tokens';
import { log } from '$lib/server/log';
import { requireUserId } from '$lib/server/auth/require';

export const GET: RequestHandler = async ({ locals }) => {
	const userId = requireUserId(locals);
	const cfg = loadConfig();
	const authToken = tokens.getGithubToken(userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;

	try {
		const [auth, models] = await Promise.all([
			fetchAuthStatus(userId, authToken),
			fetchModels(userId, authToken)
		]);
		return json({ auth, models });
	} catch (e) {
		log.warn('copilot.status.failed', { err: String(e) });
		return json(
			{
				auth: { isAuthenticated: false, statusMessage: String(e) },
				models: []
			},
			{ status: 200 }
		);
	}
};
