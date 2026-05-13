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

`$lib/client/sse.ts` exposes:

```ts
export async function* streamSse<T>(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): AsyncIterable<T> { ... }
```

Uses `fetch` + `ReadableStream` (not `EventSource`, because `EventSource`
doesn't support POST). Parses `data:` lines as JSON, yields typed events.

Chat composer flow:

```ts
async function send(text: string) {
  const ac = new AbortController();
  cancelCurrent = () => ac.abort();
  for await (const ev of streamSse<PortalEvent>(`/api/conversations/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: ac.signal,
  })) {
    applyEvent(ev);
  }
}
```

A visible "Stop" button calls `cancelCurrent()`, which closes the SSE; the
server detects `request.signal.aborted` and aborts the SDK call.

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
