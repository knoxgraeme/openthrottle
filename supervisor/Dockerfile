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
COPY contracts/package.json contracts/package-lock.json* ./contracts/
RUN npm ci --prefix contracts
COPY contracts/tsconfig.json contracts/tsconfig.build.json ./contracts/
COPY contracts/src ./contracts/src
RUN npm run build --prefix contracts
COPY supervisor/package.json supervisor/package-lock.json* ./supervisor/
RUN npm ci --prefix supervisor
COPY supervisor/tsconfig.json supervisor/tsconfig.build.json ./supervisor/
COPY supervisor/src ./supervisor/src
COPY supervisor/pipelines ./supervisor/pipelines
RUN npm run build --prefix supervisor
# Strip devDependencies (typescript, tsx, @types/*) from node_modules,
# leaving the built better-sqlite3 native binary intact for the runtime stage.
RUN npm prune --omit=dev --prefix supervisor

FROM node:22-slim AS runtime
WORKDIR /app/supervisor
ENV NODE_ENV=production
COPY --from=build /app/contracts/package.json /app/contracts/package.json
COPY --from=build /app/contracts/dist /app/contracts/dist
COPY --from=build /app/supervisor/package.json ./package.json
COPY --from=build /app/supervisor/node_modules ./node_modules
COPY --from=build /app/supervisor/dist ./dist
COPY --from=build /app/supervisor/pipelines ./pipelines

# /data is where the SQLite DB lives (see fly.toml [mounts] and DATABASE_PATH default).
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/index.js"]
