-- 018_background_agent_lifecycles.sql
-- Track spawned sub-agent lifecycle separately from tool_calls.status.
--
-- For background `task` calls, tool_calls.status = 'ok' means the launch
-- tool call returned successfully. This table records the spawned agent's
-- own lifecycle when the SDK emits subagent.started/completed/failed.

CREATE TABLE background_agent_lifecycles (
  tool_call_id TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE INDEX idx_background_agent_lifecycles_agent
  ON background_agent_lifecycles(agent_id);
