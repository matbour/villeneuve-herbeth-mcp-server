# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# OCR + PDF tooling for the bulk-annotate / OCR pipeline:
#   - ocrmypdf wraps tesseract to produce searchable PDFs from scans
#   - tesseract-ocr-data-fra adds the French language model
#   - poppler-utils provides pdftotext / pdfinfo / pdftoppm
#   - qpdf is used to split multi-document PDFs page-range by page-range
#   - ghostscript is required by ocrmypdf for PDF/A output
RUN apk add --no-cache \
    ocrmypdf \
    tesseract-ocr-data-fra \
    tesseract-ocr-data-eng \
    poppler-utils \
    qpdf \
    ghostscript \
    unpaper
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000 \
    MCP_DOWNLOAD_RETURN_BASE64=1 \
    HERBETH_METADATA_DB=/app/data/metadata.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Mount this as a persistent volume to keep curated metadata across deploys.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Coolify-friendly healthcheck — hits /health, no auth required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1 || exit 1

USER bun
CMD ["bun", "run", "src/index.ts"]
