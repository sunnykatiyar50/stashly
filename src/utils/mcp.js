'use strict';
// The Model Context Protocol side of Stashly, shared by the two ways of reaching it: bin/stashly-mcp.js (stdio, started by the
// AI client) and the server's own POST /mcp endpoint (HTTP, switched on in Admin > Settings > MCP). Both run exactly this code:
// the protocol (JSON-RPC) and four tools that let an assistant create a stash for a topic, push notes into it and read
// them back. The tools talk to Stashly through its normal HTTP API, so every limit and rule of the server applies to them.
//
// It never deletes anything: the tools create stashes, add notes and read. See docs/mcp.md.
const crypto = require('crypto');
const { version } = require('../../package.json');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

// A failure the model should see as the tool's answer (isError), not as a protocol error
class ToolError extends Error {}
const fail = message => { throw new ToolError(message); };

const random = length => Array.from(crypto.randomBytes(length), b => ALPHABET[b % ALPHABET.length]).join('');

// "Q3 launch plan" becomes q3-launch-plan-x7k2pq. Without a password the name is the only lock, so it gets a random
// tail that makes it unguessable (and long enough for the server's minimum); with a password the plain name is used.
function stashNameFor(topic, hasPassword) {
    const base = String(topic).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'stash';
    if (hasPassword) return base.length >= 4 ? base : `${base}-${random(4)}`;
    return `${base}-${random(Math.max(6, 12 - base.length - 1))}`;
}

// A stash name, or a link to one (http://host/s/name, with or without a #key), as the bare name
function stashName(raw) {
    if (typeof raw !== 'string' || !raw.trim()) fail('Say which stash (its name, or its link).');
    const match = /\/s\/([^/?#\s]+)/.exec(raw);
    const name = (match ? decodeURIComponent(match[1]) : raw).trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(name)) fail('A stash name has only letters, numbers, - and _.');
    return name;
}

const clip = (text, length) => {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > length ? `${one.slice(0, length - 1)}…` : one;
};

class StashlyApi {
    constructor(base, password, fetchImpl = fetch) {
        this.base = base.replace(/\/+$/, '');
        this.password = password;
        this.fetch = fetchImpl;
        this.cookies = new Map(); // stash name -> cookie header, kept for this run only
        this.passwords = new Map(); // stash name -> the password it was created with in this run
    }

    // The link people open. publicBase is set when the server is reached through another address than the one the tools call
    // (the HTTP endpoint calls back on its own local address, which no one else could use).
    link(name) { return `${this.publicBase || this.base}/s/${name}`; }

    async raw(method, path, { json, cookie } = {}) {
        const headers = {};
        let body;
        if (json !== undefined) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
        if (cookie) headers.Cookie = cookie;
        let res;
        try {
            // A redirect could carry the cookie to another server, so none is followed
            res = await this.fetch(this.base + path, { method, headers, body, redirect: 'error' });
        } catch (err) {
            fail(`Cannot reach Stashly at ${this.base}: ${(err.cause && err.cause.message) || err.message}`);
        }
        return res;
    }

    // One request to a stash: unlocks it first when it has a password (the one given, else STASHLY_PASSWORD)
    async request(name, method, path, { json, password } = {}) {
        const secret = password || this.passwords.get(name) || this.password;
        const url = `/api/stashes/${encodeURIComponent(name)}${path}`;
        for (let attempt = 0; ; attempt++) {
            if (secret && !this.cookies.has(name)) await this.unlock(name, secret);
            const res = await this.raw(method, url, { json, cookie: this.cookies.get(name) });
            if (res.status === 401 && attempt === 0 && secret) { this.cookies.delete(name); continue; }
            return this.answer(res, name);
        }
    }

    async unlock(name, secret) {
        const res = await this.raw('POST', `/api/stashes/${encodeURIComponent(name)}/unlock`, { json: { password: secret } });
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            fail(body && body.error ? `Could not open ${name}: ${body.error}` : `Could not open ${name} (the server answered ${res.status}).`);
        }
        const pairs = res.headers.getSetCookie().map(line => line.split(';')[0]);
        if (pairs.length) this.cookies.set(name, pairs.join('; '));
    }

    async answer(res, name) {
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* plain text */ }
        if (res.ok) return body === null ? text : body;
        const why = (body && body.error) || text.trim() || `The server answered ${res.status}.`;
        if (res.status === 401) fail(`${name} is password protected. Give its password (password argument, or STASHLY_PASSWORD).`);
        if (res.status === 404) fail(`There is no stash called ${name} (it may have expired).`);
        fail(why);
    }

    async create(body) {
        const res = await this.raw('POST', '/api/stashes', { json: body });
        const made = await this.answer(res, body.slug);
        if (body.password) this.passwords.set(made.slug || body.slug, body.password);
        return made;
    }
}

