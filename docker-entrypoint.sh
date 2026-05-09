#!/bin/sh
# docker-entrypoint.sh — fix volume ownership, then drop to the bun user.
#
# Background: when /app/data is bind-mounted from the host, the volume's
# ownership is whatever the host filesystem says — typically root:root,
# while the container's `bun` user is uid=1000 and can't write there.
# The image-time `chown` in the Dockerfile is masked by the mount.
#
# This script (running as root) ensures /app/data exists, chowns it to
# bun:bun, then exec's the real CMD as bun via su-exec.
set -e

DATA_DIR="/app/data"

if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR"
fi

# Best-effort. Tolerate read-only mounts and noop on already-correct owners.
chown -R bun:bun "$DATA_DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  exec su-exec bun:bun "$@"
fi
exec "$@"
