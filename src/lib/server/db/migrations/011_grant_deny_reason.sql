-- 011_grant_deny_reason.sql
--
-- Add an optional `deny_reason` column to `permission_grants`. When a deny
-- grant matches a request, the bridge surfaces this text as `feedback` on
-- the SDK's `{kind:'reject'}` response so the agent's tool-failure payload
-- explains *why* the call was rejected (e.g. "use the `grep` tool instead
-- of bare `grep`"). NULL = no feedback, fall back to a generic rejection.

ALTER TABLE permission_grants ADD COLUMN deny_reason TEXT;
