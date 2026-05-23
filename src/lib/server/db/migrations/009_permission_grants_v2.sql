-- 009_permission_grants_v2.sql
--
-- Tier 2 of the permissions overhaul: replace the coarse
-- (user, conversation, tool) grant key with a richer shape that can
-- express per-(permission_kind, scope_pattern) allow/deny decisions
-- with optional expiry.
--
-- New columns:
--   permission_kind   NULL = any kind (matches legacy rows)
--   scope_pattern     glob; NULL = any scope (matches legacy rows)
--   decision          'allow' | 'deny' (deny beats allow at match time)
--   expires_at        unix ms; NULL = forever
--
-- Existing rows are preserved as wildcard allow grants (NULL kind, NULL
-- pattern, decision='allow', no expiry), so behavior is unchanged for
-- users who had previously clicked "Allow always".

CREATE TABLE permission_grants_v2 (
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT             REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT    NOT NULL,
  permission_kind TEXT,
  scope_pattern   TEXT,
  decision        TEXT    NOT NULL DEFAULT 'allow',
  expires_at      INTEGER,
  granted_at      INTEGER NOT NULL
);

INSERT INTO permission_grants_v2
  (user_id, conversation_id, tool, permission_kind, scope_pattern, decision, expires_at, granted_at)
SELECT user_id, conversation_id, tool, NULL, NULL, 'allow', NULL, granted_at
FROM permission_grants;

DROP TABLE permission_grants;
ALTER TABLE permission_grants_v2 RENAME TO permission_grants;

-- Lookup is always keyed on (user_id, conversation_id, tool); the kind /
-- pattern / decision / expiry filtering happens in app code.
CREATE INDEX idx_permission_grants_lookup
  ON permission_grants(user_id, conversation_id, tool);
