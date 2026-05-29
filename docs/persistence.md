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
  github_id       INTEGER UNIQUE,           -- null for the local-only `AUTH_MODE=none` user
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
  default_policy     TEXT NOT NULL DEFAULT 'prompt',  -- 'prompt'|'allow-all'|'deny-all'
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

Added in migration `005_turn_snapshots.sql`. Backs edit/retry forks by storing
manual restore points for the workdir. It does **not** make conversations
transactional or automatically rewind files.

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
git commit written under the workdir's git repo at
`refs/portal/turns/{pre|post}/{messageId}`. `kind='pre'` is captured
before running a user turn; `kind='post'` is captured after the
assistant's reply persists. Trees are content-addressed so identical
worktree states across messages dedup naturally.

Snapshotting uses a per-snapshot `GIT_INDEX_FILE` so the workdir's normal
staging area is never touched. The `refs/portal/turns/` namespace is
private — it never overlaps `refs/heads/*` or `refs/tags/*`.

When a user edits a previous message, the portal:

1. Looks up the `pre` snapshot for that message (or `post` for the
   retry-from-assistant flavour) — for surfacing in the UI and as a
   manual restore point only.
2. Creates a new conversation with `forked_from_conversation_id` /
   `forked_from_message_id` set, sharing the source's `workdir`.
3. Clones the message rows strictly before the edited one into the new
   conversation, then appends the edited content as a fresh user message
   (for the edit flavour; the retry flavour clones up to and including
   the assistant target and appends nothing).
4. Clones/restores the message-linked memory-bank snapshots described below so
   the fork's active memories match the selected branch point.
5. Starts a brand-new SDK session under the new conversation id. No
   prior conversation events are seeded into the SDK in v1 — the agent
   starts fresh from the next prompt, using the live shared workdir. The
   cloned message rows exist for UI continuity only.

Limitations (v1):

- The fork shares the source's workdir. The portal does **not**
  automatically roll the files back to the snapshot — multiple
  conversations live in one tree, so a unilateral rewind would clobber
  other in-flight work. The snapshot ref is left in the repo so the
  user can `git diff`/`git restore` against it manually if they want
  to reproduce the prior state.
- A conversation boundary is a transcript/session boundary only. It is not a
  filesystem, git, process, network, or database isolation boundary.
- Side effects outside the workdir (DB writes, network calls) are not generally
  rolled back; memory-bank state is the exception described below.
- Submodule/LFS state is out of scope.

## Memory banks

Added in migration `025_memory_banks.sql`. Memory banks are per-conversation
SQLite rows that let the agent recall, update, and deliberately forget details
that should remain consistent across turns. The first pass uses one bank per
conversation/session; the schema includes a `shared` scope for future
cross-session reuse, but v1 model-facing tools expose only `scene` and
`session`.

```sql
CREATE TABLE memory_banks (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('scene','session','shared')),
  scene_id        TEXT REFERENCES memory_scenes(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  entity          TEXT,
  content_json    TEXT NOT NULL,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  importance      INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived','forgotten','superseded')),
  source          TEXT NOT NULL CHECK (source IN ('model','harvester','user')),
  supersedes_id   TEXT REFERENCES memory_banks(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER
);

CREATE UNIQUE INDEX idx_memory_active_entity_unique
  ON memory_banks(conversation_id, scope, entity)
  WHERE status = 'active';

CREATE VIRTUAL TABLE memory_banks_fts USING fts5(
  kind, entity, content, tags,
  content='memory_banks', content_rowid='rowid'
);

CREATE TABLE memory_scenes (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label           TEXT,
  opened_at       INTEGER NOT NULL,
  closed_at       INTEGER
);
```

`entity` is the **sole external identity** of a memory: a stable dot-path handle
(`story.protagonist.mara`, `user.memory.style`, `repo.commands.validation`) that
the model-facing tools and the harvester use to address records. The
`idx_memory_active_entity_unique` partial index enforces **one active row per
`(conversation, scope, entity)`**, so writing the same handle again upserts the
existing row in place rather than spawning a near-duplicate. Writers that omit a
handle get a generated `auto.<kind>.<rand>` slug so every active row stays
addressable.

The ULID `id` is **internal-only**: it is the primary key and the ref target for
`supersedes_id`, `message_memory_context`, and the snapshot tables, but it is
never serialized to the model. Renames and "split one memory into two" are done
by forgetting a handle and writing new ones, not by mutating ids.

`kind` is a mutable label, **not** part of the identity, so an update can change a
memory's kind in place. It is the typed record category (`character`,
`plot_thread`, `scene_state`, `bugfix`, `command`, etc.). A genuinely distinct
fact deserves its own honest handle — e.g. Mara's relationship to Kael lives
under `mara.rel.kael` rather than as a second slot on the `mara` handle.
`content_json` stores native JSON content; strings are allowed, but callers
should prefer structured objects or scalars over JSON encoded inside strings.

