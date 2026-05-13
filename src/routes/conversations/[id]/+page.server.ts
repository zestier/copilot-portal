import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';

export const load: PageServerLoad = ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id, locals.userId);
	if (!conv) throw error(404);
	const msgs = messages.listByConversation(conv.id);
	return { conversation: conv, messages: msgs };
};
