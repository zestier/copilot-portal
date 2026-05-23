import { ulid } from '../ids';
import { getDb } from '../index';
import type { WorkspaceTicket, WorkspaceTicketStatus } from '$lib/types';

interface TicketRow {
	id: string;
	user_id: string;
	workspace_key: string;
	title: string;
	body: string;
	status: string;
	source_conversation_id: string | null;
	source_message_id: string | null;
	created_at: number;
	updated_at: number;
	closed_at: number | null;
}

function normalizeStatus(raw: string): WorkspaceTicketStatus {
	return raw === 'done' || raw === 'archived' ? raw : 'open';
}

function rowToTicket(r: TicketRow): WorkspaceTicket {
	return {
		id: r.id,
		userId: r.user_id,
		workspaceKey: r.workspace_key,
		title: r.title,
		body: r.body,
		status: normalizeStatus(r.status),
		sourceConversationId: r.source_conversation_id,
		sourceMessageId: r.source_message_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		closedAt: r.closed_at
	};
}

export interface ListOptions {
	status?: WorkspaceTicketStatus | 'all';
	limit?: number;
}

export function list(
	userId: string,
	workspaceKey: string,
	opts: ListOptions = {}
): WorkspaceTicket[] {
	const limit = opts.limit ?? 100;
	const status = opts.status ?? 'open';
	const rows =
		status === 'all'
			? (getDb()
					.prepare(
						`SELECT * FROM workspace_tickets
						 WHERE user_id = ? AND workspace_key = ?
						 ORDER BY status = 'open' DESC, updated_at DESC, created_at DESC
						 LIMIT ?`
					)
					.all(userId, workspaceKey, limit) as TicketRow[])
			: (getDb()
					.prepare(
						`SELECT * FROM workspace_tickets
						 WHERE user_id = ? AND workspace_key = ? AND status = ?
						 ORDER BY updated_at DESC, created_at DESC
						 LIMIT ?`
					)
					.all(userId, workspaceKey, status, limit) as TicketRow[]);
	return rows.map(rowToTicket);
}

export function count(
	userId: string,
	workspaceKey: string,
	status: WorkspaceTicketStatus = 'open'
): number {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) AS count FROM workspace_tickets
			 WHERE user_id = ? AND workspace_key = ? AND status = ?`
		)
		.get(userId, workspaceKey, status) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function get(id: string, userId: string): WorkspaceTicket | null {
	const row = getDb()
		.prepare('SELECT * FROM workspace_tickets WHERE id = ? AND user_id = ?')
		.get(id, userId) as TicketRow | undefined;
	return row ? rowToTicket(row) : null;
}

export interface CreateInput {
	workspaceKey: string;
	title: string;
	body?: string;
	sourceConversationId?: string | null;
	sourceMessageId?: string | null;
}

export function create(userId: string, input: CreateInput): WorkspaceTicket {
	const id = ulid();
	const now = Date.now();
	const title = input.title.trim();
	const body = input.body?.trim() ?? '';
	if (!title) throw new Error('ticket title cannot be empty');
	getDb()
		.prepare(
			`INSERT INTO workspace_tickets(
			   id, user_id, workspace_key, title, body, status,
			   source_conversation_id, source_message_id, created_at, updated_at, closed_at
			 ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
		)
		.run(
			id,
			userId,
			input.workspaceKey,
			title,
			body,
			input.sourceConversationId ?? null,
			input.sourceMessageId ?? null,
			now,
			now
		);
	return {
		id,
		userId,
		workspaceKey: input.workspaceKey,
		title,
		body,
		status: 'open',
		sourceConversationId: input.sourceConversationId ?? null,
		sourceMessageId: input.sourceMessageId ?? null,
		createdAt: now,
		updatedAt: now,
		closedAt: null
	};
}

export interface UpdateInput {
	title?: string;
	body?: string;
	status?: WorkspaceTicketStatus;
}

export function update(id: string, userId: string, patch: UpdateInput): WorkspaceTicket | null {
	const current = get(id, userId);
	if (!current) return null;

	const title = patch.title?.trim();
	if (title !== undefined && !title) throw new Error('ticket title cannot be empty');
	const nextStatus = patch.status ?? current.status;
	const now = Date.now();
	const closedAt =
		nextStatus === 'done' || nextStatus === 'archived' ? (current.closedAt ?? now) : null;

	getDb()
		.prepare(
			`UPDATE workspace_tickets
			 SET title = ?, body = ?, status = ?, updated_at = ?, closed_at = ?
			 WHERE id = ? AND user_id = ?`
		)
		.run(
			patch.title?.trim() ?? current.title,
			patch.body?.trim() ?? current.body,
			nextStatus,
			now,
			closedAt,
			id,
			userId
		);
	return get(id, userId);
}

export function remove(id: string, userId: string): boolean {
	const r = getDb()
		.prepare('DELETE FROM workspace_tickets WHERE id = ? AND user_id = ?')
		.run(id, userId);
	return r.changes > 0;
}
