// The MCP server (bin/stashly-mcp.js): protocol basics over a real stdio pipe, and each tool against a real app.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeApp } = require('./helpers/app');
const { stashNameFor, stashName } = require('../bin/stashly-mcp');

const SERVER = path.join(__dirname, '..', 'bin', 'stashly-mcp.js');

// The app on a free port, and an MCP client talking to the server process over its stdin and stdout
async function setup(env = {}) {
    const ctx = makeApp();
    const http = ctx.app.listen(0);
    await new Promise(resolve => http.once('listening', resolve));
    const url = `http://127.0.0.1:${http.address().port}`;
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, STASHLY_URL: url, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const waiting = new Map();
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            const message = JSON.parse(line);
            const resolve = waiting.get(message.id);
            if (resolve) { waiting.delete(message.id); resolve(message); }
        }
    });
    let next = 1;
    const rpc = (method, params) => new Promise(resolve => {
        const id = next++;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const call = async (name, args) => {
        const reply = await rpc('tools/call', { name, arguments: args });
        return { text: reply.result.content[0].text, isError: Boolean(reply.result.isError), reply };
    };
    const done = () => { child.stdin.end(); child.kill(); http.close(); http.closeAllConnections(); };
    return { ...ctx, url, child, rpc, call, done };
}

test('names: a topic becomes a safe stash name, with an unguessable tail when there is no password', () => {
    assert.match(stashNameFor('Q3 launch plan!', false), /^q3-launch-plan-[a-z2-7]{6,}$/);
    assert.ok(stashNameFor('x', false).length >= 12);
    assert.equal(stashNameFor('Q3 launch plan', true), 'q3-launch-plan');
    assert.match(stashNameFor('Ünïcode café', true), /^unicode-cafe$/);
    assert.match(stashNameFor('!!!', false), /^stash-/);
    assert.equal(stashName('http://host:3000/s/My-Stash#key'), 'my-stash');
    assert.equal(stashName('plain-name'), 'plain-name');
    assert.throws(() => stashName('bad name!'), /only letters/);
    assert.throws(() => stashName(''), /which stash/);
});

test('it answers the MCP handshake, lists its tools and answers ping', async () => {
    const t = await setup();
    try {
        const init = await t.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        assert.equal(init.result.protocolVersion, '2025-03-26');
        assert.deepEqual(init.result.capabilities, { tools: {} });
        assert.equal(init.result.serverInfo.name, 'stashly');
        // An unknown version gets the newest one this server speaks
        assert.equal((await t.rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
        child_notify(t.child, 'notifications/initialized');
        const tools = (await t.rpc('tools/list')).result.tools;
        assert.deepEqual(tools.map(x => x.name), ['create_stash', 'add_note', 'list_notes', 'read_note']);
        assert.ok(tools.every(x => x.description && x.inputSchema.type === 'object'));
        assert.deepEqual((await t.rpc('ping')).result, {});
        assert.equal((await t.rpc('nope/nothing')).error.code, -32601);
        assert.equal((await t.rpc('tools/call', { name: 'delete_everything', arguments: {} })).error.code, -32602);
    } finally {
        t.done();
    }
});

function child_notify(child, method) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

test('create_stash makes a stash for a topic, add_note fills it, list_notes and read_note read it back', async () => {
    const t = await setup();
    try {
        const made = await t.call('create_stash', { topic: 'Q3 launch plan' });
        assert.equal(made.isError, false, made.text);
        const name = /Created stash "([^"]+)"/.exec(made.text)[1];
        assert.match(name, /^q3-launch-plan-/);
        assert.ok(made.text.includes(`${t.url}/s/${name}`));
        assert.ok(t.model.findBySlug(name));

        const added = await t.call('add_note', { stash: name, text: '# Findings\nShip on Tuesday.', title: 'Findings', tags: ['Launch', '#q3'] });
        assert.equal(added.isError, false, added.text);
        assert.match(added.text, /Added note \d+ \("Findings"\)/);
        assert.match(added.text, /Tags: launch, q3/);
        await t.call('add_note', { stash: `${t.url}/s/${name}`, text: 'a second note, given by link' });

        const listed = await t.call('list_notes', { stash: name });
        assert.match(listed.text, /^2 item\(s\)/);
        assert.match(listed.text, /"Findings" \[launch, q3\]: # Findings Ship on Tuesday\./);
        assert.match(listed.text, /Tags in this stash: launch \(1\), q3 \(1\)/);
        assert.match((await t.call('list_notes', { stash: name, tag: 'launch' })).text, /^1 item\(s\)/);
        assert.match((await t.call('list_notes', { stash: name, search: 'second' })).text, /^1 item\(s\)/);
        assert.equal((await t.call('list_notes', { stash: name, search: 'zzz' })).text, 'No notes match.');

        const id = /note (\d+)/.exec(added.text)[1];
        const read = await t.call('read_note', { stash: name, id: Number(id) });
        assert.match(read.text, /^#\d+ "Findings"\nTags: launch, q3\n\n# Findings\nShip on Tuesday\.$/);
    } finally {
        t.done();
    }
});

test('add_note can create the stash when it is missing, and says so when it is not', async () => {
    const t = await setup();
    try {
        const missing = await t.call('add_note', { stash: 'no-such-stash-yet', text: 'hello' });
        assert.equal(missing.isError, true);
        assert.match(missing.text, /no stash called no-such-stash-yet/);
        assert.equal(t.model.findBySlug('no-such-stash-yet'), null);

        const made = await t.call('add_note', { stash: 'ideas', text: 'first idea', create_if_missing: true });
        assert.equal(made.isError, false, made.text);
        const name = /Created stash "([^"]+)"/.exec(made.text)[1];
        assert.ok(name.length >= 12 && name.startsWith('ideas-'), 'a short name gets an unguessable tail');
        assert.ok(t.model.findBySlug(name));
    } finally {
        t.done();
    }
});

test('a stash created with a password is remembered for the rest of the run', async () => {
    const t = await setup();
    try {
        const made = await t.call('create_stash', { topic: 'Private plans', password: 'correct horse battery' });
        const name = /Created stash "([^"]+)"/.exec(made.text)[1];
        assert.equal(name, 'private-plans');
        assert.match(made.text, /password protected/);
        assert.equal((await t.call('add_note', { stash: name, text: 'secret thing' })).isError, false);
        assert.match((await t.call('list_notes', { stash: name })).text, /secret thing/);
    } finally {
        t.done();
    }
});

