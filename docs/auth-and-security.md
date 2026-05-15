# 05 — Auth and security

This portal grants its users the ability to run arbitrary code on the host
(the Copilot agent can edit files and execute shell commands). Treat it
accordingly: it is **never** safe to expose unauthenticated.

## Threat model

| Actor                     | Capability we must prevent                                   |
|---------------------------|--------------------------------------------------------------|
| Random internet stranger  | Any access (no anonymous reads, no chat).                    |
| Someone with the URL      | Same — URL knowledge is not auth.                            |
| Logged-in user (you)      | Bounded by Copilot CLI's own sandboxing + permission prompts.|
| Malicious tool output     | Cannot inject HTML/script into the chat UI (sanitize all assistant markdown). |
| XSS on `vscode.dev`-style | Mitigated by strict CSP and no inline scripts in dev/prod.   |

We are not trying to defend the *host machine* from a logged-in user — that's
out of scope; this is single-tenant.

## Auth modes

Selected via `AUTH_MODE` env var.

### `github` (default; recommended)

Standard GitHub OAuth App, web flow.

1. User hits any page → `hooks.server.ts` sees no session cookie →
   redirects to `/login`.
2. `/login` redirects to `https://github.com/login/oauth/authorize?...`
   with `state=<csrf>` and `scope=read:user`.
3. `/auth/callback` exchanges code → access token → fetches `/user`.
4. If `login` is in `ALLOWED_GITHUB_LOGINS`, mint a signed session cookie
   (JWT, 30-day expiry, `HttpOnly; Secure; SameSite=Lax`); else 403.
5. The GitHub access token is stored encrypted in SQLite (AES-256-GCM with
   `ENCRYPTION_KEY`) and is **separate** from the Copilot subscription
   token — see below.

### `shared-secret`

Single password (the `SHARED_SECRET`) entered on `/login`. Useful for
tunneling demos where you don't want to set up an OAuth app. Still issues
a session cookie. Rate-limited (5 attempts / 15 min / IP).

### `none`

Disables auth. **Only** honored when `HOST=127.0.0.1` *and* an explicit
`I_KNOW_THIS_IS_LOCAL=1` is set. Refuses to start otherwise.

## Session cookies

- Signed JWT (`HS256`) with `sub=<userId>`, `iat`, `exp`.
- Stored as `__Host-portal_session` (forces `Secure`, `Path=/`, no
  `Domain=`).
- Rotated on each successful auth.

## CSRF

- By default, mutating endpoints require a same-origin `Origin`/`Referer`
  header (SvelteKit's built-in check + an explicit check for the JSON API).
- The session cookie is `SameSite=Lax`, which blocks cross-site `POST` from
  classic forms and cross-site credentialed `fetch`.
- When `TUNNEL_HOST` is set, both origin checks are skipped — the request's
  `Host` won't match what the server thinks its origin is, so the checks
  would reject every request. SameSite=Lax cookies still apply. Front with
  an authenticating reverse proxy if you need stronger guarantees.

## Copilot token handling

The Copilot subscription auth used by the SDK is distinct from the portal's
login token.

Three strategies, configurable per user:

1. **Forward portal-issued GitHub OAuth token** — simplest; works if your
   OAuth app's user-to-server token has Copilot entitlement. The token is
   read from encrypted storage and injected into the SDK subprocess as
   `COPILOT_GITHUB_TOKEN` in its environment. Never logged, never echoed
   to the client.
2. **Pre-run `copilot auth login`** on the host — the SDK picks up the
   stored CLI credentials. The portal does no token handling. Best for
   single-user home installs.
3. **BYOK** — user pastes an OpenAI/Anthropic key in `/settings`; stored
   encrypted; forwarded as the appropriate env var. Limits model selection
   accordingly.

## Working-directory containment

- Conversations are pinned to a directory at creation; it cannot be changed
  after the first message. (Renaming via settings is a delete + recreate.)
- The portal enforces that the directory is within an allowlist
  (`DATA_DIR/workspaces/` by default, plus any explicit
  `ALLOWED_WORKDIRS` entries). Symlinks resolved with `realpath`; any
  resolution outside the allowlist is rejected.
- The Copilot CLI itself does additional containment within that directory;
  we don't try to second-guess it.

## Tool permissions

- Default policy: **prompt** for every tool call that mutates state or runs
  a shell command. Read-only tools (file reads, web fetches) can be set to
  auto-allow.
- "Allow always" decisions are scoped to a single conversation by default;
  promoting to "global allow" requires confirmation in settings.
- The full permission decision log is persisted (see
  [persistence.md](persistence.md)) and viewable in the conversation
  detail page.

## Content sanitization

- All markdown from the assistant is rendered client-side with `marked` →
  `DOMPurify` (see `src/lib/client/markdown.ts`). Assistant content is
  never injected into SSR HTML; the chat transcript is hydrated and
  rendered in the browser, where DOMPurify uses the real DOM.
- A strict default CSP is sent from `hooks.server.ts`:
  - `default-src 'self'`
  - `script-src 'self'` (no `unsafe-inline`; SvelteKit hashes inline scripts)
  - `style-src 'self' 'unsafe-inline'` (Svelte component styles)
  - `connect-src 'self'`
  - `img-src 'self' data:`
  - `frame-ancestors 'none'`

## Rate limiting

In-process token bucket per IP for unauthenticated endpoints (`/login`,
OAuth callback) and per session for authenticated endpoints. Defaults:

- `/login` POST: 5 / 15 min.
- Authenticated message send: 60 / minute.

## Logging

- Structured JSON logs to stdout.
- Auth tokens and message bodies are **never** logged at default level.
  At `LOG_LEVEL=debug`, message bodies are logged with a `[REDACTED]`
  placeholder for anything that matches a token-shaped regex.

## Cloudflare Tunnel considerations

When fronting with `cloudflared`:

- Run with Cloudflare Access in front (Zero Trust → Application policy
  restricting to your Google/GitHub identity). The portal then sees CF
  identity headers and *can* trust them (`CF-Access-Authenticated-User-Email`)
  — but we still require the portal's own session for defense in depth.
- Bind the SvelteKit listener to `127.0.0.1` so it's only reachable via the
  tunnel sidecar.
