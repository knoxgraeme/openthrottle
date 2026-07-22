# Multi-stage build per docs/SPEC.md "Supervisor contract > Fly":
#   node:22-slim, tsc build, CMD node dist/index.js
#
# better-sqlite3 ships prebuilt native binaries for common platforms, but we
# install build-essential/python3 as a fallback in case prebuild-install
# can't find a match for the target platform and falls back to node-gyp.

FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY pipelines ./pipelines
RUN npm run build
# Strip devDependencies (typescript, tsx, @types/*) from node_modules,
# leaving the built better-sqlite3 native binary intact for the runtime stage.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/pipelines ./pipelines

# /data is where the SQLite DB lives (see fly.toml [mounts] and DATABASE_PATH default).
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/index.js"]
