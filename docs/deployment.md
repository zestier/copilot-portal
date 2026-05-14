# 07 — Deployment

Target: a Linux host you control (home server, VPS, Raspberry Pi 5+, etc.),
fronted by a Cloudflare Tunnel for remote access.

## Build

```dockerfile
# Dockerfile

# ---- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime
# git is commonly invoked by the Copilot CLI's tools; include it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3000
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build"]
```

The Copilot CLI is bundled into `@github/copilot-sdk` for Node, so no
separate install step is needed at build time.

## Compose

```yaml
# compose.yaml
services:
  portal:
    build: .
    image: copilot-portal:latest
    restart: unless-stopped
    environment:
      HOST: 127.0.0.1            # only reachable via the tunnel
      PORT: 3000
      DATA_DIR: /data
      AUTH_MODE: github
      SESSION_SECRET: ${SESSION_SECRET:?required}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?required}
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:?required}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:?required}
      ALLOWED_GITHUB_LOGINS: ${ALLOWED_GITHUB_LOGINS:?required}
      LOG_LEVEL: info
    volumes:
      - ./data:/data
    network_mode: host          # so 127.0.0.1 is reachable by cloudflared
                                # (alternative: shared bridge + service name)

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?required}
    network_mode: host
    depends_on:
      - portal
```

Generating secrets:

```bash
export SESSION_SECRET=$(openssl rand -base64 48)
export ENCRYPTION_KEY=$(openssl rand -base64 32)
```

Store these in a `.env` file (gitignored). `compose.yaml` reads them via
the `${VAR:?required}` syntax so the stack refuses to start if any are
missing.

## GitHub OAuth App setup

1. Create an OAuth app at <https://github.com/settings/developers>.
2. Homepage URL: `https://copilot.example.com` (your tunnel hostname).
3. Authorization callback URL: `https://copilot.example.com/auth/callback`.
4. Copy client id / secret into `.env`.
5. (Optional) Require this app to be approved by your organization if you
   want org-scoped Copilot entitlement to flow through.

## Cloudflare Tunnel setup

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create tunnel.
2. Install method: Docker → copy the `TUNNEL_TOKEN`.
3. Public Hostname: `copilot.example.com` → Service `http://127.0.0.1:3000`.
4. (Strongly recommended) Zero Trust → Access → Applications → Self-hosted.
   Cover the same hostname; policy: "Emails are one of: you@example.com"
   with GitHub or Google identity provider.

With Access in front, the portal is doubly protected: CF gates at the
network edge, and the portal's own login still applies.

## Local development

```bash
cp .env.example .env             # fill in dev OAuth app values
npm ci
npm run dev                      # SvelteKit dev server on :5173
```

For dev, use a separate GitHub OAuth app pointing at
`http://127.0.0.1:5173/auth/callback`. Set `AUTH_MODE=shared-secret`
or `AUTH_MODE=none` (with `HOST=127.0.0.1` + `I_KNOW_THIS_IS_LOCAL=1`) for
faster iteration.

## Updates

- Image is versioned; `docker compose pull && docker compose up -d` for
  updates.
- Migrations run automatically on startup; DB schema is forward-only.
- Rolling back across a migration requires restoring a pre-update DB
  backup.

## Health and observability

- `GET /api/health` → `200 {"ok":true}` if DB reachable and migrations
  current (`{"ok":false,"error":"…"}` with status 503 on failure). Used by
  compose healthcheck and CF Tunnel.
- Logs to stdout as structured JSON. `docker logs -f portal` is sufficient
  for personal use; pipe to Loki/Vector if you have one.
- Metrics out of scope for v1.

## Resource expectations

- Idle: ~150 MB RAM, negligible CPU.
- Active session: +200–400 MB while the Copilot CLI subprocess is running.
- Per `MAX_CONCURRENT_SESSIONS=4` (default), budget ~1.5 GB peak RAM.
- Disk: DB grows with conversation history; expect tens of MB even after
  heavy use.
