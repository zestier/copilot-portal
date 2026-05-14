import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { workspaceRoot } from '$lib/server/files';
import { headInfo } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals }) => {
	authorizeConversation(params.id, locals.userId);
	const status = await headInfo(workspaceRoot());
	return json({ status });
};
