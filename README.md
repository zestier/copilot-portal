# Copilot Portal

A self-hosted web portal for interacting with GitHub Copilot's agent runtime, built
on top of the official [`github/copilot-sdk`](https://github.com/github/copilot-sdk).
Intended to be run on a personal/home machine and exposed via a Cloudflare Tunnel
(or similar) for remote access from a phone or laptop.

> **Status:** Initial implementation (Phases 0–2 of the roadmap). The
> Copilot SDK is pinned to `@github/copilot-sdk@^0.3.0` (preview).

## Quick start (local, no auth)

```bash
cp .env.example .env
# Edit .env: set ENCRYPTION_KEY (and SESSION_SECRET if not AUTH_MODE=none).
#   openssl rand -base64 32   # ENCRYPTION_KEY
#   openssl rand -base64 48   # SESSION_SECRET
# For pure-local dev, leave AUTH_MODE=none and set HOST=127.0.0.1 +
# I_KNOW_THIS_IS_LOCAL=1.

# Authenticate the Copilot CLI on the host (the SDK reuses these creds):
#   pnpm dlx @github/copilot auth login

corepack enable        # one-time, to provide pnpm
pnpm install
pnpm run dev   # http://127.0.0.1:5173
```

## Production (Docker + Cloudflare Tunnel)

```bash
docker compose up -d --build
```

See [docs/deployment.md](docs/deployment.md) for the OAuth + tunnel setup.

## Scripts

| Script              | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `pnpm run dev`      | Vite dev server with HMR.                      |
| `pnpm run build`    | Production build into `build/`.                |
| `pnpm start`        | Run the production build (`node build`).       |
| `pnpm run check`    | `svelte-check` + TS.                           |
| `pnpm run lint`     | ESLint + Prettier check.                       |
| `pnpm test`         | Vitest unit tests.                             |
| `pnpm run test:e2e` | Build + Playwright e2e (uses stubbed Copilot). |

This project uses **pnpm** (declared via `packageManager` in `package.json`).
Use `corepack enable` once to make pnpm available without a global install.

## Goals

- A clean web chat UI for Copilot agent sessions — comparable in feel to the
  VS Code Copilot Chat pane, but accessible from any browser.
- Self-hosted, single-user-first. No cloud middleman.
- Use the **official** GitHub Copilot SDK only. No reverse-engineered endpoints,
  no ToS gray areas.
- Persist conversations locally so sessions survive restarts and can be resumed.
- Trivial to deploy: `docker compose up` + a Cloudflare Tunnel.

## Non-goals (initially)

- Multi-tenant SaaS. Single-user, optionally with a small allowlist of GitHub
  accounts later.
- A Copilot Extensions marketplace / `@agent` registry.
- Full feature parity with VS Code Copilot Chat (no native diff view editor,
  no inline-edit-in-file UX beyond showing the diff produced by the agent).
- Mobile-native apps. Web is responsive; that's enough.

## Document index

1. [docs/architecture.md](docs/architecture.md) — Components and data flow.
2. [docs/tech-stack.md](docs/tech-stack.md) — SvelteKit, rationale, dependencies.
3. [docs/backend-sdk-integration.md](docs/backend-sdk-integration.md) — How the
   server uses `@github/copilot-sdk`, session lifecycle, streaming.
4. [docs/frontend-ui.md](docs/frontend-ui.md) — Routes, components, UX details.
5. [docs/auth-and-security.md](docs/auth-and-security.md) — Login, tunnel exposure,
   threat model.
6. [docs/persistence.md](docs/persistence.md) — SQLite schema, conversation storage.
7. [docs/deployment.md](docs/deployment.md) — Dockerfile, compose, Cloudflare Tunnel.
8. [docs/roadmap.md](docs/roadmap.md) — Phases / MVP scope.

## TL;DR architecture

```
Browser (SvelteKit client)
       │  HTTPS, SSE for streaming
       ▼
SvelteKit server (Node adapter)
       │  @github/copilot-sdk (JSON-RPC over stdio)
       ▼
copilot CLI (server mode, child process)
       │  HTTPS
       ▼
GitHub Copilot backend
```

Persistence (SQLite) lives next to the SvelteKit server. One Copilot CLI
subprocess per active session, managed by the SDK.
