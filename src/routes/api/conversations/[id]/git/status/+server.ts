import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { headInfo } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals }) => {
	const { workdir } = authorizeConversation(params.id, locals.userId);
	const info = await headInfo(workdir);
	return json(info);
};
