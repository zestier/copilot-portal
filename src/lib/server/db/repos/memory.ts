import { randomBytes } from 'node:crypto';
import { ulid } from '../ids';
import { getDb } from '../index';

// Usability rules for the entity-keyed memory model. These are surfaced
// verbatim on every practical path (model-facing tool descriptions, the
// harvester prompt, and the auto-injected memory block) so the "one
// entity = one memory" contract is understood wherever the bank is used.
export const MEMORY_ENTITY_GUIDANCE: readonly string[] = [
	'Address every memory by its entity handle: a stable dot-path key such as story.protagonist.mara, user.memory.style, or repo.commands.validation.',
	'One entity is exactly one memory. Writing the same scope+entity again replaces that memory in place, so reuse the exact handle to refine a fact and never spawn a near-duplicate under a reworded handle.',
	'A genuinely distinct fact deserves its own honest handle. If Mara\u2019s relationship to Kael is its own fact, store it under mara.rel.kael rather than overloading the mara handle with a second slot.',
	'kind is a mutable label, not part of the identity, so updating a memory can change its kind in place without creating a second record.'
];

export type MemoryScope = 'scene' | 'session' | 'shared';
export type WritableMemoryScope = Exclude<MemoryScope, 'shared'>;
export type MemoryStatus = 'active' | 'archived' | 'forgotten' | 'superseded';
export type MemorySource = 'model' | 'harvester' | 'user';
export type MemoryContent =
	| null
	| string
	| number
	| boolean
	| MemoryContent[]
	| { [key: string]: MemoryContent };

export const MAX_MEMORY_CONTENT_JSON_CHARS = 8000;

export interface MemoryRow {
	id: string;
	conversationId: string;
	scope: MemoryScope;
	sceneId: string | null;
	kind: string;
	entity: string | null;
	content: MemoryContent;
	tags: string[];
	importance: number;
	status: MemoryStatus;
	source: MemorySource;
	supersedesId: string | null;
	createdAt: number;
	updatedAt: number;
	expiresAt: number | null;
}

export interface SceneRow {
	id: string;
	conversationId: string;
	label: string | null;
	openedAt: number;
	closedAt: number | null;
}

interface MemoryDbRow {
	id: string;
	conversation_id: string;
	scope: string;
	scene_id: string | null;
	kind: string;
	entity: string | null;
	content_json: string;
	tags_json: string;
	importance: number;
	status: string;
	source: string;
	supersedes_id: string | null;
	created_at: number;
	updated_at: number;
	expires_at: number | null;
}

interface SceneDbRow {
	id: string;
	conversation_id: string;
	label: string | null;
	opened_at: number;
	closed_at: number | null;
}

interface SnapshotMetaRow {
	message_id: string;
	created_at: number;
}

interface SnapshotSceneRow {
	message_id: string;
	original_scene_id: string;
	label: string | null;
	opened_at: number;
	closed_at: number | null;
}

interface SnapshotMemoryRow {
	message_id: string;
	original_memory_id: string;
	scope: string;
	original_scene_id: string | null;
	kind: string;
	entity: string | null;
	content_json: string;
	tags_json: string;
	importance: number;
	status: string;
	source: string;
	original_supersedes_id: string | null;
	created_at: number;
	updated_at: number;
	expires_at: number | null;
}

export interface WriteInput {
	scope: MemoryScope;
	sceneId?: string | null;
	kind: string;
	entity?: string | null;
	content: MemoryContent;
	tags?: string[];
	importance?: number;
	source: MemorySource;
	supersedesId?: string | null;
}

export interface UpdateInput {
	kind?: string;
	content?: MemoryContent;
	entity?: string | null;
	tags?: string[];
	importance?: number;
	status?: MemoryStatus;
}

export interface ListOptions {
	scope?: MemoryScope;
	status?: MemoryStatus | 'all';
	includeArchived?: boolean;
	limit?: number;
	sceneId?: string | null;
}

export interface QueryOptions {
	scope?: MemoryScope;
	includeArchived?: boolean;
	limit?: number;
}

function parseTags(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string') : [];
	} catch {
		return [];
	}
}

function normalizeTags(tags: string[] | undefined): string[] {
	if (!tags) return [];
	const seen = new Set<string>();
	for (const tag of tags) {
		const trimmed = tag.trim();
		if (trimmed) seen.add(trimmed);
	}
	return [...seen];
}

