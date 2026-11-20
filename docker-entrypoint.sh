#!/bin/sh
# Container entrypoint.
#
# The container starts as root only to make sure the data directory belongs to the "node" user (UID 1000),
# then runs the app as node. This fixes volumes and bind mounts that were created by root (an older image,
# or Docker creating a missing host folder), which would otherwise stop SQLite from opening its file.
#
# If the container is started as another user (user: 1000:1000 in Compose), the directory is only checked,
# and a clear message explains how to fix it.
set -e

data_dir="$(dirname "${SQLITE_PATH:-/data/stashly.sqlite}")"

if [ "$(id -u)" = "0" ]; then
    node_uid="$(id -u node)"
    mkdir -p "$data_dir"
    # Only walk the directory when its owner is wrong, so restarts stay fast
    if [ "$(stat -c %u "$data_dir")" != "$node_uid" ]; then
        echo "docker-entrypoint: giving node (UID $node_uid) ownership of $data_dir"
        chown -R node:node "$data_dir"
    fi
    exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

if [ ! -w "$data_dir" ]; then
    owner="$(stat -c '%u:%g' "$data_dir" 2>/dev/null || echo unknown)"
    echo "docker-entrypoint: $data_dir is not writable by UID $(id -u) (directory owner: $owner)."
    echo "  Fix it on the host (one time):  sudo chown -R $(id -u):$(id -g) <host folder mounted at $data_dir>"
    echo "  Or use a named volume, or start the container as root (the default) to fix ownership automatically."
    exit 1
fi

exec "$@"
