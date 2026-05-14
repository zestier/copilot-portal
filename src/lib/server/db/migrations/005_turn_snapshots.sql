-- 005_turn_snapshots.sql
-- Per-message git snapshots of the conversation workdir, used by the
-- "edit earlier message" feature to materialise a forked conversation's
-- workdir at the state it had when that message was authored.
--
-- `kind` is 'pre' for the workdir state captured BEFORE running the
-- user's turn (this is what we restore to when that user message is
-- edited) and 'post' for the state captured AFTER the assistant's reply
-- (useful for diff views / "fork after this reply" affordances).
--
-- We store the commit, tree, and the actual ref name so that a future
-- garbage-collection pass can update or delete refs predictably without
-- recomputing them.

CREATE TABLE turn_snapshots (
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('pre', 'post')),
  git_ref      TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  tree_sha     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
);
CREATE INDEX idx_turn_snapshots_tree ON turn_snapshots(tree_sha);

ALTER TABLE conversations ADD COLUMN forked_from_conversation_id TEXT;
ALTER TABLE conversations ADD COLUMN forked_from_message_id TEXT;
