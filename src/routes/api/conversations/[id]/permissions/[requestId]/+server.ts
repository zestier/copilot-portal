import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as permissions from '$lib/server/copilot/permissions';
import * as convs from '$lib/server/db/repos/conversations';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';

const Body = z.object({ decision: z.enum(['allow-once', 'allow-always', 'deny']) });

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const userId = requireUserId(locals);
	// Make sure the conversation is owned by the caller.
	const conv = convs.get(params.id!, userId);
	if (!conv) throw error(404);

	const { decision } = await parseBody(request, Body);
	const pending = permissions.get(params.requestId!);
	if (!pending || pending.conversationId !== conv.id) throw error(404);

	const ok = permissions.resolve(params.requestId!, userId, decision);
	if (!ok) throw error(404);
	return json({ ok: true });
};
