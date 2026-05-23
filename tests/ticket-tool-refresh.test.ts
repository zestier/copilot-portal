import { describe, expect, it } from 'vitest';
import {
	findToolCallRecord,
	shouldRefreshTicketsAfterToolResult
} from '../src/lib/client/ticket-tool-refresh';
import type { Message, ToolCallRecord } from '../src/lib/types';

function toolCall(id: string, tool: string): ToolCallRecord {
	return {
		id,
		messageId: 'message-1',
		tool,
		argsJson: '{}',
		resultJson: null,
		status: 'pending',
		startedAt: 1,
		endedAt: null,
		textOffset: null,
		parentToolCallId: null
	};
}

function message(id: string, toolCalls: ToolCallRecord[] = []): Pick<Message, 'toolCalls'> {
	return { toolCalls: toolCalls.map((tc) => ({ ...tc, messageId: id })) };
}

describe('ticket tool refresh helpers', () => {
	it('finds tool calls across prior messages', () => {
		const ticketUpdate = toolCall('ticket-update-1', 'ticket_update');
		const messages = [
			message('message-1', [ticketUpdate]),
			message('message-2', [toolCall('bash-1', 'bash')])
		];

		expect(findToolCallRecord(messages, 'ticket-update-1')?.tool).toBe('ticket_update');
	});

	it('only refreshes after successful ticket mutations', () => {
		expect(shouldRefreshTicketsAfterToolResult(toolCall('add-1', 'ticket_add'), { ok: true })).toBe(
			true
		);
		expect(
			shouldRefreshTicketsAfterToolResult(toolCall('update-1', 'ticket_update'), { ok: true })
		).toBe(true);
		expect(
			shouldRefreshTicketsAfterToolResult(toolCall('update-2', 'ticket_update'), { ok: false })
		).toBe(false);
		expect(
			shouldRefreshTicketsAfterToolResult(toolCall('read-1', 'ticket_get'), { ok: true })
		).toBe(false);
		expect(shouldRefreshTicketsAfterToolResult(undefined, { ok: true })).toBe(false);
	});
});
