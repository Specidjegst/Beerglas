# syntax=docker/dockerfile:1
#
# ZAPF ROYALE Game-Server (@zapf/server) — Multi-Stage-Build.
#
# WICHTIG: Build-Kontext ist der REPO-ROOT (pnpm-Workspace), nicht server/:
#
#   docker build -f server/Dockerfile -t zapf-server .
#
# Railway macht das automatisch richtig (railway.json: dockerfilePath =
# server/Dockerfile, Kontext = Repo-Root).
#
# Persistenz: DATA_DIR zeigt auf /app/data — dorthin ein Volume mounten,
# sonst gehen Lobbies, geheime Seeds und Join-Timestamps bei jedem
# Neustart/Redeploy verloren:
#
#   docker run -p 8787:8787 -v zapf-data:/app/data zapf-server

# ---------- Stage 1: Build ----------
FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /repo

# Erst nur die Manifeste -> Docker-Layer-Cache für die Dependencies.
COPY package.json pnpm-workspace.yaml ./
# Lockfile optional kopieren (Glob matcht 0 oder 1 Datei).
COPY pnpm-lock.yam[l] ./
COPY server/package.json server/package.json

RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --filter @zapf/server --frozen-lockfile; \
    else \
      pnpm install --filter @zapf/server; \
    fi

# Quellcode und Build (tsc -> dist/ + Kopie der IDL nach dist/chain/idl.json).
COPY server/ server/
RUN pnpm --filter @zapf/server build

# Standalone-Paket nach /out: package.json + dist/ + NUR Prod-Dependencies.
# (--legacy für pnpm >= 10; ältere pnpm-Versionen kennen das Flag nicht,
# dort greift der Fallback ohne --legacy.)
RUN pnpm --filter @zapf/server deploy --prod --legacy /out \
 || pnpm --filter @zapf/server deploy --prod /out

# ---------- Stage 2: Runtime ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

WORKDIR /app

# Non-root: das node-Image bringt bereits den User "node" (uid 1000) mit.
COPY --from=build --chown=node:node /out /app
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8787

# /app/data = JSON-Persistenz (DATA_DIR) — als Volume mounten (s. Kopf der Datei).
CMD ["node", "dist/index.js"]
