-- 026_memory_support_levels.sql
--
-- Make memory support configurable per user default and per conversation.
-- Defaults preserve the previous behavior: tools, injected active memories,
-- and post-turn harvesting are all enabled.

ALTER TABLE user_settings
  ADD COLUMN default_memory_level TEXT NOT NULL DEFAULT 'harvester';

ALTER TABLE conversations
  ADD COLUMN memory_level TEXT NOT NULL DEFAULT 'harvester';
