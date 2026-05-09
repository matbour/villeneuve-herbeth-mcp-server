#!/bin/sh
# docker-entrypoint.sh — make /app/data writable, then run the server.
#
# We run as root inside the container. Coolify (and most Docker orchestrators)
# bind-mount /app/data from a host path that's typically root-owned, so
# trying to drop to an unprivileged user inside the container fails to
# write the SQLite file. Running as root sidesteps the volume-ownership
# question entirely. The image is single-tenant (one MCP server per
# container) so the security trade-off is small.
set -e

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR"

# Best-effort: ensure something inside the dir is writable in case some
# orchestrator puts a non-root file in there at startup.
chmod -R u+rwX "$DATA_DIR" 2>/dev/null || true

exec "$@"
