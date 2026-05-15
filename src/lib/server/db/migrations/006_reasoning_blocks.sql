-- 006_reasoning_blocks.sql
-- Split per-message reasoning into multiple ordered segments so the UI can
-- interleave thinking boxes with text and tool calls (previously a single
-- concatenated string rendered above the whole message).
--
-- Each row is one contiguous burst of reasoning deltas. text_offset records
-- where in the assistant's accumulated content the burst occurred, mirroring
-- the convention used by tool_calls and file_edits.
--
-- Legacy columns messages.reasoning / messages.reasoning_duration_ms are
-- left in place for safe rollback; the backfill below copies any existing
-- value into a single segment at offset 0.

CREATE TABLE reasoning_blocks (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  segment_index   INTEGER NOT NULL,
  text            TEXT NOT NULL,
  text_offset     INTEGER,
  started_at      INTEGER NOT NULL,
  duration_ms     INTEGER
);
CREATE INDEX idx_reasoning_blocks_message
  ON reasoning_blocks(message_id, segment_index);

INSERT INTO reasoning_blocks (id, message_id, segment_index, text, text_offset, started_at, duration_ms)
SELECT
  lower(hex(randomblob(13))),
  id,
  0,
  reasoning,
  0,
  created_at,
  reasoning_duration_ms
FROM messages
WHERE reasoning IS NOT NULL AND length(reasoning) > 0;
