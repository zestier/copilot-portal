-- 012_conversation_session_settings.sql
--
-- Per-conversation session settings exposed via the SDK:
--   * `mode`              — SessionMode: 'interactive' | 'plan' | 'autopilot'
--                           Forwarded to the runtime via `session.rpc.mode.set`
--                           after createSession/resumeSession.
--   * `approve_all_tools` — when 1, every tool-permission request for this
--                           conversation is auto-approved. Mirrored to the
--                           SDK via `session.rpc.permissions.setApproveAll`
--                           so the model can adapt its behaviour, and also
--                           short-circuited in the bridge's
--                           `onPermissionRequest` so the audit log records
--                           an honest `auto-allow` row for each request.
--
-- Default values match prior behaviour (interactive mode, no bypass), so
-- this migration is a no-op for existing conversations.

ALTER TABLE conversations
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'interactive';

ALTER TABLE conversations
  ADD COLUMN approve_all_tools INTEGER NOT NULL DEFAULT 0;
