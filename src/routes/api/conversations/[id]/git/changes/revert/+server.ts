import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import { discardAllLocalChanges, GitError } from '$lib/server/git';

export const POST: RequestHandler = async ({ params, locals }) => {
	const { workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	try {
		await discardAllLocalChanges(workdir);
		return json({ ok: true });
	} catch (e) {
		if (e instanceof GitError) throw error(400, e.message);
		throw e;
	}
};
