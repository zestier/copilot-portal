import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import { headInfo } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals }) => {
	const { workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	const status = await headInfo(workdir);
	return json({ status });
};