function normalizeImportance(value: number | undefined): number {
	if (value === undefined) return 3;
	if (!Number.isInteger(value) || value < 1 || value > 5) {
		throw new Error('memory importance must be an integer from 1 to 5');
	}
	return value;
}

function normalizeKind(value: string): string {
	const kind = value.trim();
	if (!kind) throw new Error('memory kind cannot be empty');
	if (kind.length > 80) throw new Error('memory kind cannot exceed 80 characters');
	return kind;
}

function normalizeEntity(value: string | null | undefined): string | null {
	const entity = value?.trim();
	if (!entity) return null;
	if (entity.length > 200) throw new Error('memory entity cannot exceed 200 characters');
	return entity;
}

// `entity` is the sole external identity, so every active row needs one. When a
// writer omits it we mint a stable, collision-resistant slug derived from the
// kind so the record is still addressable (e.g. auto.bugfix.k7f3a9c2d1).
function entityOrAutoSlug(value: string | null | undefined, kind: string): string {
	const entity = normalizeEntity(value);
	if (entity) return entity;
	const base =
		kind
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'memory';
	return `auto.${base}.${randomBytes(5).toString('hex')}`;
}

export function isMemoryContent(value: unknown): value is MemoryContent {
	if (value === null) return true;
	const t = typeof value;
	if (t === 'string' || t === 'boolean') return true;
	if (t === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isMemoryContent);
	if (t === 'object' && value) {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return false;
		return Object.values(value as Record<string, unknown>).every(isMemoryContent);
	}
	return false;
}

export function isMemoryContentWithinLimit(value: unknown): value is MemoryContent {
	if (!isMemoryContent(value)) return false;
	const json = JSON.stringify(value);
	return json !== undefined && json.length <= MAX_MEMORY_CONTENT_JSON_CHARS;
}

function parseContentJson(raw: string): MemoryContent {
	const parsed = JSON.parse(raw) as unknown;
	if (!isMemoryContent(parsed)) throw new Error('stored memory content is not JSON-compatible');
	return parsed;
}

export function stringifyContent(value: MemoryContent): string {
	if (!isMemoryContent(value)) throw new Error('memory content must be a JSON-compatible value');
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error('memory content must be a JSON-compatible value');
	if (json.length > MAX_MEMORY_CONTENT_JSON_CHARS) {
		throw new Error(
			`memory content cannot exceed ${MAX_MEMORY_CONTENT_JSON_CHARS} JSON characters`
		);
	}
	return json;
}

export function formatContent(value: MemoryContent): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function rowToMemory(row: MemoryDbRow): MemoryRow {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		scope: row.scope as MemoryScope,
		sceneId: row.scene_id,
		kind: row.kind,
		entity: row.entity,
		content: parseContentJson(row.content_json),
		tags: parseTags(row.tags_json),
		importance: row.importance,
		status: row.status as MemoryStatus,
		source: row.source as MemorySource,
		supersedesId: row.supersedes_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at
	};
}

function rowToScene(row: SceneDbRow): SceneRow {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		label: row.label,
		openedAt: row.opened_at,
		closedAt: row.closed_at
	};
}

export function get(id: string, userId: string, conversationId: string): MemoryRow | null {
	const row = getDb()
		.prepare(
			`SELECT m.* FROM memory_banks m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE m.id = ? AND m.conversation_id = ? AND c.user_id = ?`
		)
		.get(id, conversationId, userId) as MemoryDbRow | undefined;
	return row ? rowToMemory(row) : null;
}

