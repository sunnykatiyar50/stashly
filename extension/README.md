# Stashly browser extension

A small Manifest V3 extension for Chrome, Edge and Firefox. It lets you use a stash from any tab without opening the
Stashly page. It has no build step: load this folder as it is.

- **Popup** (toolbar button, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>): pick a stash (the last five are
  remembered), send typed text or the clipboard as a note, see the 20 newest notes with a Copy button on each and
  search for older ones, drop a file onto the popup (or use **File…**) to upload it, and open the stash in a tab.
- **Right-click → Send to Stashly**: sends the selected text, the link or the page address. With more than one recent
  stash it becomes a submenu. The toolbar button shows **OK**, or **!** with the reason in its tooltip.
- **Password-protected stashes**: the popup asks for the password the first time and then retries what you were doing.
  It uses the same sign-in cookie as the Stashly page, so unlocking in one unlocks the other.

## Load it

Every GitHub Release has the extension built for that version. You can also build it yourself (see below).

| Browser | File | How |
| --- | --- | --- |
| Chrome, Edge (and other Chromium browsers) | `stashly-extension-<version>-chromium.zip` | Unzip it. Open `chrome://extensions` (or `edge://extensions`), turn on *Developer mode*, choose *Load unpacked* and pick the unzipped folder. It stays installed, but outside the Chrome Web Store and Edge Add-ons, unpacked is the only way: Chrome and Edge do not install a packed extension from a file (except through enterprise policy), and the browser may remind you that developer-mode extensions are on. |
| Firefox, Zen (and other Firefox-based browsers) for a permanent install | `stashly-extension-<version>-firefox-signed.xpi` | Open the file in the browser (drag it into a window, or *Install Add-on From File…* in the cog menu of `about:addons`). This file is only in a release when signing is set up (see below). |
| Firefox, Zen, for a quick try | `stashly-extension-<version>-firefox.zip` | Open `about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on…* and pick the zip. It is removed when the browser closes. |

**Signed or not, in Firefox and Zen.** Release Firefox installs an add-on permanently only when Mozilla has signed
it. It refuses the unsigned zip as a normal install, and its `xpinstall.signatures.required` setting changes nothing.
Zen ships with that setting on, so it refuses the unsigned zip in the same way (tested in Zen 1.24.1b: "signature
required"). Zen is built without the hard lock, though, so setting `xpinstall.signatures.required` to `false` in
`about:config` lets it install the unsigned zip permanently (also tested). Firefox Developer Edition, Nightly, ESR and
unbranded builds behave like Zen here. Turning signature checks off applies to every add-on, so the signed `.xpi` is
the better choice.

From a checkout, load the `extension` folder itself the same way (Chrome/Edge: *Load unpacked*; Firefox/Zen:
*Load Temporary Add-on…* and pick `extension/manifest.json`). It shows version 0.0.0, because only the build writes
the real version.

Firefox needs version 128 or later.

Then open the extension's options, enter your server (for example `https://stash.example.com` or
`http://localhost:3000`) and save. The browser asks for access to that host only.

To change the shortcut: `chrome://extensions/shortcuts` in Chrome or Edge; in Firefox, *Manage Extension Shortcuts*
in the cog menu of `about:addons`.

## Build and release

```powershell
npm run build:extension
```

`scripts/build-extension.js` needs only Node, with no other tools, and works the same on Windows and Linux. It reads
the version from `package.json` and writes:

| Path | What |
| --- | --- |
| `dist/stashly-extension-<version>-chromium.zip` | for Chrome and Edge. The manifest has no `background.scripts` and no `browser_specific_settings`, which Chromium does not use. |
| `dist/stashly-extension-<version>-firefox.zip` | for Firefox and Zen. The manifest has no `background.service_worker`; Firefox runs the background script instead. |
| `dist/chromium/`, `dist/firefox/` | the same files unpacked |

`dist/` is ignored by git. The same input always gives the same zip, byte for byte.

