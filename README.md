# Stashly

A self-hosted shared stash. Two machines that can't reach each other open the same link, drop text, images and files on it, and copy them across. No account is needed: anyone can create and use a stash. Optional accounts (off unless `ADMIN_PASSWORD` is set, made by the admin, one sign-in page for everyone) let people follow their stashes in one place; see [Accounts](#accounts-optional).

- **A stash** is one shared link: `/s/<name>`. The name is always required: type your own (letters, numbers, `-` and `_`), or leave the box empty and press Create to get a random 12-character one.
- **Home** is one box for opening and creating: type a name and press **Open**. If the stash exists you are taken in; if not, the page says so and offers to create it. **Create** makes it with the default expiry. **More options** opens the rest: a password and expiry for a new stash (side by side), and opening with a pasted link (on its own row, since links are long) (read-only and drop-box links keep their access). **Use a random name** sits right under the box. Your followed and owned stashes are on **My stashes** in the menu, not on this page.
- **Items** are notes, images and files. The new-note box sits above the list and stays small; the expand button opens a bigger box with a title and a drop zone. Add files with the paperclip, by dragging them onto the page, or by pasting a screenshot (Ctrl+V).
- **Titles**: a note can have an optional title (up to 150 characters). Without one, the first 40 characters of the note are used. The list shows the title and two lines of the note (the eye button above the list hides the note lines; the choice is kept per device); search matches titles too.
- **Clip order**: drag a clip by the handle on its left to move it (mouse or finger), or press Alt+Up / Alt+Down on a selected clip. The order is saved and other open pages follow. New clips still arrive on top, and pinned clips stay above the rest.
- **Resizable panes**: drag the divider between the clip list and the open clip to make the list wider or narrower (double-click it, or press Home, to reset; the arrow keys work when it is focused). The width is remembered in your browser.
- **Note options** (expand the new-note box): **Burn after reading** keeps the text on the server, out of the list and live updates and out of search, until someone clicks "Reveal and delete"; it is shown once and deleted for everyone. **Secret** masks the text as dots in the page until you click Show (Copy still works; this hides it from a glance, it is not encryption). **Delete this note after** 5 minutes, 1 hour, 8 hours or 1 day removes just that note, and never later than its stash. From curl use the headers `X-Burn-After-Read: 1`, `X-Secret: 1` and `X-Expires: 5m`; a plain GET of `.../latest` leaves a burn note alone (409); `curl -X POST .../latest` reads it and uses it up.
- **Copy fast**: "Copy latest" in a stash's header (or **Alt+C**) copies the newest note. Each note row has its own copy button (shown on hover, always visible on touch screens). A burn-after-reading note has none, since copying it would mean revealing it.
- **Pin, edit and keep the last N**: **Pin** a note or file to keep it at the top (pinned items are never removed by "keep the last N"). **Edit** changes a note's title and text in place (its date and options stay; burn-after-reading notes cannot be edited), or gives a file a title of its own, so a file called `IMG_20261122_104512.jpg` can show as "Receipt". The download keeps the real name, and the list shows it under the title. A title typed in the composer before dropping a single file becomes that file's title. **Options > Keep only the last** deletes the oldest unpinned items as new ones arrive, so a stash can behave like a rolling clipboard; lowering it deletes straight away, after a confirmation.
- **Undo a delete**: when someone with full access deletes a note or file, a toast with an **Undo** button appears and stays for up to 10 seconds. The item is not destroyed at once: it waits in a trash for `UNDO_SECONDS` (default 120, or Admin > Settings; **0 turns undo off**, and deletes are immediate and final, as in earlier versions), and **Undo** (`POST /api/stashes/NAME/items/ID/restore`) puts it back with the same id, place in the list and pin. While it waits it is invisible everywhere (list, counts, search, `latest`, export, downloads) and does not count towards the limits; bringing it back checks the limits again (items, files, space) and is refused with the usual 413 or 507 if there is no room, leaving it in the trash until the time is up. An uploaded file's bytes stay on disk in the `files` folder during that time and are wiped when the entry is purged (the cleanup job runs every minute, so removal can lag the deadline by up to a minute; a restore after the deadline is refused even before that). **Never undoable**, because their point is that they cannot be read back or because nobody asked for them: burn-after-reading and secret notes, "keep the last N" trimming, a note's own expiry, and a stash that is deleted or expires (which also removes its trash). Deleting a stash while its items are in the trash removes them with it. Only full access can delete or restore.
- **Edit conflicts**: if two people edit the same note (or file title) at once, the second save is no longer a silent last-write-wins. The page remembers the version it started from and sends it as `baseEditedAt`; if the item was changed since, the server saves nothing and answers `409` with `{ error, conflict: true, item }` (the current item, with its full text). The page keeps the form and what you typed and offers **Overwrite with mine** or **Use theirs**. A live update arriving for the note you are editing leaves your form alone and does not change what it compares against. API users can opt in by sending `baseEditedAt` (the item's `editedAt`, or `null` if it has never been edited); a request that leaves it out is not checked and works as before (last write wins).
- **Links, Markdown and code**: web addresses (http and https only) in a note are clickable and open in a new tab. A note that looks like **Markdown** is rendered in the open clip (headings, bold/italic/strike, inline code, links, bullet/numbered/task lists with nesting, quotes, tables, rules and fenced code blocks, which are coloured by their language). Code and data are coloured when recognised: JSON, JavaScript/TypeScript, Python, shell, SQL, CSS, HTML/XML, YAML, Go, Rust, Java, C#, C/C++, PHP, Ruby, PowerShell, INI/TOML, Dockerfile and diffs. The detection is cautious, and **Plain text** in the open clip switches it off (the stored text is never changed; **Copy** always copies the original). Both are small built-in tools, not full parsers, and they only ever build text and a fixed set of elements, so a note can never inject markup: raw HTML is shown as text, only http and https links work, and images are shown as links (nothing is loaded from a note).
- **Renaming a stash**: **Options > Stash name > Rename** (full access only). The note count, pins, expiry and password stay. The old address stops working at once and the old name stays reserved (see **Reserved names** below), read-only and drop-box links are cancelled (they carry the old name), and on a password-protected stash everyone else has to sign in again while the person who renamed it stays signed in. Open pages on other devices follow the new address.
- **Auto-copy, notifications and who is here** (Options > This tab, both off by default and kept for this tab only): **Copy new notes automatically** puts a note that arrives from another device on this computer's clipboard (browsers only allow this while the tab is in front, so otherwise it is copied when you come back). Secret and burn-after-reading notes are never copied automatically, so they don't end up in the system's clipboard history or its cloud sync. **Notify me** shows a desktop notification for a new item while the tab is in the background (needs https or localhost and your permission; secret and burn notes show no text). The header shows **N connected**, the number of pages open on the stash right now; a device with two tabs counts twice.
- **Share from your phone (PWA)**: Stashly can be installed as an app, and then appears in the phone's share sheet. Share text or a link from any app, and the "Share to a stash" page opens with it filled in; pick the stash (those you opened on this device are suggested) and tap Send. The share sheet sends what you shared with POST, and the page receives it in the part of the address after `#` and then clears it, so it never appears in proxy logs or the browser's history (reinstall the app if you installed it before this change). Browsers only offer install and sharing over **HTTPS** (or `localhost`), so put Stashly behind a TLS reverse proxy. On Android open the site in Chrome and choose "Install app"; the share target works for text and links, not files. **The installed app reopens the last stash** you used when you launch it from its icon (it starts at `/?source=pwa`, which only the icon uses, so visiting the home page in a browser is unaffected). **Log out** or **Exit**, or a stash that has expired or been deleted, clears that memory so the next launch starts at the home page. Only the stash's name is remembered, in the browser's local storage; if you installed the app before this change, reinstall it (or wait for the browser to refresh the manifest) so the new start address takes effect. A password-protected stash must be opened once on that device first, so its unlock cookie exists. The service worker caches nothing.
- **Export**: `GET /api/stashes/NAME/export` (or `stashly export NAME`, there is no button in the page yet) downloads the whole stash as `NAME.zip` for full and read-only access (a drop-box link cannot read, so it cannot export). The zip holds `stash.json` (the stash and a list of its items, each with its id, kind, title, dates, pin and the path of its entry), `notes/<id>-<title>.txt` for every note and `files/<id>-<file name>` for every file, exactly as uploaded (image thumbnails are not exported: they are only small copies of images the zip holds in full). **Burn-after-reading notes are never exported**, because reading one uses it up; `stash.json` only says that one was skipped. Secret notes are exported. The zip is built while it is sent (nothing is held in memory or written to disk), names are made safe (no folders, control characters or `..`), and a stash that would not fit in a plain zip (4 GB or 65535 entries) is refused with a 413 before anything is sent. It uses the same rate limit as other reads.
- **Image thumbnails**: the list shows a small picture (at most 256 px, WebP or JPEG, a few KB) for each image instead of loading the whole file, which can be up to 25 MB. The server has no image library, so the **browser makes the thumbnail**: after an image upload succeeds the page shrinks it on a canvas (an animated GIF keeps its first frame; a file the browser cannot decode simply gets none) and sends it to `PUT /api/stashes/NAME/files/ID/thumb`. Other open pages get the item again with its `thumbUrl` through the live stream (`item-updated`). An image with no thumbnail yet (sent from curl or the `stashly` command, or older than this feature) shows the file icon when it is over 1 MB and itself when it is smaller; the first time a page with full access shows it, that page makes and uploads the thumbnail (one at a time, only for rows that scroll into view, and silently skipped on any failure). The open clip always shows the full image. A **drop-box link** may attach a thumbnail only to an image that has none and was added in the last 5 minutes, so it can give its own upload a thumbnail but cannot replace anything; full access may attach or replace any time; a read-only link can only read them. The server checks every thumbnail: at most `MAX_THUMB_KB` (default 200 KB, `413` above that) and content that really is a JPEG, PNG or WebP by its first bytes, whatever the name or Content-Type says (an SVG is always refused, `415`). A thumbnail is stored beside its image as `files/<id>.thumb`, goes with it when the item is deleted, trimmed or expires or its stash goes (and, for an undoable delete, when the trash is purged), does not count towards the file or space limits, **is included in the admin backup and left out of the export**. Without JavaScript or canvas support nothing breaks: images just have no thumbnail.
- **Long lists load in pages**: the page loads the first 100 clips and ends the list with **Show more (N left)**, which also loads the next 100 by itself when it scrolls into view. Search and date filters apply to all pages (changing them starts again at the first page), clips added by other devices still join the top, deleted ones disappear, and the count reads "100 of 250 clips" until everything is loaded. A background refresh (after a dropped live connection) keeps as many clips on the page as were there. Pages are added at the end, so the clips already on screen are never rebuilt or reordered.
- **Live**: items appear on every open page without a refresh (Server-Sent Events).
- **QR code**: the "QR code" button in a stash's header shows a code that opens the stash on a phone or another device. It is made in the browser from the address you are using, so open Stashly by its network address or domain (not `localhost`) for a code a phone can reach; the page says so when the address is `localhost`. A stash password is not part of the code.
- **Password** (optional, per stash): at least 10 characters (`MIN_PASSWORD_LENGTH`, or Admin > Settings; passwords set before the rule keep working), stored as a salted scrypt hash; unlocking sets an HttpOnly cookie for that stash only.
- **Reserved names**: when a stash is deleted, expires or is renamed, its old name can't be used by a new stash for 30 days (`RESERVE_OLD_NAMES_DAYS`, or Admin > Settings; 0 turns it off). A phone, bookmark or curl script still using the old name then gets "not found" instead of quietly sending to whoever took the name next.
- **The header and Options**: the header keeps the everyday buttons (QR code, Copy latest, Copy link, Share links, Extend, Log out or Exit). Everything rarely needed is behind the **gear icon** at its right end, in tabs: **This device** (auto-copy and notifications for this tab), **Stash** (what it can hold, keep the last N, rename), **Sign-in** (password-protected stashes only) and **Delete**, which only works after you type the stash's name. A read-only or drop-box link only sees the tabs that apply to it.
- **What a stash can hold**: **Options > Stash** sets it to notes and files (the default), **notes only** or **files only**. It applies to everyone who can add, drop-box links and the API too; the page hides what cannot be added, and the server refuses it (403) before reading an upload. What is already in the stash stays.
- **Sessions and logging out**: when you unlock a stash you choose how long to **stay signed in** in that browser (30 minutes, 2 hours, 12 hours, 24 hours, 7 days or 30 days; 24 hours by default; never longer than the stash itself, so a 30 day sign-in needs a stash that lives that long). Longer sign-ins are convenient on your own computer; pick a short one on a shared machine or log out when you are done. **Options > Sign-in** shows when it ends and lets you change that from now, but never to more than 30 days after you signed in (unlock again to start a new 30 days), so a copied sign-in cannot be kept alive forever. **Log out** in the stash header (**Exit** on a stash with no password) clears the sign-in and goes home. Other browsers are not affected. **Sign out other devices** (Options > Sign-in) ends every other sign-in to the stash at once, such as a browser you left signed in somewhere or a copied cookie, plus the sessions opened from read-only and drop-box links, and keeps you signed in. The password and the share links still work for new sign-ins; cancel the links under Share links if needed. If the stash's password is changed, every open page is asked for the new one.
- **Changing a stash's password**: a stash made by a guest has no owner, so whoever knows the current password is in charge of it. A stash made by a signed-in user is owned by them (see **Owners** under Accounts), and the owner may set a new password without typing the old one. **Options > Sign-in > Change password** asks for the current password again (so a browser someone walked away from cannot be used to take the stash over), then the new one twice. Everyone else is signed out and the read-only and drop-box links are cancelled; the person who changed it stays signed in for the time they had left. Wrong current passwords count towards the same lockout as unlocking. A stash with no password cannot get one this way, because anyone with its name could then lock everyone else out; only the admin can do that. If nobody knows the password any more, the admin can set a new one.
- **Share links** (password-protected stashes): the "Share links" button makes a **read-only link** (read and copy, nothing else) and a **drop-box link** (add notes and files, see nothing). Each is shown once when made; only its hash is stored, and the key sits after a `#` so it never reaches the server or its logs. Making a new link, or cancelling one, ends the old one at once. Revealing a burn-after-reading note needs full access, since it deletes the note. Without a password the name already gives full access, so these links need one.
- **Names are the lock** on a stash without a password, so such a name must be at least 10 characters (`MIN_OPEN_NAME_LENGTH`, or Admin > Settings; 0 turns it off). Shorter names need a password. Existing stashes are not changed.
- **Auto-expiry**: pick 1 hour to 30 days. A stash is deleted with everything in it when its time is up. "Extend" restarts the timer.
- **Search and date range** inside every stash, matching note text and file names. The page sends the search words in the request body (`POST /api/stashes/NAME/query`), so they never appear in an address that a proxy logs; `GET /api/stashes/NAME?search=...` still works for scripts.

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

Open http://localhost:3000. Data lives in the `stashly-data` volume (`docker compose down -v` deletes it). Settings go in a `.env` file next to `docker-compose.yml` (copy `.env.example` to `.env`; the compose file reads it, and it is optional). Set at least `SESSION_SECRET` and `ADMIN_PASSWORD`.

**Keep the data on a volume.** The database is `/data/stashly.sqlite` and the uploaded files are in `/data/files`, and `/data` must be a volume or bind mount, because updating the image recreates the container and deletes anything stored inside it. Leave `SQLITE_PATH` unset (a bare file name such as `stashly.sqlite` puts the database inside the container). At startup the container logs a `WARNING` when the database folder isn't on a mount or is only on an anonymous volume; set `ALLOW_EPHEMERAL_DATA=true` to silence it for a throwaway container.

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

`scripts/release.js` checks that you're on an up-to-date `main` with a clean tree, runs the tests, bumps `package.json`, builds the browser extension into `dist/` as a check, commits, tags `vX.Y.Z` and pushes. Pushing the tag starts two workflows:

| Workflow | What it does |
|---|---|
| `docker.yml` | Runs the tests on Node 22 and 24, then publishes the image as `X.Y.Z`, `X.Y`, `X` and `sha-<commit>` (pushes to `main` publish `latest`) |
| `release.yml` | Checks the tag matches `package.json`, then creates the GitHub Release with generated notes, a `docker-compose.yml` pinned to that version, `.env.example`, and the browser extension built for that version (two zips, plus a signed Firefox `.xpi` when the `AMO_JWT_*` secrets are set; see [extension/README.md](extension/README.md#build-and-release)). Tags with a suffix such as `v1.2.0-rc.1` are marked as pre-releases |

Pull requests run the tests and build the image without publishing it. The first time the image is published, GitHub creates the package as private: open it under your profile's Packages and set its visibility to public so `docker pull` works without logging in.

## Admin

Set `ADMIN_PASSWORD` and restart to turn on the admin area at `/admin`. There is **one sign-in for everyone**, on the account page (`/account`): username and password, and the account's **role** (admin or user) decides what you can do afterwards. The server's own admin is the account named by `ADMIN_USERNAME` (default `admin`) with the password `ADMIN_PASSWORD`; Stashly creates it as an admin account at startup. Open `/admin` while signed out and it asks you to sign in (and brings you back); open it with a plain user account and it says the account is not an admin. Without `ADMIN_PASSWORD` the admin area, and with it accounts, are off.

- **The environment account**: it is a normal account for signing in, following stashes and the audit log, but it is **set by the server's environment and cannot be edited in the UI or API**: no password reset, role change, disable, delete, "Sign out everywhere" or password change by anyone (`409`, "This account is set by ADMIN_USERNAME and ADMIN_PASSWORD in the server environment."). The Users list shows it as "Set in the server environment". Change its password by changing `ADMIN_PASSWORD` and restarting: Stashly rehashes it and signs that account out everywhere; an unchanged password at a restart changes nothing.
- **Changing or clashing names**: if `ADMIN_USERNAME` already belongs to a regular user, Stashly refuses to start and tells you to choose another `ADMIN_USERNAME` or delete that user. If you change `ADMIN_USERNAME`, the old environment account is kept but turned into an ordinary, disabled user (it is logged at startup) that you can delete under Admin > Users; the new name gets its own account. Because `admin` is a guessable name, the sign-in lockout and rate limits apply to it like any other account, and `ADMIN_PASSWORD` should be long and random.
- **The old admin login** (`POST /api/admin/login` with only `{password}`, which sets the `stashly_admin` cookie) still works for scripts and keeps all its behaviour; the admin page no longer uses it. Sign out on the admin page ends the account session and clears that cookie too.

- **Stashes**: every stash with its item count, size, creation and expiry time, plus totals against the server limits. Search by name, extend, delete, or **set or change its password**. The admin pages never show note text or file content, and the admin session does not unlock a password-protected stash. Setting a password is the exception that lets someone in: it signs everyone out of that stash, cancels its read-only and drop-box links, and clears any wrong-password lockout, and then whoever knows the new password (the admin included) can open it. It is meant for a forgotten password, so tell the owner. The notes and files are not touched.
- **Users**: add, disable, delete and sign out accounts, change roles and reset passwords (see Accounts). The overview shows how many users there are.
- **Settings**: change the limits (file size, files and items per stash, space per stash and on the server, note size, number of stashes), allow stashes that never expire, and make creating stashes admin-only or signed-in-only. The undo time for deletes (`UNDO_SECONDS`) is here too, under Stashes. Changes apply at once and are kept in the database across restarts. "Reset to defaults" goes back to the environment values. Settings you never touch keep following the environment.
- **Backup**: **Stashes > Download backup** (or `GET /api/admin/backup` while signed in as admin) streams `stashly-backup-<date>.zip` with `stashly.sqlite`, a consistent snapshot of the database taken with SQLite's `VACUUM INTO` while the server keeps running, and `files/<id>` for every uploaded file, plus `files/<id>.thumb` for each image thumbnail. The snapshot goes through a private temporary file in the files folder's `tmp/` that is always deleted, even when the download fails or the browser disconnects. Limited to 5 per 10 minutes per address. **The backup is not encrypted and holds everything readable: every note and file, the stash password hashes, the user accounts with their password hashes and follow lists, and the session secret** (so it can sign in as anyone). Keep it as private as the server's own disk. Making it briefly pauses the server for a large database, so do it at a quiet time; a file uploaded or deleted while it runs may be missing from it or extra in it (extras are removed at the next start).
- **Restoring a backup**: stop Stashly, unzip the backup into the data folder so that `stashly.sqlite` and `files/` end up where the server expects them (next to each other, or wherever `SQLITE_PATH` and `FILES_DIR` point; in Docker that is the `/data` volume), delete any `stashly.sqlite-wal` and `stashly.sqlite-shm` files left next to a database you are replacing, and start Stashly again. Passwords, share links and sign-ins keep working if `SESSION_SECRET` is the same as before; without it, people just sign in again.
- Sign-in (the account page) is rate limited and locked out per username like every account, and its session lasts `USER_SESSION_DAYS`. Changing `ADMIN_PASSWORD` signs the admin account out everywhere. The legacy password-only login (`/api/admin/login`) keeps its own rate limit (`RATE_ADMIN_LOGIN`, wrong passwords only) and a 12-hour cookie.

## Accounts (optional)

Stashly works without accounts, and most people never need one: anyone can create a stash and open any stash they have the name, password or link for, with no login. Accounts are an extra for people who want to **follow** their stashes and watch them all in one place. They are **off unless `ADMIN_PASSWORD` is set** (without it every `/api/auth/*` and `/api/me/*` address answers 404 "Accounts are not enabled on this server.").

- **Who makes accounts**: only an admin. In **Admin > Users** an admin adds a user (username, optional display name, an initial password it tells the user, and a role). The first admin is the environment account (`ADMIN_USERNAME`, see [Admin](#admin)), so there is always someone who can create the first users. The reserved `ADMIN_USERNAME` cannot be given to a new user. There is no self sign-up.
- **Roles**: **admin** and **user**. A user with the `admin` role can use the whole admin area (stashes, settings, backup, users), signing in on the same account page (`/account`) as everyone and then opening `/admin` (the **Admin** button is there for admins; `/account?next=/admin` goes straight on to it after sign-in, and no other `next` value is followed). A `user` can sign in, follow stashes and change their own password, and has no access to the admin area (the admin API answers `403`). An admin account cannot demote, disable or delete **itself**, and the environment account cannot be changed by anyone, so it always exists as an admin while accounts are on and the last admin can never lock you out. Changing a role, disabling an account, **Sign out** and **Reset password** end every session of that user at once; deleting a user removes their follow list and never touches a stash.
- **Usernames and passwords**: 3 to 40 letters, numbers, dots, dashes and underscores, unique whatever the case (`Sam` and `sam` are one account). Passwords follow the same length rule as stash passwords (`MIN_PASSWORD_LENGTH`, at most 200) and are stored as salted scrypt hashes. A wrong sign-in always says "That username or password is not right.", for an unknown name, a wrong password and a disabled account alike (an unknown name costs the same hashing work, so the answer's timing does not tell them apart). Wrong passwords are limited per address (`RATE_USER_LOGIN`, default 10 per 15 minutes) and per username and address with the same lockout as stash passwords (`STASH_UNLOCK_FAILURES` and `STASH_UNLOCK_WINDOW_MIN`).
- **Sessions**: signing in sets an HttpOnly, SameSite=Strict cookie (`stashly_user`, Secure like the stash cookies) that lasts `USER_SESSION_DAYS` (default 7, 1 to 90). It is tied to the user's password, role and a session counter, so a password change, a role change, a disable or **Sign out** ends it. Changing your own password (**My stashes > Change password**) asks for the current one and keeps this browser signed in while signing out the others.
- **Following a stash**: on **My stashes** (`/account`) a signed-in user adds a stash by its name plus its password, or a read-only link (the whole address works), and Stashly checks it once; the password is never stored. A stash with no password is followed by its name. The stash page has a **Follow** button for the same thing, using the access the browser already has (a read-only link follows as read-only; a drop-box link cannot be followed, there is nothing to read). A user who **creates** a stash while signed in follows it automatically. Following a stash again updates the grant (a password upgrades a read-only follow, a link downgrades it) without a duplicate.
- **How a follow gives access**: when a signed-in user opens a stash they have no cookie for, a follow acts as the access they proved: **full** or **read-only**, so they can open it, add, pin or delete (full) or only read and copy (read-only) with nothing to unlock. The follow stores a snapshot of what it was given (the stash's password salt and sign-in version, and for a read-only follow the hash of the link). **A follow ends the moment a cookie would**: changing the stash password, **Sign out other devices**, the admin setting a password, and cancelling or replacing the read-only link all stop it working, and the stash shows on the dashboard as "Needs the password again" (nothing else about it is shown) until the user follows it again. The person who changed the password or signed out the others keeps their own follow, like their cookie. Renaming a stash keeps follows with full access (the stash keeps its identity) and ends read-only ones (the link is cancelled); deleting or expiring a stash removes its follows. A stash with no password stays open to anyone with its name, followed or not. Following is rate limited like unlocking: wrong passwords and links count towards the **same** per-stash lockout as the unlock form, and requests for names that do not exist are limited like everywhere else, so the follow form is no cheaper way to guess a password or a name.
- **The dashboard** (`/account`, `GET /api/me/stashes`): each followed stash with its name, a lock for password stashes, access (full or read-only), the number of items and files, how many are **new** since the user last opened it, the time of the latest activity, and when it expires, newest activity first, refreshing every 20 seconds while the tab is visible and again when it comes back (paused while hidden). Burn-after-reading notes count as items but their text is never shown. The stash page marks the stash as seen when it opens and every 30 seconds while it stays open (`POST /api/me/stashes/NAME/seen`); the dashboard itself never marks anything seen.
- **Pinned stashes**: **Pin** a stash in **My stashes** (or with the **Pin** button on the stash page) and it is listed under **Pinned** in the left menu on every page, for quick switching, and comes first in My stashes. Up to 20 pins per user; pins are private to the account, only store the stash name (never a password), and go away when you unfollow the stash.
- **Owners**: a stash made by a signed-in user is **owned** by them; a stash made by a guest has no owner. Every stash you own is always in **My stashes**, first, marked **Yours**, with no Unfollow, and you open it with no password and no read-only link needed, so nothing can lock you out of it (a password change, even one by someone else, never makes it "need the password again"). The owner may set a new password without the old one. Only stashes someone else (or a guest) made can be followed and unfollowed. Stashes made before owners existed have no owner and count as guest stashes. If an owner's account is deleted, their stashes become guest stashes: they stay, and their password still opens them.
- **Admins and passwords**: an admin cannot choose a new password for a stash that has an owner (they can still extend or delete it). For a guest's stash an admin can set a new password, which signs everyone out, cancels share links, and shows everyone using the stash "An admin chose this stash's password on <date>" until someone who knows the password changes it. Set `ADMIN_CAN_RESET_STASH_PASSWORDS=false` (or turn it off in Admin > Settings) to remove the admin's reset for every stash; the admin can then only extend or delete. The admin list shows who made each stash (an owner's name, or Guest).
- **Who may create stashes**: anyone, as before. `REQUIRE_LOGIN_TO_CREATE` (or Admin > Settings > Stashes > "Only signed-in users can create stashes") limits creating to signed-in users and admins; `REQUIRE_ADMIN_TO_CREATE` keeps its meaning and now allows the `ADMIN_PASSWORD` admin and users with the admin role. Both are off by default, and "only the admin" wins when both are on. Whatever the setting, opening and using a stash needs no login.
- **Logs and metrics**: accounts add audit events and two metrics (below). Neither a username, password, session token nor stash name is ever written to a log: a user is named by id, a stash by the usual keyed hash.


## From a terminal (no browser)

```bash
curl -d "text to share" -H "Content-Type: text/plain" http://HOST:3000/api/stashes/NAME/notes
curl http://HOST:3000/api/stashes/NAME/latest
curl -X POST http://HOST:3000/api/stashes/NAME/files -H "X-File-Name: report.pdf" \
     -H "Content-Type: application/octet-stream" --data-binary @report.pdf
```

Password-protected stashes need the unlock cookie: `curl -c jar -d '{"password":"..."}' -H "Content-Type: application/json" .../unlock`, then add `-b jar` to later calls.

### The `stashly` command

`bin/stashly.js` is the same thing in one file with no dependencies (Node 22 or newer): it unlocks password-protected stashes for you, uploads files straight from disk (a large file is never read into memory) and saves downloads as files. Run it as `node bin/stashly.js ...`, or with `npm link` (or `npm install -g .`) as `stashly ...`.

```bash
export STASHLY_URL=http://HOST:3000        # default http://localhost:3000 (or --url)
export STASHLY_PASSWORD=...                # for password-protected stashes (or --password)

stashly new NAME --ttl 7d --password P     # create a stash (ttl: 1h, 8h, 1d, 7d, 30d; --password is optional)
stashly send NAME "text to share"          # a note; with no text, or "-", the text is read from stdin
echo "from a pipe" | stashly send NAME --title "Pipe"
stashly send NAME --file report.pdf        # upload a file (optional --title; over 8 MB it goes up in pieces, see Resumable uploads)
stashly get NAME                           # the newest note, to stdout
stashly list NAME                          # id, kind, size, date, title
stashly pull NAME ID --out copy.pdf        # download a file item (default: its own name; "-" for stdout)
stashly export NAME --out all.zip          # the whole stash as a zip (default NAME.zip)
```

It exits with 0 when it worked, and 1 on any error with one line on stderr that carries the server's own message (for example `stashly: This stash is locked. Enter the password.`). `get` leaves a burn-after-reading note alone (the server answers 409), and `pull` and `export` never overwrite an existing file. Prefer `STASHLY_PASSWORD` to `--password`, which other users of the computer can see in the process list.

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

## Limits (all configurable)

Most of these are changed in the admin area, under **Admin > Settings**, and apply at once with no restart. `.env` only needs what has to be set before the server starts (the admin password, the secret, the address and storage, logging); the variables below that say "Also in Admin > Settings" can still be given in the environment, as the **starting value**: a value saved from the Settings page wins over the environment until you press **Reset to defaults**, which goes back to the environment's values. The others (marked in [.env.example](.env.example), some of them commented out as advanced) are read when the server starts.

**What the Settings page covers**, in its tabs:

| Tab | Settings |
|---|---|
| **Limits** | Largest note and file, files and items per stash, file space per stash and on the server, number of stashes |
| **Security** | Shortest stash password and shortest open name, days a given-up name stays reserved, how long account sign-ins last, wrong account passwords allowed, wrong stash passwords before a lockout and how long it lasts |
| **Files** | Which file types can be uploaded |
| **Stashes** | Default expiry, stashes that never expire, how long a delete can be undone, who can create stashes, whether an admin can reset stash passwords |
| **Rate limits** | Stashes created, notes added, files uploaded and reads, each per minute per address |
| **Email** | The SMTP server, login, From address, the address of this server used in links, emails per hour, and a "Send test email" button |

Rate limits and lockouts count per address in memory, so a restart starts the counts again.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_NOTE_KB` | 100 | Largest single note Also in **Admin > Settings > Limits** (the environment gives the starting value). |
| `MAX_FILE_MB` | 25 | Largest single file Also in **Admin > Settings > Limits** (the environment gives the starting value). |
| `MAX_FILES_PER_STASH` | 500 | Files in one stash Also in **Admin > Settings > Limits** (the environment gives the starting value). |
| `MAX_ITEMS_PER_STASH` | 1000 | Notes and files in one stash (keep above the file limit) Also in **Admin > Settings > Limits** (the environment gives the starting value). |
| `MAX_STASH_MB` | 100 | Total file size in one stash Also in **Admin > Settings > Limits** (the environment gives the starting value). |
| `MAX_TOTAL_MB` | 2048 | Total file size on the whole server Also in **Admin > Settings > Limits** (the environment gives the starting value). |
| `MAX_STASHES` | 1000 | Stashes on the whole server Also in **Admin > Settings > Limits** (the environment gives the starting value). |
| `FILE_TYPES` | safe | Which files can be uploaded: `safe`, `no-programs` or `any` (see File types). Also in **Admin > Settings > Files** (the environment gives the starting value). |
| `ALLOW_NO_EXPIRY` | false | Allow stashes that never expire. Also in **Admin > Settings > Stashes** (the environment gives the starting value). |
| `REQUIRE_ADMIN_TO_CREATE` | false | Only the admin can create stashes (needs `ADMIN_PASSWORD`). Also in **Admin > Settings > Stashes** (the environment gives the starting value). |
| `RATE_CREATE` | 20 | Stashes one address may create a minute. Also in **Admin > Settings > Rate limits** (the environment gives the starting value). |
| `RATE_POST` | 120 | Notes and other changes one address may make a minute. Also in **Admin > Settings > Rate limits** (the environment gives the starting value). |
| `RATE_UPLOAD` | 40 | Files one address may start uploading a minute. Also in **Admin > Settings > Rate limits** (the environment gives the starting value). |
| `RATE_ADMIN_LOGIN` | 10 | Wrong admin passwords per address per 15 minutes. Also in **Admin > Settings > Security** as "Wrong account passwords allowed" (one setting for users and the admin). |
| `SMTP_ENABLED` | false | Send emails (reset links, shared links) through your own mail server. Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `SMTP_HOST` | (empty) | Mail server host name. Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `SMTP_PORT` | 587 | Mail server port (587 for STARTTLS, 465 for SSL). Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `SMTP_SECURITY` | starttls | `starttls`, `ssl` or `none` (plain text, for a trusted local relay only). Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `SMTP_USER` | (empty) | Username for the mail server (leave empty if it needs none). Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `SMTP_PASSWORD` | (empty) | Password for the mail server. Saved from the admin page it is stored encrypted with the server secret, so keep `SESSION_SECRET` fixed. Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `SMTP_FROM` | (empty) | The From address of every email. Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `SMTP_FROM_NAME` | Stashly | The name shown beside the From address. Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `EMAIL_PER_HOUR` | 100 | Most emails the server sends in an hour. Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `PUBLIC_URL` | (empty) | This server's own address (`https://stash.example.com`), used in links inside emails. Never taken from the request. Also in **Admin > Settings > Email** (the environment gives the starting value). |
| `MAX_THUMB_KB` | 200 | Largest image thumbnail the page may send (the page makes them about 256 px wide, usually a few KB) |
| `MAX_CHUNK_MB` | 4 | Largest piece of a resumable upload one request may carry (at least 64 KB; more than this is never buffered or written per request) |
| `MAX_OPEN_UPLOADS` / `MAX_OPEN_UPLOADS_SERVER` | 5 / 50 | Unfinished resumable uploads one stash and the whole server may hold (`429` above that) |
| `UPLOAD_IDLE_HOURS` | 24 | An unfinished resumable upload that gets no new piece for this long is removed by the cleanup job |
| `RATE_CHUNK` | 6000 | Pieces of resumable uploads per address per minute (starting an upload uses `RATE_UPLOAD`) |
| `UNDO_SECONDS` | 120 | How long a person's delete of a note or file can be undone (0 to 3600; 0 = off, deletes are immediate). Items waiting in the trash are not counted by the limits above, but a trashed file still takes disk space until it is purged Also in **Admin > Settings > Stashes** (the environment gives the starting value). |

### Passwords, lockout and cookies

| Variable | Default | Meaning |
|---|---|---|
| `MIN_OPEN_NAME_LENGTH` | 10 | Shortest stash name allowed without a password (0 = off) Also in **Admin > Settings > Security** (the environment gives the starting value). |
| `MIN_PASSWORD_LENGTH` | 10 | Shortest stash password, when one is set or changed (4 to 200) Also in **Admin > Settings > Security** (the environment gives the starting value). |
| `RESERVE_OLD_NAMES_DAYS` | 30 | Days a deleted, expired or renamed stash's name stays unavailable to new stashes (0 = off) Also in **Admin > Settings > Security** (the environment gives the starting value). |
| `STASH_UNLOCK_FAILURES` | 10 | Wrong passwords for one stash from one address before that address is refused; the whole stash is refused at 5 times this, from anyone (0 = off) Also in **Admin > Settings > Security** (the environment gives the starting value). |
| `RATE_READ` | 600 | Reads (listing, files, `latest`, live streams) per address per minute Also in **Admin > Settings > Rate limits** (the environment gives the starting value). |
| `RATE_NOT_FOUND` | 60 | Requests for stashes that do not exist, per address per minute (slows name guessing) |
| `MAX_STREAMS_PER_STASH` / `MAX_STREAMS_PER_IP` | 100 / 30 | Open live streams (0 = no limit) |
| `STASH_UNLOCK_WINDOW_MIN` | 15 | How long that refusal lasts, in minutes Also in **Admin > Settings > Security** (the environment gives the starting value). |
| `COOKIE_SECURE` | auto | `auto` marks cookies Secure when the connection is HTTPS; `true` always (use it behind a TLS proxy you did not set `TRUST_PROXY` for) |
| `FILES_DIR` | `files` next to the database | Where uploaded files are stored (one plain file each). **Back up the database and this folder together.** Older databases that kept files inside SQLite are moved here automatically at the first start |
| `RATE_UNLOCK` | 10 | Wrong passwords per address per 15 minutes |
| `ADMIN_USERNAME` | `admin` | The admin account that `ADMIN_PASSWORD` belongs to: 3 to 40 letters, numbers, dots, dashes or underscores, stored lowercase (an invalid value stops the start). Created at startup with the `admin` role; everyone, the admin included, signs in on the account page. Only used while `ADMIN_PASSWORD` is set. Use a long `ADMIN_PASSWORD`: the name is easy to guess |
| `USER_SESSION_DAYS` | 7 | How long a user stays signed in on one browser (1 to 90). Needs `ADMIN_PASSWORD` Also in **Admin > Settings > Security** (the environment gives the starting value). |
| `REQUIRE_LOGIN_TO_CREATE` | false | Only signed-in users and admins can create stashes (needs `ADMIN_PASSWORD`; also in Admin > Settings) |
| `ADMIN_CAN_RESET_STASH_PASSWORDS` | true | Whether an admin may choose a new password for a stash that has no owner (a guest made it). Never possible for a stash a signed-in user owns. `false` removes the reset for every stash Also in **Admin > Settings > Stashes** (the environment gives the starting value). |
| `RATE_USER_LOGIN` | 10 | Wrong account passwords per address per 15 minutes Also in **Admin > Settings > Security** (the environment gives the starting value). |

The per-stash lockout is on top of the per-address limit, so guessing from many addresses gets nowhere either. The cost: someone who knows a stash's name can deliberately lock new unlocks for a while by guessing wrong. A person who is already unlocked, or who has a share link, is not affected, and the count lives in memory, so a restart clears it. Cookies are always `HttpOnly` and `SameSite=Strict`, and responses carry a content security policy, `no-store`, and a permissions policy that turns off camera, microphone, location and similar features Stashly never uses.

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

## Operating Stashly: logs and metrics

Three things help you run a server. All are off by default, and none of them ever carries a **stash name, password, token, cookie, note text, file name or query string**: a stash name is the only secret of a stash without a password, so the logs name a stash by a short keyed hash instead (see below).

| Variable | Default | Meaning |
|---|---|---|
| `LOG_FORMAT` | `off` | `json` writes one JSON line to stdout for each finished request |
| `AUDIT_LOG` | `off` | `stdout` writes one JSON line for each change of who can reach what |
| `METRICS_TOKEN` | empty | Turns on `GET /metrics` (Prometheus text format); callers must send `Authorization: Bearer <token>`. Use a long random value |

**Access log** (`LOG_FORMAT=json`): `{"time","level":"info","msg":"request","method","route","status","ms","ip","stash","role","bytes"}`. `route` is the route *pattern* (`/api/stashes/:slug/notes`), never the real path; a request no route answered is `unmatched`, and the page's own files are `static`. `stash` is the first 10 hex characters of an HMAC-SHA-256 of the name keyed with the server's secret, so lines about one stash can be matched with each other, but the name cannot be read from them (the secret is kept in the database or set with `SESSION_SECRET`, so tags stay the same across restarts). `role` is `full`, `view`, `drop` or `none` when a stash was involved. `bytes` is the response's Content-Length when it has one. A live stream is logged when it ends. `/health` and `/metrics` are not logged.

**Audit log** (`AUDIT_LOG=stdout`): `{"time","level":"audit","event","ip","stash","actor","detail"}` with `actor` `visitor`, `admin` or `system` (expiry). Events: `stash.created`, `stash.deleted` (`detail.reason`: visitor, admin or expired), `stash.renamed` (hashes of the old and new name), `stash.password_changed`, `stash.password_reset_by_admin`, `stash.sessions_signed_out`, `stash.share_link_created` / `stash.share_link_revoked` (the kind only), `stash.unlock_failed` (every wrong password, with the address), `stash.locked_out` (when the lockout trips), `item.deleted` / `item.restored` (the kind only), `stash.exported`, `admin.login_succeeded`, `admin.login_failed`, `admin.logout`, `admin.settings_changed` (the settings that changed and their new values; none is a secret) and `admin.backup_downloaded`. Accounts add `user.login_succeeded`, `user.login_failed` (also a wrong current password when changing it), `user.locked_out`, `user.logout`, `user.password_changed`, `user.followed` (with the stash's hash; `detail.via` is `create` when it came from creating the stash) and `user.unfollowed`, with `actor` `user` or `visitor`, and `user.created`, `user.updated` (only the names of the changed fields), `user.password_reset`, `user.signed_out` and `user.deleted`, done by an admin. A user is identified by number in `detail.user`; no line carries a username, display name, password or session token, and an unknown name in a failed sign-in is not recorded at all. Send stdout to your log collector; Docker keeps it for `docker logs`.

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

## Browser extension

`extension/` holds a small Manifest V3 extension for Chrome, Edge and Firefox. It sends notes, links and files to a stash
from any tab, and lists, searches and copies your notes. Each release attaches it built for that version
(`npm run build:extension` builds it locally); see [extension/README.md](extension/README.md). What it and the server
do with your data is in [PRIVACY.md](PRIVACY.md).

## Tests

```powershell
npm test
```
