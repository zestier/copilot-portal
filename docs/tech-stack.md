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

- **Node.js ≥ 20 LTS** (the Copilot CLI bundled by `@github/copilot-sdk`
  requires a recent Node).
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
| Syntax highlighting      | `shiki` (lazy-loaded in client)                    |
| Diff rendering           | `diff` + custom Svelte component                   |
| Auth (OAuth)             | `@octokit/auth-oauth-app` or hand-rolled flow      |
| Cookie/session           | SvelteKit's `cookies` API + signed JWT             |
| Crypto for at-rest       | Node `crypto` (AES-256-GCM)                        |
| Testing (unit)           | `vitest`                                           |
| Testing (e2e)            | `@playwright/test`                                 |
| Lint/format              | `eslint`, `prettier`, `svelte-check`               |

No global state managers (Pinia/Redux-equivalent). Svelte 5 runes + a small
number of `.svelte.ts` stores are enough.

## Repository layout

```
copilot-portal/
├─ src/
│  ├─ app.html
│  ├─ app.d.ts
│  ├─ hooks.server.ts
│  ├─ lib/
│  │  ├─ client/                  # browser-only helpers
│  │  │  ├─ sse.ts
│  │  │  └─ markdown.ts
│  │  ├─ components/
│  │  │  ├─ Chat.svelte
│  │  │  ├─ Message.svelte
│  │  │  ├─ ToolCall.svelte
│  │  │  ├─ DiffView.svelte
│  │  │  ├─ PermissionPrompt.svelte
│  │  │  └─ Sidebar.svelte
│  │  ├─ server/
│  │  │  ├─ copilot/
│  │  │  │  ├─ bridge.ts          # SDK wrapper, event normalization
│  │  │  │  ├─ pool.ts            # session→client map, idle reaper
│  │  │  │  └─ permissions.ts
│  │  │  ├─ db/
│  │  │  │  ├─ index.ts           # better-sqlite3 singleton
│  │  │  │  ├─ migrations/
│  │  │  │  └─ repos/             # conversations.ts, messages.ts, ...
│  │  │  ├─ auth/
│  │  │  │  ├─ github.ts          # OAuth device flow
│  │  │  │  └─ session.ts         # cookie/JWT helpers
│  │  │  └─ config.ts             # env parsing via zod
│  │  ├─ stores/
│  │  │  ├─ conversation.svelte.ts
│  │  │  └─ toast.svelte.ts
│  │  └─ types.ts
│  └─ routes/
│     ├─ +layout.svelte
│     ├─ +layout.server.ts        # auth gate, user info
│     ├─ +page.svelte             # conversation list / new chat
│     ├─ login/
│     │  ├─ +page.svelte
│     │  └─ +page.server.ts
│     ├─ auth/
│     │  └─ callback/+server.ts
│     ├─ conversations/
│     │  └─ [id]/
│     │     ├─ +page.svelte
│     │     └─ +page.server.ts
│     ├─ settings/+page.svelte
│     └─ api/
│        ├─ conversations/
│        │  ├─ +server.ts                  # POST create, GET list
│        │  └─ [id]/
│        │     ├─ +server.ts                # GET, DELETE
│        │     ├─ messages/+server.ts       # POST send, SSE stream
│        │     └─ permissions/[reqId]/+server.ts
│        └─ health/+server.ts
├─ static/
├─ Dockerfile
├─ compose.yaml
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
| `HOST`                    | `0.0.0.0`                | Listen address.                      |
| `DATA_DIR`                | `./data`                 | DB + workspace root.                 |
| `SESSION_SECRET`          | *(required)*             | Signs session cookies.               |
| `ENCRYPTION_KEY`          | *(required, 32B base64)* | At-rest encryption for tokens.       |
| `AUTH_MODE`               | `github`                 | `github` \| `shared-secret` \| `none` |
| `GITHUB_CLIENT_ID`        | —                        | OAuth app client id.                 |
| `GITHUB_CLIENT_SECRET`    | —                        | OAuth app secret.                    |
| `ALLOWED_GITHUB_LOGINS`   | —                        | Comma-separated allowlist.           |
| `SHARED_SECRET`           | —                        | If `AUTH_MODE=shared-secret`.        |
| `COPILOT_GITHUB_TOKEN`    | —                        | Optional: forwarded to SDK.          |
| `IDLE_TIMEOUT_MIN`        | `15`                     | SDK client idle reap.                |
| `MAX_CONCURRENT_SESSIONS` | `4`                      | Hard cap.                            |
| `LOG_LEVEL`               | `info`                   | `debug` \| `info` \| `warn` \| `error` |
