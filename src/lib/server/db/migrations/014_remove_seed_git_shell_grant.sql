-- 014_remove_seed_git_shell_grant.sql
--
-- Older default seed grants auto-approved a broad `git` shell rule that
-- included subcommands such as `config`, `stash`, `branch`, `tag`, and
-- `remote`. Those are not safely read-only, and Git's option surface is too
-- broad to keep auto-allowing from a seed grant. Convert that exact family of
-- seeded user-global allow grants into visible deny grants with feedback. The
-- feedback tells agents to use structured Git tools, while preserving a
-- frugal one-time `forcePermissionPrompt` escalation path.

INSERT INTO permission_grants(
  user_id, conversation_id, tool, permission_kind, scope_pattern, scope_json,
  decision, expires_at, granted_at, deny_reason
)
SELECT
  u.id,
  NULL,
  t.tool,
  'custom-tool',
  NULL,
  '{"kind":"any"}',
  'allow',
  NULL,
  CAST(unixepoch('now') * 1000 AS INTEGER),
  NULL
FROM users u
CROSS JOIN (
  SELECT 'git_status' AS tool
  UNION ALL SELECT 'git_diff'
  UNION ALL SELECT 'git_log'
  UNION ALL SELECT 'git_show_commit'
  UNION ALL SELECT 'git_show_file'
) t
WHERE NOT EXISTS (
  SELECT 1
  FROM permission_grants pg
  WHERE pg.user_id = u.id
    AND pg.conversation_id IS NULL
    AND pg.tool = t.tool
    AND pg.permission_kind = 'custom-tool'
    AND pg.scope_json = '{"kind":"any"}'
    AND pg.decision = 'allow'
);

UPDATE permission_grants
SET decision = 'deny',
    scope_json = '{"kind":"shell","rule":{"argv0":"git"}}',
    deny_reason = 'Shell `git` is denied by default. Use git_status/git_diff/git_log/git_show_commit/git_show_file. Escalate sparingly with `forcePermissionPrompt` only if no Git tool fits.'
WHERE tool = 'shell'
  AND permission_kind = 'shell'
  AND conversation_id IS NULL
  AND scope_pattern IS NULL
  AND decision = 'allow'
  AND scope_json LIKE '%"kind":"shell"%'
  AND scope_json LIKE '%"argv0":"git"%'
  AND scope_json LIKE '%"preSubcommandOptions"%'
  AND scope_json LIKE '%"config"%'
  AND scope_json LIKE '%"stash"%'
  AND scope_json LIKE '%"branch"%'
  AND scope_json LIKE '%"tag"%'
  AND scope_json LIKE '%"remote"%';
