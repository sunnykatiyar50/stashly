FROM node:26-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# The entrypoint makes sure the data directory belongs to the node user, then runs the app as node.
# Stripping \r keeps it working when the file was checked out on Windows with CRLF line endings.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/data/stashly.sqlite

# The database (notes and files) lives here: mount a volume to keep it across restarts
RUN mkdir -p /data && chown node:node /data
VOLUME /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Starts as root only for the ownership fix; the app itself always runs as node (UID 1000)
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/app.js"]
