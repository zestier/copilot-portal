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

- Spawning and managing the bundled `copilot` CLI subprocess per session.
- Translating SDK events (token deltas, tool calls, permission prompts,
  file edits) into a normalized event stream the frontend understands.
- Enforcing per-session resource limits (max concurrent sessions, idle timeout).

### 3. Session store (SQLite)

A single `portal.db` file holding:

- Conversations and their messages.
- Tool-call records and approvals.
- Auth state (encrypted refresh tokens, CSRF secrets).
- User settings (default model, default working directory, allowed tools).

See [persistence.md](persistence.md).

### 4. Working-directory sandbox

Each conversation is pinned to a working directory on the host. The agent
operates within that directory (this is how the Copilot CLI scopes file ops).
By default `~/.copilot-portal/workspaces/<conversation-id>/`. Users can pin
existing repos.

### 5. Cloudflare Tunnel (optional, deployment-time)

`cloudflared` runs as a sidecar container, exposing the SvelteKit port over
a named tunnel. See [deployment.md](deployment.md).

## Data flow: sending a message

```
User types message in chat UI
        │
        ▼
POST /api/conversations/:id/messages   (JSON body)
        │
        ▼
SvelteKit server endpoint:
  1. Persist user message to SQLite
  2. Ensure SDK client exists for this conversation (spin up if needed)
  3. Call sdk.sendMessage(...) and get an async iterator of events
  4. Return SSE response, streaming normalized events
        │
        ▼
Client subscribes to SSE on the same endpoint (POST + SSE response).
Events update Svelte stores; UI re-renders incrementally.
        │
        ▼
On stream end:
  - Persist assistant message, tool calls, and any file edits to SQLite
  - Update conversation `updated_at`
```

## Streaming protocol

Server → client SSE events, one JSON object per `data:` line:

| `type`                | Payload                                              |
|-----------------------|------------------------------------------------------|
| `message.start`       | `{ messageId, role: "assistant" }`                   |
| `message.delta`       | `{ messageId, text }`                                |
| `message.end`         | `{ messageId }`                                      |
| `tool.call`           | `{ toolCallId, tool, args }`                         |
| `tool.permission`     | `{ toolCallId, tool, args, requestId }` (needs ack)  |
| `tool.result`         | `{ toolCallId, ok, summary, output? }`               |
| `file.edit`           | `{ path, diff }`                                     |
| `error`               | `{ code, message }`                                  |
| `done`                | `{}`                                                 |

Permission acknowledgements are a separate POST:
`POST /api/conversations/:id/permissions/:requestId { decision: "allow" | "deny" | "always" }`.

## Concurrency model

- **One SDK client per conversation**, kept alive until idle for N minutes
  (configurable, default 15) or explicitly closed.
- A small in-memory `Map<conversationId, SdkClient>` in the server process.
- Idle reaper runs every minute. On shutdown, all clients are closed cleanly.
- New messages to an idle/closed conversation transparently respawn the client
  and resume from persisted history.

## Failure modes and recovery

- **CLI subprocess crash** — SDK surfaces an error; the bridge marks the
  client dead, persists a system message in the conversation, and the next
  user message respawns.
- **Network error to Copilot backend** — surfaced as a normal `error` event;
  user can retry without losing conversation state.
- **Server restart** — conversations are durable in SQLite. SDK clients are
  ephemeral and recreated on demand. Any in-flight assistant turn that was
  not finalized is marked `interrupted` and shown as such in the UI.
