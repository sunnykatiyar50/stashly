#!/usr/bin/env node
'use strict';
// A Model Context Protocol server for Stashly over stdio (one JSON-RPC message per line), for AI clients that start a
// program themselves: Claude Desktop, Claude Code, Cursor, ... When Stashly itself is reachable from the client, the
// server's own HTTP endpoint (POST /mcp, switched on in Admin > Settings > MCP) needs no program and no file path.
// The tools are the same; they live in src/utils/mcp.js. Nothing to install beyond Node 22.
//
//   STASHLY_URL        where Stashly runs (default http://localhost:3000)
//   STASHLY_PASSWORD   the password to try for password-protected stashes (a tool call can give its own)
//
// It never deletes anything. See docs/mcp.md.
const readline = require('readline');
const { createServer, stashNameFor, stashName, TOOLS } = require('../src/utils/mcp');

function main(env, input = process.stdin, output = process.stdout) {
    const server = createServer({ url: env.STASHLY_URL || 'http://localhost:3000', password: env.STASHLY_PASSWORD || '' });
    const send = reply => { if (reply) output.write(`${JSON.stringify(reply)}\n`); };
    const pending = new Set();
    const lines = readline.createInterface({ input });
    lines.on('line', line => {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        const work = server.handle(message).then(send, err => process.stderr.write(`stashly-mcp: ${err.stack || err}\n`));
        pending.add(work);
        work.finally(() => pending.delete(work));
    });
    // When the client closes the pipe, finish what is in flight, then exit
    lines.on('close', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
}

if (require.main === module) main(process.env);

module.exports = { createServer, stashNameFor, stashName, TOOLS };
