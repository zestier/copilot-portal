# 02 — Tech stack

## Why SvelteKit

- One repo, one process, one deploy. SSR + server endpoints + static assets
  from the same toolchain.
- The Copilot SDK is Node-native; SvelteKit's Node adapter lets us call it
  directly from `+server.ts` without a separate API tier.
- Svelte 5 runes (`$state`, `$derived`) map cleanly onto streaming chat state.
- Small client bundle — important for a tool that may be loaded over a slow
  tunnel from a phone.

(React + Next would also work; the design here doesn't depend on Svelte
specifics beyond file conventions.)

## Runtime

- **Node.js ≥ 24** (declared in `engines`; the Copilot CLI bundled by
  `@github/copilot-sdk` requires a recent Node, and we use a few `node:`
  builtins that are only stable on 22+).
- **TypeScript** everywhere. `strict: true`.
- **`@sveltejs/adapter-node`** for production build.

## Core dependencies

| Purpose                  | Package                                            |
|--------------------------|----------------------------------------------------|
| Web framework            | `@sveltejs/kit`, `svelte` (v5)                     |
| Copilot integration      | `@github/copilot-sdk`                              |
| DB                       | `better-sqlite3` (sync, fast, embedded)            |
| Migrations               | Hand-rolled in `src/lib/server/db/migrations/`     |
| Schema/validation        | `zod`                                              |
| Markdown rendering       | `marked` + `dompurify` (sanitize on client)        |
| Diff rendering           | `diff` + custom Svelte component                   |
| Auth (OAuth)             | Hand-rolled GitHub OAuth web flow (no octokit dep) |
| Cookie/session           | SvelteKit's `cookies` API + signed JWT             |
| Crypto for at-rest       | Node `crypto` (AES-256-GCM)                        |
| ID generation            | `ulid` (monotonic factory)                         |
| Testing (unit)           | `vitest`                                           |
| Testing (e2e)            | `@playwright/test`                                 |
| Lint/format              | `eslint`, `prettier`, `svelte-check`               |

No global state managers (Pinia/Redux-equivalent). Svelte 5 runes plus
a few small `.svelte.ts`/`.ts` modules under `src/lib/client/` are enough.

## Repository layout

```
zap/
├─ src/
│  ├─ app.html
│  ├─ app.d.ts
│  ├─ hooks.server.ts
│  ├─ lib/
│  │  ├─ client/                  # browser-only helpers
│  │  │  ├─ sse.ts
│  │  │  ├─ markdown.ts
│  │  │  ├─ diff-parser.ts
│  │  │  ├─ file-browser.ts
│  │  │  ├─ interactive-queue.ts
│  │  │  └─ sidebar.ts
│  │  ├─ components/             # Chat, Sidebar, FileBrowser,
│  │  │                          # InteractiveRequestDialog, ToolCall,
│  │  │                          # DiffView, ContextMeter,
│  │  │                          # ReasoningBlock, … + ui/
│  │  ├─ server/
│  │  │  ├─ copilot/
│  │  │  │  ├─ bridge.ts          # compatibility facade
│  │  │  │  ├─ copilot-provider.ts # SDK wrapper, event normalization
│  │  │  │  ├─ bridge-stub.ts     # in-process stub (e2e via COPILOT_STUB)
│  │  │  │  ├─ pool.ts            # conversation→session map, idle reaper
│  │  │  │  ├─ turn-runner.ts     # per-turn event log + persistence
│  │  │  │  ├─ async-queue.ts
│  │  │  │  └─ interactive-requests.ts
│  │  │  ├─ db/
│  │  │  │  ├─ index.ts           # better-sqlite3 singleton
│  │  │  │  ├─ ids.ts             # monotonic ULID factory
│  │  │  │  ├─ migrations/
│  │  │  │  └─ repos/             # conversations, messages, settings,
│  │  │  │                       # tokens, usage, users
│  │  │  ├─ auth/
│  │  │  │  ├─ github.ts          # OAuth web flow
│  │  │  │  ├─ session.ts         # cookie/JWT helpers
│  │  │  │  └─ require.ts         # route guards
│  │  │  ├─ files.ts            # FS read / tree (workspace-rooted)
│  │  │  ├─ git.ts              # git plumbing (status, log, diff)
│  │  │  ├─ snapshots.ts        # per-turn pre/post git snapshots
│  │  │  ├─ fork.ts             # edit-and-rerun / retry forks
│  │  │  ├─ workdir.ts          # PROJECT_ROOT resolution
│  │  │  ├─ conversation-auth.ts
│  │  │  ├─ http.ts             # JSON response envelopes
│  │  │  ├─ sse.ts              # SSE response helper
│  │  │  ├─ crypto.ts           # AES-256-GCM
│  │  │  ├─ title.ts            # auto-title via the SDK
│  │  │  ├─ validate.ts
│  │  │  ├─ log.ts
│  │  │  └─ config.ts           # env parsing via zod
│  │  └─ types.ts
│  └─ routes/
│     ├─ +layout.svelte
│     ├─ +layout.server.ts        # auth gate, user info
│     ├─ +page.svelte             # conversation list / new chat
│     ├─ login/
│     ├─ logout/
│     ├─ auth/callback/           # OAuth callback
│     ├─ conversations/[id]/      # chat view
│     ├─ settings/
│     └─ api/
│        ├─ admin/                # redeploy
│        ├─ conversations/
│        │  ├─ +server.ts                            # POST create, GET list
│        │  └─ [id]/
│        │     ├─ +server.ts                         # GET, DELETE
│        │     ├─ export/                            # markdown export
│        │     ├─ forks/                             # list child forks
│        │     ├─ fs/                                # tree, file, diff
│        │     ├─ git/                               # status, log, commit
│        │     ├─ messages/[msgId]/fork/             # edit / retry
│        │     ├─ permissions/[requestId]/+server.ts
│        │     └─ turns/
│        │        ├─ +server.ts                       # POST start turn
│        │        └─ [turnId]/stream/+server.ts       # GET SSE, DELETE cancel
│        ├─ copilot/                # status, models
│        └─ health/+server.ts
├─ static/
├─ scripts/
│  ├─ serve.mjs                # supervisor with build.live/ swap
│  ├─ dev-isolated.mjs         # dev with throwaway DATA_DIR
│  ├─ install-git-hooks.mjs
│  ├─ bump-actions.mjs
│  └─ git-hooks/pre-commit
├─ e2e/                        # Playwright specs
├─ tests/                      # vitest unit specs
├─ Dockerfile
├─ compose.yaml
├─ compose.tunnel.yaml
├─ package.json
├─ svelte.config.js
├─ vite.config.ts
└─ tsconfig.json
```

