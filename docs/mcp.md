# MCP server (for AI assistants)

Stashly can act as a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI assistant (Claude Code, Cursor, and other MCP clients) can use it as a place to keep notes: create a stash for a topic, push notes into it (with tags), and read them back later. There are two ways to connect, and they run the same four tools:

| | **HTTP endpoint** (`POST /mcp`) | **stdio program** (`bin/stashly-mcp.js`) |
|---|---|---|
| What the client needs | the address and an access token | a path to the file on its own machine, and Node 22 |
| Where it runs | inside your Stashly server | started by the client, on the client's machine |
| Switch on | Admin > Settings > MCP, then restart | nothing on the server |
| Works from another machine | yes | yes, if `STASHLY_URL` reaches the server |

**Use the HTTP endpoint when the client can reach your Stashly.** It needs no file path and no Node on the client: that path is only needed by the stdio program, because the client has to start that program itself.

## The HTTP endpoint

### Turn it on

1. Sign in as the admin and open **Settings > MCP**.
2. Tick **Enable the MCP server** and **Save changes**. (Or start the server with `MCP_ENABLED=true`; the setting is the same.)
3. **Restart Stashly.** The endpoint is only started when the server starts, so until then the page says it is switched on but not running. Needs `ADMIN_PASSWORD`, because the access token is made in the admin area.
4. On the same tab press **Make a token**. It is shown once (only a hash is kept), so copy it now. **Make a new token** replaces it (the old one stops working at once) and **Revoke** removes it.

### Connect a client

The address is `https://<your stashly>/mcp` (the tab shows it), and every request carries `Authorization: Bearer <token>`.

**Claude Code**

```bash
claude mcp add --transport http stashly https://stash.example.com/mcp --header "Authorization: Bearer stm_..."
```

Any other client that can call a remote (HTTP) MCP server with a custom `Authorization` header takes the same two things. Claude Desktop's built-in connectors do not take a bearer header, so use the stdio program below there.

### Things to know

- **Token, not a login:** the token is the only credential. Anyone who has it can create stashes and add to and read open stashes through the tools, so keep it like a password and use HTTPS. There is one token for the server; revoke or replace it any time.
- **It acts like any other visitor.** The tools call Stashly's own API on the address the request came in on, so every limit and rule applies: note size, stash limits, rate limits, and "only the admin can create stashes" (`create_stash` is then refused with the server's own message).
- **Passwords:** a stash made with a password through the tools is remembered by the server until it restarts, so the next call needs no password. For a protected stash someone else made, pass `password` in the call.
- **Links in answers** use **Address of this server** (Admin > Settings > Email) when it is set, otherwise the host the client called.
- **Wrong tokens** are limited per address (30 in 15 minutes), and every tool call is written to the audit log (`mcp.tool_called`: the tool and whether it failed, never what was in it), along with `admin.mcp_token_created` and `admin.mcp_token_revoked`.
- It is plain request and response: no event stream and no session, so `GET` and `DELETE /mcp` answer `405`.

## The stdio program

Point the client at the file and tell it where Stashly runs. The client starts the program itself, which is why it needs the path (replace `/path/to/stashly` with where you put the repository or the unpacked files).

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

After `npm link` (or `npm install -g .`) the command is also available as `stashly-mcp`, with no path.

| Setting | Meaning |
|---|---|
| `STASHLY_URL` | where Stashly runs (default `http://localhost:3000`) |
| `STASHLY_PASSWORD` | a password to try for password-protected stashes. A tool call can give its own instead, and a stash created in the same run remembers the password it was created with. |

It needs nothing switched on at the server and has no token: access follows the usual rules (a stash's name or password).

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
- **Files are not handled**, only notes, and there is no tool to make a share link.
- A server that only lets signed-in users or the admin create stashes (`REQUIRE_ADMIN_TO_CREATE` or `REQUIRE_LOGIN_TO_CREATE`) refuses `create_stash` with the server's own message; the tools can still add to stashes that already exist.

## Notes on safety

- Anyone who can run the stdio program can use every stash its `STASHLY_PASSWORD` opens, so give it a password only for stashes you want the assistant to reach. A stash without a password is open to anyone who has its link, as always.
- Note text comes from the assistant. Treat what it writes like anything else it produces, and remember that open stashes are readable by anyone with the link.
