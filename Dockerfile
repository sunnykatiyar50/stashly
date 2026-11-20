FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/data/stashly.sqlite

# The database (notes and files) lives here: mount a volume to keep it across restarts
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/app.js"]
