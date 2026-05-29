CREATE TABLE message_memory_context (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	memory_id TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('scene', 'session', 'shared')),
	kind TEXT NOT NULL,
	entity TEXT,
	content_json TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
	sort_index INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_message_memory_context_order
	ON message_memory_context(message_id, sort_index);
