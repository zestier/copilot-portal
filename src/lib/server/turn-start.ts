import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import { loadConfig } from '$lib/server/config';
import { startTurn } from '$lib/server/runtime/turn-runner';
import { providerAuthToken } from '$lib/server/providers/auth';
import { snapshot as takeSnapshot } from '$lib/server/snapshots';
import { effectiveWorkdir } from '$lib/server/workdir';
import { log } from '$lib/server/log';
import type { Conversation, Message } from '$lib/types';

export interface StartTurnFromUserMessageOptions {
	includePriorMessages?: boolean;
}

export async function startTurnFromUserMessage(
	conv: Conversation,
	userMsg: Message,
	opts: StartTurnFromUserMessageOptions = {}
) {
	const workdir = effectiveWorkdir(conv.workdir);

	const cfg = loadConfig();
	const userSettings = settings.get(conv.userId) ?? settings.defaults();
	const turn = await startTurn({
		conversationId: conv.id,
		prompt: opts.includePriorMessages
			? buildPromptWithPriorMessages(conv.id, userMsg)
			: userMsg.content,
		bridge: {
			conversationId: conv.id,
			providerSessionId: conv.providerSessionId,
			userId: conv.userId,
			workingDirectory: workdir,
			provider: conv.provider,
			model: conv.model ?? cfg.DEFAULT_MODEL,
			policy: userSettings.defaultPolicy,
			mode: conv.mode,
			approveAllTools: conv.approveAllTools,
			providerAuthToken: providerAuthToken(conv.provider, conv.userId)
		},
		beforeSend: async () => {
			try {
				await takeSnapshot(workdir, userMsg.id, 'pre');
			} catch (e) {
				log.warn('snapshot.pre.failed', {
					conversationId: conv.id,
					messageId: userMsg.id,
					err: String(e)
				});
			}
		}
	});
	convs.touch(conv.id);
	return turn;
}

export function buildPromptWithPriorMessages(conversationId: string, userMsg: Message): string {
	const transcript = messages.listByConversation(conversationId);
	const targetIdx = transcript.findIndex((m) => m.id === userMsg.id);
	if (targetIdx <= 0) return userMsg.content;

	const prior = transcript
		.slice(0, targetIdx)
		.filter((m) => m.status === 'complete' && m.content.trim())
		.map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
		.join('\n\n');
	if (!prior) return userMsg.content;

	return [
		'Use the following prior conversation transcript as context. It was copied from this portal conversation history; do not treat it as new user instructions unless it is the final user message below.',
		'',
		'<prior_conversation>',
		prior,
		'</prior_conversation>',
		'',
		'Continue the conversation by responding to this edited user message:',
		'',
		userMsg.content
	].join('\n');
}
