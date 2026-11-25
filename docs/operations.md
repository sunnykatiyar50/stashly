# Running a server: logs, metrics and security

For the person who runs Stashly. See the [README](../README.md) for the short version.

## Operating Stashly: logs and metrics

Three things help you run a server. All are off by default, and none of them ever carries a **stash name, password, token, cookie, note text, file name or query string**: a stash name is the only secret of a stash without a password, so the logs name a stash by a short keyed hash instead (see below).

| Variable | Default | Meaning |
|---|---|---|
| `LOG_FORMAT` | `off` | `json` writes one JSON line to stdout for each finished request |
| `AUDIT_LOG` | `off` | `stdout` writes one JSON line for each change of who can reach what |
| `METRICS_TOKEN` | empty | Turns on `GET /metrics` (Prometheus text format); callers must send `Authorization: Bearer <token>`. Use a long random value |

**Access log** (`LOG_FORMAT=json`): `{"time","level":"info","msg":"request","method","route","status","ms","ip","stash","role","bytes"}`. `route` is the route *pattern* (`/api/stashes/:slug/notes`), never the real path; a request no route answered is `unmatched`, and the page's own files are `static`. `stash` is the first 10 hex characters of an HMAC-SHA-256 of the name keyed with the server's secret, so lines about one stash can be matched with each other, but the name cannot be read from them (the secret is kept in the database or set with `SESSION_SECRET`, so tags stay the same across restarts). `role` is `full`, `view`, `drop` or `none` when a stash was involved. `bytes` is the response's Content-Length when it has one. A live stream is logged when it ends. `/health` and `/metrics` are not logged.

**Audit log** (`AUDIT_LOG=stdout`): `{"time","level":"audit","event","ip","stash","actor","detail"}` with `actor` `visitor`, `admin` or `system` (expiry). Events: `stash.created`, `stash.deleted` (`detail.reason`: visitor, admin or expired), `stash.renamed` (hashes of the old and new name), `stash.password_changed`, `stash.password_reset_by_admin`, `stash.sessions_signed_out`, `stash.share_link_created` / `stash.share_link_revoked` (the kind only), `stash.extended` (`detail.by` `owner` or `visitor`, `detail.ttl`) / `stash.extended_by_admin`, `stash.owner_set_by_admin` / `stash.ownership_transferred` (`detail.user` / `detail.to`: the new owner's number), `stash.unlock_failed` (every wrong password, with the address), `stash.locked_out` (when the lockout trips), `item.deleted` / `item.restored` (the kind only), `item.share_created` (`detail.expires`) / `item.share_revoked` (a link to one clip), `admin.mcp_token_created` / `admin.mcp_token_revoked`, `mcp.tool_called` (`actor` `mcp`; `detail.tool` and `detail.failed`, never the arguments), `stash.exported`, `admin.login_succeeded`, `admin.login_failed`, `admin.logout`, `admin.settings_changed` (the settings that changed and their new values; none is a secret) and `admin.backup_downloaded`. Accounts add `user.login_succeeded`, `user.login_failed` (also a wrong current password when changing it), `user.locked_out`, `user.logout`, `user.password_changed`, `user.followed` (with the stash's hash; `detail.via` is `create` when it came from creating the stash) and `user.unfollowed`, with `actor` `user` or `visitor`, and `user.created`, `user.updated` (only the names of the changed fields), `user.password_reset`, `user.signed_out` and `user.deleted`, done by an admin. A user is identified by number in `detail.user`; no line carries a username, display name, password or session token, and an unknown name in a failed sign-in is not recorded at all. Send stdout to your log collector; Docker keeps it for `docker logs`.

**Metrics** (`METRICS_TOKEN` set): `stashly_http_requests_total{method,route,status_class}`, `stashly_http_request_duration_seconds` (histogram by route), `stashly_stashes`, `stashly_items{kind}`, `stashly_stored_bytes`, `stashly_trashed_items`, `stashly_sse_connections`, `stashly_unlock_failures_total`, `stashly_uploads_total`, `stashly_uploaded_bytes_total`, `stashly_exports_total`, `stashly_admin_logins_total{result}`, `stashly_user_logins_total{result}`, `stashly_users{role}`, `stashly_build_info{version}`, `stashly_process_start_time_seconds` and the process memory. Labels are route patterns and fixed words only, so a new stash never adds a series. Counters start from zero at every restart. A Prometheus job:

```yaml
scrape_configs:
  - job_name: stashly
    authorization: { type: Bearer, credentials: "<METRICS_TOKEN>" }
    static_configs: [{ targets: ["stashly:3000"] }]
```

Without `METRICS_TOKEN` the address answers 404. Keep `/metrics` and the logs off the public internet where you can: the numbers say how much is stored and how busy the server is.

## Security notes

- The stash name is the "key". Random 12-character names can't be guessed; short custom names can, so add a password for anything private.
- A backup (Admin > Download backup) contains the password hashes and the session secret as well as all content, unencrypted. Treat it like the server's disk.
- Passwords protect access. Content is stored unencrypted, notes in the SQLite file and uploaded files in the `files` folder next to it, so protect the server and its disk.
- Deleted notes and files (burned, expired, trimmed or deleted) and the old text of edited notes are overwritten in the database file (`secure_delete`) and the write-ahead log is emptied afterwards, and an uploaded file is overwritten with zeros before it is removed from the `files` folder, so they can't be read back from disk. Copies already in backups are not affected. **One exception, on purpose: undoable deletes.** When a person deletes a note or file and undo is on (`UNDO_SECONDS`, 120 by default), the item stays in the database (and the file on disk, unchanged) for that long, so it can still be read from the database file, from a backup made in that time, and by anyone with disk access, until the trash is purged; then it is removed with the same secure delete. Burn-after-reading and secret notes, trimmed and expired items and deleted stashes never wait: they are removed at once. Set `UNDO_SECONDS=0` to have every delete immediate and secure.
- The admin can reset the password of a stash that has no owner (a guest made it) and so get into it, but not of a stash a signed-in user owns; the stash shows when it happened, and `ADMIN_CAN_RESET_STASH_PASSWORDS=false` removes the reset altogether; use a long random `ADMIN_PASSWORD` (the server logs a warning below 12 characters). The admin account's name is easy to guess (`admin` by default), so rely on the long password: the per-username lockout and the rate limits protect it like any other account.
- Notes are shown as plain text (never as HTML). Strict CSP, `Cache-Control: no-store`, `noindex`, no referrer.
- Rate limits per IP on creating stashes, posting, uploading and wrong passwords. Behind a reverse proxy set `TRUST_PROXY=1` (`true` means the same: one proxy).
- No virus scanning of uploads. Treat it as a personal or team tool, not a public file host.
- Run it behind HTTPS if it leaves your LAN. On plain HTTP the cookie still works, but "Copy image" is unavailable (browsers only allow it on secure pages); text copy has a fallback.
