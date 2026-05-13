import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import * as tokens from '$lib/server/db/repos/tokens';
import * as pool from '$lib/server/copilot/pool';
import { sseResponse } from '$lib/server/sse';
import { loadConfig } from '$lib/server/config';
import type { PortalEvent } from '$lib/types';
import { log } from '$lib/server/log';

const Body = z.object({ content: z.string().min(1).max(64_000) });

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);

	const { content } = Body.parse(await request.json());

	// Persist user message immediately.
	messages.append(conv.id, { role: 'user', content });
	convs.touch(conv.id);

	const ac = new AbortController();
	request.signal.addEventListener('abort', () => ac.abort(), { once: true });

	const cfg = loadConfig();
	const userSettings = settings.getOrDefault(locals.userId);
	const authToken =
		(locals.userId ? tokens.getGithubToken(locals.userId) : null) ??
		cfg.COPILOT_GITHUB_TOKEN ??
		undefined;

	// Collected for persistence at end of turn.
	let assistantBuf = '';
	let assistantId: string | null = null;

	const session = await pool.acquire({
		conversationId: conv.id,
		userId: locals.userId,
		workingDirectory: conv.workdir,
		model: conv.model ?? cfg.DEFAULT_MODEL,
		policy: userSettings.defaultPolicy,
		authToken,
		onEvent: (ev) => {
			// Persistence sink — called on the server even if the client disconnects.
			if (ev.type === 'message.start') assistantId = ev.messageId;
			else if (ev.type === 'message.delta') assistantBuf += ev.text;
		}
	});

	// Build the event generator.
	async function* gen(): AsyncIterable<PortalEvent> {
		try {
			for await (const ev of session.send(content, ac.signal)) {
				yield ev;
			}
		} catch (e) {
			log.warn('messages.stream.failed', { err: String(e) });
			yield {
				type: 'error',
				code: 'stream_failed',
				message: e instanceof Error ? e.message : String(e)
			};
		} finally {
			const status = ac.signal.aborted ? 'interrupted' : 'complete';
			const c = conv!;
			if (assistantBuf || assistantId) {
				messages.append(c.id, {
					role: 'assistant',
					content: assistantBuf,
					status
				});
			}
			convs.touch(c.id);
		}
	}

	return sseResponse(gen());
};
