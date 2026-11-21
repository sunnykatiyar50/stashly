# Stashly browser extension

A small Manifest V3 extension for Chrome, Edge and Firefox. It lets you use a stash from any tab without opening the
Stashly page. It has no build step: load this folder as it is.

- **Popup** (toolbar button, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>): pick a stash (the last five are
  remembered), send typed text or the clipboard as a note, show the newest note and copy it, drop a file onto the popup
  (or use **File…**) to upload it, and open the stash in a tab.
- **Right-click → Send to Stashly**: sends the selected text, the link or the page address. With more than one recent
  stash it becomes a submenu. The toolbar button shows **OK**, or **!** with the reason in its tooltip.
- **Password-protected stashes**: the popup asks for the password the first time and then retries what you were doing.
  It uses the same sign-in cookie as the Stashly page, so unlocking in one unlocks the other.

## Load it

**Chrome / Edge**: open `chrome://extensions` (or `edge://extensions`), turn on *Developer mode*, choose
*Load unpacked* and pick this `extension` folder.

**Firefox** (128 or later): open `about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on…* and pick
`extension/manifest.json`. A temporary add-on is removed when Firefox closes.

Then open the extension's options, enter your server (for example `https://stash.example.com` or
`http://localhost:3000`) and save. The browser asks for access to that host only.

To change the shortcut: `chrome://extensions/shortcuts` in Chrome or Edge; in Firefox, *Manage Extension Shortcuts*
in the cog menu of `about:addons`.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | The server address and the recent stashes |
| `contextMenus` | *Send to Stashly* |
| Your server's host (asked at run time) | To call the Stashly API with your sign-in cookie. Nothing else is declared up front. The pattern has no port, because Firefox ignores a pattern with a port ([bug 1362809](https://bugzilla.mozilla.org/show_bug.cgi?id=1362809)). So access covers that host on any port. |
| `clipboardRead` (optional, asked the first time) | Only for **Send clipboard**. Pasting into the box needs nothing. |

The extension does not read pages. It sends only what you choose to send, and only to your server.

## Good to know

- **Show newest note** calls `GET /api/stashes/:slug/latest`. It does this only when you click, never when the popup
  opens. If you have full access and the newest note is burn-after-reading, showing it uses it up, as `/latest` always
  does.
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
| 6 | Open stash: send a note, **Show newest note**, drop a file (the CRLF bytes arrive intact), and the recent list is kept in order | Passed |
| 6 | **Copy**, **Send clipboard**, dragging a real file from the desktop, **Open** | Not run: these need a real click, and BiDi cannot send input to extension pages |
| 7 | Context menu: selection and link sent, the badge shows **OK**, and the submenu lists the recent stashes. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> is bound to `_execute_action`. | Passed. The menu was not clicked by hand and the key was not pressed. |

So no server change is needed for Firefox either.

**Had a browser not sent the cookie**, this was the smallest server change. It is not needed now and is kept only as
a record. Let the API routes also accept the token in an `Authorization: Bearer <token>` header. That token is either
a share-link token (`view` or `drop`, checked with the same `linkTokenMatches` as `/redeem`), or a signed full-access
token returned in the `/unlock` response body when the request asks for it. `access()` in
`src/controllers/stashController.js` would check the header after the cookies. A header cannot be sent cross-site
without a CORS preflight, which Stashly does not answer, so CSRF stays closed.
