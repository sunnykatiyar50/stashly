// The server's own MCP endpoint (POST /mcp): it exists only when switched on at startup, needs the access token made in the admin
// area, and runs the same tools as the stdio server, reaching Stashly's own API on the address the request came in on.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { connect } = require('../src/database/sqlite');

const ADMIN = 'admin-pass-123';

async function setup(overrides = {}, options = {}) {
    const ctx = makeApp({ adminPassword: ADMIN, mcpEnabled: true, ...overrides }, options);
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    const makeToken = async () => (await admin.post('/api/admin/mcp/token').expect(201)).body.token;
    const rpc = (token, method, params, id = 1) =>
        request(ctx.app).post('/mcp').set('Authorization', `Bearer ${token}`).send({ jsonrpc: '2.0', id, method, params });
    const call = async (token, name, args) => (await rpc(token, 'tools/call', { name, arguments: args }).expect(200)).body.result;
    return { ...ctx, admin, makeToken, rpc, call };
}

test('the endpoint is not there unless it was switched on when the server started', async () => {
    const ctx = await setup({ mcpEnabled: false });
    await request(ctx.app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' }).expect(404);
    const status = (await ctx.admin.get('/api/admin/mcp').expect(200)).body;
    assert.deepEqual(status, { enabled: false, running: false, tokenSet: false, tokenCreatedAt: null, path: '/mcp' });
    // Without the admin area there is nothing to make a token in, so it cannot be on at all
    const none = makeApp({ mcpEnabled: true });
    assert.equal(none.config.mcpEnabled, false);
    await request(none.app).post('/mcp').send({}).expect(404);
});

test('turning it on in the settings is saved at once but only takes effect after a restart', async () => {
    const db = connect(':memory:');
    const first = await setup({ mcpEnabled: false }, { db });
    await first.admin.put('/api/admin/settings').send({ values: { mcpEnabled: true } }).expect(200);
    const saved = (await first.admin.get('/api/admin/mcp').expect(200)).body;
    assert.equal(saved.enabled, true);
    assert.equal(saved.running, false, 'still not running in this run');
    await request(first.app).post('/mcp').send({}).expect(404);
    const group = (await first.admin.get('/api/admin/settings').expect(200)).body.fields.find(f => f.key === 'mcpEnabled');
    assert.equal(group.group, 'MCP');

    // The next start reads the saved setting and mounts the endpoint
    const second = await setup({ mcpEnabled: false }, { db });
    assert.equal(second.config.mcpEnabled, true);
    const status = (await second.admin.get('/api/admin/mcp').expect(200)).body;
    assert.deepEqual([status.enabled, status.running], [true, true]);
    await request(second.app).post('/mcp').send({}).expect(401);
});

test('every request needs the access token: none made yet, a wrong one and a revoked one are all refused', async () => {
    const ctx = await setup();
    const ping = token => ctx.rpc(token, 'ping');
    const none = await request(ctx.app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' }).expect(401);
    assert.match(none.body.error, /no access token yet/);
    assert.equal(none.headers['www-authenticate'], 'Bearer');

    const token = await ctx.makeToken();
    assert.match(token, /^stm_[A-Za-z0-9_-]{30,}$/);
    await request(ctx.app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' }).expect(401);
    await ping('stm_wrong').expect(401);
    await request(ctx.app).post('/mcp').set('Authorization', token).send({}).expect(401);
    assert.deepEqual((await ping(token).expect(200)).body.result, {});

    // The status never carries the token, and only its hash is stored
    const status = (await ctx.admin.get('/api/admin/mcp').expect(200)).body;
    assert.equal(status.tokenSet, true);
    assert.ok(!JSON.stringify(status).includes(token));
    assert.ok(!JSON.stringify(ctx.db.prepare("SELECT value FROM meta WHERE key = 'mcp_token'").get()).includes(token));

    // A new token replaces the old one at once; revoking ends the new one
    const next = await ctx.makeToken();
    await ping(token).expect(401);
    await ping(next).expect(200);
    await ctx.admin.delete('/api/admin/mcp/token').expect(200);
    await ping(next).expect(401);
    assert.equal((await ctx.admin.get('/api/admin/mcp').expect(200)).body.tokenSet, false);
});

test('only the admin can make or revoke the token', async () => {
    const ctx = await setup();
    const stranger = request.agent(ctx.app);
    for (const [method, path] of [['get', '/api/admin/mcp'], ['post', '/api/admin/mcp/token'], ['delete', '/api/admin/mcp/token']]) {
        const res = await stranger[method](path);
        assert.ok([401, 403].includes(res.status), `${method} ${path} gave ${res.status}`);
    }
});

test('the protocol over HTTP: handshake, tool list, notifications get no body, batches and bad bodies are refused', async () => {
    const ctx = await setup();
    const token = await ctx.makeToken();
    const init = (await ctx.rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }).expect(200)).body;
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'stashly');
    const tools = (await ctx.rpc(token, 'tools/list').expect(200)).body.result.tools;
    assert.deepEqual(tools.map(t => t.name), ['create_stash', 'add_note', 'list_notes', 'read_note']);

    await request(ctx.app).post('/mcp').set('Authorization', `Bearer ${token}`).send({ jsonrpc: '2.0', method: 'notifications/initialized' }).expect(202);
    await request(ctx.app).post('/mcp').set('Authorization', `Bearer ${token}`).send([{ jsonrpc: '2.0', id: 1, method: 'ping' }]).expect(400);
    await request(ctx.app).post('/mcp').set('Authorization', `Bearer ${token}`).set('Content-Type', 'text/plain').send('ping').expect(400);
    assert.equal((await ctx.rpc(token, 'nope').expect(200)).body.error.code, -32601);
    // There is no event stream or session to end
    await request(ctx.app).get('/mcp').expect(405);
    await request(ctx.app).delete('/mcp').expect(405);
});

