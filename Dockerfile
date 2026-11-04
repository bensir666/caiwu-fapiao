# ---- build the web pages ----
FROM node:22-bookworm-slim AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- install server dependencies (better-sqlite3 is native; build tools are the fallback if no prebuilt binary) ----
FROM node:22-bookworm-slim AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SQLITE_BINARY_MIRROR=
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN export npm_config_better_sqlite3_binary_host_mirror=$SQLITE_BINARY_MIRROR; \
    npm ci --omit=dev --registry=$NPM_REGISTRY --no-audit --no-fund \
    || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
        && npm ci --omit=dev --registry=$NPM_REGISTRY --no-audit --no-fund --build-from-source)

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_DIR=/app/web TZ=Asia/Shanghai
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/assets ./assets
COPY --from=web /web/dist ./web
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
