import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as pool from '$lib/server/copilot/pool';

export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);
	return json({
		conversation: conv,
		messages: messages.listByConversation(conv.id)
	});
};

const PatchBody = z.object({ title: z.string().min(1).max(200) });

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.userId) throw error(401);
	const body = PatchBody.parse(await request.json());
	const ok = convs.rename(params.id!, locals.userId, body.title);
	if (!ok) throw error(404);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	await pool.release(params.id!);
	const ok = convs.remove(params.id!, locals.userId);
	if (!ok) throw error(404);
	return json({ ok: true });
};
