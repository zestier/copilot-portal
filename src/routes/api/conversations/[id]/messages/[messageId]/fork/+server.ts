import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { forkAtMessage, ForkRejected } from '$lib/server/fork';

const Body = z.object({ content: z.string().min(1).max(64_000) });

const REJECT_STATUS: Record<string, number> = {
	source_not_found: 404,
	message_not_found: 404,
	not_user_message: 400,
	source_busy: 409,
	no_snapshot: 422,
	unsupported_workdir: 422
};

/**
 * Edit a previous user message and re-run from there. Creates a NEW
 * conversation seeded with prior history + the edited message, with its
 * workdir materialised from the pre-snapshot we captured when the
 * original message was first sent.
 *
 * Returns `{ conversationId }` of the new fork. The client should
 * navigate to it to continue.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.userId) throw error(401);
	const sourceId = params.id!;
	const messageId = params.messageId!;
	const { content } = Body.parse(await request.json());

	try {
		const { conversation } = await forkAtMessage({
			userId: locals.userId,
			sourceConversationId: sourceId,
			messageId,
			newContent: content
		});
		return json({ conversationId: conversation.id });
	} catch (e) {
		if (e instanceof ForkRejected) {
			throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
		}
		throw e;
	}
};
