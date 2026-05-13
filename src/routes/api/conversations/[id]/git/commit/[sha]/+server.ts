import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { workspaceRoot } from '$lib/server/files';
import { showCommit, GitError } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals }) => {
	authorizeConversation(params.id, locals.userId);
	const workdir = workspaceRoot();
	const sha = params.sha;
	if (!sha) throw error(400, 'sha required');
	try {
		const detail = await showCommit(workdir, sha);
		return json(detail);
	} catch (e) {
		if (e instanceof GitError) throw error(404, e.message);
		throw e;
	}
};
