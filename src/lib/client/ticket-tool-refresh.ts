import type { Message, PortalEvent, ToolCallRecord } from '$lib/types';

const TICKET_MUTATION_TOOLS = new Set(['ticket_add', 'ticket_update']);

type ToolResultEvent = Extract<PortalEvent, { type: 'tool.result' }>;

export function findToolCallRecord(
	messages: Pick<Message, 'toolCalls'>[],
	toolCallId: string
): ToolCallRecord | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const toolCall = messages[i].toolCalls?.find((t) => t.id === toolCallId);
		if (toolCall) return toolCall;
	}
}

export function shouldRefreshTicketsAfterToolResult(
	toolCall: Pick<ToolCallRecord, 'tool'> | undefined,
	ev: Pick<ToolResultEvent, 'ok'>
): boolean {
	return ev.ok && !!toolCall && TICKET_MUTATION_TOOLS.has(toolCall.tool);
}
