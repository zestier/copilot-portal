export const CHAT_STREAM_STALL_TIMEOUT_MS = 60_000;

export type StreamRefreshAction = 'finish' | 'reattach' | 'stay-attached';

export function streamRefreshAction({
	currentTurnId,
	refreshedActiveTurnId,
	hasEventSource
}: {
	currentTurnId: string | null;
	refreshedActiveTurnId: string | null;
	hasEventSource: boolean;
}): StreamRefreshAction {
	if (!refreshedActiveTurnId) {
		return currentTurnId || hasEventSource ? 'finish' : 'stay-attached';
	}
	if (!hasEventSource || refreshedActiveTurnId !== currentTurnId) {
		return 'reattach';
	}
	return 'stay-attached';
}
