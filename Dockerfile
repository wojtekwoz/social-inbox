# syntax=docker/dockerfile:1
# Small single-container build: Node 22 LTS on Alpine, SQLite on a volume.

FROM node:22-alpine AS build
WORKDIR /app
# Toolchain only in the build stage, in case better-sqlite3 has no prebuilt binary for this platform.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/inbox.db \
    NODE_OPTIONS="--max-old-space-size=96"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data \
 && ln -s /app/dist/cli/index.js /usr/local/bin/sinbox && chmod +x /app/dist/cli/index.js
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "dist/main.js"]
