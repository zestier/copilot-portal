CREATE TABLE memory_banks (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	scope TEXT NOT NULL CHECK (scope IN ('scene', 'session', 'shared')),
	scene_id TEXT REFERENCES memory_scenes(id) ON DELETE SET NULL,
	kind TEXT NOT NULL,
	entity TEXT,
	content_json TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
	status TEXT NOT NULL DEFAULT 'active' CHECK (
		status IN ('active', 'archived', 'forgotten', 'superseded')
	),
	source TEXT NOT NULL CHECK (source IN ('model', 'harvester', 'user')),
	supersedes_id TEXT REFERENCES memory_banks(id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	expires_at INTEGER,
	CHECK (status != 'active' OR (entity IS NOT NULL AND trim(entity) != ''))
);

CREATE INDEX idx_memory_conv_scope_status
	ON memory_banks(conversation_id, scope, status, updated_at DESC);

CREATE INDEX idx_memory_scene
	ON memory_banks(conversation_id, scene_id)
	WHERE scene_id IS NOT NULL;

-- One active row per (conversation, scope, entity). NOTE: scene_id is
-- intentionally NOT part of this key. It is safe only because at most one
-- scene is open per conversation at a time (idx_memory_scenes_one_open) and
-- closeScene archives a scene's active rows, so two active scene-scoped rows
-- can never share an entity. Preserve those invariants before relaxing this.
CREATE UNIQUE INDEX idx_memory_active_entity_unique
	ON memory_banks(conversation_id, scope, entity)
	WHERE status = 'active';

CREATE VIRTUAL TABLE memory_banks_fts USING fts5(
	kind,
	entity,
	content,
	tags,
	content='memory_banks',
	content_rowid='rowid'
);

CREATE TRIGGER memory_banks_ai AFTER INSERT ON memory_banks BEGIN
	INSERT INTO memory_banks_fts(rowid, kind, entity, content, tags)
	VALUES (new.rowid, new.kind, coalesce(new.entity, ''), new.content_json, new.tags_json);
END;

CREATE TRIGGER memory_banks_ad AFTER DELETE ON memory_banks BEGIN
	INSERT INTO memory_banks_fts(memory_banks_fts, rowid, kind, entity, content, tags)
	VALUES ('delete', old.rowid, old.kind, coalesce(old.entity, ''), old.content_json, old.tags_json);
END;

CREATE TRIGGER memory_banks_au AFTER UPDATE ON memory_banks BEGIN
	INSERT INTO memory_banks_fts(memory_banks_fts, rowid, kind, entity, content, tags)
	VALUES ('delete', old.rowid, old.kind, coalesce(old.entity, ''), old.content_json, old.tags_json);
	INSERT INTO memory_banks_fts(rowid, kind, entity, content, tags)
	VALUES (new.rowid, new.kind, coalesce(new.entity, ''), new.content_json, new.tags_json);
END;

CREATE TABLE memory_scenes (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	label TEXT,
	opened_at INTEGER NOT NULL,
	closed_at INTEGER
);

CREATE INDEX idx_memory_scenes_open
	ON memory_scenes(conversation_id, closed_at);

CREATE UNIQUE INDEX idx_memory_scenes_one_open
	ON memory_scenes(conversation_id)
	WHERE closed_at IS NULL;
