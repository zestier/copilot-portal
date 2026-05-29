-- 019_backend_provider_persistence.sql
--
-- Store backend provider identity separately from model ids. Existing rows
-- were all Copilot-backed before provider selection was introduced, so the
-- non-null default preserves prior behavior and keeps old conversations
-- pinned to Copilot even if the user's future default provider changes.

ALTER TABLE conversations
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'copilot';

ALTER TABLE user_settings
  ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'copilot';
