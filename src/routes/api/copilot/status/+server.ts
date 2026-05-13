import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchAuthStatus, fetchModels } from '$lib/server/copilot/bridge';
import { loadConfig } from '$lib/server/config';
import * as tokens from '$lib/server/db/repos/tokens';
import { log } from '$lib/server/log';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.userId) throw error(401);
	const cfg = loadConfig();
	const authToken = tokens.getGithubToken(locals.userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;

	try {
		const [auth, models] = await Promise.all([fetchAuthStatus(authToken), fetchModels(authToken)]);
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
