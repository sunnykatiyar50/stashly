# Configuration

How to set limits, passwords and file types. Most of these are changed in the admin area, with no restart. See the [README](../README.md) for the short version.

## Limits and settings

Most of these are changed in the admin area, under **Admin > Settings**, and apply at once with no restart. `.env` only needs what has to be set before the server starts (the admin password, the secret, the address and storage, logging); the variables below that say "Also in Admin > Settings" can still be given in the environment, as the **starting value**: a value saved from the Settings page wins over the environment until you press **Reset to defaults**, which goes back to the environment's values. The others (marked in [.env.example](../.env.example), some of them commented out as advanced) are read when the server starts.

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
