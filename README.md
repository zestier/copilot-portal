# Copilot Portal — Design Docs

A self-hosted web portal for interacting with GitHub Copilot's agent runtime, built
on top of the official [`github/copilot-sdk`](https://github.com/github/copilot-sdk).
Intended to be run on a personal/home machine and exposed via a Cloudflare Tunnel
(or similar) for remote access from a phone or laptop.

> **Status:** Design only. These docs bootstrap the project.

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
