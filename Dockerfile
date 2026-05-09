# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# Runtime image is intentionally minimal: just Bun + the MCP server.
# OCR / PDF tools (ocrmypdf, tesseract, poppler-utils, qpdf, ghostscript,
# unpaper) are only needed by the operator pipeline under scripts/, which
# runs outside the deployed container. If you ever want to run the
# pipeline inside Docker, install them in a dedicated build stage or use
# `oven/bun:1.3-debian` and `apt-get install ocrmypdf qpdf …`.

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000 \
    MCP_DOWNLOAD_RETURN_BASE64=1 \
    HERBETH_METADATA_DB=/app/data/metadata.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Persistent volume for the curated metadata DB.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Coolify-friendly healthcheck — hits /health, no auth required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1 || exit 1

# Run as root. A bind-mounted /app/data on the host is typically root-owned
# and any in-container `chown bun` is silently ignored by the host's
# overlay/rootless mapping, breaking SQLite writes. Single-tenant container
# → root is fine.
USER root
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
