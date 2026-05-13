-- 003_conversation_usage.sql
-- Latest context-window usage snapshot per conversation, sourced from the
-- SDK's `session.usage_info` event. One row per conversation, upserted on
-- every snapshot. Nullable per-bucket columns mirror the SDK schema where
-- the breakdown is optional.

CREATE TABLE conversation_usage (
  conversation_id          TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  current_tokens           INTEGER NOT NULL,
  token_limit              INTEGER NOT NULL,
  messages_length          INTEGER NOT NULL,
  system_tokens            INTEGER,
  conversation_tokens      INTEGER,
  tool_definitions_tokens  INTEGER,
  updated_at               INTEGER NOT NULL
);