These usability rules are centralized in `MEMORY_ENTITY_GUIDANCE`
(`src/lib/server/db/repos/memory.ts`) and surfaced verbatim on every practical
path — the memory tool descriptions, the harvester prompt, and the auto-injected
memory block — so the "one entity = one memory" contract is consistent wherever
the bank is used.

`memory_banks_fts` is maintained by insert/update/delete triggers and backs the
`memory_query` tool. The FTS row indexes kind, entity, `content_json`, and tags.
JSON tags are stored in `tags_json`; they are rendered into FTS as searchable
text but not joined relationally.

Scopes:

- `scene` — short-lived situational state. `memory_scene_end` closes the current
  row in `memory_scenes`, archives active memories tied to that scene, and stamps
  `expires_at`.
- `session` — active for the whole conversation and included in the default
  memory digest until forgotten or superseded.
- `shared` — reserved for future cross-session banks. The database can store it
  for forward compatibility, but v1 tools and the harvester do not write it.

Statuses are lifecycle markers, not hard deletion. `forgotten` rows are kept for
audit/undo but excluded from the auto-injected block and default queries.
`archived` rows usually come from closed scenes. `superseded` rows remain linked
through `supersedes_id` when a fact is replaced.

Memory support is configurable per user default and per conversation:

- `none` — no model-facing memory tools, no injected digest, and no harvester.
- `tools` — exposes memory tools only.
- `injector` — exposes memory tools and renders active scene/session memories
  into the portal prelude within a fixed character budget.
- `harvester` — includes tools and injection, then runs a background harvester
  after assistant replies persist. The harvester may write, update, forget, or
  close a scene using the same repository APIs as the model-facing memory tools.
  It is also prompted to compact, correct, rewrite, and split existing active
  memories, especially bloated direct-agent entries, while preserving important
  qualifiers, using native JSON content, and avoiding duplicates by updating
  existing stable entities. The harvest streams on its own background turn
  (announced to the client via a `memory.harvest.started` event on the primary
  turn before its `done`), so its `pending` → `applied`/`empty`/`failed`
  transition is visible live without blocking the visible turn or the user's
  next message; the persisted `message_memory_harvest` row remains the source of
  truth on refresh.

Memory repository functions take both `userId` and `conversationId`; read/write
queries join or validate the owning conversation so authorization stays enforced
at the data layer.

After each completed assistant turn, the full memory-bank state is snapshotted
against that assistant message. When the `harvester` level is active the
snapshot is deferred until the background harvest settles so it captures the
harvested state; the snapshot is otherwise taken inline at turn end. The next
turn's memory injection waits for any in-progress harvest before reading the
digest, so it never injects pre-harvest memories or races the snapshot. Forks
clone those snapshots into the new conversation and restore the active memory
bank to the selected branch point: editing a user message restores the prior
assistant snapshot, while retrying from an assistant restores that assistant's
snapshot. Inline backtracking uses the same snapshots to roll the active memory
bank back before deleting later messages, so memory writes, updates, scene
changes, and forgets from discarded turns do not leak into the rewound
conversation.


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
   when disabled and `409` if a redeploy is already in flight. Under
   `AUTH_MODE=github`, redeploy is limited to `REDEPLOY_ADMIN_GITHUB_LOGINS`
   (or the sole `ALLOWED_GITHUB_LOGINS` entry in single-user installs);
   shared-secret and local auth modes treat the authenticated operator as the
   admin. Only meaningful when the portal is started via `pnpm run serve`.
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

## Repo-module conventions

The modules under `src/lib/server/db/repos/*.ts` are the only callers of
`better-sqlite3` outside migrations. They follow a small, uniform contract:

- **`getX(...) → X | null`** — a missing row returns `null`. No
  synthetic-default variants (use a sibling `defaults()` helper if the
  caller wants a fallback, e.g. `settings.get(uid) ?? settings.defaults()`).
- **`getOrCreateX(...) → X`** — idempotent get-or-insert. Always returns
  a real, persisted row (e.g. `users.ensureLocalUser`,
  `users.upsertGithub`).
- **Inserts that mint an entity** — return the inserted row
  (e.g. `convs.create`, `msgs.append`).
- **Scoped mutators** (UPDATE/DELETE with `AND user_id = ?` enforcing
  ownership) return `boolean` indicating whether the row was changed —
  callers use this to distinguish "applied" from "not yours / 404".
- **Unscoped mutators** (UPDATE/UPSERT on a known-trusted id, no
  authorization check) return `void`. Caller is expected to have
  authorized the entity beforehand.
