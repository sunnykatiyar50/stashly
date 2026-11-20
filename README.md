# Stashly

A self-hosted shared stash. Two machines that can't reach each other open the same link, drop text, images and files on it, and copy them across. No accounts.

- **A stash** is one shared link: `/s/<name>`. The name is always required. The form pre-fills a random 12-character one; you can type your own (letters, numbers, `-` and `_`).
- **Items** are notes, images and files. The new-note box sits above the list and stays small; the expand button opens a bigger box with a title and a drop zone. Add files with the paperclip, by dragging them onto the page, or by pasting a screenshot (Ctrl+V).
- **Titles**: a note can have an optional title (up to 150 characters). Without one, the first five words of the note are used. The list shows the title and two lines of the note; search matches titles too.
- **Resizable panes**: drag the divider between the clip list and the open clip to make the list wider or narrower (double-click it, or press Home, to reset; the arrow keys work when it is focused). The width is remembered in your browser.
- **Note options** (expand the new-note box): **Burn after reading** keeps the text on the server, out of the list and live updates and out of search, until someone clicks "Reveal and delete"; it is shown once and deleted for everyone. **Secret** masks the text as dots in the page until you click Show (Copy still works; this hides it from a glance, it is not encryption). **Delete this note after** 5 minutes, 1 hour, 8 hours or 1 day removes just that note, and never later than its stash. From curl use the headers `X-Burn-After-Read: 1`, `X-Secret: 1` and `X-Expires: 5m`; reading a burn note with `.../latest` uses it up.
- **Copy fast**: "Copy latest" in a stash's header (or **Alt+C**) copies the newest note. Each note row has its own copy button (shown on hover, always visible on touch screens). A burn-after-reading note has none, since copying it would mean revealing it.
- **Share from your phone (PWA)**: Stashly can be installed as an app, and then appears in the phone's share sheet. Share text or a link from any app, and the "Share to a stash" page opens with it filled in; pick the stash (those you opened on this device are suggested) and tap Send. Browsers only offer install and sharing over **HTTPS** (or `localhost`), so put Stashly behind a TLS reverse proxy. On Android open the site in Chrome and choose "Install app"; the share target works for text and links, not files. A password-protected stash must be opened once on that device first, so its unlock cookie exists. The service worker caches nothing.
- **Live**: items appear on every open page without a refresh (Server-Sent Events).
- **QR code**: the "QR code" button in a stash's header shows a code that opens the stash on a phone or another device. It is made in the browser from the address you are using, so open Stashly by its network address or domain (not `localhost`) for a code a phone can reach; the page says so when the address is `localhost`. A stash password is not part of the code.
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

### With Docker

The image is published to GitHub Container Registry as `ghcr.io/sunnykatiyar50/stashly` for `linux/amd64` and `linux/arm64`, and runs as the unprivileged `node` user.

```powershell
docker compose up -d
docker compose pull; docker compose up -d     # update later
```

Open http://localhost:3000. Data lives in the `stashly-data` volume (`docker compose down -v` deletes it). Set `SESSION_SECRET`, `ADMIN_PASSWORD` and other options under `environment:` in [docker-compose.yml](docker-compose.yml).

**Keep the data on a volume.** The database is `/data/stashly.sqlite`, and `/data` must be a volume or bind mount, because updating the image recreates the container and deletes anything stored inside it. Leave `SQLITE_PATH` unset (a bare file name such as `stashly.sqlite` puts the database inside the container). At startup the container logs a `WARNING` when the database folder isn't on a mount or is only on an anonymous volume; set `ALLOW_EPHEMERAL_DATA=true` to silence it for a throwaway container.

Run a released version instead of `latest` by setting `IMAGE_TAG` (see the Releases page), or build from this source tree:

```powershell
$env:IMAGE_TAG = "0.1.0"; docker compose up -d
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Without Compose:

```bash
docker run -d --name stashly --restart unless-stopped -p 3000:3000 \
  -v stashly-data:/data ghcr.io/sunnykatiyar50/stashly:latest
