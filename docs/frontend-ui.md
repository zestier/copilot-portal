# 04 — Frontend / UI

Svelte 5, SvelteKit file-based routing. Mobile-first responsive layout.

## Routes

| Path                         | Purpose                                                |
|------------------------------|--------------------------------------------------------|
| `/`                          | Conversation list + "New chat" CTA.                    |
| `/conversations/[id]`        | Chat view for a single conversation.                   |
| `/settings`                  | User settings (default model, default workdir, etc.).  |
| `/login`                     | OAuth entry point.                                     |
| `/auth/callback`             | OAuth callback target.                                 |

All routes except `/login` and `/auth/callback` require an authenticated
session (enforced in `hooks.server.ts`).

## Layout

```
┌──────────────────────────────────────────────────────┐
│  Sidebar (collapsible on mobile)   │   Main          │
│  ┌────────────────────────────┐    │   ┌──────────┐  │
│  │ + New chat                 │    │   │ Header   │  │
│  │ ── Conversations ──        │    │   │  title,  │  │
│  │  • "Fix flaky test in foo" │    │   │  model,  │  │
│  │  • "Draft release notes"   │    │   │  workdir │  │
│  │  • …                       │    │   └──────────┘  │
│  │                            │    │   ┌──────────┐  │
│  │ ── Settings                │    │   │ Messages │  │
│  └────────────────────────────┘    │   │  scroll  │  │
│                                    │   └──────────┘  │
│                                    │   ┌──────────┐  │
│                                    │   │ Composer │  │
│                                    │   └──────────┘  │
└──────────────────────────────────────────────────────┘
```

Sidebar is a `<details>`-like drawer below a breakpoint (~768 px).

## Components

### `Chat.svelte`

Owns the conversation's runtime state: messages, current stream, pending
permission prompts. Reads initial data from `+page.server.ts`'s `load`,
then opens an SSE connection on submit.

State (Svelte 5 runes):

```ts
let messages = $state<Message[]>(initial);
let streaming = $state<{ messageId: string; buffer: string } | null>(null);
let pendingPermission = $state<PermissionRequest | null>(null);
let toolCalls = $state<Record<string, ToolCallView>>({});
```

### `Message.svelte`

Renders one message. Assistant content is markdown → sanitized HTML.
Code blocks lazy-load `shiki` and render with copy buttons. Tool calls
and file edits are rendered as folded inline cards.

### `ToolCall.svelte`

Folded card showing tool name, status (pending/running/ok/error), and
expanding to show arguments and result/output.

### `DiffView.svelte`

Renders unified diff with side-by-side or inline toggle. Per-edit
"open in editor" link is just informational on the web build; on desktop,
clicking the path copies it to clipboard.

### `FileBrowser.svelte`

Read-only, git-aware file browser rooted at the **server process's working
directory** (resolved to its realpath at startup). The conversation id in
the API URL is used only for ownership/auth; every conversation in a given
deployment browses the same workspace root. Surfaced as a **Files** tab on
`/conversations/[id]` (sits next to **Chat**). Two-pane layout: a left rail
that switches between **Files** (hierarchical tree with per-entry git
status badges and roll-ups to ancestor directories, plus toggles for hidden
/ ignored files) and **Commits** (branch / HEAD header with ahead/behind,
plus the recent commit log with "Load more"). The right pane renders either
the selected file (text content + binary placeholder, capped at 1 MiB) with
a **Content** / **Diff** toggle, or a selected commit's detail with its
file list and per-file diff. Mobile collapses both grids into stacked
single-pane rows.

Backed by:

| Endpoint                                              | Returns                       |
| ----------------------------------------------------- | ----------------------------- |
| `GET /api/conversations/[id]/fs/tree?path=&hidden=&ignored=` | Directory listing + git status per entry. |
| `GET /api/conversations/[id]/fs/file?path=&ref=`     | File content (working tree or git revision); binary detected. |
| `GET /api/conversations/[id]/fs/diff?target=&sha=&path=` | Unified diff (working tree vs HEAD/index, or commit). |
| `GET /api/conversations/[id]/git/status`             | Branch, HEAD sha, upstream, ahead/behind, dirty count. |
| `GET /api/conversations/[id]/git/log?limit=&skip=`   | Recent commits.               |
| `GET /api/conversations/[id]/git/commit/[commitSha]`       | Commit metadata + changed files. |