test('the tools work over HTTP: create a stash for a topic, add a tagged note, list and read it', async () => {
    const ctx = await setup();
    const token = await ctx.makeToken();
    const made = await ctx.call(token, 'create_stash', { topic: 'Q3 launch plan' });
    assert.ok(!made.isError, made.content[0].text);
    const name = /Created stash "([^"]+)"/.exec(made.content[0].text)[1];
    assert.match(name, /^q3-launch-plan-/);
    assert.ok(ctx.model.findBySlug(name), 'the stash exists on this server');

    const added = await ctx.call(token, 'add_note', { stash: name, text: 'Ship on Tuesday.', title: 'Findings', tags: ['Launch'] });
    assert.ok(!added.isError, added.content[0].text);
    assert.match(added.content[0].text, /Tags: launch/);
    const listed = (await ctx.call(token, 'list_notes', { stash: name, tag: 'launch' })).content[0].text;
    assert.match(listed, /^1 item\(s\)/);
    const id = /note (\d+)/.exec(added.content[0].text)[1];
    assert.match((await ctx.call(token, 'read_note', { stash: name, id: Number(id) })).content[0].text, /Ship on Tuesday\./);
});

test('links in the answers use the public address (or the host the client called), never the internal one the tools call on', async () => {
    const ctx = await setup({ publicUrl: 'https://stash.example.com' });
    const token = await ctx.makeToken();
    const made = (await ctx.call(token, 'create_stash', { topic: 'Public link' })).content[0].text;
    assert.match(made, /Link: https:\/\/stash\.example\.com\/s\/public-link-/);

    const plain = await setup();
    const plainToken = await plain.makeToken();
    const reply = await request(plain.app).post('/mcp').set('Authorization', `Bearer ${plainToken}`).set('Host', 'stashly.lan:8080')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_stash', arguments: { topic: 'Host link' } } }).expect(200);
    const text = reply.body.result.content[0].text;
    assert.match(text, /Link: http:\/\/stashly\.lan:8080\/s\/host-link-/);
    assert.ok(!text.includes('127.0.0.1'));
});

test('a stash made with a password is remembered by the server, and a protected stash needs its password', async () => {
    const ctx = await setup();
    const token = await ctx.makeToken();
    const made = await ctx.call(token, 'create_stash', { topic: 'Private plans', password: 'correct horse battery' });
    assert.ok(!made.isError, made.content[0].text);
    const added = await ctx.call(token, 'add_note', { stash: 'private-plans', text: 'secret thing' });
    assert.ok(!added.isError, added.content[0].text);

    // A stash someone else made with a password is not opened without it
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked-by-someone', password: 'correct horse battery' }).expect(201);
    const refused = await ctx.call(token, 'add_note', { stash: 'locked-by-someone', text: 'x' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /password protected/);
    const opened = await ctx.call(token, 'add_note', { stash: 'locked-by-someone', text: 'x', password: 'correct horse battery' });
    assert.ok(!opened.isError, opened.content[0].text);
});

test('it acts like any other visitor: a server that only lets the admin create stashes refuses create_stash', async () => {
    const ctx = await setup({ requireAdminToCreate: true });
    const token = await ctx.makeToken();
    const refused = await ctx.call(token, 'create_stash', { topic: 'Not allowed' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Only the admin can create stashes/);
});

test('the audit log records the tool and the address, never the arguments or the token', async () => {
    const audit = [];
    const access = [];
    const ctx = await setup({ logFormat: 'json', auditLog: 'stdout' }, { logOut: line => access.push(line), auditOut: line => audit.push(line) });
    const token = await ctx.makeToken();
    await ctx.call(token, 'create_stash', { topic: 'Audited topic' });
    await ctx.call(token, 'add_note', { stash: 'no-such-stash-here', text: 'secret words in a note' });
    await ctx.admin.delete('/api/admin/mcp/token').expect(200);

    const events = audit.map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.event).filter(name => name.includes('mcp')), ['admin.mcp_token_created', 'mcp.tool_called', 'mcp.tool_called', 'admin.mcp_token_revoked']);
    const calls = events.filter(e => e.event === 'mcp.tool_called');
    assert.deepEqual(calls.map(e => e.detail), [{ tool: 'create_stash', failed: false }, { tool: 'add_note', failed: true }]);
    assert.ok(calls.every(e => e.actor === 'mcp' && e.ip));
    const everything = [...audit, ...access].join('\n');
    assert.ok(!everything.includes(token), 'the token is in a log line');
    assert.ok(!everything.includes('secret words in a note'));
    assert.ok(!everything.includes('Audited topic'));
});

test('wrong tokens are rate limited per address, while correct requests never count towards the limit', async () => {
    const ctx = await setup();
    const token = await ctx.makeToken();
    // Many correct requests in a row: none is refused, however many
    for (let i = 0; i < 40; i++) await ctx.rpc(token, 'ping').expect(200);
    const statuses = [];
    for (let i = 0; i < 33; i++) statuses.push((await ctx.rpc(`stm_wrong${i}`, 'ping')).status);
    assert.ok(statuses.includes(429), `expected a 429, got ${[...new Set(statuses)].join(',')}`);
});