// ---- the tools ----

const TOOLS = [
    {
        name: 'create_stash',
        description: 'Create a new stash (a shared space for notes and files) for a topic, and get its name and link. Use one stash per topic or project, then add notes to it with add_note. Without a password the stash is open to anyone with its link, so the name gets a random tail to keep it unguessable.',
        inputSchema: {
            type: 'object',
            properties: {
                topic: { type: 'string', description: 'What the stash is for, e.g. "Q3 launch plan". It becomes the start of the stash name.' },
                password: { type: 'string', description: 'Optional. Protects the stash; people need it to open the link.' },
                ttl: { type: 'string', description: 'Optional. How long the stash lives, e.g. "1h", "1d", "7d", "30d" (the server decides which values it accepts; default is the server\'s).' },
            },
            required: ['topic'],
        },
        async run(api, args) {
            if (typeof args.topic !== 'string' || !args.topic.trim()) fail('Give a topic for the stash.');
            const password = args.password || undefined;
            const slug = stashNameFor(args.topic, Boolean(password));
            const made = await api.create({ slug, password, ttl: args.ttl || undefined });
            const name = made.slug || slug;
            return [
                `Created stash "${name}".`,
                `Link: ${api.link(name)}`,
                password ? 'It is password protected; give the password to anyone who should open it.' : 'Anyone with this link can read and add to it.',
                'Use the name above as `stash` in add_note and list_notes.',
            ].join('\n');
        },
    },
    {
        name: 'add_note',
        description: 'Add a text note to a stash, optionally with a title and tags. Use it to save what the user wants kept: findings, drafts, snippets, summaries. Pass create_if_missing with a topic-style name to make the stash first when it does not exist.',
        inputSchema: {
            type: 'object',
            properties: {
                stash: { type: 'string', description: 'The stash name, or its link.' },
                text: { type: 'string', description: 'The note text (Markdown is rendered by Stashly).' },
                title: { type: 'string', description: 'Optional short title (150 characters at most). Without one, the first words of the note are used.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to organise the note: up to 8 short words (letters, numbers, - and _).' },
                password: { type: 'string', description: 'Only for a password-protected stash.' },
                create_if_missing: { type: 'boolean', description: 'Create the stash (named like the `stash` value, open without a password) when there is none. Default false.' },
            },
            required: ['stash', 'text'],
        },
        async run(api, args) {
            const name = stashName(args.stash);
            if (typeof args.text !== 'string' || !args.text.trim()) fail('The note is empty.');
            const note = { text: args.text };
            if (args.title) note.title = args.title;
            let created = false;
            let item;
            try {
                item = await api.request(name, 'POST', '/notes', { json: note, password: args.password });
            } catch (err) {
                if (!(args.create_if_missing && /no stash called/.test(err.message))) throw err;
                // Names that are not long enough to be safe get a random tail, like create_stash gives
                const made = await api.create({ slug: name.length >= 12 || args.password ? name : stashNameFor(name, false), password: args.password || undefined });
                created = made.slug;
                item = await api.request(made.slug, 'POST', '/notes', { json: note, password: args.password });
            }
            const where = created || name;
            const lines = [`${created ? `Created stash "${where}" and added` : 'Added'} note ${item.id} ("${clip(item.title, 60)}") to ${where}.`];
            if (args.tags && args.tags.length) {
                try {
                    const tagged = await api.request(where, 'PUT', `/items/${item.id}/tags`, { json: { tags: args.tags }, password: args.password });
                    lines.push(`Tags: ${tagged.tags.join(', ') || '(none)'}`);
                } catch (err) {
                    lines.push(`The note was added, but the tags were not: ${err.message}`);
                }
            }
            lines.push(`Link: ${api.link(where)}`);
            return lines.join('\n');
        },
    },
    {
        name: 'list_notes',
        description: 'List what is in a stash, newest first (pinned first): id, date, title, tags and the start of each note. Filter with a search word or a tag. Use read_note for a whole note.',
        inputSchema: {
            type: 'object',
            properties: {
                stash: { type: 'string', description: 'The stash name, or its link.' },
                search: { type: 'string', description: 'Optional words to search for in notes and titles.' },
                tag: { type: 'string', description: 'Optional: only notes with this tag.' },
                limit: { type: 'integer', description: 'How many to list, 1 to 100 (default 20).' },
                password: { type: 'string', description: 'Only for a password-protected stash.' },
            },
            required: ['stash'],
        },
        async run(api, args) {
            const name = stashName(args.stash);
            const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 20, 1), 100);
            const query = { limit, preview: true, tz: '0' };
            if (args.search) query.search = args.search;
            if (args.tag) query.tag = [args.tag];
            const stash = await api.request(name, 'POST', '/query', { json: query, password: args.password });
            if (!stash.items.length) return args.search || args.tag ? 'No notes match.' : `${name} has no notes yet.`;
            const lines = stash.items.map(item => {
                const kind = item.kind === 'file' ? `file ${item.fileName} (${item.fileSize} bytes)` : item.burn ? '(burn after reading: not shown)' : item.secret ? '(secret: not shown)' : clip(item.text, 120);
                const tags = item.tags && item.tags.length ? ` [${item.tags.join(', ')}]` : '';
                return `#${item.id} ${item.createdAt.slice(0, 16).replace('T', ' ')} "${clip(item.title, 60)}"${tags}: ${kind}`;
            });
            const more = stash.total > stash.items.length ? `\n…and ${stash.total - stash.items.length} more (raise limit, or search).` : '';
            const tagLine = stash.tags && stash.tags.length ? `\nTags in this stash: ${stash.tags.map(t => `${t.name} (${t.count})`).join(', ')}` : '';
            return `${stash.total} item(s) in ${name}:\n${lines.join('\n')}${more}${tagLine}`;
        },
    },
    {
        name: 'read_note',
        description: 'Read one note in full, by the id that list_notes or add_note gave.',
        inputSchema: {
            type: 'object',
            properties: {
                stash: { type: 'string', description: 'The stash name, or its link.' },
                id: { type: 'integer', description: 'The note id.' },
                password: { type: 'string', description: 'Only for a password-protected stash.' },
            },
            required: ['stash', 'id'],
        },
        async run(api, args) {
            const name = stashName(args.stash);
            if (!Number.isInteger(args.id) || args.id < 1) fail('The id is the number list_notes shows.');
            const item = await api.request(name, 'GET', `/items/${args.id}`, { password: args.password });
            if (item.kind === 'file') return `#${item.id} is a file (${item.fileName}, ${item.fileSize} bytes); only notes can be read here.`;
            // A burn-after-reading note is used up by reading it, so it is never fetched this way
            if (item.burn) return `#${item.id} burns after reading; it is left alone.`;
            const tags = item.tags && item.tags.length ? `\nTags: ${item.tags.join(', ')}` : '';
            return `#${item.id} "${item.title}"${tags}\n\n${item.text}`;
        },
    },
];

