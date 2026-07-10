# Yes Chef! Stage-1 — container image for the Synology NAS.
#
# Node 22 is required because the app uses Node's built-in node:sqlite (added in 22.5).
# Two stages: "build" compiles TypeScript to plain JS; "runtime" ships only the compiled
# output + production dependencies, so the image stays small and has no dev tooling.

# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
COPY test ./test
COPY public ./public
# Tests read only the frozen sample staples — copying just that file keeps the
# test/build layers cache-stable when the personal staples.json is edited.
COPY data/staples.sample.json ./data/staples.sample.json
# Gate the image on a green suite — a red test run fails the build, so a broken
# app can never ship to the NAS silently.
RUN npm test
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
# ffmpeg (audio extraction) + the prebuilt whisper-cli (prebuilt by
# scripts/whisper-build and placed in the build context as bin/whisper-cli,
# outside the deploy zip). These layers sit BEFORE any app-code COPY so code-only
# rebuilds never re-run the apt install. The ggml model is NOT baked in — it's
# volume-mounted from ./models (see docker-compose.yml).
# libgomp1: whisper-cli links libgomp.so.1 (OpenMP threading) which node:22-slim
# lacks — without it the binary exits 127 at load (verified in review).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY bin/whisper-cli /usr/local/bin/whisper-cli
ENV NODE_ENV=production
# Quiet the experimental-feature notice from node:sqlite.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
# The SQLite database lives here; this path is mounted to a NAS folder (see compose),
# so your data survives restarts and is covered by your NAS backups.
ENV YESCHEF_DB=/data/yeschef.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
COPY data ./data

EXPOSE 3000

# Simple healthcheck so Container Manager shows the app as healthy/unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/items').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# First-run bootstrap (migrate + seed only if the DB is empty), then start the server.
CMD ["sh", "-c", "node dist/bootstrap.js && node dist/server.js"]
