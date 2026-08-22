# Phoenixx OS — one image serving the API and the web app.
#
# Render's node runtime does not need this; it is here for a VPS, Cloud Run, or
# anywhere that wants a reproducible build. Build from the phoenixx-os folder:
#   docker build -t phoenixx-os .
#   docker run -p 4010:4010 -v phoenixx-data:/data \
#     -e JWT_ACCESS_SECRET=... -e JWT_REFRESH_SECRET=... phoenixx-os

# node:sqlite ships with Node itself, so there is nothing to compile and the
# slim image is enough. The app requires 22.13+.
FROM node:22.13-slim AS build
WORKDIR /app

# Dependencies first: this layer is reused whenever only source files change.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22.13-slim
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only; the web app is already built bytes by now.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev --workspace server --include-workspace-root

COPY server ./server
COPY --from=build /app/web/dist ./web/dist

# The database and generated PDFs live on a volume, not in the image.
ENV SERVE_WEB=true \
    DB_FILE=/data/phoenixx.db \
    STORAGE_DIR=/data/storage \
    PORT=4010
VOLUME /data
EXPOSE 4010

# Run unprivileged: the node image ships a `node` user for exactly this.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4010)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
