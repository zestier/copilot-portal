# 03 — Backend / SDK integration

This document describes how the SvelteKit server uses
[`@github/copilot-sdk`](https://github.com/github/copilot-sdk) to drive Copilot
agent sessions.

> The exact SDK surface is in public preview and may shift. Treat the type
> names below as illustrative; pin to a known-good version and adapt.

## Module: `$lib/server/copilot/bridge.ts`

A thin wrapper that:

1. Instantiates one SDK client per conversation, scoped to that conversation's
   working directory.
2. Translates SDK events into the normalized `PortalEvent` discriminated union
   defined in `$lib/types.ts`.
3. Handles backpressure: SSE writes are awaited; if a client disconnects, the
   stream is cancelled and the SDK call aborted via `AbortController`.

### Sketch

```ts
// $lib/server/copilot/bridge.ts
import { Copilot } from "@github/copilot-sdk";
import type { PortalEvent } from "$lib/types";

export interface BridgeOptions {
  conversationId: string;
  workingDirectory: string;
  model?: string;
  authToken?: string;          // forwarded as COPILOT_GITHUB_TOKEN env
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  signal: AbortSignal;
}

export class CopilotBridge {
  private client: Copilot;
  constructor(private opts: BridgeOptions) {
    this.client = new Copilot({
      cwd: opts.workingDirectory,
      model: opts.model,
      env: opts.authToken ? { COPILOT_GITHUB_TOKEN: opts.authToken } : undefined,
      // SDK exposes a permission handler hook:
      onToolPermissionRequest: opts.onPermission,
    });
  }

  async *send(prompt: string): AsyncIterable<PortalEvent> {
    const stream = this.client.sendMessage(prompt, { signal: this.opts.signal });
    for await (const ev of stream) {
      yield* normalize(ev);
    }
  }

  async close() {
    await this.client.dispose();
  }
}
```

`normalize()` is a pure function in the same module that maps SDK event shapes
to `PortalEvent`. It is the single point of coupling to the SDK's wire format;
when the SDK changes, this is the only file that needs updating (plus tests).

### Context-window usage events

In addition to the message/tool/permission events documented above, the bridge
also subscribes to the SDK's context-window signals and surfaces them on the
same `PortalEvent` stream:

- `session.usage_info` → `context.usage` — emitted by the SDK once per turn
  (and once with `isInitial: true` at session start) with `currentTokens`,
  `tokenLimit`, `messagesLength`, and an optional `{systemTokens,
  conversationTokens, toolDefinitionsTokens}` breakdown. The turn runner
  persists the latest snapshot to the `conversation_usage` table so that the
  meter can render immediately on page load.
- `session.compaction_start` → `context.compaction` with `phase: 'start'`.
- `session.compaction_complete` → `context.compaction` with `phase: 'complete'`,
  carrying optional `tokensRemoved` / `messagesRemoved`.

Per-call telemetry (`assistant.usage` — input/output/cache/reasoning tokens and
CAPI cost) is intentionally **not** forwarded today; revisit if a per-turn cost
view is needed.

## Module: `$lib/server/copilot/pool.ts`

```ts
// Singleton, per-process.
const clients = new Map<string, { bridge: CopilotBridge; lastUsed: number }>();

export async function acquire(convId: string, opts: BridgeOptions) { ... }
export function touch(convId: string) { ... }
export async function release(convId: string) { ... }

// Idle reaper, started in hooks.server.ts:
export function startIdleReaper(idleMs: number) {
  setInterval(async () => {
    const now = Date.now();
    for (const [id, entry] of clients) {
      if (now - entry.lastUsed > idleMs) await release(id);
    }
  }, 60_000).unref();
}
```

Hard cap: when `clients.size >= MAX_CONCURRENT_SESSIONS`, refuse new sends
with HTTP 429 unless the caller releases an existing one.

## Module: `$lib/server/copilot/permissions.ts`

Tool-call permission flow:

1. SDK calls `onToolPermissionRequest({ tool, args })`.
2. Bridge emits `tool.permission` SSE event with a unique `requestId` and
   stashes a `{ resolve }` deferred keyed by `requestId`.
3. Client renders a `<PermissionPrompt>` and the user picks
   *Allow once / Allow always / Deny*.
4. Client posts `POST /api/conversations/:id/permissions/:requestId` with
   the decision. Endpoint looks up the deferred, resolves it, returns 204.
5. "Allow always" persists `{ tool, conversationId }` (or `{ tool, *  }` for
   global) to SQLite; the permission handler short-circuits future requests
   matching either scope without prompting.

A user-configurable default policy (deny-all / prompt-all / allow-readonly /
allow-all) gates the prompt entirely.

## Conversation send endpoint

`src/routes/api/conversations/[id]/messages/+server.ts`:

```ts
export async function POST({ params, request, locals }) {
  const { id } = params;
  const body = await request.json();
  const { content } = z.object({ content: z.string().min(1) }).parse(body);

  const conv = await repos.conversations.get(id, locals.userId);
  if (!conv) return error(404);

  await repos.messages.append(id, { role: "user", content });

  const ac = new AbortController();
  request.signal.addEventListener("abort", () => ac.abort());

  const bridge = await pool.acquire(id, {
    conversationId: id,
    workingDirectory: conv.workdir,
    model: conv.model,
    authToken: locals.copilotToken,
    onPermission: makePermissionHandler(id),
    signal: ac.signal,
  });

  return sseResponse(async function* () {
    let assistant = "";
    for await (const ev of bridge.send(content)) {
      yield ev;
      if (ev.type === "message.delta") assistant += ev.text;
      // collect tool calls / file edits for persistence
    }
    await repos.messages.append(id, { role: "assistant", content: assistant /*, toolCalls, edits */ });
    yield { type: "done" };
  });
}
```

`sseResponse` is a small helper that wraps an async generator of JSON-able
events into a `Response` with `Content-Type: text/event-stream` and proper
flushing.

## Auth token plumbing to the SDK

Three modes, in priority order:

1. **Per-user GitHub OAuth token** — minted via the portal's own OAuth app.
   Stored encrypted in SQLite, forwarded to the SDK as `COPILOT_GITHUB_TOKEN`
   for each spawn.
2. **Pre-logged-in `copilot` CLI** — if `~/.config/copilot/auth.json` (or
   equivalent) exists on the host and `AUTH_MODE != github`, the SDK can
   reuse it. Single-user mode.
3. **BYOK** — env vars `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / etc. forwarded
   to the SDK, with model selection restricted to those providers.

## Testing

- **Unit tests** of `normalize()` in `bridge.ts` against captured SDK event
  fixtures. The single most important set of tests in the project.
- **Bridge integration tests** with a stub Copilot CLI binary (a tiny Node
  script that speaks the SDK's JSON-RPC and emits scripted events). Keeps
  CI fast and offline.
- **End-to-end tests** with Playwright, opt-in (env-gated), against a real
  Copilot subscription. Run nightly, not on every PR.

## Edit-and-rerun (workdir checkpointing)

The SDK does not expose an API to fork a session at an earlier turn, nor
does it snapshot the workdir. Both layers are owned by the portal:

- **Workdir snapshots**: see `docs/persistence.md` — every user turn gets
  a `pre` snapshot, every assistant turn a `post` snapshot, stored as git
  commits under `refs/portal/turns/*` in the conversation's own workdir.
- **Conversation forking**: editing a user message — or retrying from
  an assistant message — creates a new conversation
  (`src/lib/server/fork.ts`). We spin up a brand-new SDK session keyed
  by the new conversation id rather than trying to mutate the source's
  SDK event log (which we don't own).

### Two fork flavours

The same endpoint (`POST /api/conversations/:id/messages/:msgId/fork`)
covers both:

| Body          | Target role | Snapshot used | Prefix cloned         | New user msg appended |
| ------------- | ----------- | ------------- | --------------------- | --------------------- |
| `{content}`   | `user`      | `pre`         | strictly before target | yes (edited content)  |
| `{}`          | `assistant` | `post`        | up to and incl. target | no                    |

"Edit-and-rerun" reproduces the file state from when the original user
message was first sent and lets the user reword it. "Retry-from-here"
reproduces the file state immediately after an assistant turn finished
and lets the user pick the conversation up with a different follow-up.

### Discovering forks

A `GET /api/conversations/:id/forks` endpoint lists child forks keyed by
source message id. The chat UI uses this to render a "Forked → …" badge
on each message that has produced a fork. Forked conversations also
expose a parent breadcrumb derived from `forked_from_conversation_id`
on load.

### SDK history seeding

In v1 the forked SDK session starts with **no seeded history**. Prior
messages are cloned into SQLite for UI continuity, but the agent itself
has no memory of them — it picks up cold from the edited message.

This is a deliberate trade-off:

- It avoids writing into the SDK's `events.jsonl`, whose schema is
  generated and not part of the SDK's public surface.
- It avoids inflating the first prompt with a synthesized preamble that
  would burn context tokens on every fork.
- It matches the user's intent for the common case ("rewind the code and
  let me re-ask"): the file state is what mattered, and the user is
  about to re-establish whatever context they need anyway.

If/when the SDK exposes a supported way to seed conversation history,
the fork service can opt into it without changing the table schema.
