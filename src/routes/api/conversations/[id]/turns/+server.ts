import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import * as tokens from '$lib/server/db/repos/tokens';
import { loadConfig } from '$lib/server/config';
import { startTurn, getTurn } from '$lib/server/copilot/turn-runner';
import { snapshot as takeSnapshot } from '$lib/server/snapshots';
import { log } from '$lib/server/log';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';

const Body = z.object({ content: z.string().min(1).max(64_000) });

/**
 * Start a new turn. Returns the new turn id synchronously. The turn runs
 * on the server independently of this request — the client opens an
 * `EventSource` against `/turns/[turnId]/stream` to receive its events.
 *
 * Splitting "start" from "stream" lets us use native `EventSource` for
 * the streaming half (which is GET-only): the browser then handles
 * reconnect + `Last-Event-ID` replay for free, which is what makes the
 * phone-lock-and-unlock case "just work" without custom reconnect glue.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);

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
	const userSettings = settings.get(conv.userId) ?? settings.defaults();
	const authToken = tokens.getGithubToken(conv.userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;

	const turn = await startTurn({
		conversationId: conv.id,
		prompt: content,
		bridge: {
			conversationId: conv.id,
			userId: conv.userId,
			workingDirectory: conv.workdir,
			model: conv.model ?? cfg.DEFAULT_MODEL,
			policy: userSettings.defaultPolicy,
			authToken
		}
	});

	return json({ turnId: turn.id, userMessageId: userMsg.id });
};
