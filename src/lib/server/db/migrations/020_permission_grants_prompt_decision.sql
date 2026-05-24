-- 020_permission_grants_prompt_decision.sql
--
-- Permission grants now support a third explicit saved resolution:
--   decision          'allow' | 'deny' | 'prompt'
--
-- `allow` is preserved as the storage value for existing approve grants.
-- Product/UI copy presents it as "Approve"; `deny` keeps rejecting with
-- optional deny_reason feedback; `prompt` forces an interactive permission
-- dialog for matching requests. There is intentionally no table rewrite here:
-- the v2 grants table has no CHECK constraint, so existing rows remain valid
-- and new prompt rows can be inserted directly.

SELECT 1;
