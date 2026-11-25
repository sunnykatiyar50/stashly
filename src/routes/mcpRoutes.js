const express = require('express');
const rateLimit = require('express-rate-limit');
const { linkTokenMatches } = require('../utils/token');
const { createServer, StashlyApi } = require('../utils/mcp');

// The server's own MCP endpoint, POST /mcp (the "Streamable HTTP" transport, answering every request with plain JSON). It is
// only mounted when the MCP server is switched on in Admin > Settings > MCP when Stashly starts. Every request needs the access
// token made there (Authorization: Bearer <token>); only its hash is stored. The tools are the same ones bin/stashly-mcp.js
// offers, and they reach Stashly through its own HTTP API, on the very connection address the request arrived at, so every
// limit and rule of the server applies to them as to any other visitor.
function createMcpRoutes({ model, config, audit }) {
    const router = express.Router();

    // One client for the whole run: it keeps the unlock cookies and the passwords of stashes it made, so a stash made by one
    // call can be used by the next. The address it talks to is set from each request (below).
    const api = new StashlyApi('http://127.0.0.1', '');

    // Only wrong or missing tokens count towards it (a correct request never adds to the count); an address that has tried too
    // many has to wait before anything it sends is looked at, so tokens cannot be guessed at speed
    const guessLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 30,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        requestWasSuccessful: (req, res) => res.statusCode !== 401,
        skipSuccessfulRequests: true,
        message: { error: 'Too many requests with a wrong token. Try again in a few minutes.' },
    });
    const readLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: () => Math.max(config.rateRead, 1),
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down.' },
    });

    const authorize = (req, res, next) => {
        const stored = model.getMcpToken();
        const unauthorized = error => res.status(401).set('WWW-Authenticate', 'Bearer').json({ error });
        if (!stored) return unauthorized('The MCP server has no access token yet. Make one in Admin > Settings > MCP.');
        const match = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
        if (!match || !linkTokenMatches(match[1].trim(), stored.hash)) return unauthorized('A valid access token is needed (Authorization: Bearer <token>).');
        next();
    };

    // JSON-RPC bodies; as large as the API allows a note to be, plus the envelope
    const body = (req, res, next) => express.json({ limit: `${Math.ceil((config.maxNoteBytes * 2) / 1024) + 4}kb` })(req, res, next);

    // The address this very request came in on, so the tools can call back into the same server whatever it is bound to
    // (an address bound to one interface only, a container, a port mapping)
    const localBase = req => {
        const host = req.socket.localAddress || '127.0.0.1';
        return `http://${host.includes(':') ? `[${host}]` : host}:${req.socket.localPort}`;
    };

    router.post('/', readLimiter, guessLimiter, authorize, body, async (req, res) => {
        const message = req.body;
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC message as application/json.' } });
        }
        // This request's own view of the shared client: its own addresses, the unlock cookies and remembered passwords shared. The
        // links given back use the server's public address when it is set (Admin > Settings > Email > Address of this server),
        // else the host the client called; the caller holds the access token, so that is not a visitor's input to distrust.
        const scoped = Object.create(api);
        scoped.base = localBase(req);
        scoped.publicBase = config.publicUrl || `${req.protocol}://${req.get('host')}`;
        const mcp = createServer({ api: scoped, onTool: (tool, failed) => audit('mcp.tool_called', { req, actor: 'mcp', detail: { tool, failed: Boolean(failed) } }) });
        try {
            const reply = await mcp.handle(message);
            // A notification (no id) gets no body
            if (!reply) return res.status(202).end();
            res.set('Cache-Control', 'no-store').json(reply);
        } catch (err) {
            console.error('MCP request failed:', err && err.message);
            res.status(500).json({ jsonrpc: '2.0', id: message.id === undefined ? null : message.id, error: { code: -32603, message: 'Internal error' } });
        }
    });

    // There is no event stream and no session to end: a client that asks for them is told so
    router.all('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Send MCP messages with POST.' }));
    return router;
}

module.exports = { createMcpRoutes };
