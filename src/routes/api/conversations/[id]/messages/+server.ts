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

	interface PendingTool {
		toolCallId: string;
		tool: string;
		argsJson: string;
		resultJson: string | null;
		status: 'pending' | 'ok' | 'error';
		startedAt: number;
		endedAt: number | null;
		textOffset: number;
	}
	const pendingTools = new Map<string, PendingTool>();
	const pendingEdits: { path: string; diff: string; textOffset: number }[] = [];

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
			else if (ev.type === 'tool.call') {
				pendingTools.set(ev.toolCallId, {
					toolCallId: ev.toolCallId,
					tool: ev.tool,
					argsJson: safeJson(ev.args),
					resultJson: null,
					status: 'pending',
					startedAt: Date.now(),
					endedAt: null,
					textOffset: assistantBuf.length
				});
			} else if (ev.type === 'tool.result') {
				const tc = pendingTools.get(ev.toolCallId);
				if (tc) {
					tc.status = ev.ok ? 'ok' : 'error';
					tc.resultJson = safeJson(ev.output ?? ev.summary);
					tc.endedAt = Date.now();
				}
			} else if (ev.type === 'file.edit') {
				pendingEdits.push({
					path: ev.path,
					diff: ev.diff,
					textOffset: assistantBuf.length
				});
			}
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
			if (assistantBuf || assistantId || pendingTools.size || pendingEdits.length) {
				const persisted = messages.append(c.id, {
					role: 'assistant',
					content: assistantBuf,
					status
				});
				for (const t of pendingTools.values()) {
					messages.insertToolCall(persisted.id, {
						id: t.toolCallId,
						tool: t.tool,
						argsJson: t.argsJson,
						resultJson: t.resultJson,
						status: t.status === 'pending' ? 'error' : t.status,
						startedAt: t.startedAt,
						endedAt: t.endedAt,
						textOffset: t.textOffset
					});
				}
				for (const e of pendingEdits) {
					messages.insertFileEdit(persisted.id, e.path, e.diff, e.textOffset);
				}
			}
			convs.touch(c.id);
		}
	}

	return sseResponse(gen());
};

function safeJson(v: unknown): string {
	try {
		return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}
