const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

async function stash(ctx, slug = 'clips') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

// Adds notes one second apart so their order is clear
async function addNotes(ctx, base, texts) {
    const ids = [];
    for (const text of texts) {
        ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
        ids.push((await request(ctx.app).post(`${base}/notes`).send({ text }).expect(201)).body.id);
    }
    return ids;
}

const texts = async (ctx, base) => (await request(ctx.app).get(base).expect(200)).body.items.map(i => i.text || i.fileName);

// ---- pin ----

test('a pinned item stays at the top, whatever its age, and can be unpinned', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const [oldest] = await addNotes(ctx, base, ['oldest', 'middle', 'newest']);
    assert.deepEqual(await texts(ctx, base), ['newest', 'middle', 'oldest']);

    const pinned = await request(ctx.app).post(`${base}/items/${oldest}/pin`).send({ pinned: true }).expect(200);
    assert.equal(pinned.body.pinned, true);
    assert.deepEqual(await texts(ctx, base), ['oldest', 'newest', 'middle']);

    await request(ctx.app).post(`${base}/items/${oldest}/pin`).send({ pinned: false }).expect(200);
    assert.deepEqual(await texts(ctx, base), ['newest', 'middle', 'oldest']);
});

test('pinning tells open pages, and needs a real item and a yes or no', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const [id] = await addNotes(ctx, base, ['x']);
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ event, id: data.id, pinned: data.pinned });
    await request(ctx.app).post(`${base}/items/${id}/pin`).send({ pinned: true }).expect(200);
    assert.deepEqual(published, [{ event: 'item-updated', id, pinned: true }]);
    await request(ctx.app).post(`${base}/items/${id}/pin`).send({ pinned: 'yes' }).expect(400);
    await request(ctx.app).post(`${base}/items/999/pin`).send({ pinned: true }).expect(404);
});

test('a file can be pinned too', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
    await addNotes(ctx, base, ['newer note']);
    await request(ctx.app).post(`${base}/items/${file.body.id}/pin`).send({ pinned: true }).expect(200);
    assert.deepEqual(await texts(ctx, base), ['a.png', 'newer note']);
});

// ---- keep the last N ----

test('keep-last deletes the oldest unpinned items beyond N as new ones arrive', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 3 }).expect(200);
    const published = [];
    const original = ctx.events.publish.bind(ctx.events);
    ctx.events.publish = (slug, event, data) => { published.push({ event, id: data.id }); original(slug, event, data); };

    const ids = await addNotes(ctx, base, ['one', 'two', 'three', 'four', 'five']);
    assert.deepEqual(await texts(ctx, base), ['five', 'four', 'three']);
    const deleted = published.filter(p => p.event === 'item-deleted').map(p => p.id);
    assert.deepEqual(deleted, [ids[0], ids[1]]);
    assert.equal((await request(ctx.app).get(base)).body.keepLast, 3);
});

test('pinned items are never trimmed and do not count towards N', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const [first] = await addNotes(ctx, base, ['keep me forever']);
    await request(ctx.app).post(`${base}/items/${first}/pin`).send({ pinned: true }).expect(200);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 2 }).expect(200);
    await addNotes(ctx, base, ['a', 'b', 'c', 'd']);
    assert.deepEqual(await texts(ctx, base), ['keep me forever', 'd', 'c']);
});

test('keep-last applies to files as well as notes', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 1 }).expect(200);
    await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
    await addNotes(ctx, base, ['replaces the file']);
    assert.deepEqual(await texts(ctx, base), ['replaces the file']);
    assert.equal(ctx.model.totalBytes(), 0);
});

test('lowering keep-last trims at once, and null turns it off', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await addNotes(ctx, base, ['1', '2', '3', '4']);
    const res = await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 2 }).expect(200);
    assert.equal(res.body.removed, 2);
    assert.deepEqual(await texts(ctx, base), ['4', '3']);

    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: null }).expect(200);
    await addNotes(ctx, base, ['5', '6']);
    assert.equal((await texts(ctx, base)).length, 4);
    assert.equal((await request(ctx.app).get(base)).body.keepLast, null);
});

test('keep-last must be a sensible number', async () => {
    const ctx = makeApp({ maxItemsPerStash: 50 });
    const base = await stash(ctx);
    for (const keepLast of [-1, 1.5, 'lots', 51]) {
        await request(ctx.app).put(`${base}/keep-last`).send({ keepLast }).expect(400);
    }
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 50 }).expect(200);
});

// ---- edit ----

test('a note can be edited in place: text and title change, its date and options stay', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ title: 'old title', text: 'old text', secret: true, expires: '1h' }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 60000);
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ event, text: data.text });

    const res = await request(ctx.app).put(`${base}/items/${added.body.id}`).send({ title: 'new title', text: 'new text\r\nline two' }).expect(200);
    assert.equal(res.body.title, 'new title');
    assert.equal(res.body.text, 'new text\nline two');
    assert.equal(res.body.createdAt, added.body.createdAt);
    assert.equal(res.body.secret, true);
    assert.equal(res.body.expiresAt, added.body.expiresAt);
    assert.equal(res.body.editedAt, ctx.clock.time.toISOString());
    assert.deepEqual(published, [{ event: 'item-updated', text: 'new text\nline two' }]);

    const list = await request(ctx.app).get(base).expect(200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].text, 'new text\nline two');
});

