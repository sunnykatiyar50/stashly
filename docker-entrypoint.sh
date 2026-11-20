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

# Everything is lost when the container is recreated (every image update does that) unless the database
# folder is on a volume or bind mount. A relative or wrong SQLITE_PATH puts it in the container's own
# filesystem, so say so loudly instead of letting stashes vanish later. Set ALLOW_EPHEMERAL_DATA=true to
# silence this on purpose (throwaway containers).
warn_if_not_persistent() {
    [ "${ALLOW_EPHEMERAL_DATA:-}" = "true" ] && return 0
    mountinfo="${MOUNTINFO_FILE:-/proc/self/mountinfo}"   # MOUNTINFO_FILE lets tests supply a fake table
    [ -r "$mountinfo" ] || return 0
    dir="$(cd "$data_dir" 2>/dev/null && pwd -P)" || return 0

    # mountinfo fields: id parent major:minor root mount_point options ...
    # Find the deepest mount that contains the data directory, ignoring "/" and the system mounts.
    best=""
    best_root=""
    while read -r _ _ _ root mount_point _; do
        case "$mount_point" in
            / | /proc | /proc/* | /sys | /sys/* | /dev | /dev/*) continue ;;
        esac
        case "$dir" in
            "$mount_point" | "$mount_point"/*)
                if [ "${#mount_point}" -gt "${#best}" ]; then best="$mount_point"; best_root="$root"; fi
                ;;
        esac
    done < "$mountinfo"

    if [ -z "$best" ]; then
        echo "docker-entrypoint: WARNING: the database folder $dir is NOT on a volume or bind mount."
        echo "  Everything in it is deleted when the container is recreated, for example when you pull a new image."
        echo "  SQLITE_PATH is '${SQLITE_PATH:-}': leave it unset, or use /data/stashly.sqlite, and keep a volume on /data"
        echo "  (volumes: - stashly-data:/data). Set ALLOW_EPHEMERAL_DATA=true to hide this warning."
    elif printf '%s' "$best_root" | grep -Eq '/volumes/[0-9a-f]{64}/_data$'; then
        echo "docker-entrypoint: WARNING: $best is an anonymous Docker volume, which is easy to lose (docker compose down -v,"
        echo "  docker system prune --volumes, or creating the container again without the old volume)."
        echo "  Mount a named volume or a host folder on $best instead (volumes: - stashly-data:$best)."
    fi
    return 0
}

if [ "$(id -u)" = "0" ]; then
    node_uid="$(id -u node)"
    mkdir -p "$data_dir"
    # Only walk the directory when its owner is wrong, so restarts stay fast
    if [ "$(stat -c %u "$data_dir")" != "$node_uid" ]; then
        echo "docker-entrypoint: giving node (UID $node_uid) ownership of $data_dir"
        chown -R node:node "$data_dir"
    fi
    warn_if_not_persistent
    exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

if [ ! -w "$data_dir" ]; then
    owner="$(stat -c '%u:%g' "$data_dir" 2>/dev/null || echo unknown)"
    echo "docker-entrypoint: $data_dir is not writable by UID $(id -u) (directory owner: $owner)."
    echo "  Fix it on the host (one time):  sudo chown -R $(id -u):$(id -g) <host folder mounted at $data_dir>"
    echo "  Or use a named volume, or start the container as root (the default) to fix ownership automatically."
    exit 1
fi

warn_if_not_persistent
exec "$@"
