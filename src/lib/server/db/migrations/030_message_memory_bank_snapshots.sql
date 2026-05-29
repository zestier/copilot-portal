CREATE TABLE message_memory_bank_snapshot_meta (
	message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL
);

CREATE TABLE message_memory_bank_snapshot_scenes (
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	original_scene_id TEXT NOT NULL,
	label TEXT,
	opened_at INTEGER NOT NULL,
	closed_at INTEGER,
	PRIMARY KEY (message_id, original_scene_id)
);

CREATE TABLE message_memory_bank_snapshot_memories (
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	original_memory_id TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('scene', 'session', 'shared')),
	original_scene_id TEXT,
	kind TEXT NOT NULL,
	entity TEXT,
	content_json TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
	status TEXT NOT NULL CHECK (
		status IN ('active', 'archived', 'forgotten', 'superseded')
	),
	source TEXT NOT NULL CHECK (source IN ('model', 'harvester', 'user')),
	original_supersedes_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	expires_at INTEGER,
	PRIMARY KEY (message_id, original_memory_id)
);
