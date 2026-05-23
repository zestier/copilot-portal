import { ulid } from '../ids';
import { getDb } from '../index';
import type {
	Message,
	MessageStatus,
	Role,
	ToolCallRecord,
	FileEditRecord,
	ReasoningBlockRecord
} from '$lib/types';

interface MsgRow {
	id: string;
	conversation_id: string;
	role: string;
	content: string;
	status: string;
	error_code: string | null;
	created_at: number;
	reasoning: string | null;
	reasoning_duration_ms: number | null;
}

interface ToolRow {
	id: string;
	message_id: string;
	tool: string;
	args_json: string;
	result_json: string | null;
	status: string;
	started_at: number;
	ended_at: number | null;
	text_offset: number | null;
	parent_tool_call_id: string | null;
}

interface EditRow {
	id: string;
	message_id: string;
	path: string;
	diff: string;
	created_at: number;
	text_offset: number | null;
	parent_tool_call_id: string | null;
}

interface ReasoningRow {
	id: string;
	message_id: string;
	segment_index: number;
	text: string;
	text_offset: number | null;
	started_at: number;
	duration_ms: number | null;
	parent_tool_call_id: string | null;
}

function rowToMessage(r: MsgRow): Message {
	return {
		id: r.id,
		conversationId: r.conversation_id,
		role: r.role as Role,
		content: r.content,
		status: r.status as MessageStatus,
		errorCode: r.error_code,
		createdAt: r.created_at
	};
}

export function listByConversation(conversationId: string): Message[] {
	const db = getDb();
	const rows = db
		.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC')
		.all(conversationId) as MsgRow[];
	const msgs = rows.map(rowToMessage);
	if (msgs.length === 0) return msgs;

	const ids = msgs.map((m) => m.id);
	const placeholders = ids.map(() => '?').join(',');
	const toolRows = db
		.prepare(
			`SELECT * FROM tool_calls WHERE message_id IN (${placeholders}) ORDER BY started_at ASC`
		)
		.all(...ids) as ToolRow[];
	const editRows = db
		.prepare(
			`SELECT * FROM file_edits WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
		)
		.all(...ids) as EditRow[];
	const reasoningRows = db
		.prepare(
			`SELECT * FROM reasoning_blocks WHERE message_id IN (${placeholders}) ORDER BY segment_index ASC`
		)
		.all(...ids) as ReasoningRow[];

	const byMsgT: Record<string, ToolCallRecord[]> = {};
	for (const t of toolRows) {
		(byMsgT[t.message_id] ??= []).push({
			id: t.id,
			messageId: t.message_id,
			tool: t.tool,
			argsJson: t.args_json,
			resultJson: t.result_json,
			status: t.status as ToolCallRecord['status'],
			startedAt: t.started_at,
			endedAt: t.ended_at,
			textOffset: t.text_offset,
			parentToolCallId: t.parent_tool_call_id
		});
	}
	const byMsgE: Record<string, FileEditRecord[]> = {};
	for (const e of editRows) {
		(byMsgE[e.message_id] ??= []).push({
			id: e.id,
			messageId: e.message_id,
			path: e.path,
			diff: e.diff,
			createdAt: e.created_at,
			textOffset: e.text_offset,
			parentToolCallId: e.parent_tool_call_id
		});
	}
	const byMsgR: Record<string, ReasoningBlockRecord[]> = {};
	for (const r of reasoningRows) {
		(byMsgR[r.message_id] ??= []).push({
			id: r.id,
			messageId: r.message_id,
			segmentIndex: r.segment_index,
			text: r.text,
			textOffset: r.text_offset,
			startedAt: r.started_at,
			durationMs: r.duration_ms,
			parentToolCallId: r.parent_tool_call_id
		});
	}
	for (const m of msgs) {
		m.toolCalls = byMsgT[m.id] ?? [];
		m.fileEdits = byMsgE[m.id] ?? [];
		m.reasoningBlocks = byMsgR[m.id] ?? [];
	}
	return msgs;
}

export interface AppendInput {
	role: Role;
	content: string;
	status?: MessageStatus;
	errorCode?: string | null;
}

export function append(conversationId: string, input: AppendInput): Message {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO messages(id, conversation_id, role, content, status, error_code, created_at, reasoning, reasoning_duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
		)
		.run(
			id,
			conversationId,
			input.role,
			input.content,
			input.status ?? 'complete',
			input.errorCode ?? null,
			now
		);
	return {
		id,
		conversationId,
		role: input.role,
		content: input.content,
		status: input.status ?? 'complete',
		errorCode: input.errorCode ?? null,
		createdAt: now
	};
}

export function updateStatus(id: string, status: MessageStatus, errorCode?: string | null) {
	getDb()
		.prepare('UPDATE messages SET status = ?, error_code = ? WHERE id = ?')
		.run(status, errorCode ?? null, id);
}

export function updateContent(id: string, content: string, status: MessageStatus) {
	getDb()
		.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?')
		.run(content, status, id);
}

export function updateContentOnly(id: string, content: string) {
	getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
}

export function insertToolCall(messageId: string, t: Omit<ToolCallRecord, 'messageId'>) {
	getDb()
		.prepare(
			`INSERT INTO tool_calls(
			   id, message_id, tool, args_json, result_json, status, started_at, ended_at,
			   text_offset, parent_tool_call_id
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			t.id,
			messageId,
			t.tool,
			t.argsJson,
			t.resultJson,
			t.status,
			t.startedAt,
			t.endedAt,
			t.textOffset,
			t.parentToolCallId ?? null
		);
}

export function upsertToolCall(messageId: string, t: Omit<ToolCallRecord, 'messageId'>) {
	getDb()
		.prepare(
			`INSERT INTO tool_calls(
			   id, message_id, tool, args_json, result_json, status, started_at, ended_at,
			   text_offset, parent_tool_call_id
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   message_id = excluded.message_id,
			   tool = excluded.tool,
			   args_json = excluded.args_json,
			   result_json = excluded.result_json,
			   status = excluded.status,
			   started_at = excluded.started_at,
			   ended_at = excluded.ended_at,
			   text_offset = excluded.text_offset,
			   parent_tool_call_id = excluded.parent_tool_call_id`
		)
		.run(
			t.id,
			messageId,
			t.tool,
			t.argsJson,
			t.resultJson,
			t.status,
			t.startedAt,
			t.endedAt,
			t.textOffset,
			t.parentToolCallId ?? null
		);
}

export function getToolCallArgs(id: string): unknown | null {
	const row = getDb().prepare('SELECT args_json FROM tool_calls WHERE id = ?').get(id) as
		| { args_json: string }
		| undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.args_json);
	} catch {
		return null;
	}
}

