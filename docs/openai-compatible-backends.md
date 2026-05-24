# OpenAI-compatible backends

The portal can run new conversations against any backend that exposes an
OpenAI-compatible `/v1` API with streaming chat completions, tool calls, and a
`/models` endpoint. This is useful for local or self-hosted model servers while
keeping the same portal conversation, tool permission, and audit UI.

## Start a compatible backend

Start your model server outside the portal and enable its OpenAI-compatible API.
The portal expects:

1. A base URL ending in `/v1`, for example `http://127.0.0.1:1234/v1`.
2. `GET /v1/models` returning available model ids.
3. `POST /v1/chat/completions` accepting `stream: true`, `tools`, and
   `tool_choice: "auto"`.
4. Optional bearer-token auth via `Authorization: Bearer <token>`.

Keep the backend reachable from the portal process. For Docker deployments, use
a host or service name that is valid from inside the container rather than a
desktop-only loopback address.

## Configure the portal

Set these environment variables and restart the portal:

```bash
DEFAULT_BACKEND_PROVIDER=openai-compatible
DEFAULT_MODEL=<model-id>
OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1
# Optional, only when your backend requires bearer auth:
OPENAI_COMPATIBLE_API_KEY=<token>
# Optional cap for multi-step tool loops:
OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS=8
```

You can also leave `DEFAULT_BACKEND_PROVIDER=copilot` and select
**OpenAI compatible** from **Settings -> General -> Default provider**. The
settings page shows whether the backend is configured, whether bearer auth is in
use, and whether model discovery returned model ids. If discovery succeeds, pick
a model from the list; if discovery is unavailable or the model is not listed,
enter the exact model id manually.

Existing conversations keep the provider and model selected when they were
created. Change settings before starting a new conversation.

## Feature differences from Copilot

OpenAI-compatible sessions use the portal's provider boundary, not the Copilot
SDK runtime. Core chat, portal-hosted tools, permission prompts, persisted
messages, file diffs, and workspace tickets remain available when the model emits
compatible tool calls.

Expected differences:

| Area | OpenAI-compatible behavior |
| ---- | -------------------------- |
| Runtime modes | Saved for portal permission semantics, but not sent as Copilot runtime mode hints. |
| Approve all | Enforced by the portal for portal-hosted tools; no separate provider-side approval cache is reset. |
| Context meter | No Copilot context-window or compaction events are emitted. |
| Subagents | Copilot subagent/task lifecycle events are unavailable. |
| MCP info events | Copilot SDK sampling, OAuth, and external-tool informational events are unavailable. |
| Plan exit and elicitation | Copilot callback dialogs for plan-exit and elicitation are unavailable. |

Model quality, context size, tool-calling reliability, and supported message
formats depend on the selected backend and model. If a turn fails before any
tokens stream, check the settings status card, the backend server logs, and that
`OPENAI_COMPATIBLE_BASE_URL` points to the `/v1` endpoint.