export function write(userId: string, conversationId: string, input: WriteInput): MemoryRow {
	assertConversationOwned(userId, conversationId);
	const kind = normalizeKind(input.kind);
	const contentJson = stringifyContent(input.content);
	const entity = entityOrAutoSlug(input.entity, kind);
	const tags = normalizeTags(input.tags);
	const tagsJson = JSON.stringify(tags);
	const importance = normalizeImportance(input.importance);
	const sceneId =
		input.scope === 'scene'
			? input.sceneId
				? requireScene(userId, conversationId, input.sceneId).id
				: ensureCurrentScene(userId, conversationId).id
			: null;

	const db = getDb();
	const tx = db.transaction(() => {
		const id = ulid();
		const now = Date.now();
		// Upsert on the active-handle key: re-writing the same (scope, entity)
		// refines the existing memory in place instead of creating a duplicate.
		// kind is part of the payload, not the key, so it can change here too.
		db.prepare(
			`INSERT INTO memory_banks(
			   id, conversation_id, scope, scene_id, kind, entity, content_json, tags_json,
			   importance, status, source, supersedes_id, created_at, updated_at, expires_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)
			 ON CONFLICT(conversation_id, scope, entity) WHERE status = 'active'
			 DO UPDATE SET
			   kind = excluded.kind,
			   scene_id = excluded.scene_id,
			   content_json = excluded.content_json,
			   tags_json = excluded.tags_json,
			   importance = excluded.importance,
			   source = excluded.source,
			   supersedes_id = excluded.supersedes_id,
			   updated_at = excluded.updated_at`
		).run(
			id,
			conversationId,
			input.scope,
			sceneId,
			kind,
			entity,
			contentJson,
			tagsJson,
			importance,
			input.source,
			input.supersedesId ?? null,
			now,
			now
		);
		const created = activeByEntity(conversationId, input.scope, entity);
		if (!created) throw new Error(`Upserted memory not found: ${input.scope}/${entity}`);
		return created;
	});
	return tx();
}

function activeByEntity(
	conversationId: string,
	scope: MemoryScope,
	entity: string
): MemoryRow | null {
	const row = getDb()
		.prepare(
			`SELECT * FROM memory_banks
			 WHERE conversation_id = ? AND scope = ? AND entity = ? AND status = 'active'
			 LIMIT 1`
		)
		.get(conversationId, scope, entity) as MemoryDbRow | undefined;
	return row ? rowToMemory(row) : null;
}

// Resolve the active memory addressed by an entity handle. Entity is unique per
// (conversation, scope) among active rows, so a scope disambiguates when the
// same handle exists in both a scene and the session.
export function resolveActive(
	userId: string,
	conversationId: string,
	entity: string,
	scope?: MemoryScope
): MemoryRow | null {
	assertConversationOwned(userId, conversationId);
	const handle = entity.trim();
	if (!handle) return null;
	const clauses = ['m.conversation_id = ?', 'c.user_id = ?', 'm.entity = ?', "m.status = 'active'"];
	const params: Array<string> = [conversationId, userId, handle];
	if (scope) {
		clauses.push('m.scope = ?');
		params.push(scope);
	}
	const rows = getDb()
		.prepare(
			`SELECT m.* FROM memory_banks m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE ${clauses.join(' AND ')}`
		)
		.all(...params) as MemoryDbRow[];
	if (rows.length === 0) return null;
	if (rows.length > 1) {
		throw new Error(
			`Multiple active memories match entity "${handle}"; specify scope to disambiguate.`
		);
	}
	return rowToMemory(rows[0]);
}

export function updateByEntity(
	userId: string,
	conversationId: string,
	entity: string,
	scope: MemoryScope | undefined,
	patch: UpdateInput
): MemoryRow | null {
	const target = resolveActive(userId, conversationId, entity, scope);
	if (!target) return null;
	return update(target.id, userId, conversationId, patch);
}

export function forgetByEntity(
	userId: string,
	conversationId: string,
	entity: string,
	scope?: MemoryScope
): boolean {
	const target = resolveActive(userId, conversationId, entity, scope);
	if (!target) return false;
	return forget(target.id, userId, conversationId);
}

export function update(
	id: string,
	userId: string,
	conversationId: string,
	patch: UpdateInput
): MemoryRow | null {
	const current = get(id, userId, conversationId);
	if (!current) return null;
	const kind = patch.kind === undefined ? current.kind : normalizeKind(patch.kind);
	const contentJson =
		patch.content === undefined
			? stringifyContent(current.content)
			: stringifyContent(patch.content);
	const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags);
	const importance =
		patch.importance === undefined ? current.importance : normalizeImportance(patch.importance);
	const status = patch.status ?? current.status;
	const entity =
		status === 'active'
			? entityOrAutoSlug(patch.entity === undefined ? current.entity : patch.entity, kind)
			: patch.entity === undefined
				? current.entity
				: normalizeEntity(patch.entity);
	const now = Date.now();
	getDb()
		.prepare(
			`UPDATE memory_banks
			 SET kind = ?, entity = ?, content_json = ?, tags_json = ?, importance = ?, status = ?, updated_at = ?
			 WHERE id = ? AND conversation_id = ?`
		)
		.run(
			kind,
			entity,
			contentJson,
			JSON.stringify(tags),
			importance,
			status,
			now,
			id,
			conversationId
		);
	return get(id, userId, conversationId);
}

