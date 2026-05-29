-- 021_provider_session_id.sql
--
-- Portal conversations can be destructively rewritten (inline edit), but the
-- Copilot SDK persists backend sessions by session id. Keep a separate runtime
-- session id so a rewritten portal conversation can start from a fresh backend
-- context without changing its user-visible conversation id.

ALTER TABLE conversations
  ADD COLUMN provider_session_id TEXT;

UPDATE conversations
   SET provider_session_id = id
 WHERE provider_session_id IS NULL;
