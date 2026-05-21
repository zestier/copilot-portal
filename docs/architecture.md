# 01 — Architecture

## Components

### 1. SvelteKit app (single deployable unit)

Runs under `@sveltejs/adapter-node`. Serves:

- **Client routes** — chat UI, session list, settings.
- **Server endpoints** (`+server.ts`) — REST-ish JSON API and SSE streams.
- **Hooks** (`hooks.server.ts`) — auth gate, request logging.

A single Node process. No separate API server.

### 2. Copilot SDK bridge

A server-side module (`$lib/server/copilot/`) that wraps
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk).
Responsible for:

- Spawning and managing a single `CopilotClient` subprocess (shared
  across conversations), and opening a per-conversation **session** on
  top of it.
- Translating SDK events (token deltas, tool calls, permission prompts,
  file edits, context-window usage) into a normalized event stream the
  frontend understands.
- Enforcing per-session resource limits (max concurrent sessions, idle
  timeout).

### 3. Session store (SQLite)

A single `portal.db` file holding:

- Conversations and their messages.
- Tool-call records and approvals.
- Auth state (encrypted refresh tokens, CSRF secrets).
- User settings (default model, default working directory, allowed tools).

See [persistence.md](persistence.md).

### 4. Working directory

The Copilot SDK runs against a single project tree — the `PROJECT_ROOT`
env var, defaulting to the server process's cwd. All conversations in a
given deployment share that same workdir; the agent's edits land in one
place, and the file browser / git tabs all read from it. (Earlier
versions tried to give each conversation its own private sandbox under
`DATA_DIR/workspaces/<id>/`, but the SDK was never actually pointed at
those dirs; the per-conversation sandbox idea was removed. See
`src/lib/server/workdir.ts` for the resolution logic and the legacy-path
fallback.)

### 5. Cloudflare Tunnel (optional, deployment-time)

`cloudflared` runs as a sidecar container, exposing the SvelteKit port over
a named tunnel. See [deployment.md](deployment.md).

## Data flow: sending a message

```
User types message in chat UI
        │
        ▼
POST /api/conversations/:id/turns   (JSON body)
        │
        ▼
SvelteKit server endpoint:
  1. Persist user message to SQLite
  2. Snapshot workdir and start an in-memory Turn
  3. Return { turnId } synchronously (no streaming on this response)
        │
        ▼
Client opens EventSource(/api/conversations/:id/turns/:turnId/stream)
  - Each event arrives with an id: line
  - On lock/unlock/network blip the browser auto-reconnects
    with Last-Event-ID, and the server replays from that offset
  - On 410 Gone (turn grace expired) the client refetches messages
        │
        ▼
On turn end (`done` event):
  - Server has already persisted assistant message, tool calls, edits
  - Client closes the EventSource
```

## Streaming protocol

Server → client SSE events, one JSON object per `data:` line:

| `type`                | Payload                                              |
|-----------------------|------------------------------------------------------|
| `message.start`       | `{ messageId, role: "assistant" }`                   |
| `message.delta`       | `{ messageId, text }`                                |
| `message.end`         | `{ messageId }`                                      |
| `tool.call`           | `{ toolCallId, tool, args }`                         |
| `interactive.request` | `{ request: InteractiveRequestView }` (needs ack)    |
| `interactive.resolved`| `{ requestId, kind, outcome }`                       |
| `tool.result`         | `{ toolCallId, ok, summary, output? }`               |
| `file.edit`           | `{ path, diff }`                                     |
| `error`               | `{ code, message }`                                  |
| `done`                | `{}`                                                 |

Interactive acknowledgements (permission, auto-mode-switch, user-input,
elicitation, exit-plan-mode, plus info-only sampling/mcp_oauth/external_tool)
all flow through one endpoint:
`POST /api/conversations/:id/interactive/:requestId` with a
discriminated `{ kind, ... }` body. The legacy
`/permissions/:requestId` endpoint remains as a one-release shim.

## Concurrency model

- **One shared `CopilotClient` subprocess** for the whole portal process,
  lazily started on first use.
- **One SDK session per conversation**, kept alive until idle for N
  minutes (configurable, default 15) or explicitly closed. Held in a
  small in-memory `Map<conversationId, Session>` (`copilot/pool.ts`).
- Idle reaper runs every minute. On shutdown, all sessions are closed
  and the shared client is stopped cleanly.
- New messages to an idle/closed conversation transparently respawn the
  session and resume from persisted history.

## Failure modes and recovery

- **CLI subprocess crash** — SDK surfaces an error; the bridge marks the
  shared client dead, persists a system message in the conversation, and
  the next user message respawns it.
- **Network error to Copilot backend** — surfaced as a normal `error` event;
  user can retry without losing conversation state.
- **Server restart** — conversations are durable in SQLite. SDK sessions
  and the shared client are ephemeral and recreated on demand. Any
  in-flight assistant turn that was not finalized is marked `interrupted`
  and shown as such in the UI.
