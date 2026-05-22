-- 013_user_settings_default_mode.sql
--
-- Persist the default session mode used for newly created conversations.
-- Matches prior behaviour for existing users by defaulting to 'interactive'.

ALTER TABLE user_settings
  ADD COLUMN default_mode TEXT NOT NULL DEFAULT 'interactive';