export function forget(id: string, userId: string, conversationId: string): boolean {
	const result = getDb()
		.prepare(
			`UPDATE memory_banks AS m
			 SET status = 'forgotten', updated_at = ?
			 WHERE id = ? AND conversation_id = ?
			   AND EXISTS (
			     SELECT 1 FROM conversations c
			     WHERE c.id = m.conversation_id AND c.user_id = ?
			   )`
		)
		.run(Date.now(), id, conversationId, userId);
	return result.changes > 0;
}

export function supersede(
	oldId: string,
	userId: string,
	conversationId: string,
	input: Omit<WriteInput, 'supersedesId'>
): MemoryRow {
	const db = getDb();
	const tx = db.transaction(() => {
		const old = get(oldId, userId, conversationId);
		if (!old) throw new Error(`Memory not found: ${oldId}`);
		// Demote the old row first so it leaves the active-handle key; otherwise
		// the entity-keyed upsert in write() would collide with it and refine it
		// in place instead of minting the fresh superseding row.
		update(oldId, userId, conversationId, { status: 'superseded' });
		const created = write(userId, conversationId, { ...input, supersedesId: oldId });
		return created;
	});
	return tx();
}

export function list(userId: string, conversationId: string, opts: ListOptions = {}): MemoryRow[] {
	const limit = opts.limit ?? 100;
	const clauses = ['m.conversation_id = ?', 'c.user_id = ?'];
	const params: Array<string | number | null> = [conversationId, userId];
	if (opts.scope) {
		clauses.push('m.scope = ?');
		params.push(opts.scope);
	}
	if (opts.sceneId !== undefined) {
		clauses.push(opts.sceneId === null ? 'm.scene_id IS NULL' : 'm.scene_id = ?');
		if (opts.sceneId !== null) params.push(opts.sceneId);
	}
	if (opts.status && opts.status !== 'all') {
		clauses.push('m.status = ?');
		params.push(opts.status);
	} else if (!opts.includeArchived && opts.status !== 'all') {
		clauses.push("m.status = 'active'");
	}
	params.push(limit);
	const rows = getDb()
		.prepare(
			`SELECT m.* FROM memory_banks m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE ${clauses.join(' AND ')}
			 ORDER BY CASE m.scope WHEN 'scene' THEN 0 WHEN 'session' THEN 1 ELSE 2 END,
			          m.importance DESC, m.updated_at DESC, m.created_at DESC
			 LIMIT ?`
		)
		.all(...params) as MemoryDbRow[];
	return rows.map(rowToMemory);
}

export function query(
	userId: string,
	conversationId: string,
	q: string,
	opts: QueryOptions = {}
): MemoryRow[] {
	const limit = opts.limit ?? 20;
	const ftsQuery = toFtsQuery(q);
	if (!ftsQuery) {
		return list(userId, conversationId, {
			scope: opts.scope,
			limit,
			includeArchived: opts.includeArchived
		});
	}
	const clauses = ['m.conversation_id = ?', 'c.user_id = ?', 'memory_banks_fts MATCH ?'];
	const params: Array<string | number> = [conversationId, userId, ftsQuery];
	if (opts.scope) {
		clauses.push('m.scope = ?');
		params.push(opts.scope);
	}
	if (!opts.includeArchived) clauses.push("m.status = 'active'");
	params.push(limit);
	const rows = getDb()
		.prepare(
			`SELECT m.* FROM memory_banks_fts
			 JOIN memory_banks m ON m.rowid = memory_banks_fts.rowid
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE ${clauses.join(' AND ')}
			 ORDER BY CASE m.scope WHEN 'scene' THEN 0 WHEN 'session' THEN 1 ELSE 2 END,
			          bm25(memory_banks_fts), m.importance DESC, m.updated_at DESC
			 LIMIT ?`
		)
		.all(...params) as MemoryDbRow[];
	return rows.map(rowToMemory);
}

