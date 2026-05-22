import { ulid } from '../ids';
import { getDb } from '../index';
import { normalizeSessionMode, type Conversation, type SessionMode } from '$lib/types';

interface ConvRow {
	id: string;
	user_id: string;
	title: string;
	workdir: string;
	model: string | null;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
	forked_from_conversation_id: string | null;
	forked_from_message_id: string | null;
	mode: string | null;
	approve_all_tools: number | null;
}

function rowToConv(r: ConvRow): Conversation {
	const mode = normalizeSessionMode(r.mode);
	return {
		id: r.id,
		userId: r.user_id,
		title: r.title,
		workdir: r.workdir,
		model: r.model,
		mode,
		approveAllTools: r.approve_all_tools === 1,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		archivedAt: r.archived_at,
		forkedFromConversationId: r.forked_from_conversation_id,
		forkedFromMessageId: r.forked_from_message_id
	};
}

export function get(id: string, userId: string): Conversation | null {
	const r = getDb()
		.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
		.get(id, userId) as ConvRow | undefined;
	return r ? rowToConv(r) : null;
}

export interface ListOpts {
	includeArchived?: boolean;
	limit?: number;
}

/**
 * List conversations that were forked from `sourceId` (i.e., child forks).
 * Scoped to `userId` so users only ever see their own forks; the source
 * conversation must also be theirs at the call site.
 */
export function listChildren(userId: string, sourceId: string): Conversation[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM conversations
			 WHERE user_id = ? AND forked_from_conversation_id = ?
			 ORDER BY created_at ASC`
		)
		.all(userId, sourceId) as ConvRow[];
	return rows.map(rowToConv);
}

export function list(userId: string, opts: ListOpts = {}): Conversation[] {
	const limit = opts.limit ?? 200;
	const sql = opts.includeArchived
		? `SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`
		: `SELECT * FROM conversations WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`;
	const rows = getDb().prepare(sql).all(userId, limit) as ConvRow[];
	return rows.map(rowToConv);
}

export interface CreateInput {
	title: string;
	workdir: string;
	model: string | null;
	mode?: SessionMode;
	id?: string;
	forkedFromConversationId?: string | null;
	forkedFromMessageId?: string | null;
}

/**
 * Mint a fresh conversation id without touching the database. Useful when
 * the caller needs the id to derive other state (e.g. workdir path) before
 * inserting the row.
 */
export function newId(): string {
	return ulid();
}

export function create(userId: string, input: CreateInput): Conversation {
	const id = input.id ?? ulid();
	const now = Date.now();
	const forkConv = input.forkedFromConversationId ?? null;
	const forkMsg = input.forkedFromMessageId ?? null;
	const mode = input.mode ?? 'interactive';
	getDb()
		.prepare(
			`INSERT INTO conversations(
			   id, user_id, title, workdir, model, mode, created_at, updated_at,
			   forked_from_conversation_id, forked_from_message_id
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, userId, input.title, input.workdir, input.model, mode, now, now, forkConv, forkMsg);
	return {
		id,
		userId,
		title: input.title,
		workdir: input.workdir,
		model: input.model,
		mode,
		approveAllTools: false,
		createdAt: now,
		updatedAt: now,
		archivedAt: null,
		forkedFromConversationId: forkConv,
		forkedFromMessageId: forkMsg
	};
}

export function rename(id: string, userId: string, title: string): boolean {
	const r = getDb()
		.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
		.run(title, Date.now(), id, userId);
	return r.changes > 0;
}

/**
 * Update per-conversation session settings (mode and/or approve-all bypass).
 * Returns true iff a row was modified. The bridge reads these on each
 * `pool.acquire` so a recreated session inherits the latest values; the
 * /session PATCH endpoint additionally pushes them to the live SDK session
 * via `session.setMode` / `session.setApproveAll`.
 */
export function updateSessionSettings(
	id: string,
	userId: string,
	patch: { mode?: SessionMode; approveAllTools?: boolean }
): boolean {
	const sets: string[] = [];
	const args: Array<string | number> = [];
	if (patch.mode !== undefined) {
		sets.push('mode = ?');
		args.push(patch.mode);
	}
	if (patch.approveAllTools !== undefined) {
		sets.push('approve_all_tools = ?');
		args.push(patch.approveAllTools ? 1 : 0);
	}
	if (sets.length === 0) return false;
	sets.push('updated_at = ?');
	args.push(Date.now());
	args.push(id, userId);
	const r = getDb()
		.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
		.run(...args);
	return r.changes > 0;
}

export function touch(id: string) {
	getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function archive(id: string, userId: string): boolean {
	const r = getDb()
		.prepare(
			'UPDATE conversations SET archived_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL'
		)
		.run(Date.now(), id, userId);
	return r.changes > 0;
}

export function unarchive(id: string, userId: string): boolean {
	const r = getDb()
		.prepare(
			'UPDATE conversations SET archived_at = NULL WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL'
		)
		.run(id, userId);
	return r.changes > 0;
}

export function remove(id: string, userId: string): boolean {
	const r = getDb()
		.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
		.run(id, userId);
	return r.changes > 0;
}