## Configuration (env)

All env vars validated with `zod` at startup; the process refuses to start on
invalid config.

| Var                       | Default                  | Description                          |
|---------------------------|--------------------------|--------------------------------------|
| `PORT`                    | `3000`                   | Listen port.                         |
| `HOST`                    | `127.0.0.1`              | Listen address.                      |
| `DATA_DIR`                | `./data`                 | DB root (`portal.db` + legacy workspaces dir). |
| `PROJECT_ROOT`            | *(process cwd)*          | The directory the Copilot SDK and the FS/git tabs operate inside. Shared by all conversations. |
| `SESSION_SECRET`          | *(required unless `AUTH_MODE=none`)* | Signs session cookies (≥ 32 chars). |
| `ENCRYPTION_KEY`          | *(required, base64 of 32 raw bytes)* | At-rest encryption for tokens. |
| `AUTH_MODE`               | `none`                   | `github` \| `shared-secret` \| `none`. |
| `I_KNOW_THIS_IS_LOCAL`    | —                        | Must be `1` together with `HOST=127.0.0.1` (or `0.0.0.0`) for `AUTH_MODE=none`. |
| `GITHUB_CLIENT_ID`        | —                        | OAuth app client id (`github` mode). |
| `GITHUB_CLIENT_SECRET`    | —                        | OAuth app secret (`github` mode).    |
| `ALLOWED_GITHUB_LOGINS`   | —                        | Comma-separated allowlist (`github` mode, non-empty). |
| `SHARED_SECRET`           | —                        | If `AUTH_MODE=shared-secret`.        |
| `COPILOT_GITHUB_TOKEN`    | —                        | Optional: forwarded to the SDK.      |
| `COPILOT_CLI_URL`         | —                        | If set, connect to an external `copilot --headless --port N` instead of spawning the bundled CLI. See `docs/deployment.md` Topology C. |
| `DEFAULT_BACKEND_PROVIDER`| `copilot`                | Default backend for new conversations: `copilot` \| `openai-compatible` \| `lm-studio`. |
| `DEFAULT_MODEL`           | `claude-sonnet-4.5`      | Default model id for new conversations, stored separately from the provider id. |
| `OPENAI_COMPATIBLE_BASE_URL` | —                     | Base `/v1` URL for an OpenAI-compatible backend. |
| `OPENAI_COMPATIBLE_API_KEY` | —                      | Optional bearer token for the generic OpenAI-compatible backend. |
| `OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS` | `8`       | Maximum OpenAI-compatible tool-calling loops before the portal stops the turn. |
| `OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES` | `20`  | Maximum complete portal messages replayed when a fresh OpenAI-compatible session restores context. |
| `OPENAI_COMPATIBLE_TEMPERATURE` | — | Optional sampling temperature for OpenAI-compatible and LM Studio chat completions. Leave unset to use backend/model defaults. |
| `OPENAI_COMPATIBLE_TOP_P` | — | Optional nucleus sampling value for OpenAI-compatible and LM Studio chat completions. Leave unset to use backend/model defaults. |
| `OPENAI_COMPATIBLE_PRESENCE_PENALTY` | — | Optional topic repetition penalty for OpenAI-compatible and LM Studio chat completions. Leave unset to use backend/model defaults. |
| `OPENAI_COMPATIBLE_FREQUENCY_PENALTY` | — | Optional token repetition penalty for OpenAI-compatible and LM Studio chat completions. Leave unset to use backend/model defaults. |
| `LMSTUDIO_BASE_URL`       | `http://127.0.0.1:1234`  | Base URL for LM Studio's local server. The portal uses `/v1` for chat and `/api/v1` for model metadata. |
| `LMSTUDIO_API_KEY`        | —                        | Optional LM Studio API token when server authentication is enabled. |
| `IDLE_TIMEOUT_MIN`        | `15`                     | SDK session idle reap.               |
| `MAX_CONCURRENT_SESSIONS` | `4`                      | Hard cap on live sessions.           |
| `LOG_LEVEL`               | `info`                   | `debug` \| `info` \| `warn` \| `error`. |
| `ENABLE_REDEPLOY`         | —                        | Set to `1` to enable `POST /api/admin/redeploy` (only meaningful under `pnpm run serve`). |
| `COPILOT_STUB`            | —                        | Set to `1` to swap the real SDK for the in-process stub. Used by e2e tests. |
| `DB_MIGRATIONS_DIR`       | *(auto)*                 | Explicit override for the migrations directory. Useful when cwd isn't the repo root. |
