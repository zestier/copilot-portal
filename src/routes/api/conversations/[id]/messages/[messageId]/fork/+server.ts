import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { forkAtMessage, ForkRejected } from '$lib/server/fork';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';

// `content` present => edit a user message with the new text.
// `content` absent  => retry from an assistant message (uses post snapshot).
const Body = z.object({ content: z.string().min(1).max(64_000).optional() });

const REJECT_STATUS: Record<string, number> = {
	source_not_found: 404,
	message_not_found: 404,
	not_user_message: 400,
	unsupported_role: 400,
	content_required: 400,
	content_not_allowed: 400,
	source_busy: 409,
	no_snapshot: 422,
	unsupported_workdir: 422
};

/**
 * Fork a conversation from a given message.
 *
 *  - Body `{ content }`  → edit that user message, re-run from there.
 *  - Body `{}`           → retry from that assistant message.
 *
 * Returns `{ conversationId }` of the new fork. The client should
 * navigate to it to continue.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const userId = requireUserId(locals);
	const sourceId = params.id!;
	const messageId = params.messageId!;
	// Accept an empty body for retry-from-assistant.
	const parsed = await parseBody(request, Body, { allowEmpty: true });

	try {
		const { conversation } = await forkAtMessage({
			userId,
			sourceConversationId: sourceId,
			messageId,
			newContent: parsed.content ?? null
		});
		return json({ ok: true, conversationId: conversation.id });
	} catch (e) {
		if (e instanceof ForkRejected) {
			throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
		}
		throw e;
	}
};
