# syntax=docker/dockerfile:1

# ---- Base: shared toolchain for native modules (better-sqlite3 / node-gyp) ----
FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

# ---- Dependencies: full install (incl. dev) against the lockfile ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- Development: hot reload, source bind-mounted by compose.dev.yml ----
FROM deps AS development
ENV NODE_ENV=development \
    PORT=3000 \
    DATABASE_PATH=/app/data/timeoff.sqlite
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ---- Build: compile TypeScript, then drop dev deps (keeps compiled native addons) ----
FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Runtime: minimal production image ----
FROM node:24-alpine AS runtime
WORKDIR /app
# libstdc++ is required at runtime by the compiled better-sqlite3 addon
RUN apk add --no-cache libstdc++
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/timeoff.sqlite
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# SQLite data dir, owned by the unprivileged node user
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/" >/dev/null 2>&1 || exit 1
CMD ["node", "dist/main.js"]
