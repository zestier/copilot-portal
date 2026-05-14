import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as usage from '$lib/server/db/repos/usage';

export const load: PageServerLoad = ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id, locals.userId);
	if (!conv) throw error(404);
	const msgs = messages.listByConversation(conv.id);
	const contextUsage = usage.get(conv.id);

	// If this conversation was forked, surface parent info for a
	// breadcrumb. Resolves silently to null if the parent was deleted or
	// belongs to a different user.
	let parent: {
		id: string;
		title: string;
		messageId: string | null;
		messageIndex: number | null;
	} | null = null;
	if (conv.forkedFromConversationId) {
		const p = convs.get(conv.forkedFromConversationId, locals.userId);
		if (p) {
			let idx: number | null = null;
			if (conv.forkedFromMessageId) {
				const parentMsgs = messages.listByConversation(p.id);
				const i = parentMsgs.findIndex((m) => m.id === conv.forkedFromMessageId);
				idx = i >= 0 ? i : null;
			}
			parent = {
				id: p.id,
				title: p.title,
				messageId: conv.forkedFromMessageId,
				messageIndex: idx
			};
		}
	}

	return { conversation: conv, messages: msgs, contextUsage, parent };
};