// ---- the protocol ----

// onTool(name, failed) is told which tool ran (never its arguments), so the HTTP endpoint can audit it
// api: an existing StashlyApi to use (the HTTP endpoint keeps one for the whole run, so its unlock cookies carry over)
function createServer({ url = 'http://localhost:3000', password = '', fetchImpl, onTool = null, api: shared = null } = {}) {
    const api = shared || new StashlyApi(url, password, fetchImpl);
    const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
    const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    // One message in, the reply out (null for a notification, which gets none)
    async function handle(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
            return message && message.id !== undefined ? error(message.id, -32600, 'Invalid request') : null;
        }
        const { id, method, params = {} } = message;
        const notification = id === undefined || id === null;
        switch (method) {
            case 'initialize': {
                const asked = params.protocolVersion;
                return ok(id, {
                    protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
                    capabilities: { tools: {} },
                    serverInfo: { name: 'stashly', version },
                    instructions: 'Stashly holds notes in "stashes", each at its own link. Create one stash per topic with create_stash, save things with add_note, find them again with list_notes and read_note.',
                });
            }
            case 'ping': return notification ? null : ok(id, {});
            case 'tools/list': return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
            case 'tools/call': {
                const tool = TOOLS.find(t => t.name === params.name);
                if (!tool) return error(id, -32602, `Unknown tool: ${params.name}`);
                try {
                    const text = await tool.run(api, params.arguments || {});
                    if (onTool) onTool(tool.name, false);
                    return ok(id, { content: [{ type: 'text', text }] });
                } catch (err) {
                    if (onTool) onTool(tool.name, true);
                    if (!(err instanceof ToolError)) process.stderr.write(`stashly-mcp: ${err.stack || err}\n`);
                    return ok(id, { content: [{ type: 'text', text: err instanceof ToolError ? err.message : 'Something went wrong in the Stashly server.' }], isError: true });
                }
            }
            default:
                // Notifications (such as notifications/initialized) need no answer
                return notification ? null : error(id, -32601, `Method not found: ${method}`);
        }
    }
    return { handle, api };
}

module.exports = { createServer, stashNameFor, stashName, TOOLS, StashlyApi };