All paths are constrained to the workspace root realpath; symlinks that
escape are rejected. `git` is spawned with `shell: false`, hard timeouts,
and output size caps.

### `PermissionPrompt.svelte`

Modal-ish inline card that blocks further streaming. Shows tool name,
arguments preview, and three buttons: *Allow once*, *Allow always for this
conversation*, *Deny*. A small "what does this tool do?" tooltip pulls from
a static description map.

### `Composer.svelte`

Textarea with autosize. Submit on `Cmd/Ctrl+Enter`. Plain `Enter` inserts a
newline. Drag-and-drop file attachment (phase 2) reads file contents and
includes them inline in the prompt.

### `Sidebar.svelte`

Conversation list with relative timestamps. Each row has a kebab (⋯) menu
exposing **Rename** (inline edit), **Archive**/**Unarchive**, and **Delete**.
Archived conversations are tucked into a collapsible "Archived (N)" group.
A **Select** button enables multi-select mode with a bulk action bar at the
bottom for archiving, unarchiving, or deleting in batches. API failures
surface in a dismissible inline banner. Click a row to navigate; archiving
releases the conversation's pooled SDK client.

## Streaming on the client

Chat streaming uses the browser's native `EventSource`. The architecture
splits "start a turn" (POST) from "stream a turn" (GET-only SSE) so we
can hand the entire reconnect lifecycle — including `Last-Event-ID`
replay on auto-reconnect — to the browser.

```ts
async function send(text: string) {
  const r = await fetch(`/api/conversations/${id}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text })
  });
  const { turnId } = await r.json();
  const es = new EventSource(`/api/conversations/${id}/turns/${turnId}/stream`);
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data) as PortalEvent;
    applyEvent(ev);
    if (ev.type === 'done') es.close();
  };
  es.onerror = () => {
    // Transient errors keep readyState === CONNECTING and the browser
    // auto-reconnects. Only CLOSED is terminal (e.g. server 410 Gone
    // after the finished-turn grace expired during a phone lock).
    if (es.readyState === EventSource.CLOSED) {
      void refreshMessages(); // re-pull persisted state so UI catches up
    }
  };
}
```

Each event the server emits carries a monotonic `id:` line; on
auto-reconnect the browser sends `Last-Event-ID` and the server replays
strictly from there. No client-side stall watchdog, no manual backoff,
no `visibilitychange`/`online` choreography — locking and unlocking the
phone mid-turn just works.

A visible "Stop" button issues `DELETE /api/conversations/[id]/turns/[turnId]`
to actually cancel the upstream SDK turn (closing the EventSource alone
would only detach this client).

## Context-window meter

The chat header renders a `ContextMeter` next to the conversation title showing
`currentTokens / tokenLimit` plus a percentage. The bar fill is color-coded by
threshold: green below 70%, amber 70–90%, red above 90%. Clicking the bar
toggles a per-bucket breakdown (system / conversation / tools / messages) when
the SDK provided one.

Data flow:

- Initial value comes from `+page.server.ts`, which reads the latest snapshot
  from the `conversation_usage` table and passes it to `Chat.svelte` as
  `initialUsage`.
- Live updates arrive on the SSE stream as `context.usage` events (translated
  from `session.usage_info` by the server-side bridge) and are merged into
  local component state.
- `context.compaction` events with `phase: 'complete'` show a transient
  "✨ compacted · −N tokens" notice next to the meter that auto-dismisses
  after a few seconds.

## Theming

- Dark mode by default. Light mode toggle in settings.
- CSS variables for palette; no Tailwind required (keeps bundle small).
- System font stack. Monospace via `ui-monospace, Menlo, …`.

## Accessibility

- All interactive components keyboard-operable.
- Permission prompt traps focus until decided.
- ARIA live region on the streaming message so screen readers announce
  meaningful chunks (debounced to ~1 s).

## Empty / error states

- New install with no conversations: large CTA, links to settings to verify
  Copilot auth.
- Auth missing: chat send is disabled with a banner pointing to `/settings`.
- SSE disconnect mid-stream: keep what was streamed, show "interrupted",
  offer "Resume" (which sends an empty continuation prompt).
