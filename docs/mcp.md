# MCP server (for AI assistants)

`bin/stashly-mcp.js` lets an AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io) (Claude Desktop, Claude Code, Cursor, ...) use Stashly as a place to keep notes: create a stash for a topic, push notes into it (with tags), and read them back later. It is one file with no dependencies (Node 22+), like the `stashly` command, and talks to your Stashly server over its normal HTTP API. It speaks MCP over stdio.

## Set it up

Point your assistant at the file and tell it where Stashly runs.

**Claude Code**

```bash
claude mcp add stashly --env STASHLY_URL=http://localhost:3000 -- node /path/to/stashly/bin/stashly-mcp.js
```

**Claude Desktop** (`claude_desktop_config.json`), or any client that takes the same JSON:

```json
{
  "mcpServers": {
    "stashly": {
      "command": "node",
      "args": ["/path/to/stashly/bin/stashly-mcp.js"],
      "env": { "STASHLY_URL": "http://localhost:3000" }
    }
  }
}
```

After `npm link` (or `npm install -g .`) the command is also available as `stashly-mcp`.

| Setting | Meaning |
|---|---|
| `STASHLY_URL` | where Stashly runs (default `http://localhost:3000`) |
| `STASHLY_PASSWORD` | a password to try for password-protected stashes. A tool call can give its own instead, and a stash created in the same run remembers the password it was created with. |

## Tools

| Tool | What it does |
|---|---|
| `create_stash` | `topic` (required), `password`, `ttl`. Makes a stash for a topic and returns its name and link. Without a password the name is the topic plus a random tail (`q3-launch-plan-x7k2pq`), because then the name is the only lock; with a password the plain topic name is used. |
| `add_note` | `stash` (name or link), `text`, `title`, `tags` (up to 8), `password`, `create_if_missing`. Adds a note and tags it. With `create_if_missing` a stash that does not exist is made first. |
| `list_notes` | `stash`, `search`, `tag`, `limit` (1-100, default 20), `password`. Lists items newest first with id, date, title, tags and the start of each note, plus the tags in use in the stash. |
| `read_note` | `stash`, `id`, `password`. Reads one note in full. |

A typical use: *"Research X and keep what you find in a stash for it"*. The assistant calls `create_stash` once, then `add_note` for each finding, and gives you the link.

## What it will not do

- **Nothing is deleted.** There are no delete, edit or expire tools, so an assistant cannot destroy what is in a stash. Use the page or the API for that.
- **Burn-after-reading notes are never read** (reading uses them up), and secret notes are not shown in listings.
- **Files are not handled**, only notes.
- A server that only lets signed-in users or the admin create stashes (`REQUIRE_ADMIN_TO_CREATE` or `REQUIRE_LOGIN_TO_CREATE`) refuses `create_stash` with the server's own message; the tools can still add to stashes that already exist.

## Notes on safety

- Whoever can run the server process can use every stash its `STASHLY_PASSWORD` opens, so give it a password only for stashes you want the assistant to reach. A stash without a password is open to anyone who has its link, as always.
- Note text comes from the assistant. Treat what it writes like anything else it produces, and remember that open stashes are readable by anyone with the link.