test('clearing the title goes back to the first 40 characters of the text', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ title: 'given', text: 'whatever' }).expect(201);
    const res = await request(ctx.app).put(`${base}/items/${added.body.id}`).send({ title: '', text: 'one two three four five six' }).expect(200);
    assert.equal(res.body.hasTitle, false);
    assert.equal(res.body.title, 'one two three four five six');
});

test('editing refuses empty or oversized text, a long title, the content of a file, burn notes and missing items', async () => {
    const ctx = makeApp({ maxNoteBytes: 20 });
    const base = await stash(ctx);
    const note = await request(ctx.app).post(`${base}/notes`).send({ text: 'short' }).expect(201);
    const burn = await request(ctx.app).post(`${base}/notes`).send({ text: 'burn', burn: true }).expect(201);
    const file = await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);

    await request(ctx.app).put(`${base}/items/${note.body.id}`).send({ text: '   ' }).expect(400);
    await request(ctx.app).put(`${base}/items/${note.body.id}`).send({ text: 'x'.repeat(21) }).expect(413);
    await request(ctx.app).put(`${base}/items/${note.body.id}`).send({ text: 'ok', title: 'x'.repeat(151) }).expect(400);
    await request(ctx.app).put(`${base}/items/${burn.body.id}`).send({ text: 'changed' }).expect(400);
    // A file's title can be changed (see files.test.js), but not its content
    await request(ctx.app).put(`${base}/items/${file.body.id}`).send({ text: 'changed' }).expect(400);
    await request(ctx.app).put(`${base}/items/999`).send({ text: 'changed' }).expect(404);
    assert.equal((await request(ctx.app).get(base)).body.items.find(i => i.id === note.body.id).text, 'short');
});

test('an edited note is found by its new text, not the old', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const added = await request(ctx.app).post(`${base}/notes`).send({ text: 'apples' }).expect(201);
    await request(ctx.app).put(`${base}/items/${added.body.id}`).send({ text: 'oranges' }).expect(200);
    assert.equal((await request(ctx.app).get(`${base}?search=oranges`)).body.items.length, 1);
    assert.equal((await request(ctx.app).get(`${base}?search=apples`)).body.items.length, 0);
});

// ---- who may do these ----

test('read-only and drop-box links cannot pin, edit or change keep-last', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'vault', password: 'correct horse' }).expect(201);
    const note = await owner.post('/api/stashes/vault/notes').send({ text: 'x' }).expect(201);
    const view = (await owner.post('/api/stashes/vault/share-links').send({ kind: 'view' }).expect(201)).body.token;
    const drop = (await owner.post('/api/stashes/vault/share-links').send({ kind: 'drop' }).expect(201)).body.token;
    const viewer = request.agent(ctx.app);
    await viewer.post('/api/stashes/vault/redeem').send({ token: view }).expect(200);
    const dropper = request.agent(ctx.app);
    await dropper.post('/api/stashes/vault/redeem').send({ token: drop }).expect(200);

    for (const agent of [viewer, dropper]) {
        await agent.post(`/api/stashes/vault/items/${note.body.id}/pin`).send({ pinned: true }).expect(403);
        await agent.put(`/api/stashes/vault/items/${note.body.id}`).send({ text: 'hacked' }).expect(403);
        await agent.put('/api/stashes/vault/keep-last').send({ keepLast: 1 }).expect(403);
    }
    const seen = await owner.get('/api/stashes/vault').expect(200);
    assert.equal(seen.body.items[0].text, 'x');
    assert.equal(seen.body.items[0].pinned, false);
    assert.equal(seen.body.keepLast, null);
});

test('an old database gets the pin, edit and keep-last columns', () => {
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
    const items = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
    const stashes = db.prepare('PRAGMA table_info(stashes)').all().map(c => c.name);
    for (const column of ['pinned', 'edited_at']) assert.ok(items.includes(column), column);
    assert.ok(stashes.includes('keep_last'));
    db.close();
});

// ---- live events: which page added an item ----

test('a live "item-added" event says which page added it, and rejects odd ids', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const seen = [];
    ctx.events.publish = (slug, event, data) => { if (event === 'item-added') seen.push(data.origin); };
    await request(ctx.app).post(`${base}/notes`).set('X-Tab-Id', 'abc123').send({ text: 'a' }).expect(201);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'b' }).expect(201);
    await request(ctx.app).post(`${base}/notes`).set('X-Tab-Id', '<script>').send({ text: 'c' }).expect(201);
    await request(ctx.app).post(`${base}/files`).set('X-Tab-Id', 'file-tab').set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
    assert.deepEqual(seen, ['abc123', null, null, 'file-tab']);
    // The id is only for the live event: it is not stored or listed
    assert.ok(!('origin' in (await request(ctx.app).get(base)).body.items[0]));
});
