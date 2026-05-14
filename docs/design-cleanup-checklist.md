# Design cleanup checklist

Tracking list of design inconsistencies surfaced by the 2026-05-14 review.
Work top to bottom; tick items as they land. The **last** item removes this file.

Each entry links to the relevant call sites — see the original review for
the suggested unified convention.

---

## High impact

- [ ] **1. Honor per-conversation `workdir`.** Use the `workdir` returned by
      `authorizeConversation` instead of `workspaceRoot()` in every fs/git
      route, or delete the field and document the single-workspace model.
  - `src/lib/server/conversation-auth.ts`
  - `src/routes/api/conversations/[id]/{fs,git}/**/+server.ts`
  - `docs/architecture.md` (claims workdir-scoped sessions)

- [ ] **2. Standardize JSON response envelopes.** Pick one convention for
      collections (`{items}` vs bare array vs `{data}`) and one for mutation
      results (`{ok:true,…}`), apply across all `/api/*` routes.
  - Wrapped: `…/conversations/+server.ts`, `…/forks/+server.ts`,
    `…/git/log/+server.ts`, `…/git/changes/+server.ts`
  - Bare: `…/git/status/+server.ts`, `…/git/commit/[commitSha]/+server.ts`,
    `…/copilot/status/+server.ts`, `…/fs/file/+server.ts`,
    `…/fs/tree/+server.ts`
  - Mutations: `…/conversations/[id]/+server.ts`,
    `…/permissions/[requestId]/+server.ts`, `…/messages/+server.ts`,
    `…/messages/[messageId]/fork/+server.ts`, `…/health/+server.ts`

- [ ] **3. Unify error body shapes.** Funnel auth/origin/rate-limit
      rejections through `error(...)` (or a small `apiError(status, code)`
      helper) so every `/api/*` response is JSON `{message, code}`.
      Standardize form-action results on `{ok, error?}`.
  - `src/hooks.server.ts` (plain-text 401/403/429)
  - `src/routes/auth/callback/+server.ts` (plain-text 400/403/502)
  - `src/routes/login/+page.server.ts` vs `src/routes/settings/+page.server.ts`

- [x] **4. Convert Zod errors to 400s.** Replace `Body.parse(...)` with
      `safeParse` (or a wrapper that throws `error(400, …)`) in every API
      route. Currently all bad payloads surface as 500 "Internal server error".
  - `src/routes/api/conversations/+server.ts`
  - `src/routes/api/conversations/[id]/+server.ts`
  - `src/routes/api/conversations/[id]/messages/+server.ts`
  - `src/routes/api/conversations/[id]/permissions/[requestId]/+server.ts`
  - `src/routes/api/conversations/[id]/messages/[messageId]/fork/+server.ts`

- [ ] **5. One auth/ownership idiom.** Extend `authorizeConversation` to
      optionally return the full conversation row and use it from every
      route. Remove the hand-rolled `userId / convs.get / 404` blocks.
  - All routes under `src/routes/api/conversations/[id]/**/+server.ts`

- [ ] **6. Single-shot conversation creation.** Compute the workdir before
      `convs.create(...)` (or add `convs.setWorkdir`) so the route stops doing
      a placeholder INSERT + raw UPDATE with a dynamic db import.
  - `src/routes/api/conversations/+server.ts`
  - `src/lib/server/conversation-auth.ts` (drop the compensating workdir check)
  - `src/lib/server/db/repos/conversations.ts`

## Bugs

- [x] **7. Reset `redeploy` `inFlight` in `finally`.** On the success path the
      flag is only cleared by `process.exit(0)`; if the supervisor isn't
      running, every later POST is stuck on 409.
  - `src/routes/api/admin/redeploy/+server.ts`

## Medium impact

- [ ] **8. Route `redeploy` through the shared SSE helper.** Extend
      `sseResponse` to accept arbitrary JSON event payloads so the redeploy
      endpoint gets heartbeats and shares the encoding contract.
  - `src/lib/server/sse.ts`
  - `src/routes/api/admin/redeploy/+server.ts`

- [ ] **9. Standardize repo semantics.** Decide on `getX → X | null`,
      `getOrCreateX → X` (no synthetic-default variants), and a uniform
      return shape for mutators (boolean "changed?" vs void).
  - `src/lib/server/db/repos/{conversations,messages,settings,tokens,usage,users}.ts`

- [ ] **10. Hoist API response types and dedupe the `aggregate` reducers.**
      Move `ChangeEntry` / `AggregatedStatus` and the two `aggregate(StatusEntry)`
      functions into `src/lib/server/git.ts` (single function with an
      `{includeIgnored}` option). Public shapes belong in `src/lib/types.ts`.
  - `src/routes/api/conversations/[id]/git/changes/+server.ts`
  - `src/routes/api/conversations/[id]/fs/tree/+server.ts`

- [x] **11. Centralize env access.** Add `TUNNEL_HOST`, `COPILOT_STUB`, and
      `DB_MIGRATIONS_DIR` to the zod schema in `config.ts` so `loadConfig()`
      stays the only env reader.
  - `src/lib/server/config.ts`
  - `src/hooks.server.ts`
  - `src/lib/server/copilot/bridge-stub.ts`
  - `src/lib/server/db/index.ts`

- [ ] **12. Drop redundant `locals.userId` checks in API handlers.** The
      hooks gate already 401s `/api/*` for unauthenticated requests; either
      remove the per-handler checks (and type `locals.userId` as `string`)
      or align the hooks error shape with `error(401)`'s JSON body.
  - `src/hooks.server.ts`
  - All `src/routes/api/**/+server.ts` files

- [x] **13. Reconcile permission-decision vocabulary with docs.** Code uses
      `allow-once | allow-always | deny`; update `docs/architecture.md` and
      `docs/backend-sdk-integration.md` (or change the code — code is right).
  - `src/lib/types.ts`
  - `src/routes/api/conversations/[id]/permissions/[requestId]/+server.ts`
  - `docs/architecture.md`, `docs/backend-sdk-integration.md`

## Low impact

- [x] **14. Spell out route param names.** `[reqId]` → `[requestId]`,
      `[sha]` → `[commitSha]`; align with `[messageId]`.
  - `src/routes/api/conversations/[id]/permissions/[requestId]/+server.ts`
  - `src/routes/api/conversations/[id]/git/commit/[commitSha]/+server.ts`

- [x] **15. Fix docs drift.** Either implement `GET /api/export` or mark it
      roadmap-only in `docs/persistence.md`. Add a short "admin" section
      describing the `redeploy` and `permissions/[requestId]` endpoints.
  - `docs/persistence.md`

## Cleanup

- [ ] **16. Remove this checklist file** (`docs/design-cleanup-checklist.md`)
      and the entry for it in `docs/` once items 1–15 are complete.
