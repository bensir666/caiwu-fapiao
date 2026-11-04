#!/bin/sh
# The data folder is usually a bind mount created by root on the host: hand it to the unprivileged node user, then drop root.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec runuser -u node -- "$@"
fi
exec "$@"
