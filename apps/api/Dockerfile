# One image serving both the API and the built frontend.
#
# Single-origin on purpose: the session cookie is SameSite=Lax, which a
# browser will not send cross-site. Splitting the frontend onto its own
# domain would force SameSite=None or a reverse proxy; this avoids both and
# removes CORS from the deployment entirely.

# ---------------------------------------------------------------- build web --
FROM node:22-slim AS web
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @voicequery/web --include-workspace-root

COPY packages/shared packages/shared
COPY apps/web apps/web
# Empty: the frontend calls /api on its own origin.
ENV VITE_API_BASE=""
RUN npm run build --workspace @voicequery/web

# ------------------------------------------------------------------ runtime --
# The API runs TypeScript directly through tsx, and DuckDB's native bindings
# must match the runtime, so there is no separate compile stage to strip.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @voicequery/api --include-workspace-root

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY --from=web /app/apps/web/dist apps/web/dist

# Dataset files live here; mount a persistent volume over it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The binary directly, not `npx`: if tsx were ever missing from the image
# npx would silently try to fetch it at boot, turning a packaging mistake
# into a slow mystery instead of an immediate, obvious failure.
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
