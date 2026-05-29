CREATE TABLE message_memory_harvest (
	message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK (status IN ('pending', 'skipped', 'empty', 'applied', 'failed')),
	reason TEXT,
	writes INTEGER NOT NULL DEFAULT 0,
	updates INTEGER NOT NULL DEFAULT 0,
	forgets INTEGER NOT NULL DEFAULT 0,
	scene_ended INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	prompt TEXT,
	response TEXT,
	reasoning TEXT,
	parsed_json TEXT,
	changes_json TEXT,
	updated_at INTEGER NOT NULL
);
