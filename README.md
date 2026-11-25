# Stashly

**Share text, images and files between computers that can't reach each other.** Open the same link on both, drop something on one, and it shows up on the other. No account needed.

Stashly is self-hosted: you run it on your own machine or server, and your notes and files stay there.

## Using it

1. **Open or create a stash.** The home page has two cards. **Open a stash** takes a name, or a link you were given: press **Open**. **Create a stash** takes a name — press **Use a random name**, or leave the box empty and press **Create** — plus an optional password and how long it lives. A stash lives at `/s/<name>`.
2. **Open the same link on your other machine** (the **QR code** button in the header opens it on a phone).
3. **Add things.** Type a note, add files with the paperclip, drag them onto the page, or paste a screenshot (Ctrl+V).
4. **Copy them on the other side.** Items appear live, with no refresh. Press **Copy latest** (or **Alt+C**) for the newest note, or the copy button on any note.

Everything else is optional:

- **Protect it**: set a password, and share a **read-only link** or a **drop-box link** (add but not see) from the **Share links** button.
- **Share one clip**: press **Share** on a note or file for a link that opens only that clip, no sign-in and nothing else from the stash. It expires (7 days by default) and can be cancelled.
- **Let it expire**: a stash and everything in it is deleted after 1 hour to 30 days. **Extend** restarts the timer.
- **Keep it tidy**: pin items, drag to reorder, search, filter by date, or keep only the last N items so a stash works like a rolling clipboard.
- **Handle sensitive notes**: **Burn after reading** shows a note once and deletes it; **Secret** hides it as dots; a note can delete itself after 5 minutes to a day.
- **Undo a delete** for a couple of minutes, and **edit** notes in place.
- **Install it on your phone** (HTTPS needed) and use your phone's share sheet to send text, links, photos or any files straight to a stash (reinstall the app once if you installed it before files were supported: the share sheet only lists an app for files when the installed copy knows it takes them; iPhones and iPads do not offer web apps in the share sheet at all).
- **Optional accounts**: if the server has them on, sign in to follow your stashes in one place, pin the ones you use most, and manage your details under **Settings**.

All of it, with the details, is in [docs/features.md](docs/features.md).

## From a terminal

```bash
curl -d "text to share" -H "Content-Type: text/plain" http://HOST:3000/api/stashes/NAME/notes
curl http://HOST:3000/api/stashes/NAME/latest
curl -X POST http://HOST:3000/api/stashes/NAME/files -H "X-File-Name: report.pdf" \
     -H "Content-Type: application/octet-stream" --data-binary @report.pdf
```

For a password-protected stash, unlock once and reuse the cookie: `curl -c jar -d '{"password":"..."}' -H "Content-Type: application/json" .../unlock`, then add `-b jar` to later calls.

### The `stashly` command

`bin/stashly.js` does the same in one file with no dependencies (Node 22+). It unlocks password-protected stashes for you and uploads files straight from disk. Run it as `node bin/stashly.js ...`, or as `stashly ...` after `npm link`.

```bash
export STASHLY_URL=http://HOST:3000        # default http://localhost:3000
export STASHLY_PASSWORD=...                # only for password-protected stashes

stashly new NAME --ttl 7d --password P     # create a stash
stashly send NAME "text to share"          # a note (or pipe text in on stdin)
stashly send NAME --file report.pdf        # upload a file
stashly get NAME                           # the newest note
stashly list NAME                          # what is in the stash
stashly pull NAME ID --out copy.pdf        # download a file
stashly export NAME --out all.zip          # the whole stash as a zip
```

## For AI assistants (MCP)

Stashly can be a Model Context Protocol server, so Claude Code and other assistants can create a stash for a topic, push notes into it (with tags) and read them back. Switch it on in **Admin > Settings > MCP** (then restart), make an access token there and connect a client to `https://<your stashly>/mcp`; or run `bin/stashly-mcp.js` from the client instead. It never deletes anything. Setup and the tools are in [docs/mcp.md](docs/mcp.md).

## Browser extension

A small extension for Chrome, Edge and Firefox sends notes, links and files to a stash from any tab, and lists, searches and copies your notes. Each release attaches it built for that version; see [extension/README.md](extension/README.md). What it and the server do with your data is in [PRIVACY.md](PRIVACY.md).

## Run your own

Needs Node 22.13 or newer (nothing to compile).

```powershell
npm install
npm start
```

Open http://localhost:3000. Settings go in environment variables (see [.env.example](.env.example)); to load a file: `node --env-file=.env src/app.js`.

### With Docker

The image is published as `ghcr.io/sunnykatiyar50/stashly` for `linux/amd64` and `linux/arm64`.

```powershell
docker compose up -d
docker compose pull; docker compose up -d     # update later
```

Open http://localhost:3000. Copy `.env.example` to `.env` next to `docker-compose.yml` and set at least `SESSION_SECRET` and `ADMIN_PASSWORD`.

**Keep your data on a volume.** The database (`/data/stashly.sqlite`) and uploaded files (`/data/files`) must be on a volume or bind mount, because updating the image recreates the container and deletes anything stored inside it. The compose file already does this: it pins `SQLITE_PATH` to `/data/stashly.sqlite`, so a `SQLITE_PATH` in your `.env` (such as the `./stashly.sqlite` used when running without Docker) cannot move the database off the volume. Leave it unset.

Without Compose:

```bash
docker run -d --name stashly --restart unless-stopped -p 3000:3000 \
  -v stashly-data:/data ghcr.io/sunnykatiyar50/stashly:latest
```

### Once it is running

- **Put it behind HTTPS** if it leaves your home or office network. Installing the phone app and "Copy image" both need it. Behind a reverse proxy, set `TRUST_PROXY=1`.
- **Turn on the admin area** by setting `ADMIN_PASSWORD` and restarting. Sign in at `/account`, then open `/admin` to see stashes, create users, change limits (no restart needed) and download a backup. Use a long random password.
- **Back up** the database and the `files` folder together (or use **Admin > Stashes > Download backup**).

## Keep in mind

- A stash name is its key. Random names can't be guessed; short custom names can, so add a password for anything private. Stashes without a password need a name of at least 10 characters.
- Content is stored unencrypted on the server's disk, so protect the server and its backups.
- Uploads are not scanned for viruses. Treat Stashly as a personal or team tool, not a public file host.

## More documentation

| | |
|---|---|
| [Features in detail](docs/features.md) | Every feature, option and limit of a stash |
| [Accounts and admin](docs/accounts-and-admin.md) | Users, roles, following stashes, password reset by email, the admin area |
| [Configuration](docs/configuration.md) | All settings and environment variables, file types |
| [Running a server](docs/operations.md) | Logs, metrics and security notes |
| [API](docs/api.md) | HTTP endpoints and resumable uploads |
| [Releasing](docs/releasing.md) | How maintainers cut a release |

## Tests

```powershell
npm test
```
