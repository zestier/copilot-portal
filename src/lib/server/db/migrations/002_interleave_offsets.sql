-- 002_interleave_offsets.sql
-- Record where a tool call or file edit appeared within the assistant's
-- accumulated text so the UI can render them inline rather than always at
-- the bottom of the message. NULL means "position unknown" (legacy rows)
-- and the renderer falls back to appending them after the text.

ALTER TABLE tool_calls ADD COLUMN text_offset INTEGER;
ALTER TABLE file_edits ADD COLUMN text_offset INTEGER;
