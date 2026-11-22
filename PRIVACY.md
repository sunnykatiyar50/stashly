# Privacy policy

Last updated: 23 November 2026

This policy covers the **Stashly browser extension** (Chrome, Edge and Firefox) and the **Stashly server** in this
repository.

## The short version

- Stashly is self-hosted. Your notes and files go to a Stashly server that you, or whoever runs your server, control.
- The extension sends data only to the one server address you enter in its options, and only what you choose to send.
- Nothing is sent to the author of Stashly or to anyone else. There are no analytics, no tracking and no ads.
- Your data is never sold or shared.

## The browser extension

### What it sends, and where

The extension talks to one place: the Stashly server address you save in its options. It sends:

- the text, links, page addresses and files that you choose to send, from the popup or the *Send to Stashly*
  right-click menu
- searches you type in the popup, so the server can find matching clips
- the password of a password-protected stash, when you type it to unlock that stash

Requests carry the stash's sign-in cookie, the same one the Stashly page uses in that browser.

The extension does not read the pages you visit. It sees a page's address, selected text or a link only when you use
*Send to Stashly* on it, and then sends only that.

### What it keeps in your browser

| What | Where | How long |
| --- | --- | --- |
| Your server address and the names of your last five stashes | the browser's extension storage | until you remove the extension or change them |
| Where the popup was left: the open stash, your search, half-typed text, scroll position | the browser's session storage, in memory | until the browser closes; never written to disk |

Passwords are never stored by the extension. A burn-after-reading note's text is never stored after it is revealed.

### Permissions

| Permission | Why |
| --- | --- |
| `storage` | To keep the server address, recent stashes and where the popup was left, as listed above |
| `contextMenus` | For the *Send to Stashly* right-click menu |
| Access to your server's address (asked when you save it) | To call the Stashly API on that server. No other site is accessed. |
| `clipboardRead` (optional, asked the first time you use it) | Only for the button that adds what is on your clipboard. Pasting into the text box does not need it. |

## The Stashly server

Whoever runs a Stashly server controls the data on it. If you use someone else's server, their own policy applies to
what is stored there. As built, the server:

- stores the notes and files you add, until you delete them, the note's own expiry passes, the stash expires, or the
  admin deletes the stash
- stores stash passwords only as salted hashes, never in plain text
- uses cookies only to keep you signed in to a password-protected stash, to the admin page and, if the server has
  accounts, to your account; there are no tracking or advertising cookies
- keeps visitors' IP addresses only in memory, briefly, to limit repeated requests and wrong passwords; it does not
  write them to a log
- makes no connections of its own to outside services, and sends no data to the author of Stashly

### Accounts (optional)

Accounts exist only when the person running the server turns on the admin area, and only the admin can create them.
Nobody needs one to use a stash. When a server has accounts, it stores for each one:

- a username and, if the admin gave one, a display name
- a salted hash of the password (never the password itself)
- the role (admin or user), whether the account is disabled, who created it and when
- the time of the last sign-in, and a counter that ends all its sessions when the password, role or status changes
- the list of stashes the user follows, with when each was added and when the user last opened it (used for "new"
  counts), and the access the user proved when following (full or read-only) as a snapshot of the stash's current
  password and link, never the password or the link itself

Nothing else is added: no email address, no phone number, no profile, no history of what you open, and no tracking.
The account cookie only identifies you to this server. The stash name and password you give to follow a stash are
checked once and not kept. Deleting an account removes all of this, and the stashes it followed are not touched. The
server's logs, if the operator turns them on, name a user only by number and never carry a username, a password or a
stash name. The admin can see usernames, roles, sign-in times and how many stashes each user follows, but not which
stashes, and cannot read what is in a stash from the admin pages.

Burn-after-reading notes are deleted on the server as soon as they are revealed. Deleted notes are overwritten in the
database file. When you delete a note or file yourself, the server keeps it for a short time (2 minutes by default, set
by `UNDO_SECONDS`) so the delete can be undone, and then overwrites it; burn-after-reading and secret notes are never
kept.

## Children

Stashly is not aimed at children and does not knowingly collect information from them.

## Changes

If this policy changes, the new version is published in this file, with a new date at the top. The history of every
change is in the repository's commit history.

## Contact

Questions about this policy: open an issue at <https://github.com/sunnykatiyar50/stashly/issues>.
