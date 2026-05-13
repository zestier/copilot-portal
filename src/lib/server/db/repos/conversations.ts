import { ulid } from '../ids';
import { getDb } from '../index';
import type { Conversation } from '$lib/types';

interface ConvRow {
	id: string;
	user_id: string;
	title: string;
	workdir: string;
	model: string | null;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
}

function rowToConv(r: ConvRow): Conversation {
	return {
		id: r.id,
		userId: r.user_id,
		title: r.title,
		workdir: r.workdir,
		model: r.model,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		archivedAt: r.archived_at
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
}

export function create(userId: string, input: CreateInput): Conversation {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO conversations(id, user_id, title, workdir, model, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, userId, input.title, input.workdir, input.model, now, now);
	return {
		id,
		userId,
		title: input.title,
		workdir: input.workdir,
		model: input.model,
		createdAt: now,
		updatedAt: now,
		archivedAt: null
	};
}

export function rename(id: string, userId: string, title: string): boolean {
	const r = getDb()
		.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
		.run(title, Date.now(), id, userId);
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
