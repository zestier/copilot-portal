import { ulid } from '../ids';
import { getDb } from '../index';
import { isMemoryContent, stringifyContent } from './memory';
import type Database from 'better-sqlite3';
import type {
	Message,
	MessageStatus,
	MemoryHarvestRecord,
	MemoryHarvestStatus,
	MemoryContextRecord,
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
	memory_context_enabled: number | null;
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

interface BackgroundAgentLifecycleRow {
	tool_call_id: string;
	agent_id: string;
	status: 'running' | 'completed' | 'failed';
	started_at: number;
	ended_at: number | null;
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

interface MemoryContextRow {
	id: string;
	message_id: string;
	memory_id: string;
	scope: string;
	kind: string;
	entity: string | null;
	content_json: string;
	tags_json: string;
	importance: number;
	sort_index: number;
}

interface MemoryHarvestRow {
	message_id: string;
	status: string;
	reason: string | null;
	writes: number;
	updates: number;
	forgets: number;
	scene_ended: number;
	error: string | null;
	prompt: string | null;
	response: string | null;
	reasoning: string | null;
	parsed_json: string | null;
	changes_json: string | null;
	updated_at: number;
}

export function ensureBackgroundAgentLifecycleTable(db: Database.Database = getDb()) {
	db.prepare(
		`CREATE TABLE IF NOT EXISTS background_agent_lifecycles (
		   tool_call_id TEXT PRIMARY KEY,
		   agent_id     TEXT NOT NULL,
		   status       TEXT NOT NULL,
		   started_at   INTEGER NOT NULL,
		   ended_at     INTEGER
		 )`
	).run();
	db.prepare(
		`CREATE INDEX IF NOT EXISTS idx_background_agent_lifecycles_agent
		   ON background_agent_lifecycles(agent_id)`
	).run();
}

function rowToMessage(r: MsgRow): Message {
	return {
		id: r.id,
		conversationId: r.conversation_id,
		role: r.role as Role,
		content: r.content,
		status: r.status as MessageStatus,
		errorCode: r.error_code,
		createdAt: r.created_at,
		memoryContextEnabled: r.memory_context_enabled === 1
	};
}

function parseStringArray(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string') : [];
	} catch {
		return [];
	}
}

function parseJsonValue(raw: string): MemoryContextRecord['content'] {
	const parsed = JSON.parse(raw) as unknown;
	if (isMemoryContent(parsed)) return parsed;
	throw new Error('Stored memory context content is not JSON-compatible');
}

function stringifyJsonValue(value: MemoryContextRecord['content']): string {
	return stringifyContent(value);
}

function rowToMemoryContext(row: MemoryContextRow): MemoryContextRecord {
	return {
		messageId: row.message_id,
		memoryId: row.memory_id,
		scope: row.scope as MemoryContextRecord['scope'],
		kind: row.kind,
		entity: row.entity,
		content: parseJsonValue(row.content_json),
		tags: parseStringArray(row.tags_json),
		importance: row.importance,
		sortIndex: row.sort_index
	};
}

function rowToMemoryHarvest(row: MemoryHarvestRow): MemoryHarvestRecord {
	return {
		messageId: row.message_id,
		status: row.status as MemoryHarvestStatus,
		reason: row.reason,
		writes: row.writes,
		updates: row.updates,
		forgets: row.forgets,
		sceneEnded: row.scene_ended === 1,
		error: row.error,
		prompt: row.prompt,
		response: row.response,
		reasoning: row.reasoning,
		parsedJson: row.parsed_json,
		changesJson: row.changes_json,
		updatedAt: row.updated_at
	};
}

export function listByConversation(conversationId: string): Message[] {
	const db = getDb();
	ensureBackgroundAgentLifecycleTable(db);
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
	const toolIds = toolRows.map((t) => t.id);
	const lifecycleRows =
		toolIds.length > 0
			? (db
					.prepare(
						`SELECT * FROM background_agent_lifecycles
						  WHERE tool_call_id IN (${toolIds.map(() => '?').join(',')})`
					)
					.all(...toolIds) as BackgroundAgentLifecycleRow[])
			: [];
	const lifecycleByTool = new Map(lifecycleRows.map((r) => [r.tool_call_id, r]));
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
	const memoryContextRows = db
		.prepare(
			`SELECT * FROM message_memory_context WHERE message_id IN (${placeholders}) ORDER BY sort_index ASC`
		)
		.all(...ids) as MemoryContextRow[];
	const memoryHarvestRows = db
		.prepare(`SELECT * FROM message_memory_harvest WHERE message_id IN (${placeholders})`)
		.all(...ids) as MemoryHarvestRow[];

	const byMsgT: Record<string, ToolCallRecord[]> = {};
	for (const t of toolRows) {
		const lifecycle = lifecycleByTool.get(t.id);
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
			parentToolCallId: t.parent_tool_call_id,
			backgroundAgentStatus: lifecycle?.status ?? null,
			backgroundAgentId: lifecycle?.agent_id ?? null,
			backgroundAgentStartedAt: lifecycle?.started_at ?? null,
			backgroundAgentEndedAt: lifecycle?.ended_at ?? null
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
	const byMsgM: Record<string, MemoryContextRecord[]> = {};
	for (const m of memoryContextRows) {
		(byMsgM[m.message_id] ??= []).push(rowToMemoryContext(m));
	}
	const byMsgH = new Map(memoryHarvestRows.map((row) => [row.message_id, rowToMemoryHarvest(row)]));
	for (const m of msgs) {
		m.toolCalls = byMsgT[m.id] ?? [];
		m.fileEdits = byMsgE[m.id] ?? [];
		m.memoryContext = byMsgM[m.id] ?? [];
		m.memoryHarvest = byMsgH.get(m.id) ?? null;
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
		createdAt: now,
		memoryContextEnabled: false,
		memoryContext: [],
		memoryHarvest: null
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

export function truncateAfterAndUpdateUserMessage(
	conversationId: string,
	messageId: string,
	content: string
): Message | null {
	const db = getDb();
	ensureBackgroundAgentLifecycleTable(db);
	const tx = db.transaction(() => {
		const target = db
			.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?')
			.get(conversationId, messageId) as MsgRow | undefined;
		if (!target) return null;

		const later = db
			.prepare(
				`SELECT id FROM messages
				  WHERE conversation_id = ?
				    AND (created_at > ? OR (created_at = ? AND id > ?))`
			)
			.all(conversationId, target.created_at, target.created_at, target.id) as { id: string }[];
		const laterIds = later.map((r) => r.id);
		if (laterIds.length > 0) {
			const msgPlaceholders = laterIds.map(() => '?').join(',');
			const toolIds = db
				.prepare(`SELECT id FROM tool_calls WHERE message_id IN (${msgPlaceholders})`)
				.all(...laterIds) as { id: string }[];
			if (toolIds.length > 0) {
				const toolPlaceholders = toolIds.map(() => '?').join(',');
				db.prepare(
					`DELETE FROM background_agent_lifecycles WHERE tool_call_id IN (${toolPlaceholders})`
				).run(...toolIds.map((r) => r.id));
			}
			db.prepare(`DELETE FROM reasoning_blocks WHERE message_id IN (${msgPlaceholders})`).run(
				...laterIds
			);
			db.prepare(`DELETE FROM file_edits WHERE message_id IN (${msgPlaceholders})`).run(
				...laterIds
			);
			db.prepare(`DELETE FROM message_memory_context WHERE message_id IN (${msgPlaceholders})`).run(
				...laterIds
			);
			db.prepare(`DELETE FROM message_memory_harvest WHERE message_id IN (${msgPlaceholders})`).run(
				...laterIds
			);
			db.prepare(`DELETE FROM tool_calls WHERE message_id IN (${msgPlaceholders})`).run(
				...laterIds
			);
			db.prepare(`DELETE FROM messages WHERE id IN (${msgPlaceholders})`).run(...laterIds);
		}

		db.prepare(
			`UPDATE messages
			    SET content = ?,
			        status = 'complete',
			        error_code = NULL
			  WHERE id = ?`
		).run(content, messageId);

		return rowToMessage({
			...target,
			content,
			status: 'complete',
			error_code: null
		});
	});
	return tx();
}

export interface MemoryContextInput {
	memoryId: string;
	scope: MemoryContextRecord['scope'];
	kind: string;
	entity: string | null;
	content: MemoryContextRecord['content'];
	tags: string[];
	importance: number;
}

export function replaceMemoryContext(messageId: string, rows: MemoryContextInput[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare('UPDATE messages SET memory_context_enabled = 1 WHERE id = ?').run(messageId);
		db.prepare('DELETE FROM message_memory_context WHERE message_id = ?').run(messageId);
		const stmt = db.prepare(
			`INSERT INTO message_memory_context(
			   id, message_id, memory_id, scope, kind, entity, content_json, tags_json, importance, sort_index
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		rows.forEach((row, sortIndex) => {
			stmt.run(
				ulid(),
				messageId,
				row.memoryId,
				row.scope,
				row.kind,
				row.entity,
				stringifyJsonValue(row.content),
				JSON.stringify(row.tags),
				row.importance,
				sortIndex
			);
		});
	});
	tx();
}

export interface MemoryHarvestUpsert {
	status: MemoryHarvestStatus;
	reason?: string | null;
	writes?: number;
	updates?: number;
	forgets?: number;
	sceneEnded?: boolean;
	error?: string | null;
	prompt?: string | null;
	response?: string | null;
	reasoning?: string | null;
	parsedJson?: string | null;
	changesJson?: string | null;
	updatedAt?: number;
}

export function upsertMemoryHarvest(
	messageId: string,
	input: MemoryHarvestUpsert
): MemoryHarvestRecord {
	const now = input.updatedAt ?? Date.now();
	getDb()
		.prepare(
			`INSERT INTO message_memory_harvest(
			   message_id, status, reason, writes, updates, forgets, scene_ended, error,
			   prompt, response, reasoning, parsed_json, changes_json, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(message_id) DO UPDATE SET
			   status = excluded.status,
			   reason = excluded.reason,
			   writes = excluded.writes,
			   updates = excluded.updates,
			   forgets = excluded.forgets,
			   scene_ended = excluded.scene_ended,
			   error = excluded.error,
			   prompt = excluded.prompt,
			   response = excluded.response,
			   reasoning = excluded.reasoning,
			   parsed_json = excluded.parsed_json,
			   changes_json = excluded.changes_json,
			   updated_at = excluded.updated_at`
		)
		.run(
			messageId,
			input.status,
			input.reason ?? null,
			input.writes ?? 0,
			input.updates ?? 0,
			input.forgets ?? 0,
			input.sceneEnded ? 1 : 0,
			input.error ?? null,
			input.prompt ?? null,
			input.response ?? null,
			input.reasoning ?? null,
			input.parsedJson ?? null,
			input.changesJson ?? null,
			now
		);
	return {
		messageId,
		status: input.status,
		reason: input.reason ?? null,
		writes: input.writes ?? 0,
		updates: input.updates ?? 0,
		forgets: input.forgets ?? 0,
		sceneEnded: input.sceneEnded === true,
		error: input.error ?? null,
		prompt: input.prompt ?? null,
		response: input.response ?? null,
		reasoning: input.reasoning ?? null,
		parsedJson: input.parsedJson ?? null,
		changesJson: input.changesJson ?? null,
		updatedAt: now
	};
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

export function updateBackgroundAgentLifecycle(
	toolCallId: string,
	agentId: string,
	status: 'running' | 'completed' | 'failed',
	now: number = Date.now()
) {
	const db = getDb();
	ensureBackgroundAgentLifecycleTable(db);
	db.prepare(
		`INSERT INTO background_agent_lifecycles(
		   tool_call_id, agent_id, status, started_at, ended_at
		 )
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(tool_call_id) DO UPDATE SET
		   agent_id = excluded.agent_id,
		   status = CASE
		     WHEN background_agent_lifecycles.status IN ('completed', 'failed')
		       THEN background_agent_lifecycles.status
		     ELSE excluded.status
		   END,
		   started_at = min(background_agent_lifecycles.started_at, excluded.started_at),
		   ended_at = COALESCE(background_agent_lifecycles.ended_at, excluded.ended_at)`
	).run(toolCallId, agentId, status, now, status === 'running' ? null : now);
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
	const db = getDb();
	ensureBackgroundAgentLifecycleTable(db);
	const row = db
		.prepare(
			`SELECT tc.*,
			        m.conversation_id,
			        m.role AS message_role,
			        c.user_id AS conversation_user_id,
			        bal.agent_id AS background_agent_id,
			        bal.status AS background_agent_status,
			        bal.started_at AS background_agent_started_at,
			        bal.ended_at AS background_agent_ended_at
			   FROM tool_calls tc
			   JOIN messages m ON m.id = tc.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			   LEFT JOIN background_agent_lifecycles bal ON bal.tool_call_id = tc.id
			  WHERE tc.id = ? AND m.conversation_id = ?`
		)
		.get(toolCallId, conversationId) as
		| (ToolRow & {
				conversation_id: string;
				conversation_user_id: string;
				message_role: string;
				background_agent_id: string | null;
				background_agent_status: ToolCallRecord['backgroundAgentStatus'];
				background_agent_started_at: number | null;
				background_agent_ended_at: number | null;
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
		backgroundAgentStatus: row.background_agent_status,
		backgroundAgentId: row.background_agent_id,
		backgroundAgentStartedAt: row.background_agent_started_at,
		backgroundAgentEndedAt: row.background_agent_ended_at,
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
