import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as permissions from '$lib/server/copilot/permissions';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';

const Body = z.object({ decision: z.enum(['allow-once', 'allow-always', 'deny']) });

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);

	const { decision } = await parseBody(request, Body);
	const pending = permissions.get(params.requestId!);
	if (!pending || pending.conversationId !== conv.id) throw error(404);

	const ok = permissions.resolve(params.requestId!, conv.userId, decision);
	if (!ok) throw error(404);
	return json({ ok: true });
};
