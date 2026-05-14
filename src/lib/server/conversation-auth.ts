// Helpers shared by the conversation file-browser API routes.

import { error } from '@sveltejs/kit';
import * as convs from '$lib/server/db/repos/conversations';

export interface AuthorizedConv {
	conversationId: string;
	workdir: string;
}

export function authorizeConversation(
	convId: string | undefined,
	userId: string | null | undefined
): AuthorizedConv {
	if (!userId) throw error(401);
	if (!convId) throw error(400, 'missing conversation id');
	const conv = convs.get(convId, userId);
	if (!conv) throw error(404);
	return { conversationId: conv.id, workdir: conv.workdir };
}
