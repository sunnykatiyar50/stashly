# API

Everything the web page does goes through this API, so scripts can do it too. See the [README](../README.md) for the short version.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/stashes` | `{slug, password?, ttl}` creates a stash |
| GET | `/api/stashes/suggest` | a fresh random name |
| GET | `/api/stashes/:slug` | the stash and its items (`search`, `startDate`, `endDate`, `tz`; `limit` for only 1-200 items and `offset` (0 or more) to skip that many first, to read a long list in pages; `total` still counts every match and `hasMore` says whether items remain after this page; a bad `limit` or `offset` is a `400`) |
| POST | `/api/stashes/:slug/query` | the same, with those fields in the body so search words stay out of addresses |
| GET | `/api/stashes/:slug/items/:id` | one item in full (a note's whole text) |

Add `preview` (`true` in the body, or `?preview=1`) to a listing and notes longer than 2000 characters come back cut to their first 2000, with `truncated: true` and `textLength`; fetch the rest from `items/:id`. The web page does this so a stash of large notes loads quickly. Without `preview`, text is always complete.
| POST | `/api/stashes/:slug/unlock` | `{password}` sets the cookie |
| POST | `/api/stashes/:slug/notes` | `{title?, text}` (or a plain-text body, which gets an automatic title) |
| POST | `/api/stashes/:slug/files` | raw body, `X-File-Name` header, optional `X-Title` header (both URI-encoded) |
| PUT | `/api/stashes/:slug/items/:id` | a note: `{title?, text}`; a file: `{title}` (empty goes back to the file name). Optional `baseEditedAt` (the item's `editedAt` you started from, `null` if never edited): if the item was edited since, nothing changes and the answer is `409 { error, conflict: true, item }` with the current item in full. Leave it out to skip the check (last write wins) |
| PUT | `/api/stashes/:slug/content` | `{content: "all" \| "notes" \| "files"}` what the stash takes (full access only) |
| POST | `/api/stashes/:slug/uploads` | start a resumable upload: `{name, size, title?}`. Runs every check a single upload does that needs no bytes (role, stash content kind, size, quotas, name, blocked extension) and answers `201 {id, offset: 0, size, chunkSize}` with a `Location`. See **Resumable uploads** |
| GET, HEAD | `/api/stashes/:slug/uploads/:id` | where the upload stands: `{id, offset, size, chunkSize}` (HEAD: the `Upload-Offset` header only) |
| PATCH | `/api/stashes/:slug/uploads/:id` | send one piece: header `Upload-Offset` (must equal the current offset, else `409` with the right one), the raw bytes as the body (at most `chunkSize`: `413`). Answers `200 {offset, ...}` |
| POST | `/api/stashes/:slug/uploads/:id/complete` | finish (only when `offset == size`, else `409`): checks the content type and the limits again and answers `201` with the item, exactly like a single upload |
| DELETE | `/api/stashes/:slug/uploads/:id` | cancel an unfinished upload and remove what it received (`204`) |
| GET | `/api/stashes/:slug/files/:id` | the file (`?download=1` to force a download) |
| GET | `/api/stashes/:slug/files/:id/thumb` | an image's thumbnail (full and read-only access; `404` when it has none). Served inline with `nosniff`, a sandboxing CSP and `no-store`; an item's `thumbUrl` is this address, or `null` |
| PUT | `/api/stashes/:slug/files/:id/thumb` | attach or replace an image's thumbnail: the body is the raw JPEG, PNG or WebP bytes (any Content-Type; at most `MAX_THUMB_KB`: `413`; not an image of those types: `415`; the item is not an image: `400`). Full access any time; a drop-box link only while the image has none and is under 5 minutes old (`403` otherwise). Answers the item, and other pages are sent `item-updated` |
| GET | `/api/stashes/:slug/latest` | newest note as plain text; if it is burn-after-reading, answers 409 and leaves it alone |
| POST | `/api/stashes/:slug/latest` | the same, but a burn-after-reading note is returned and deleted (full access only) |
| DELETE | `/api/stashes/:slug/items/:id` | delete a note or file (full access). Answers `{ ok: true, undoUntil }`: until when it can be restored (an ISO time), or `null` when it is gone for good (undo off, or a burn-after-reading or secret note) |
| POST | `/api/stashes/:slug/items/:id/restore` | undo a delete (full access): puts the item back with its id, place and pin; 404 if it is not in the trash or the undo time has passed; 413 or 507 if the stash limits no longer allow it |
| POST | `/api/stashes/:slug/extend` | restart the expiry timer |
| DELETE | `/api/stashes/:slug` | delete the stash |
| GET | `/api/stashes/:slug/export` | the whole stash as `<slug>.zip` (full and read-only access; burn-after-reading notes are left out) |
| GET | `/api/stashes/:slug/events` | live stream |
| GET | `/health`, `/api/config` | liveness; expiry options and limits |
| GET | `/metrics` | Prometheus metrics; only when `METRICS_TOKEN` is set, with `Authorization: Bearer <token>` |
| GET | `/api/admin/backup` | admin only: the database snapshot and all files as one zip |
| POST | `/api/auth/login` | `{username, password}` signs a user in (sets `stashly_user`); one generic `401` for every failure, `429` when locked out. `404` when accounts are off |
| POST | `/api/auth/logout` | signs this browser out |
| GET | `/api/me` | `{ enabled, user: {id, username, displayName, role, managed} \| null }`, `200` either way (`{ enabled: false }` when accounts are off) |
| POST | `/api/me/password` | `{currentPassword, newPassword}`: changes your own password, signs out your other sessions |
| GET | `/api/me/stashes` | the stashes you follow with counts and `newItems`; a stash whose grant ended shows only `slug`, `role: null`, `needsPassword: true`, `addedAt` |
| POST | `/api/me/stashes` | follow: `{slug, password?, link?}` (a link is the token or the whole address; `{slug, current: true}` follows with the access this browser already has). `401 {locked: true}` for a wrong or missing password, counted by the unlock lockout; a drop-box link is `400` |
| DELETE | `/api/me/stashes/:slug` | unfollow (the stash is untouched) |
| POST | `/api/me/stashes/:slug/seen` | mark a followed stash as seen now (resets its new count) |
| GET | `/api/admin/users` | admin: every user with role, status, `managed` (true for the environment account, which no call below can change: `409`), last sign-in and number of followed stashes (never a password or hash) |
| POST | `/api/admin/users` | admin: `{username, displayName?, password, role?}` (`role` is `admin` or `user`, default `user`); the answer never echoes the password |
| PATCH | `/api/admin/users/:id` | admin: `{role?, disabled?, displayName?}`; a role change or disable ends the user's sessions; refused (`400`) for your own role or status |
| POST | `/api/admin/users/:id/password` | admin: `{password}` resets it and ends every session of that user |
| POST | `/api/admin/users/:id/sign-out` | admin: ends every session of that user |
| DELETE | `/api/admin/users/:id` | admin: deletes the user and their follows (not their stashes); refused for your own account |

### Resumable uploads

A file bigger than 8 MB is sent in 4 MB pieces, so a flaky connection costs one piece instead of the whole file, the page can show real progress, and an upload carries on after the browser is closed or the server restarts. The page and `stashly send --file` do this by themselves; the protocol is small and works from curl too:

```bash
# 1. start: the server checks the name, type, size and quotas now, before any byte is sent
curl -s -X POST http://HOST:3000/api/stashes/NAME/uploads -H "Content-Type: application/json" \
     -d '{"name":"big.zip","size":12345678,"title":"Optional title"}'