**The version.** `package.json` is the only place it is kept. `extension/manifest.json` says `0.0.0`, and the build
writes the real version into each copy, so the two can never drift apart. A manifest version is digits only, so a
pre-release such as `1.8.0-rc.1` is built as `1.8.0`. Chromium also gets `"version_name": "1.8.0-rc.1"`, which
`chrome://extensions` shows. Firefox has no `version_name`. It would load `1.8.0-rc.1` locally, but
addons.mozilla.org accepts only digits and dots, so the Firefox build uses `1.8.0` too, and pre-releases are not
signed (see below).

**On a release.** `npm run release` builds the extension before it tags, so a broken build stops the release. Pushing
the tag runs `.github/workflows/release.yml`, which:
1. checks the tag against `package.json`
2. builds both zips
3. checks that each built manifest carries the tag's version
4. attaches both zips to the GitHub Release

### Signing the Firefox build (optional)

With two repository secrets, the release workflow also signs the Firefox build on addons.mozilla.org as an
**unlisted** add-on. Unlisted means Mozilla signs it but does not list it on the store. The workflow then attaches
`stashly-extension-<version>-firefox-signed.xpi`, which installs permanently in Firefox and Zen.

1. Sign in to addons.mozilla.org with a Firefox account.
2. Open *Tools → Manage API Keys* (https://addons.mozilla.org/developers/addon/api/key/) and generate credentials.
3. In the GitHub repository, add two secrets under *Settings → Secrets and variables → Actions*:
   - `AMO_JWT_ISSUER`: the *JWT issuer*, which looks like `user:12345:67`
   - `AMO_JWT_SECRET`: the *JWT secret*

Without both secrets the signing step is skipped and the release carries only the two zips. The step:
- runs `web-ext sign --channel=unlisted` (web-ext 8.3.0, fetched with `npx` only for this step)
- uses the add-on ID in the manifest, `stashly@stashly.extension`; the first signing registers that ID to your account
- signs stable versions only. AMO allows each version number once, and a pre-release is built with its final number.
- does not stop the release if it fails. The release is then published without the `.xpi`, with a warning in the run.

Mozilla runs automatic checks before it signs, which usually takes a few minutes; `web-ext` waits for it. To check the
build against the same rules locally, run `npx web-ext@8.3.0 lint --source-dir dist/firefox` (it currently reports
no errors or warnings).

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | The server address and the recent stashes |
| `contextMenus` | *Send to Stashly* |
| Your server's host (asked at run time) | To call the Stashly API with your sign-in cookie. Nothing else is declared up front. The pattern has no port, because Firefox ignores a pattern with a port ([bug 1362809](https://bugzilla.mozilla.org/show_bug.cgi?id=1362809)). So access covers that host on any port. |
| `clipboardRead` (optional, asked the first time) | Only for **Send clipboard**. Pasting into the box needs nothing. |

The extension does not read pages. It sends only what you choose to send, and only to your server.

## Good to know

- **The note list** shows the stash's 20 newest items (pinned ones first), each with its own **Copy**. Files are
  listed by name only. A secret note can be copied without being shown. The search box searches the whole stash on
  the server (`POST /api/stashes/:slug/query` with `{ search, limit: 20 }`, so the words stay out of addresses), a
  moment after you stop typing, and only 20 results come back. On a server older than this extension, `limit` is
  ignored and the whole list is downloaded, though still only 20 are shown.
- **Burn-after-reading notes** appear without their text. **Reveal**, then **Reveal and delete?**, fetches the text
  once and deletes the note for everyone, as on the stash page. Only full access can reveal; listing never uses a
  note up.
- In Firefox the popup can close when a file dialog opens. Drag the file onto the popup instead.
- A drop-box share link (`#drop=…`) or a read-only link (`#view=…`) should work too, though this is not yet tested.
  Open the link once in the same browser and the extension uses that cookie. A drop-box link can send but cannot show
  notes.

## Sign-in cookies from an extension (spike, November 2026)

A stash's sign-in cookie is `HttpOnly; SameSite=Strict`. The question was whether requests from the extension carry it.

**Chromium (tested on Edge 157, the same engine as Chrome)**: yes. With a host permission for the server:

| Test | Result |
| --- | --- |
| Unlock in a normal tab, then `fetch(…/latest, {credentials: 'include'})` from the service worker | 200, cookie sent |
| The same from an extension page (the popup) | 200, cookie sent |
| The extension calls `/unlock` itself | the `Set-Cookie` is stored, later extension requests are signed in |
| After that, a normal Stashly tab | also signed in (one cookie jar) |

Chromium treats a request from an extension with host permission for the URL as same-site, so Strict cookies go along.
No server change is needed for Chromium.

**Firefox (tested on Zen 1.24.1b, which is Firefox 159.0.1)**: yes, the same as Chromium. As documented since
Firefox 77 ([bug 1629436](https://bugzilla.mozilla.org/show_bug.cgi?id=1629436)), requests from extension pages and
background scripts count as first-party when the extension has host permission for the URL. The extension sets
`strict_min_version` 128. Two Firefox catches have shaped the code:

- A host pattern with a port is shown as granted but matches nothing. The CORS bypass and cookies then silently do not
  apply ([bug 2052000](https://bugzilla.mozilla.org/show_bug.cgi?id=2052000), a duplicate of 1362809). Fixed by
  requesting the host without a port.
- MV3 host permissions are not granted at install in Firefox. The options page asks for them when you save.

### Firefox checks

Run on Zen 1.24.1b (Firefox 159.0.1) with a fresh temporary profile, driven over WebDriver BiDi against
`PORT=3917 node src/app.js`. The extension was installed as a temporary add-on. Most checks used a test copy that has
the `127.0.0.1` host permission already granted, plus a small hook that opens its pages in tabs, because BiDi cannot
answer the permission prompt or open `moz-extension://` addresses. The extension code itself was unchanged.

| # | Check | Result |
| --- | --- | --- |
| 1 | The real extension loads with no console errors. The popup shows the setup step. No host access at install (only `storage` and `contextMenus`). | Passed |
| 2 | Options saves the server, verifies it, and access to `http://127.0.0.1/*` is in place | Passed. The real permission prompt was not clicked. |
| 3 | **Key check**: unlock in a normal tab, then `fetch(…/latest, {credentials: 'include'})` from the **background script** | Passed: 404 "No notes yet", not 401. The Strict cookie was sent. |
| 4 | The same from the **popup**; the popup sends to the locked stash without asking for the password | Passed |
| 5 | Cookies cleared → the popup asks for the password; a wrong password shows the error. Then it unlocks and retries the send. The normal tab and the background script are signed in by the cookie the extension got. | Passed |
| 6 | Open stash: send a note and see it in the list with **Copy**, drop a file (the CRLF bytes arrive intact), and the recent list is kept in order | Passed |
| 6 | Note list: 20 of 26 shown with the total; search waits for typing to stop and finds an older note on the server; no match and a cleared search; a burn note shows no text, the first click only asks, the second reveals it and the server deletes it | Passed |
| 6 | **Copy**, **Send clipboard**, dragging a real file from the desktop, **Open** | Not run: these need a real click, and BiDi cannot send input to extension pages |
| 7 | Context menu: selection and link sent, the badge shows **OK**, and the submenu lists the recent stashes. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> is bound to `_execute_action`. | Passed. The menu was not clicked by hand and the key was not pressed. |

So no server change is needed for Firefox either.

**Had a browser not sent the cookie**, this was the smallest server change. It is not needed now and is kept only as
a record. Let the API routes also accept the token in an `Authorization: Bearer <token>` header. That token is either
a share-link token (`view` or `drop`, checked with the same `linkTokenMatches` as `/redeem`), or a signed full-access
token returned in the `/unlock` response body when the request asks for it. `access()` in
`src/controllers/stashController.js` would check the header after the cookies. A header cannot be sent cross-site
without a CORS preflight, which Stashly does not answer, so CSRF stays closed.
