// Shared helper for conversation-scoped API routes: looks up the
// conversation, asserts ownership, and returns the full row so handlers
// don't each re-implement the same `userId / convs.get / 404` dance.

import { error } from '@sveltejs/kit';
import * as convs from '$lib/server/db/repos/conversations';
import type { Conversation } from '$lib/types';

export function authorizeConversation(
	convId: string | undefined,
	userId: string | null | undefined
): Conversation {
	if (!userId) throw error(401);
	if (!convId) throw error(400, 'missing conversation id');
	const conv = convs.get(convId, userId);
	if (!conv) throw error(404);
	return conv;
}