#    -> 201 {"id":"<secret>","offset":0,"size":12345678,"chunkSize":4194304}
# 2. send the pieces, each at the offset the server expects (here with split: 4 MB each, in order)
curl -s -X PATCH http://HOST:3000/api/stashes/NAME/uploads/ID -H "Upload-Offset: 0" \
     -H "Content-Type: application/octet-stream" --data-binary @piece-0
# after a failure, ask where it stands and carry on from that offset
curl -sI http://HOST:3000/api/stashes/NAME/uploads/ID | grep -i upload-offset
# 3. finish: only when every byte is there
curl -s -X POST http://HOST:3000/api/stashes/NAME/uploads/ID/complete
```

- The id is a random secret that belongs to that stash (and to full access or the drop-box link that started it). Password-protected stashes need the unlock cookie as for any request.
- **A piece changes nothing unless it arrives whole**: it is received into its own file and only then appended, so a connection that dies half way leaves the upload at the last whole piece. The server always says where it is (`Upload-Offset`, or `409` with `offset`), and the bytes in the partial file are the truth about it. Two pieces of one upload at once are refused (`409`).
- The type is judged from the first bytes **when the upload completes** (a refused extension is already refused at the start); a refusal (`415`) deletes the upload. Quotas are checked at the start and again at the end; running into one at the end (`413`, `507`) keeps the upload so it can be completed once there is room.
- Unfinished uploads count neither as items nor against the stash's space until they complete, but the sizes they declared count against the server's space (`MAX_TOTAL_MB`), so open uploads cannot fill the disk. `MAX_OPEN_UPLOADS` limits them per stash.
- An upload with no new piece for `UPLOAD_IDLE_HOURS` (24) is removed. Deleting, expiring or **renaming** a stash removes its unfinished uploads. Restarting the server keeps them: the partial files live in the `tmp/` folder of the files folder and the details in the database (their bytes are **not** in the backup or the export; a restored backup drops the uploads whose bytes are missing at the first start).
- The page remembers an unfinished upload in the tab (`sessionStorage`, by file name, size and date): after a reload, choose the same file again and it resumes. `stashly send --file` retries a failing piece 3 times and cancels the upload if it still fails (it does not resume by itself).
