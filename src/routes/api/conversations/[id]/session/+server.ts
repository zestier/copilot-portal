import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as pool from '$lib/server/copilot/pool';
import { getProvider } from '$lib/server/copilot/providers';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { parseBody } from '$lib/server/validate';
import { log } from '$lib/server/log';

// PATCH /api/conversations/:id/session — flip per-conversation SDK settings.
//
// Persists to the conversations row so a future open() picks them up, AND
// (when a live SDK session is cached in the pool) pushes the change to the
// running session so the active turn / next message reflects the new setting
// without needing the session to be recreated.

const PatchBody = z
	.object({
		mode: z.enum(['interactive', 'plan', 'autopilot', 'best-effort']).optional(),
		approveAllTools: z.boolean().optional()
	})
	.refine((b) => b.mode !== undefined || b.approveAllTools !== undefined, {
		message: 'No fields to update'
	});

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const body = await parseBody(request, PatchBody);
	const provider = getProvider(conv.provider);

	const persistedPatch = { ...body };
	convs.updateSessionSettings(conv.id, conv.userId, body);
	const live = pool.getActive(conv.id);
	if (live) {
		// Best-effort: the bridge already logs detailed RPC failures, and
		// the DB row is the source of truth for the next open(). Don't fail
		// the request if the live SDK rejects (preview surface, capability-gated).
		if (body.mode !== undefined && live.setMode) {
			try {
				await live.setMode(body.mode);
			} catch (e) {
				log.warn('session.set_mode_failed', { conversationId: conv.id, err: String(e) });
			}
		}
		if (body.approveAllTools !== undefined && live.setApproveAll) {
			try {
				await live.setApproveAll(body.approveAllTools);
			} catch (e) {
				log.warn('session.set_approve_all_failed', {
					conversationId: conv.id,
					err: String(e)
				});
			}
		}
	}

	return json({
		ok: true,
		conversation: convs.get(conv.id, conv.userId),
		capabilities: provider.capabilities,
		unsupported: {
			mode:
				persistedPatch.mode !== undefined && !provider.capabilities.controls.mode
					? provider.capabilities.features.modes.description
					: undefined
		}
	});
};

// POST /api/conversations/:id/session — clear the SDK's session-scoped
// approvals. Useful after the user toggles approve-all off and wants a clean
// slate without ending the conversation.
export const POST: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const provider = getProvider(conv.provider);
	if (!provider.capabilities.controls.resetSessionApprovals) {
		return json({
			ok: true,
			supported: false,
			message: 'This provider has no session-scoped approval cache to reset.'
		});
	}
	const live = pool.getActive(conv.id);
	if (live?.resetSessionApprovals) {
		try {
			await live.resetSessionApprovals();
		} catch (e) {
			log.warn('session.reset_approvals_failed', {
				conversationId: conv.id,
				err: String(e)
			});
		}
	}
	return json({ ok: true, supported: true });
};
