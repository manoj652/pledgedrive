FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PLEDGEDRIVE_HOST=0.0.0.0 \
    PLEDGEDRIVE_PORT=8787 \
    PLEDGEDRIVE_WEB_ROOT=/app/dist/apps/web/public \
    PLEDGEDRIVE_STATE_FILE=/app/data/state.json

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN addgroup -S pledgedrive && adduser -S -G pledgedrive pledgedrive \
  && mkdir -p /app/data \
  && chown -R pledgedrive:pledgedrive /app

USER pledgedrive
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/services/api/src/server.js"]
