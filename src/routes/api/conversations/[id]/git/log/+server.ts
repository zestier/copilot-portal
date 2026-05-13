import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { workspaceRoot } from '$lib/server/files';
import { log, isGitRepo, GitError } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	authorizeConversation(params.id, locals.userId);
	const workdir = workspaceRoot();
	if (!(await isGitRepo(workdir))) return json({ initialized: false, commits: [] });
	const limit = Math.min(Number(url.searchParams.get('limit') ?? '20') || 20, 200);
	const skip = Math.max(Number(url.searchParams.get('skip') ?? '0') || 0, 0);
	try {
		const commits = await log(workdir, { limit, skip });
		return json({ initialized: true, commits });
	} catch (e) {
		if (e instanceof GitError) throw error(400, e.message);
		throw e;
	}
};