export function getActiveDigest(
	userId: string,
	conversationId: string,
	budgetChars: number
): MemoryRow[] {
	if (budgetChars <= 0) return [];
	const candidates = list(userId, conversationId, {
		status: 'active',
		includeArchived: false,
		limit: 500
	});
	const selected: MemoryRow[] = [];
	let used = 0;
	for (const row of candidates) {
		const cost = renderCost(row);
		if (selected.length > 0 && used + cost > budgetChars) continue;
		if (used + cost > budgetChars) break;
		selected.push(row);
		used += cost;
	}
	return selected;
}

export function openScene(userId: string, conversationId: string, label?: string | null): SceneRow {
	assertConversationOwned(userId, conversationId);
	const id = ulid();
	const now = Date.now();
	const normalized = label?.trim() || null;
	try {
		getDb()
			.prepare(
				`INSERT INTO memory_scenes(id, conversation_id, label, opened_at, closed_at)
				 VALUES (?, ?, ?, ?, NULL)`
			)
			.run(id, conversationId, normalized, now);
	} catch (err) {
		const existing = currentScene(userId, conversationId);
		if (existing && isSqliteConstraint(err)) return existing;
		throw err;
	}
	const scene = currentScene(userId, conversationId);
	if (!scene || scene.id !== id) throw new Error(`Inserted scene not found: ${id}`);
	return scene;
}

export function closeScene(
	userId: string,
	conversationId: string
): { sceneId: string; archived: number } | null {
	const scene = currentScene(userId, conversationId);
	if (!scene) return null;
	const now = Date.now();
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare('UPDATE memory_scenes SET closed_at = ? WHERE id = ? AND conversation_id = ?').run(
			now,
			scene.id,
			conversationId
		);
		const archived = db
			.prepare(
				`UPDATE memory_banks
				 SET status = 'archived', expires_at = ?, updated_at = ?
				 WHERE conversation_id = ? AND scene_id = ? AND status = 'active'`
			)
			.run(now, now, conversationId, scene.id);
		return { sceneId: scene.id, archived: archived.changes };
	});
	return tx();
}

export function currentScene(userId: string, conversationId: string): SceneRow | null {
	const row = getDb()
		.prepare(
			`SELECT s.* FROM memory_scenes s
			 JOIN conversations c ON c.id = s.conversation_id
			 WHERE s.conversation_id = ? AND c.user_id = ? AND s.closed_at IS NULL
			 ORDER BY opened_at DESC
			 LIMIT 1`
		)
		.get(conversationId, userId) as SceneDbRow | undefined;
	return row ? rowToScene(row) : null;
}

export function snapshotForMessage(
	userId: string,
	conversationId: string,
	messageId: string
): void {
	assertMessageOwned(userId, conversationId, messageId);
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare('DELETE FROM message_memory_bank_snapshot_memories WHERE message_id = ?').run(
			messageId
		);
		db.prepare('DELETE FROM message_memory_bank_snapshot_scenes WHERE message_id = ?').run(
			messageId
		);
		db.prepare('DELETE FROM message_memory_bank_snapshot_meta WHERE message_id = ?').run(messageId);
		db.prepare(
			'INSERT INTO message_memory_bank_snapshot_meta(message_id, created_at) VALUES (?, ?)'
		).run(messageId, Date.now());
		db.prepare(
			`INSERT INTO message_memory_bank_snapshot_scenes(
			   message_id, original_scene_id, label, opened_at, closed_at
			 )
			 SELECT ?, id, label, opened_at, closed_at
			   FROM memory_scenes
			  WHERE conversation_id = ?`
		).run(messageId, conversationId);
		db.prepare(
			`INSERT INTO message_memory_bank_snapshot_memories(
			   message_id, original_memory_id, scope, original_scene_id, kind, entity, content_json,
			   tags_json, importance, status, source, original_supersedes_id,
			   created_at, updated_at, expires_at
			 )
			 SELECT ?, id, scope, scene_id, kind, entity, content_json, tags_json, importance,
			        status, source, supersedes_id, created_at, updated_at, expires_at
			   FROM memory_banks
			  WHERE conversation_id = ?`
		).run(messageId, conversationId);
	});
	tx();
}

