import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as pool from '$lib/server/copilot/pool';
import { getTurn } from '$lib/server/copilot/turn-runner';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';

export const GET: RequestHandler = ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	// Surface any in-flight turn so the client can reattach its
	// EventSource on page load without a separate round-trip. Only
	// running turns count — finished-but-still-cached turns are not
	// useful to reattach to (replay then immediate done).
	const turn = getTurn(conv.id);
	const activeTurnId = turn && turn.status === 'running' ? turn.id : null;
	return json({
		conversation: conv,
		messages: messages.listByConversation(conv.id),
		activeTurnId
	});
};

const PatchBody = z
	.object({
		title: z.string().min(1).max(200).optional(),
		archived: z.boolean().optional()
	})
	.refine((b) => b.title !== undefined || b.archived !== undefined, {
		message: 'No fields to update'
	});

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const body = await parseBody(request, PatchBody);

	if (body.title !== undefined) {
		convs.rename(conv.id, conv.userId, body.title);
	}
	if (body.archived !== undefined) {
		if (body.archived) {
			convs.archive(conv.id, conv.userId);
			await pool.release(conv.id);
		} else {
			convs.unarchive(conv.id, conv.userId);
		}
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	await pool.release(conv.id);
	convs.remove(conv.id, conv.userId);
	return json({ ok: true });
};
