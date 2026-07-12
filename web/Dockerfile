# syntax=docker/dockerfile:1
#
# ZAPF ROYALE Frontend (@zapf/web) — Multi-Stage-Build (Next.js standalone).
#
# WICHTIG: Build-Kontext ist der REPO-ROOT (pnpm-Workspace), nicht web/:
#
#   docker build -f web/Dockerfile -t zapf-web .
#
# Railway macht das automatisch richtig (web/railway.json: dockerfilePath =
# web/Dockerfile, Kontext = Repo-Root).
#
# NEXT_PUBLIC_*-Variablen werden von Next.js zur BUILD-Zeit ins Bundle
# eingebacken. Railway reicht Service-Variablen als Build-Args durch,
# sofern sie hier als ARG deklariert sind — nach einer Änderung dieser
# Variablen ist also ein Redeploy (Rebuild) nötig.

# ---------- Stage 1: Build ----------
FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /repo

ARG NEXT_PUBLIC_SERVER_URL=http://localhost:8787
ARG NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
ARG NEXT_PUBLIC_PROGRAM_ID=11111111111111111111111111111111
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL \
    NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_PROGRAM_ID=$NEXT_PUBLIC_PROGRAM_ID \
    NEXT_STANDALONE=1 \
    NEXT_TELEMETRY_DISABLED=1

# Erst nur die Manifeste -> Docker-Layer-Cache für die Dependencies.
COPY package.json pnpm-workspace.yaml ./
# Lockfile optional kopieren (Glob matcht 0 oder 1 Datei).
COPY pnpm-lock.yam[l] ./
COPY web/package.json web/package.json

RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --filter @zapf/web --frozen-lockfile; \
    else \
      pnpm install --filter @zapf/web; \
    fi

# Quellcode und Build (output: "standalone" in next.config.mjs).
COPY web/ web/
RUN mkdir -p web/public && pnpm --filter @zapf/web build

# ---------- Stage 2: Runtime ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Standalone-Output spiegelt den Workspace-Root (outputFileTracingRoot):
# /app/web/server.js + minimal benötigte node_modules.
COPY --from=build --chown=node:node /repo/web/.next/standalone /app
COPY --from=build --chown=node:node /repo/web/.next/static /app/web/.next/static
COPY --from=build --chown=node:node /repo/web/public /app/web/public

USER node

EXPOSE 3000

CMD ["node", "web/server.js"]
