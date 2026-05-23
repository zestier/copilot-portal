CREATE TABLE workspace_tickets (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_key          TEXT NOT NULL,
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'archived')),
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  closed_at              INTEGER
);

CREATE INDEX idx_workspace_tickets_user_workspace_status_updated
  ON workspace_tickets(user_id, workspace_key, status, updated_at DESC);