test('a password given to a tool call, or in STASHLY_PASSWORD, opens a protected stash', async () => {
    const ctx = makeApp();
    const request = require('supertest');
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked-stash', password: 'correct horse battery' }).expect(201);
    const { createServer } = require('../bin/stashly-mcp');
    const live = ctx.app.listen(0);
    await new Promise(resolve => live.once('listening', resolve));
    const base = `http://127.0.0.1:${live.address().port}`;
    const run = async (server, name, args) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
    try {
        const none = createServer({ url: base });
        const refused = await run(none, 'add_note', { stash: 'locked-stash', text: 'x' });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, /password protected/);

        const wrong = await run(none, 'add_note', { stash: 'locked-stash', text: 'x', password: 'not the password' });
        assert.equal(wrong.isError, true);
        assert.match(wrong.content[0].text, /Could not open locked-stash/);

        const given = await run(createServer({ url: base }), 'add_note', { stash: 'locked-stash', text: 'with a password', password: 'correct horse battery' });
        assert.ok(!given.isError, given.content[0].text);

        const env = createServer({ url: base, password: 'correct horse battery' });
        const listed = await run(env, 'list_notes', { stash: 'locked-stash' });
        assert.match(listed.content[0].text, /with a password/);
    } finally {
        live.close();
        live.closeAllConnections();
    }
});

test('bad input and unreachable servers come back as tool errors, not crashes', async () => {
    const t = await setup();
    try {
        assert.match((await t.call('create_stash', {})).text, /Give a topic/);
        assert.match((await t.call('add_note', { stash: 'whatever-stash', text: '   ' })).text, /empty/);
        assert.match((await t.call('read_note', { stash: 'whatever-stash', id: 'x' })).text, /number list_notes shows/);
        const note = await t.call('create_stash', { topic: 'Burn test' });
        const name = /Created stash "([^"]+)"/.exec(note.text)[1];
        await t.call('add_note', { stash: name, text: 'fine' });
        // A burn-after-reading note is never read (reading would use it up)
        const burn = await require('supertest')(t.app).post(`/api/stashes/${name}/notes`).send({ text: 'once only', burn: true }).expect(201);
        const read = await t.call('read_note', { stash: name, id: burn.body.id });
        assert.match(read.text, /burns after reading; it is left alone/);
        assert.equal(t.model.getItem(t.model.findBySlug(name).id, burn.body.id).text, 'once only');
        assert.match((await t.call('list_notes', { stash: name })).text, /burn after reading: not shown/);
    } finally {
        t.done();
    }

    const dead = await setup({ STASHLY_URL: 'http://127.0.0.1:1' });
    try {
        const reply = await dead.call('list_notes', { stash: 'some-stash' });
        assert.equal(reply.isError, true);
        assert.match(reply.text, /Cannot reach Stashly/);
    } finally {
        dead.done();
    }
});
