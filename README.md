# Stashly

A self-hosted shared stash. Two machines that can't reach each other open the same link, drop text, images and files on it, and copy them across. No accounts.

- **A stash** is one shared link: `/s/<name>`. The name is always required. The form pre-fills a random 12-character one; you can type your own (4 to 64 characters: `a-z 0-9 - _`).
- **Items** are notes, images and files. Add by typing, attaching, dragging files onto the page, or pasting a screenshot (Ctrl+V).
- **Live**: items appear on every open page without a refresh (Server-Sent Events).
- **Password** (optional, per stash): stored as a salted scrypt hash; unlocking sets an HttpOnly cookie for that stash only.
- **Auto-expiry**: pick 1 hour to 30 days. A stash is deleted with everything in it when its time is up. "Extend" restarts the timer.
- **Search and date range** inside every stash, matching note text and file names.

## Run it

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`; nothing to compile).

```powershell
npm install
npm start
```

Open http://localhost:3000. Settings go in environment variables (see [.env.example](.env.example)); to load a file: `node --env-file=.env src/app.js`.

With Docker:

```powershell
docker compose up -d --build
```

Data lives in the `stashly-data` volume.

## Admin

Set `ADMIN_PASSWORD` and restart to turn on the admin area at `/admin`. There is one admin, not a user system; everyone else is an anonymous visitor who uses stashes they have the link to. Without `ADMIN_PASSWORD` the admin area is off.

- **Stashes**: every stash with its item count, size, creation and expiry time, plus totals against the server limits. Search by name, extend, or delete. The admin can manage a stash but not read it: no note text or file content is shown, and the admin session does not unlock a password-protected stash.
- **Settings**: change the limits (file size, files and items per stash, space per stash and on the server, note size, number of stashes), allow stashes that never expire, and make creating stashes admin-only. Changes apply at once and are kept in the database across restarts. "Reset to defaults" goes back to the environment values. Settings you never touch keep following the environment.
- Sign-in is rate limited (wrong passwords only) and the session lasts 12 hours. Changing `ADMIN_PASSWORD` signs the admin out everywhere.

## From a terminal (no browser)

```bash
curl -d "text to share" -H "Content-Type: text/plain" http://HOST:3000/api/stashes/NAME/notes
curl http://HOST:3000/api/stashes/NAME/latest
curl -X POST http://HOST:3000/api/stashes/NAME/files -H "X-File-Name: report.pdf" \
     -H "Content-Type: application/octet-stream" --data-binary @report.pdf
```

Password-protected stashes need the unlock cookie: `curl -c jar -d '{"password":"..."}' -H "Content-Type: application/json" .../unlock`, then add `-b jar` to later calls.

## Limits (all configurable)

Set these as environment variables (or in `.env`, see [.env.example](.env.example)) and restart to apply. With the admin area on, you can also change them from the admin Settings page, without a restart.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_NOTE_KB` | 100 | Largest single note |
| `MAX_FILE_MB` | 25 | Largest single file |
| `MAX_FILES_PER_STASH` | 500 | Files in one stash |
| `MAX_ITEMS_PER_STASH` | 1000 | Notes and files in one stash (keep above the file limit) |
| `MAX_STASH_MB` | 100 | Total file size in one stash |
| `MAX_TOTAL_MB` | 2048 | Total file size on the whole server |
| `MAX_STASHES` | 1000 | Stashes on the whole server |

Allowed file types: png, jpg, gif, webp, pdf, zip, docx, xlsx, pptx, txt, csv, json, md, log. The extension **and** the content must match. SVG and HTML are refused because they can carry scripts. Files are always downloaded as attachments, except images, which are shown inline with `nosniff` and a sandboxing CSP.

## Security notes

- The stash name is the "key". Random 12-character names can't be guessed; short custom names can, so add a password for anything private.
- Passwords protect access. Content is stored unencrypted in the SQLite file, so protect the server and its disk.
- Notes are shown as plain text (never as HTML). Strict CSP, `Cache-Control: no-store`, `noindex`, no referrer.
- Rate limits per IP on creating stashes, posting, uploading and wrong passwords. Behind a reverse proxy set `TRUST_PROXY=1`.
- No virus scanning of uploads. Treat it as a personal or team tool, not a public file host.
- Run it behind HTTPS if it leaves your LAN. On plain HTTP the cookie still works, but "Copy image" is unavailable (browsers only allow it on secure pages); text copy has a fallback.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/stashes` | `{slug, password?, ttl}` creates a stash |
| GET | `/api/stashes/suggest` | a fresh random name |
| GET | `/api/stashes/:slug` | the stash and its items (`search`, `startDate`, `endDate`, `tz`) |
| POST | `/api/stashes/:slug/unlock` | `{password}` sets the cookie |
| POST | `/api/stashes/:slug/notes` | `{text}` (or a plain-text body) |
| POST | `/api/stashes/:slug/files` | raw body, `X-File-Name` header |
| GET | `/api/stashes/:slug/files/:id` | the file (`?download=1` to force a download) |
| GET | `/api/stashes/:slug/latest` | newest note as plain text |
| DELETE | `/api/stashes/:slug/items/:id` | delete a note or file |
| POST | `/api/stashes/:slug/extend` | restart the expiry timer |
| DELETE | `/api/stashes/:slug` | delete the stash |
| GET | `/api/stashes/:slug/events` | live stream |
| GET | `/health`, `/api/config` | liveness; expiry options and limits |

## Tests

```powershell
npm test
```

## Merging into Message-Sandbox later

The project is laid out like Message-Sandbox on purpose (Express 5, `node:sqlite`, helmet CSP, routes -> controller -> model, vanilla JS views, the same CSS tokens and theme script).

- **Backend**: copy `src/routes/stashRoutes.js`, `controllers/stashController.js`, `models/stashModel.js` and `utils/`. Mount with `app.use('/api/stashes', createStashRoutes({ controller, config }))` *outside* the dashboard auth, since the stash link and password are the access control. All SQL is in `stashModel.js` and the table definitions in `database/sqlite.js`, so porting to MySQL/Postgres is contained.
- **UI**: `views/stash.html` and `stash.js` can become a "Stashly" view in the dashboard; the public `/s/:slug` page stays standalone. A dashboard-only "Stashes" list would be an admin route calling the model.
- **Things to reconcile**: the localStorage keys (Stashly uses `sl_theme` and `sl_sidebar_collapsed`; Message-Sandbox uses `ms_theme`), and Message-Sandbox's `express.json` body limit, which the upload route must skip (it reads its own raw body).
