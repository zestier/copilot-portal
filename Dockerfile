# syntax=docker/dockerfile:1.7

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install build deps for better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack.
RUN corepack enable

COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build && pnpm prune --prod

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime

# git is commonly invoked by Copilot's tools; tini for clean shutdown.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
# Migrations are read from disk at runtime.
COPY --from=build /app/src/lib/server/db/migrations ./src/lib/server/db/migrations

VOLUME ["/data"]
EXPOSE 3000
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/api/health || exit 1
