# syntax=docker/dockerfile:1
#
# Official FLUJO image (issue #57). Multi-stage build on Debian slim.
#
# Alpine is deliberately avoided: onnxruntime-node (an optional transitive dep)
# ships no musl builds, and several MCP servers assume glibc.
#
# The runtime image includes the toolchains FLUJO needs to install & run MCP
# servers on demand: git (Marketplace clones), python3 + uv/uvx (Python servers),
# and Node (npx-based servers). Node-based servers use npm's cache under $HOME,
# which is why HOME points at a writable, owned directory.

# ---- Builder --------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install deps first (better layer caching) using the full dependency set so the
# production build has its build-time tooling (typescript, webpack, etc.).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Build the Next.js production output.
COPY . .
RUN npm run build

# ---- Runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    # Mark the install so /api/update reports "pull a new image" instead of a
    # broken in-app git updater (see src/utils/paths.ts + api/update/route.ts).
    FLUJO_CONTAINER=1

# Runtime toolchains for on-demand MCP server installation/execution:
#  - git: Marketplace/manual server clones
#  - python3 + venv: Python-based servers
#  - ca-certificates: TLS for clones/fetches (works with --use-system-ca)
#  - curl: uv installer + container HEALTHCHECK
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        python3 \
        python3-venv \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv/uvx (Python package runner used by many MCP servers) onto PATH.
RUN curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version && uvx --version

# Bring in the built app + production dependencies.
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/scripts ./scripts

# User data lives under the working dir (db/, mcp-servers/) and is mounted as
# named volumes by docker-compose. Create + own them so the non-root user can
# write. HOME must be writable for npm's cache when installing npx-based servers.
ENV HOME=/home/node
RUN mkdir -p /app/db /app/mcp-servers /home/node/.npm \
    && chown -R node:node /app/db /app/mcp-servers /home/node

USER node

EXPOSE 4200

# /api/cwd is a side-effect-free GET (returns the resolved paths), so it is a
# safe readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
    CMD curl -fsS http://127.0.0.1:4200/api/cwd || exit 1

# Go through the launcher so the same TLS/CA handling as `npm start` applies.
# -H 0.0.0.0 makes the server reachable from outside the container.
CMD ["node", "scripts/launch-next.mjs", "start", "-p", "4200", "-H", "0.0.0.0"]
