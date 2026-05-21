// Legacy shim: the original permission endpoint accepted `{ decision }` only.
// New clients should POST to /interactive/:requestId with `{ kind, ... }`.
// Kept for one release so an old browser tab in flight still resolves cleanly.

import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as interactive from '$lib/server/copilot/interactive-requests';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';

const Body = z.object({ decision: z.enum(['allow-once', 'allow-always', 'deny']) });

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);

	const { decision } = await parseBody(request, Body);
	const pending = interactive.get(params.requestId!);
	if (!pending || pending.conversationId !== conv.id) throw error(404);
	if (pending.kind !== 'permission') throw error(409, 'not a permission request');

	const ok = interactive.resolve(params.requestId!, conv.userId, {
		kind: 'permission',
		decision
	});
	if (!ok) throw error(404);
	return json({ ok: true });
};
