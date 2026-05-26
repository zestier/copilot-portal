import { ulid } from '../ids';
import { getDb } from '../index';
import type { ChatPromptTemplate, PromptTemplateStatus } from '$lib/types';

interface PromptTemplateRow {
	id: string;
	user_id: string;
	title: string;
	description: string;
	prompt: string;
	status: string;
	pinned: number;
	order_index: number;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
}

function normalizeStatus(raw: string): PromptTemplateStatus {
	return raw === 'archived' ? 'archived' : 'open';
}

function rowToTemplate(row: PromptTemplateRow): ChatPromptTemplate {
	return {
		id: row.id,
		userId: row.user_id,
		title: row.title,
		description: row.description,
		prompt: row.prompt,
		status: normalizeStatus(row.status),
		pinned: row.pinned === 1,
		orderIndex: row.order_index,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		archivedAt: row.archived_at
	};
}

export interface ListOptions {
	status?: PromptTemplateStatus | 'all';
	limit?: number;
}

export function list(userId: string, opts: ListOptions = {}): ChatPromptTemplate[] {
	const status = opts.status ?? 'open';
	const limit = opts.limit ?? 100;
	const rows =
		status === 'all'
			? (getDb()
					.prepare(
						`SELECT * FROM prompt_templates
						 WHERE user_id = ?
						 ORDER BY status = 'open' DESC, pinned DESC, order_index ASC, updated_at DESC
						 LIMIT ?`
					)
					.all(userId, limit) as PromptTemplateRow[])
			: (getDb()
					.prepare(
						`SELECT * FROM prompt_templates
						 WHERE user_id = ? AND status = ?
						 ORDER BY pinned DESC, order_index ASC, updated_at DESC
						 LIMIT ?`
					)
					.all(userId, status, limit) as PromptTemplateRow[]);
	return rows.map(rowToTemplate);
}

export function get(id: string, userId: string): ChatPromptTemplate | null {
	const row = getDb()
		.prepare('SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?')
		.get(id, userId) as PromptTemplateRow | undefined;
	return row ? rowToTemplate(row) : null;
}

export interface CreateInput {
	title: string;
	description?: string;
	prompt: string;
	pinned?: boolean;
	orderIndex?: number;
}

export function create(userId: string, input: CreateInput): ChatPromptTemplate {
	const title = input.title.trim();
	const description = input.description?.trim() ?? '';
	const prompt = input.prompt.trim();
	if (!title) throw new Error('prompt template title cannot be empty');
	if (!prompt) throw new Error('prompt template body cannot be empty');
	const id = ulid();
	const now = Date.now();
	const orderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex ?? 0) : 0;
	getDb()
		.prepare(
			`INSERT INTO prompt_templates(
			   id, user_id, title, description, prompt, status, pinned, order_index,
			   created_at, updated_at, archived_at
			 ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
		)
		.run(id, userId, title, description, prompt, input.pinned ? 1 : 0, orderIndex, now, now);
	return {
		id,
		userId,
		title,
		description,
		prompt,
		status: 'open',
		pinned: input.pinned ?? false,
		orderIndex,
		createdAt: now,
		updatedAt: now,
		archivedAt: null
	};
}

export interface UpdateInput {
	title?: string;
	description?: string;
	prompt?: string;
	status?: PromptTemplateStatus;
	pinned?: boolean;
	orderIndex?: number;
}

export function update(id: string, userId: string, patch: UpdateInput): ChatPromptTemplate | null {
	const current = get(id, userId);
	if (!current) return null;

	const title = patch.title?.trim();
	const prompt = patch.prompt?.trim();
	if (title !== undefined && !title) throw new Error('prompt template title cannot be empty');
	if (prompt !== undefined && !prompt) throw new Error('prompt template body cannot be empty');
	const nextStatus = patch.status ?? current.status;
	const now = Date.now();
	const archivedAt = nextStatus === 'archived' ? (current.archivedAt ?? now) : null;
	const orderIndex =
		patch.orderIndex !== undefined && Number.isFinite(patch.orderIndex)
			? Math.trunc(patch.orderIndex)
			: current.orderIndex;

	getDb()
		.prepare(
			`UPDATE prompt_templates
			 SET title = ?, description = ?, prompt = ?, status = ?, pinned = ?,
			     order_index = ?, updated_at = ?, archived_at = ?
			 WHERE id = ? AND user_id = ?`
		)
		.run(
			title ?? current.title,
			patch.description?.trim() ?? current.description,
			prompt ?? current.prompt,
			nextStatus,
			(patch.pinned ?? current.pinned) ? 1 : 0,
			orderIndex,
			now,
			archivedAt,
			id,
			userId
		);
	return get(id, userId);
}

export function archive(id: string, userId: string): ChatPromptTemplate | null {
	return update(id, userId, { status: 'archived' });
}
