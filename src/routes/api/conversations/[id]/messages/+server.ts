import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import * as tokens from '$lib/server/db/repos/tokens';
import { sseResponse } from '$lib/server/sse';
import { loadConfig } from '$lib/server/config';
import { startTurn, getTurn } from '$lib/server/copilot/turn-runner';
import { snapshot as takeSnapshot } from '$lib/server/snapshots';
import { log } from '$lib/server/log';
import { parseBody } from '$lib/server/validate';

const Body = z.object({ content: z.string().min(1).max(64_000) });

/**
 * Start a new turn. The turn runs on the server independently of this
 * request's lifecycle — if the client disconnects (page refresh, etc.) the
 * turn keeps running and its results are persisted. Reconnect via GET to
 * resume streaming.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);

	const { content } = await parseBody(request, Body);

	const existing = getTurn(conv.id);
	if (existing && existing.status === 'running') {
		throw error(409, 'A turn is already in progress for this conversation.');
	}

	// Persist user message immediately.
	const userMsg = messages.append(conv.id, { role: 'user', content });
	convs.touch(conv.id);

	// Capture a pre-turn snapshot of the workdir. Bound to this user
	// message so a later "edit this message" can restore the workdir to
	// exactly the state the agent was about to see. Failures here are
	// non-fatal — we just lose the ability to fork at this turn.
	try {
		await takeSnapshot(conv.workdir, userMsg.id, 'pre');
	} catch (e) {
		log.warn('snapshot.pre.failed', {
			conversationId: conv.id,
			messageId: userMsg.id,
			err: String(e)
		});
	}

	const cfg = loadConfig();
	const userSettings = settings.getOrDefault(locals.userId);
	const authToken =
		(locals.userId ? tokens.getGithubToken(locals.userId) : null) ??
		cfg.COPILOT_GITHUB_TOKEN ??
		undefined;

	const turn = await startTurn({
		conversationId: conv.id,
		prompt: content,
		bridge: {
			conversationId: conv.id,
			userId: locals.userId,
			workingDirectory: conv.workdir,
			model: conv.model ?? cfg.DEFAULT_MODEL,
			policy: userSettings.defaultPolicy,
			authToken
		}
	});

	return sseResponse(turn.subscribe(request.signal));
};

/**
 * Reattach to the in-progress turn for this conversation, replaying any
 * events that already happened. Used by the client to resume streaming
 * after a page refresh. Returns 204 if no turn is active or recent.
 */
export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);

	const turn = getTurn(conv.id);
	if (!turn) return new Response(null, { status: 204 });

	return sseResponse(turn.subscribe(request.signal));
};

/**
 * Explicit user-initiated cancel for the in-progress turn. Unlike merely
 * dropping the SSE connection, this actually aborts the upstream SDK turn.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);

	const turn = getTurn(conv.id);
	if (!turn || turn.status !== 'running') {
		return json({ aborted: false });
	}
	await turn.abort();
	return json({ aborted: true });
};