```

## Releasing

```powershell
npm run release -- patch             # or minor, major, or an exact version like 1.4.0
npm run release -- minor --dry-run   # shows the new version and the commits since the last tag, changes nothing
```

`scripts/release.js` checks that you're on an up-to-date `main` with a clean tree, runs the tests, bumps `package.json`, commits, tags `vX.Y.Z` and pushes. Pushing the tag starts two workflows:

| Workflow | What it does |
|---|---|
| `docker.yml` | Runs the tests on Node 22 and 24, then publishes the image as `X.Y.Z`, `X.Y`, `X` and `sha-<commit>` (pushes to `main` publish `latest`) |
| `release.yml` | Checks the tag matches `package.json`, then creates the GitHub Release with generated notes, a `docker-compose.yml` pinned to that version, and `.env.example`. Tags with a suffix such as `v1.2.0-rc.1` are marked as pre-releases |

Pull requests run the tests and build the image without publishing it. The first time the image is published, GitHub creates the package as private: open it under your profile's Packages and set its visibility to public so `docker pull` works without logging in.

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

### File types

Set `FILE_TYPES` (or change it in Admin > Settings, no restart needed):

| Mode | What can be uploaded |
|---|---|
| `safe` (default) | Any **text file**, whatever its extension (yaml, yml, conf, py, properties, html, js, sh, sql, txt, log, a `Dockerfile`, and so on), certificates (pem, cer, crt, as PEM text or binary DER), and these formats, whose content must match the extension: png, jpg, gif, webp, pdf, zip, docx, xlsx, pptx, and audio and video (mp4, m4v, mov, webm, ogv, mp3, m4a, wav, ogg, oga, opus, flac) |
| `no-programs` | Everything above, plus any other file: archives (tar.gz, 7z), apk, bin and so on. Still refused: SVG, programs and Windows launchers (exe, dll, msi, scr, com, hta, vbs, wsf, lnk, jar), macro-enabled Office files (docm, xlsm, pptm), and any file whose content is a Windows, Linux or macOS executable, under any name |
| `any` | Every file, nothing refused |

The text check means the content must really be text, so a renamed binary is refused on the safe list. In the other modes a file with a known extension but the wrong content is stored as an unknown file, not as that type.

**Previews** in the open clip: images, text files up to 512 KB, audio and video play in the page (and can seek), a zip shows the names inside it (nothing is unpacked), and a PDF has an **Open** button that shows it in its own browser tab.

Whatever the mode, files are downloaded as attachments (images show inline), and every file is served with `nosniff` and a sandboxing CSP. Unrecognised files are stored as `application/octet-stream` and text as `text/plain`, so an uploaded HTML or SVG file is never rendered or run by the server. The one exception is the PDF **Open** button, which drops the sandbox for that response only, because the browser's PDF viewer cannot run under it. No virus scanning is done in any mode.

## Security notes

- The stash name is the "key". Random 12-character names can't be guessed; short custom names can, so add a password for anything private.
- Passwords protect access. Content is stored unencrypted in the SQLite file, so protect the server and its disk.
- Notes are shown as plain text (never as HTML). Strict CSP, `Cache-Control: no-store`, `noindex`, no referrer.
- Rate limits per IP on creating stashes, posting, uploading and wrong passwords. Behind a reverse proxy set `TRUST_PROXY=1` (`true` means the same: one proxy).
- No virus scanning of uploads. Treat it as a personal or team tool, not a public file host.
- Run it behind HTTPS if it leaves your LAN. On plain HTTP the cookie still works, but "Copy image" is unavailable (browsers only allow it on secure pages); text copy has a fallback.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/stashes` | `{slug, password?, ttl}` creates a stash |
| GET | `/api/stashes/suggest` | a fresh random name |
| GET | `/api/stashes/:slug` | the stash and its items (`search`, `startDate`, `endDate`, `tz`) |
| POST | `/api/stashes/:slug/unlock` | `{password}` sets the cookie |
| POST | `/api/stashes/:slug/notes` | `{title?, text}` (or a plain-text body, which gets an automatic title) |
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
