-- 001_init.sql
-- Note: schema_migrations table is bootstrapped by the migration runner.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  github_login    TEXT UNIQUE NOT NULL,
  github_id       INTEGER UNIQUE,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

CREATE TABLE user_tokens (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_token_ct BLOB,
  byok_keys_ct    BLOB,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE user_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_model      TEXT,
  default_workdir    TEXT,
  default_policy     TEXT NOT NULL DEFAULT 'prompt',
  theme              TEXT NOT NULL DEFAULT 'dark',
  updated_at         INTEGER NOT NULL
);

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  workdir         TEXT NOT NULL,
  model           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
);
CREATE INDEX idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete',
  error_code      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv_created
  ON messages(conversation_id, created_at);

CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  result_json     TEXT,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX idx_tool_calls_message ON tool_calls(message_id);

CREATE TABLE file_edits (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  diff            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_file_edits_message ON file_edits(message_id);

CREATE TABLE permission_grants (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  granted_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id, tool)
);

CREATE TABLE permission_decisions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_summary    TEXT,
  decision        TEXT NOT NULL,
  decided_at      INTEGER NOT NULL
);
CREATE INDEX idx_permission_decisions_conv ON permission_decisions(conversation_id, decided_at DESC);