export function clearConversation(userId: string, conversationId: string): void {
	assertConversationOwned(userId, conversationId);
	clearConversationUnchecked(conversationId);
}

export function restoreSnapshotToConversation(
	userId: string,
	targetConversationId: string,
	snapshotMessageId: string | null
): boolean {
	assertConversationOwned(userId, targetConversationId);
	if (snapshotMessageId === null) {
		clearConversationUnchecked(targetConversationId);
		return true;
	}
	assertSnapshotMessageOwned(userId, snapshotMessageId);
	const db = getDb();
	const meta = db
		.prepare('SELECT * FROM message_memory_bank_snapshot_meta WHERE message_id = ?')
		.get(snapshotMessageId) as SnapshotMetaRow | undefined;
	if (!meta) return false;
	const scenes = db
		.prepare(
			`SELECT * FROM message_memory_bank_snapshot_scenes
			  WHERE message_id = ?
			  ORDER BY opened_at ASC, original_scene_id ASC`
		)
		.all(snapshotMessageId) as SnapshotSceneRow[];
	const memories = db
		.prepare(
			`SELECT * FROM message_memory_bank_snapshot_memories
			  WHERE message_id = ?
			  ORDER BY created_at ASC, original_memory_id ASC`
		)
		.all(snapshotMessageId) as SnapshotMemoryRow[];
	const tx = db.transaction(() => {
		clearConversationUnchecked(targetConversationId);
		insertSnapshotStateUnchecked(targetConversationId, scenes, memories);
	});
	tx();
	return true;
}

