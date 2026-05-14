# 06 — Persistence

Everything goes in a single SQLite database (`$DATA_DIR/portal.db`).
`better-sqlite3` for sync, embedded access. WAL mode enabled.

## Why SQLite

- Single-user / small-team workload. Postgres is overkill.
- Backup is a file copy.
- No external service to run alongside the portal container.

## Migrations

Plain `.sql` files in `src/lib/server/db/migrations/`, numbered:
`001_init.sql`, `002_add_tool_calls.sql`, etc. Applied in order at startup
inside a transaction; tracked in a `schema_migrations(version, applied_at)`
table. No ORM, no migration framework.

## Schema (initial)

```sql
-- 001_init.sql

CREATE TABLE users (
  id              TEXT PRIMARY KEY,         -- ULID
  github_login    TEXT UNIQUE NOT NULL,
  github_id       INTEGER UNIQUE NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL,         -- unix ms
  last_login_at   INTEGER
);

CREATE TABLE user_tokens (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- AES-256-GCM(plaintext, key=ENCRYPTION_KEY); nonce prepended.
  github_token_ct BLOB,
  byok_keys_ct    BLOB,                     -- JSON blob, encrypted
  updated_at      INTEGER NOT NULL
);

CREATE TABLE user_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_model      TEXT,
  default_workdir    TEXT,
  default_policy     TEXT NOT NULL DEFAULT 'prompt',  -- 'prompt'|'allow-readonly'|'allow-all'|'deny-all'
  theme              TEXT NOT NULL DEFAULT 'dark',
  updated_at         INTEGER NOT NULL
);

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,         -- ULID
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  workdir         TEXT NOT NULL,
  model           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
);
CREATE INDEX idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,         -- ULID, sortable
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,            -- 'user'|'assistant'|'system'
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete',  -- 'complete'|'interrupted'|'error'
  error_code      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv_created
  ON messages(conversation_id, created_at);

CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  result_json     TEXT,
  status          TEXT NOT NULL,            -- 'pending'|'ok'|'error'|'denied'
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);

CREATE TABLE file_edits (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  diff            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE permission_grants (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,            -- '*' allowed
  granted_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id, tool)
);

CREATE TABLE permission_decisions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_summary    TEXT,
  decision        TEXT NOT NULL,            -- 'allow-once'|'allow-always'|'deny'
  decided_at      INTEGER NOT NULL
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

## Turn snapshots (edit-and-rerun)

Added in migration `005_turn_snapshots.sql`. Backs the "edit an earlier
message and rewind the workdir" feature.

```sql
CREATE TABLE turn_snapshots (
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('pre', 'post')),
  git_ref      TEXT NOT NULL,           -- refs/portal/turns/{kind}/{id}
  commit_sha   TEXT NOT NULL,
  tree_sha     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
);
ALTER TABLE conversations ADD COLUMN forked_from_conversation_id TEXT;
ALTER TABLE conversations ADD COLUMN forked_from_message_id TEXT;
```

The actual file state is **not** stored in SQLite. Each snapshot is a real
git commit written under the conversation's workdir at
`refs/portal/turns/{pre|post}/{messageId}`. `kind='pre'` is captured
before running a user turn; `kind='post'` is captured after the
assistant's reply persists. Trees are content-addressed so identical
worktree states across messages dedup naturally.

Snapshotting uses a per-snapshot `GIT_INDEX_FILE` so the workdir's normal
staging area is never touched. The `refs/portal/turns/` namespace is
private — it never overlaps `refs/heads/*` or `refs/tags/*`.

When a user edits a previous message, the portal:

1. Looks up the `pre` snapshot for that message.
2. Creates a new conversation with `forked_from_conversation_id` /
   `forked_from_message_id` set.
3. Materialises a fresh managed workdir from that snapshot commit (via a
   shallow local `git fetch` of just that commit, then check it out).
4. Clones the message rows strictly before the edited one into the new
   conversation, then appends the edited content as a fresh user message.
5. Starts a brand-new SDK session under the new conversation id. No
   prior conversation events are seeded into the SDK in v1 — the agent
   starts fresh from the edited turn. The cloned message rows exist for
   UI continuity only.

Limitations (v1):

- Only portal-managed workdirs (under `$DATA_DIR/workspaces/`) can be
  forked. Bring-your-own workdirs are rejected with a clear 422.
- Side effects outside the workdir (DB writes, network calls) are not
  rolled back. Forks rewind files only.
- Submodule/LFS state is out of scope.


## Conventions

- IDs are ULIDs (lexically sortable; safe in URLs).
- Timestamps are unix ms `INTEGER`.
- Sensitive fields end in `_ct` and are encrypted (AES-256-GCM with the
  `ENCRYPTION_KEY` env var; rotated by re-encrypt-and-rewrite migration).
- JSON columns are `TEXT`. Queried only by key paths via `json_extract()`,
  not used for joins.

## Repositories

Thin function modules under `src/lib/server/db/repos/`. No active record /
no ORM. Each function takes the user id when applicable, so authorization
is enforced at the data layer too:

```ts
// repos/conversations.ts
export function get(id: string, userId: string): Conversation | null { ... }
export function list(userId: string, opts: ListOpts): Conversation[] { ... }
export function create(userId: string, input: CreateConvInput): Conversation { ... }
export function rename(id: string, userId: string, title: string): void { ... }
export function touch(id: string): void { ... }
export function archive(id: string, userId: string): boolean { ... }
export function unarchive(id: string, userId: string): boolean { ... }
```

## Backup and export

- Restore is offline: stop the container, replace `portal.db`, start.
- `GET /api/conversations/:id/export` emits a single markdown file with
  the conversation's messages, tool calls, and diffs inlined.
- _Roadmap:_ `GET /api/export` will return a `portal.tar.gz` containing
  `portal.db` plus a `manifest.json` (excludes `user_tokens` and
  `byok_keys_ct` by default; flag to include). Not yet implemented — use
  the offline file-copy path until then.

## Admin and operations endpoints

A small set of endpoints exists outside the per-conversation CRUD surface.
They are authenticated like the rest of `/api/*` (session cookie required)
and live alongside the data routes:

- `POST /api/admin/redeploy` — streams a Server-Sent Events feed of a
  `git fetch` / `git pull` / `pnpm install` / `pnpm run verify` pipeline,
  then exits the process so the supervisor (`scripts/serve.mjs`) can
  relaunch from the refreshed `build/`. Body: `{pull?: boolean}` (defaults
  to `true`). Gated by the `ENABLE_REDEPLOY` env flag — returns `403`
  when disabled and `409` if a redeploy is already in flight. Only
  meaningful when the portal is started via `pnpm run serve`.
- `POST /api/conversations/:id/permissions/:requestId` — resolves a
  pending Copilot tool-permission prompt. Body:
  `{decision: 'allow-once' | 'allow-always' | 'deny'}`. Returns
  `{ok: true}` on success, `404` if the request id is unknown or no
  longer pending. The matching SSE feed for pending prompts is published
  via the conversation's event stream.

## Retention

No automatic deletion. The UI offers per-conversation delete (cascades).
Archived conversations are collapsed under an "Archived" group in the sidebar
but preserved; users can unarchive them or include them in API listings via
`GET /api/conversations?archived=1`.
