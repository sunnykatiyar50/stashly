const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

async function stash(ctx, slug = 'opts', body = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);
    return `/api/stashes/${slug}`;
}

const minutes = n => n * 60 * 1000;

// ---- per-note expiry ----

test('a note with its own expiry disappears when the time is up, before the cleanup job runs', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'short lived', expires: '5m' }).expect(201);
    assert.equal(added.body.expiresAt, new Date(ctx.clock.time.getTime() + minutes(5)).toISOString());
    await request(ctx.app).post(`${base}/notes`).send({ text: 'stays' }).expect(201);

    let res = await request(ctx.app).get(base).expect(200);
    assert.equal(res.body.items.length, 2);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + minutes(6));
    res = await request(ctx.app).get(base).expect(200);
    assert.deepEqual(res.body.items.map(i => i.text), ['stays']);
});

test('the cleanup job deletes expired notes and tells open pages', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'x', expires: '5m' }).expect(201);
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ slug, event, data });

    ctx.controller.cleanup();
    assert.equal(published.length, 0);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + minutes(6));
    ctx.controller.cleanup();
    assert.deepEqual(published, [{ slug: 'opts', event: 'item-deleted', data: { id: added.body.id } }]);
    assert.equal(ctx.model.usage(1).items, 0);
});

test('a note expiry that is not on the list is refused', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const res = await request(ctx.app).post(`${base}/notes`).send({ text: 'x', expires: '10y' }).expect(400);
    assert.equal(res.body.field, 'expires');
});

test('a note never outlives its stash', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'short', { ttl: '1h' });
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'x', expires: '1d' }).expect(201);
    const stashRow = ctx.model.findBySlug('short');
    assert.equal(added.body.expiresAt, stashRow.expires_at);
});

test('the latest-note endpoint skips an expired note', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'old and kept' }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'new but short', expires: '5m' }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + minutes(6));
    const res = await request(ctx.app).get(`${base}/latest`).expect(200);
    assert.equal(res.text, 'old and kept');
});

// ---- burn after reading ----

test('a burn-after-reading note never shows its text in the list, a live event or a search', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const events = [];
    ctx.events.publish = (slug, event, data) => events.push({ event, data });
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'hunter2 is the password', burn: true }).expect(201);
    assert.equal(added.body.burn, true);
    assert.equal(added.body.text, null);
    assert.equal(added.body.title, 'Burn-after-reading note');
    assert.doesNotMatch(JSON.stringify(events), /hunter2/);

    const list = await request(ctx.app).get(base).expect(200);
    assert.equal(list.body.items[0].text, null);
    assert.doesNotMatch(JSON.stringify(list.body), /hunter2/);

    const search = await request(ctx.app).get(`${base}?search=hunter2`).expect(200);
    assert.equal(search.body.items.length, 0);
});

test('revealing a burn note returns its text once, deletes it and tells open pages', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'one time', burn: true }).expect(201);
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ event, data });

    const first = await request(ctx.app).post(`${base}/items/${added.body.id}/reveal`).expect(200);
    assert.equal(first.body.text, 'one time');
    assert.deepEqual(published, [{ event: 'item-deleted', data: { id: added.body.id, burned: true } }]);

    await request(ctx.app).post(`${base}/items/${added.body.id}/reveal`).expect(404);
    const list = await request(ctx.app).get(base).expect(200);
    assert.equal(list.body.items.length, 0);
});

test('reveal refuses a note that does not burn, and keeps it', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'plain' }).expect(201);
    await request(ctx.app).post(`${base}/items/${added.body.id}/reveal`).expect(404);
    const list = await request(ctx.app).get(base).expect(200);
    assert.equal(list.body.items.length, 1);
});

test('reading the latest note with curl uses up a burn note', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app)
        .post(`${base}/notes`)
        .set('Content-Type', 'text/plain')
        .set('X-Burn-After-Read', '1')
        .send('curl secret')
        .expect(201);
    // A GET never uses it up; a POST does
    await request(ctx.app).get(`${base}/latest`).expect(409);
    const first = await request(ctx.app).post(`${base}/latest`).expect(200);
    assert.equal(first.text, 'curl secret');
    await request(ctx.app).get(`${base}/latest`).expect(404);
});

test('revealing needs the stash password like everything else', async () => {
    const ctx = makeApp();
    const agent = request.agent(ctx.app);
    await agent.post('/api/stashes').send({ slug: 'locked', password: 'correct horse' }).expect(201);
    const added = await agent.post('/api/stashes/locked/notes').send({ text: 'x', burn: true }).expect(201);
    await request(ctx.app).post(`/api/stashes/locked/items/${added.body.id}/reveal`).expect(401);
    await agent.post(`/api/stashes/locked/items/${added.body.id}/reveal`).expect(200);
});

// ---- secret notes ----

test('a secret note without a title does not leak its first words as a title', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'api key abc123 for prod', secret: true }).expect(201);
    assert.equal(added.body.secret, true);
    assert.equal(added.body.title, 'Secret note');
    assert.equal(added.body.text, 'api key abc123 for prod');

    const titled = await request(ctx.app).post(`${base}/notes`).send({ title: 'prod key', text: 'abc', secret: true }).expect(201);
    assert.equal(titled.body.title, 'prod key');
});

test('options can be set with headers on a plain-text note', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const res = await request(ctx.app)
        .post(`${base}/notes`)
        .set('Content-Type', 'text/plain')
        .set('X-Secret', 'true')
        .set('X-Expires', '1h')
        .send('from curl')
        .expect(201);
    assert.equal(res.body.secret, true);
    assert.equal(res.body.expiresAt, new Date(ctx.clock.time.getTime() + minutes(60)).toISOString());
});

test('an old database gets the new columns', () => {
    const { connect } = require('../src/database/sqlite');
    const { DatabaseSync } = require('node:sqlite');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-')), 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE stashes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, password_hash TEXT, password_salt TEXT, ttl_ms INTEGER, created_at TEXT NOT NULL, expires_at TEXT)`);
    old.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, stash_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, file_name TEXT, file_type TEXT, file_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, title TEXT)`);
    old.close();
    const db = connect(file);
    const names = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
    for (const column of ['expires_at', 'burn', 'secret']) assert.ok(names.includes(column), column);
    db.close();
});