export function updateToolCall(
	id: string,
	patch: Partial<Pick<ToolCallRecord, 'resultJson' | 'status' | 'endedAt'>>
) {
	const fields: string[] = [];
	const values: unknown[] = [];
	if (patch.resultJson !== undefined) {
		fields.push('result_json = ?');
		values.push(patch.resultJson);
	}
	if (patch.status !== undefined) {
		fields.push('status = ?');
		values.push(patch.status);
	}
	if (patch.endedAt !== undefined) {
		fields.push('ended_at = ?');
		values.push(patch.endedAt);
	}
	if (fields.length === 0) return;
	values.push(id);
	getDb()
		.prepare(`UPDATE tool_calls SET ${fields.join(', ')} WHERE id = ?`)
		.run(...values);
}

export interface ToolCallWithConversation extends ToolCallRecord {
	conversationId: string;
	conversationUserId: string;
	messageRole: Role;
}

export function getToolCallForConversation(
	conversationId: string,
	toolCallId: string
): ToolCallWithConversation | null {
	const row = getDb()
		.prepare(
			`SELECT tc.*, m.conversation_id, m.role AS message_role, c.user_id AS conversation_user_id
			   FROM tool_calls tc
			   JOIN messages m ON m.id = tc.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE tc.id = ? AND m.conversation_id = ?`
		)
		.get(toolCallId, conversationId) as
		| (ToolRow & {
				conversation_id: string;
				conversation_user_id: string;
				message_role: string;
		  })
		| undefined;
	if (!row) return null;
	return {
		id: row.id,
		messageId: row.message_id,
		tool: row.tool,
		argsJson: row.args_json,
		resultJson: row.result_json,
		status: row.status as ToolCallRecord['status'],
		startedAt: row.started_at,
		endedAt: row.ended_at,
		textOffset: row.text_offset,
		parentToolCallId: row.parent_tool_call_id,
		conversationId: row.conversation_id,
		conversationUserId: row.conversation_user_id,
		messageRole: row.message_role as Role
	};
}

export function insertFileEdit(
	messageId: string,
	path: string,
	diff: string,
	textOffset: number | null = null,
	parentToolCallId: string | null = null
) {
	const id = ulid();
	getDb()
		.prepare(
			`INSERT INTO file_edits(id, message_id, path, diff, created_at, text_offset, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, messageId, path, diff, Date.now(), textOffset, parentToolCallId);
}

export function upsertReasoningBlock(
	messageId: string,
	r: Omit<ReasoningBlockRecord, 'messageId'>
) {
	getDb()
		.prepare(
			`INSERT INTO reasoning_blocks(id, message_id, segment_index, text, text_offset, started_at, duration_ms, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   message_id = excluded.message_id,
			   segment_index = excluded.segment_index,
			   text = excluded.text,
			   text_offset = excluded.text_offset,
			   started_at = excluded.started_at,
			   duration_ms = excluded.duration_ms,
			   parent_tool_call_id = excluded.parent_tool_call_id`
		)
		.run(
			r.id,
			messageId,
			r.segmentIndex,
			r.text,
			r.textOffset,
			r.startedAt,
			r.durationMs ?? null,
			r.parentToolCallId ?? null
		);
}

export function insertReasoningBlock(
	messageId: string,
	r: Omit<ReasoningBlockRecord, 'messageId'>
) {
	getDb()
		.prepare(
			`INSERT INTO reasoning_blocks(id, message_id, segment_index, text, text_offset, started_at, duration_ms, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			r.id,
			messageId,
			r.segmentIndex,
			r.text,
			r.textOffset,
			r.startedAt,
			r.durationMs ?? null,
			r.parentToolCallId ?? null
		);
}

export function recoverInterruptedInFlight(now: number = Date.now()): {
	messages: number;
	toolCalls: number;
} {
	const db = getDb();
	const tx = db.transaction(() => {
		const msg = db
			.prepare(
				`UPDATE messages
				   SET status = 'interrupted',
				       error_code = COALESCE(error_code, 'server_restarted')
				 WHERE status = 'streaming'`
			)
			.run();
		const tools = db
			.prepare(
				`UPDATE tool_calls
				   SET status = 'error',
				       ended_at = COALESCE(ended_at, ?)
				 WHERE status = 'pending'`
			)
			.run(now);
		return { messages: msg.changes, toolCalls: tools.changes };
	});
	return tx();
}
