# Single-stage: the API runs TypeScript directly via tsx, and DuckDB's native
# bindings must match the runtime, so there is nothing useful to strip out.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install workspace dependencies using only the manifests first, so a source
# change does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @voicequery/api --include-workspace-root

COPY packages/shared packages/shared
COPY apps/api apps/api

# Dataset files live here; mount a volume over it in compose.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/api/src/server.ts"]
