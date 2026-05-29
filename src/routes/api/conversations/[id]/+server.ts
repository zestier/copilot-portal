import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as pool from '$lib/server/runtime/pool';
import { getTurn, getBackgroundTurn } from '$lib/server/runtime/turn-runner';
import { listForConversation as listPendingInteractive } from '$lib/server/runtime/interactive-requests';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { deleteProviderSession } from '$lib/server/providers';
import { providerAuthToken } from '$lib/server/providers/auth';
import { log } from '$lib/server/log';

export const GET: RequestHandler = ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	// Surface any in-flight turn so the client can reattach its
	// EventSource on page load without a separate round-trip. Only
	// running turns count — finished-but-still-cached turns are not
	// useful to reattach to (replay then immediate done).
	const turn = getTurn(conv.id);
	const activeTurnId = turn && turn.status === 'running' ? turn.id : null;
	const harvestTurn = getBackgroundTurn(conv.id);
	const activeHarvestTurnId = harvestTurn ? harvestTurn.id : null;
	return json({
		conversation: conv,
		messages: messages.listByConversation(conv.id),
		activeTurnId,
		activeHarvestTurnId,
		// Outstanding prompts so a refresh / SSE blip can rehydrate the
		// dialog rather than stranding the agent on a request the user can
		// no longer see.
		pendingInteractive: listPendingInteractive(conv.id)
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
	try {
		await deleteProviderSession(conv.provider, {
			userId: conv.userId,
			providerSessionId: conv.providerSessionId,
			providerAuthToken: providerAuthToken(conv.provider, conv.userId)
		});
	} catch (e) {
		log.warn('conversation.provider_session_delete_failed', {
			conversationId: conv.id,
			provider: conv.provider,
			providerSessionId: conv.providerSessionId,
			err: String(e)
		});
	}
	convs.remove(conv.id, conv.userId);
	return json({ ok: true });
};
