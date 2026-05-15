import type { PortalEvent } from '../../src/lib/types';
import type { ConversationSession } from '../../src/lib/server/copilot/bridge';

/**
 * Build a fake ConversationSession whose `send()` yields a fixed sequence
 * of PortalEvents. Used by turn-runner and usage tests in place of the
 * real bridge/SDK.
 */
export function makeFakeSession(
	events: PortalEvent[],
	conversationId = 'conv-x'
): ConversationSession {
	return {
		conversationId,
		async *send(): AsyncIterable<PortalEvent> {
			for (const e of events) yield e;
		},
		async abort() {},
		async dispose() {},
		lastUsed: Date.now()
	};
}