export function cloneSnapshotsForMessages(
	userId: string,
	sourceConversationId: string,
	targetConversationId: string,
	messageIdMap: Map<string, string>
): void {
	assertConversationOwned(userId, sourceConversationId);
	assertConversationOwned(userId, targetConversationId);
	if (messageIdMap.size === 0) return;
	const db = getDb();
	const tx = db.transaction(() => {
		for (const [sourceMessageId, targetMessageId] of messageIdMap) {
			const meta = db
				.prepare('SELECT * FROM message_memory_bank_snapshot_meta WHERE message_id = ?')
				.get(sourceMessageId) as SnapshotMetaRow | undefined;
			if (!meta) continue;
			const scenes = db
				.prepare(
					`SELECT * FROM message_memory_bank_snapshot_scenes
					  WHERE message_id = ?
					  ORDER BY opened_at ASC, original_scene_id ASC`
				)
				.all(sourceMessageId) as SnapshotSceneRow[];
			const memories = db
				.prepare(
					`SELECT * FROM message_memory_bank_snapshot_memories
					  WHERE message_id = ?
					  ORDER BY created_at ASC, original_memory_id ASC`
				)
				.all(sourceMessageId) as SnapshotMemoryRow[];
			const sceneIdMap = new Map(scenes.map((scene) => [scene.original_scene_id, ulid()]));
			const memoryIdMap = new Map(memories.map((memory) => [memory.original_memory_id, ulid()]));

			db.prepare(
				`INSERT INTO message_memory_bank_snapshot_meta(message_id, created_at)
				 VALUES (?, ?)`
			).run(targetMessageId, meta.created_at);
			const insertScene = db.prepare(
				`INSERT INTO message_memory_bank_snapshot_scenes(
				   message_id, original_scene_id, label, opened_at, closed_at
				 ) VALUES (?, ?, ?, ?, ?)`
			);
			for (const scene of scenes) {
				insertScene.run(
					targetMessageId,
					sceneIdMap.get(scene.original_scene_id)!,
					scene.label,
					scene.opened_at,
					scene.closed_at
				);
			}
			const insertMemory = db.prepare(
				`INSERT INTO message_memory_bank_snapshot_memories(
				   message_id, original_memory_id, scope, original_scene_id, kind, entity, content_json,
				   tags_json, importance, status, source, original_supersedes_id,
				   created_at, updated_at, expires_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			for (const memory of memories) {
				insertMemory.run(
					targetMessageId,
					memoryIdMap.get(memory.original_memory_id)!,
					memory.scope,
					memory.original_scene_id ? (sceneIdMap.get(memory.original_scene_id) ?? null) : null,
					memory.kind,
					memory.entity,
					memory.content_json,
					memory.tags_json,
					memory.importance,
					memory.status,
					memory.source,
					memory.original_supersedes_id
						? (memoryIdMap.get(memory.original_supersedes_id) ?? null)
						: null,
					memory.created_at,
					memory.updated_at,
					memory.expires_at
				);
			}
		}
	});
	tx();
}

function toFtsQuery(q: string): string {
	return q
		.trim()
		.split(/\s+/)
		.map((term) => term.replace(/"/g, '""'))
		.filter(Boolean)
		.map((term) => `"${term}"`)
		.join(' AND ');
}

function renderCost(row: MemoryRow): number {
	const tags = row.tags.length ? ` ${row.tags.map((tag) => `#${tag}`).join(' ')}` : '';
	const entity = row.entity ? ` (${row.entity})` : '';
	return `[${row.scope}/${row.kind}]${entity} ${formatContent(row.content)}${tags}\n`.length;
}

function ensureCurrentScene(userId: string, conversationId: string): SceneRow {
	return currentScene(userId, conversationId) ?? openScene(userId, conversationId);
}

function requireScene(userId: string, conversationId: string, sceneId: string): SceneRow {
	const row = getDb()
		.prepare(
			`SELECT s.* FROM memory_scenes s
			 JOIN conversations c ON c.id = s.conversation_id
			 WHERE s.id = ? AND s.conversation_id = ? AND c.user_id = ?`
		)
		.get(sceneId, conversationId, userId) as SceneDbRow | undefined;
	if (!row) throw new Error(`Memory scene not found: ${sceneId}`);
	return rowToScene(row);
}

function assertConversationOwned(userId: string, conversationId: string): void {
	const row = getDb()
		.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?')
		.get(conversationId, userId) as { 1: number } | undefined;
	if (!row) throw new Error(`Conversation not found: ${conversationId}`);
}

function assertMessageOwned(userId: string, conversationId: string, messageId: string): void {
	const row = getDb()
		.prepare(
			`SELECT 1 FROM messages m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE m.id = ? AND m.conversation_id = ? AND c.user_id = ?`
		)
		.get(messageId, conversationId, userId) as { 1: number } | undefined;
	if (!row) throw new Error(`Message not found: ${messageId}`);
}

function assertSnapshotMessageOwned(userId: string, messageId: string): void {
	const row = getDb()
		.prepare(
			`SELECT 1 FROM messages m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE m.id = ? AND c.user_id = ?`
		)
		.get(messageId, userId) as { 1: number } | undefined;
	if (!row) throw new Error(`Message not found: ${messageId}`);
}

function clearConversationUnchecked(conversationId: string): void {
	const db = getDb();
	db.prepare('DELETE FROM memory_banks WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_scenes WHERE conversation_id = ?').run(conversationId);
}

function insertSnapshotStateUnchecked(
	conversationId: string,
	scenes: SnapshotSceneRow[],
	memories: SnapshotMemoryRow[]
): void {
	const db = getDb();
	const insertScene = db.prepare(
		`INSERT INTO memory_scenes(id, conversation_id, label, opened_at, closed_at)
		 VALUES (?, ?, ?, ?, ?)`
	);
	for (const scene of scenes) {
		insertScene.run(
			scene.original_scene_id,
			conversationId,
			scene.label,
			scene.opened_at,
			scene.closed_at
		);
	}

	const insertMemory = db.prepare(
		`INSERT INTO memory_banks(
		   id, conversation_id, scope, scene_id, kind, entity, content_json, tags_json,
		   importance, status, source, supersedes_id, created_at, updated_at, expires_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
	);
	for (const memory of memories) {
		insertMemory.run(
			memory.original_memory_id,
			conversationId,
			memory.scope,
			memory.original_scene_id,
			memory.kind,
			memory.entity,
			memory.content_json,
			memory.tags_json,
			memory.importance,
			memory.status,
			memory.source,
			memory.created_at,
			memory.updated_at,
			memory.expires_at
		);
	}

	const updateSupersedes = db.prepare(
		`UPDATE memory_banks
		    SET supersedes_id = ?
		  WHERE id = ? AND conversation_id = ?`
	);
	for (const memory of memories) {
		if (memory.original_supersedes_id) {
			updateSupersedes.run(
				memory.original_supersedes_id,
				memory.original_memory_id,
				conversationId
			);
		}
	}
}

function isSqliteConstraint(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
	);
}
