import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import { loadConfig } from '$lib/server/config';
import { startTurn, getTurn } from '$lib/server/runtime/turn-runner';
import { providerAuthToken } from '$lib/server/providers/auth';
import { snapshot as takeSnapshot } from '$lib/server/snapshots';
import { effectiveWorkdir } from '$lib/server/workdir';
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

	// Resolve the workdir we actually hand to the SDK / snapshotter. This
	// rewrites legacy `DATA_DIR/workspaces/<id>/` rows (empty dirs from
	// before workdirs were wired up to the SDK) back to PROJECT_ROOT so
	// existing conversations don't get a useless empty workspace.
	const workdir = effectiveWorkdir(conv.workdir);

	// Capture a pre-turn snapshot of the workdir so the user can later
	// inspect / roll back what the agent saw at this point. Non-fatal on
	// failure (worst case: that turn just has no pre-snapshot).
	try {
		await takeSnapshot(workdir, userMsg.id, 'pre');
	} catch (e) {
		log.warn('snapshot.pre.failed', {
			conversationId: conv.id,
			messageId: userMsg.id,
			err: String(e)
		});
	}

	const cfg = loadConfig();
	const userSettings = settings.get(conv.userId) ?? settings.defaults();

	const turn = await startTurn({
		conversationId: conv.id,
		prompt: content,
		bridge: {
			conversationId: conv.id,
			userId: conv.userId,
			workingDirectory: workdir,
			provider: conv.provider,
			model: conv.model ?? cfg.DEFAULT_MODEL,
			policy: userSettings.defaultPolicy,
			mode: conv.mode,
			approveAllTools: conv.approveAllTools,
			providerAuthToken: providerAuthToken(conv.provider, conv.userId)
		}
	});

	return json({ turnId: turn.id, userMessageId: userMsg.id });
};
