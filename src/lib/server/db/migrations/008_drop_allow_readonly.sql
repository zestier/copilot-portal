-- 008_drop_allow_readonly.sql
--
-- Collapse the legacy 'allow-readonly' permission policy into 'prompt'.
-- They behaved identically in decideByPolicy() (both auto-approved 'read'
-- and 'url' permission kinds and asked for everything else), and the
-- redundant option made the settings UI confusing. 'prompt' is now the
-- sole "ask for writes, auto-allow reads" policy.
UPDATE user_settings
   SET default_policy = 'prompt'
 WHERE default_policy = 'allow-readonly';
