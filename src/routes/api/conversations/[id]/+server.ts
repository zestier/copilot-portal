import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as pool from '$lib/server/copilot/pool';
import { parseBody } from '$lib/server/validate';

export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);
	return json({
		conversation: conv,
		messages: messages.listByConversation(conv.id)
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
	if (!locals.userId) throw error(401);
	const body = await parseBody(request, PatchBody);
	const id = params.id!;
	const conv = convs.get(id, locals.userId);
	if (!conv) throw error(404);

	if (body.title !== undefined) {
		convs.rename(id, locals.userId, body.title);
	}
	if (body.archived !== undefined) {
		if (body.archived) {
			convs.archive(id, locals.userId);
			await pool.release(id);
		} else {
			convs.unarchive(id, locals.userId);
		}
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	await pool.release(params.id!);
	const ok = convs.remove(params.id!, locals.userId);
	if (!ok) throw error(404);
	return json({ ok: true });
};
