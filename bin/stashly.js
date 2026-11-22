#!/usr/bin/env node
'use strict';
// A small command line for Stashly, for people who would otherwise reach for curl. One file, nothing to install
// beyond Node 22. It talks to the same HTTP API as the web page; see the README for the commands.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const HELP = `Usage: stashly [--url URL] [--password PASSWORD] <command> ...

  send NAME "text"            add a note (text from stdin when it is missing or "-")
  send NAME --file PATH       upload a file (--title T gives the note or file a title)
  get NAME                    print the newest note
  list NAME                   list the items (id, kind, size, date, title)
  pull NAME ID [--out PATH]   download a file item (default: its own name here; "-" for stdout)
  export NAME [--out FILE]    download the whole stash as a zip (default NAME.zip)
  new NAME [--ttl 1d] [--password P]   create a stash

Settings: STASHLY_URL (default http://localhost:3000) and STASHLY_PASSWORD, or --url and --password.
Exit status is 0 when it worked and 1 on any error, with the reason on stderr.`;

class CliError extends Error {}
const fail = message => { throw new CliError(message); };

// --name value pairs and plain words, in any order. A lone "-" is a word (it means stdin or stdout).
function parseArgs(argv) {
    const flags = {};
    const words = [];
    const known = ['url', 'password', 'file', 'title', 'out', 'ttl'];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') flags.help = true;
        else if (arg.startsWith('--') && arg.length > 2) {
            const [name, inline] = arg.slice(2).split(/=(.*)/s);
            if (!known.includes(name)) fail(`Unknown option --${name}. Try --help.`);
            const value = inline !== undefined ? inline : argv[++i];
            if (value === undefined) fail(`--${name} needs a value.`);
            flags[name] = value;
        } else words.push(arg);
    }
    return { flags, words };
}

class Client {
    constructor(base, password) {
        this.base = base.replace(/\/+$/, '');
        this.password = password;
        this.cookies = new Map(); // kept for this run only
    }

    // One request. Anything that is not 2xx becomes an error carrying the server's own message.
    async request(method, urlPath, { headers = {}, json, body, duplex } = {}) {
        const sent = { ...headers };
        if (json !== undefined) { body = JSON.stringify(json); sent['Content-Type'] = 'application/json'; }
        if (this.cookies.size) sent.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        let res;
        try {
            // Never follow a redirect: the cookie must only go to the server that was asked for
            res = await fetch(this.base + urlPath, { method, headers: sent, body, duplex, redirect: 'error' });
        } catch (err) {
            fail(`Cannot reach ${this.base}: ${(err.cause && err.cause.message) || err.message}`);
        }
        for (const line of res.headers.getSetCookie()) {
            const [pair] = line.split(';');
            const eq = pair.indexOf('=');
            this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
        if (!res.ok) {
            const text = await res.text();
            let message = text.trim();
            try { message = JSON.parse(text).error || message; } catch { /* plain text answer */ }
            fail(message || `The server answered ${res.status}.`);
        }
        return res;
    }

    // Opens a password-protected stash (a stash without a password answers ok and sets no cookie)
    async open(name) {
        if (this.password) await this.request('POST', `/api/stashes/${encodeURIComponent(name)}/unlock`, { json: { password: this.password } });
        return `/api/stashes/${encodeURIComponent(name)}`;
    }
}

const need = (words, count, usage) => { if (words.length < count) fail(`Usage: stashly ${usage}`); };

async function readStdin() {
    if (process.stdin.isTTY) fail('No text given: pass it as an argument, or pipe it in.');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

// Streams a response body to a file (or stdout for "-"), and removes the half-written file on failure
async function saveBody(res, target) {
    const source = Readable.fromWeb(res.body);
    if (target === '-') return pipeline(source, process.stdout, { end: false });
    const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    try {
        await pipeline(source, out);
    } catch (err) {
        fs.rmSync(target, { force: true });
        if (err.code === 'EEXIST') fail(`${target} already exists; pick another with --out.`);
        fail(`Could not save ${target}: ${err.message}`);
    }
}

// The file name the server suggests, reduced to a plain name so it can never point outside this folder
function suggestedName(res, fallback) {
    const match = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('content-disposition') || '');
    let name = fallback;
    try { if (match) name = decodeURIComponent(match[1]); } catch { /* keep the fallback */ }
    return path.basename(name.replace(/\\/g, '/')) || fallback;
}

const COMMANDS = {
    async send(client, { flags, words }) {
        need(words, 1, 'send NAME "text" | send NAME --file PATH');
        const [name, text] = words;
        const base = await client.open(name);
        if (flags.file) {
            if (text !== undefined) fail('Give either text or --file, not both.');
            const stat = fs.statSync(flags.file, { throwIfNoEntry: false });
            if (!stat || !stat.isFile()) fail(`${flags.file} is not a file.`);
            const size = stat.size;
            const headers = { 'X-File-Name': encodeURIComponent(path.basename(flags.file)), 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) };
            if (flags.title) headers['X-Title'] = encodeURIComponent(flags.title);
            // Read from disk as it is sent, so a large file is never held in memory
            const body = Readable.toWeb(fs.createReadStream(flags.file));
            const item = await (await client.request('POST', `${base}/files`, { headers, body, duplex: 'half' })).json();
            return `Sent file ${item.fileName} (id ${item.id}, ${item.fileSize} bytes)`;
        }
        const content = text === undefined || text === '-' ? await readStdin() : text;
        if (!content.trim()) fail('The note is empty.');
        const item = await (await client.request('POST', `${base}/notes`, { json: { text: content, ...(flags.title ? { title: flags.title } : {}) } })).json();
        return `Sent note ${item.id}`;
    },

    async get(client, { words }) {
        need(words, 1, 'get NAME');
        const res = await client.request('GET', `${await client.open(words[0])}/latest`);
        process.stdout.write(await res.text());
    },

    async list(client, { words }) {
        need(words, 1, 'list NAME');
        const stash = await (await client.request('GET', await client.open(words[0]))).json();
        if (!stash.items.length) return 'No items yet.';
        return stash.items
            .map(i => [i.id, i.kind, i.kind === 'file' ? `${i.fileSize}B` : i.burn ? 'burn' : `${(i.text || '').length}c`, i.createdAt.slice(0, 16).replace('T', ' '), i.title].join('\t'))
            .join('\n');
    },

    async pull(client, { flags, words }) {
        need(words, 2, 'pull NAME ID [--out PATH]');
        if (!/^\d+$/.test(words[1])) fail('ID must be the number shown by "stashly list".');
        const res = await client.request('GET', `${await client.open(words[0])}/files/${words[1]}?download=1`);
        const target = flags.out || suggestedName(res, `file-${words[1]}`);
        await saveBody(res, target);
        return target === '-' ? undefined : `Saved ${target}`;
    },

    async export(client, { flags, words }) {
        need(words, 1, 'export NAME [--out FILE]');
        const res = await client.request('GET', `${await client.open(words[0])}/export`);
        const target = flags.out || `${words[0]}.zip`;
        await saveBody(res, target);
        return target === '-' ? undefined : `Saved ${target}`;
    },

    // Creating a stash sets its password; it does not unlock anything
    async new(client, { flags, words }) {
        need(words, 1, 'new NAME [--ttl 1d] [--password P]');
        const body = { slug: words[0], ttl: flags.ttl, password: flags.password || undefined };
        const stash = await (await client.request('POST', '/api/stashes', { json: body })).json();
        return `Created ${client.base}/s/${stash.slug}${body.password ? ' (password protected)' : ''}`;
    },
};

async function main(argv, env) {
    const { flags, words } = parseArgs(argv);
    const command = words.shift();
    if (flags.help || !command || command === 'help') return console.log(HELP);
    if (!Object.hasOwn(COMMANDS, command)) fail(`Unknown command "${command}". Try --help.`);
    const base = flags.url || env.STASHLY_URL || 'http://localhost:3000';
    const client = new Client(base, flags.password || env.STASHLY_PASSWORD || '');
    const message = await COMMANDS[command](client, { flags, words });
    if (message) console.log(message);
}

main(process.argv.slice(2), process.env).catch(err => {
    console.error(`stashly: ${err instanceof CliError ? err.message : err.stack || err}`);
    process.exitCode = 1;
});
