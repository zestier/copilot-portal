-- 007_subagent_threading.sql
-- Thread tool calls, reasoning blocks, and file edits emitted by sub-agents
-- back to the outer `task` tool call that spawned them. The SDK exposes this
-- linkage via subagent.started events (mapping a child agentId to a
-- parentToolCallId) plus a parentToolCallId on most child events themselves.
--
-- Rendering: rows where parent_tool_call_id IS NULL are top-level (anchored
-- to the assistant message's content). Rows with parent_tool_call_id set are
-- nested children of that outer task tool call and rendered inside the
-- SubagentCall component, not at the message level.
--
-- text_offset is allowed to remain NULL for child rows since they are not
-- anchored to the parent assistant message's text.

ALTER TABLE tool_calls       ADD COLUMN parent_tool_call_id TEXT;
ALTER TABLE reasoning_blocks ADD COLUMN parent_tool_call_id TEXT;
ALTER TABLE file_edits       ADD COLUMN parent_tool_call_id TEXT;

CREATE INDEX idx_tool_calls_parent       ON tool_calls(parent_tool_call_id);
CREATE INDEX idx_reasoning_blocks_parent ON reasoning_blocks(parent_tool_call_id);
CREATE INDEX idx_file_edits_parent       ON file_edits(parent_tool_call_id);
