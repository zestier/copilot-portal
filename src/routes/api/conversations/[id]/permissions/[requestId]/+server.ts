import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as permissions from '$lib/server/copilot/permissions';
import * as convs from '$lib/server/db/repos/conversations';

const Body = z.object({ decision: z.enum(['allow-once', 'allow-always', 'deny']) });

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.userId) throw error(401);
	// Make sure the conversation is owned by the caller.
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);

	const { decision } = Body.parse(await request.json());
	const pending = permissions.get(params.requestId!);
	if (!pending || pending.conversationId !== conv.id) throw error(404);

	const ok = permissions.resolve(params.requestId!, locals.userId, decision);
	if (!ok) throw error(404);
	return json({ ok: true });
};
