const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

async function stash(ctx, slug = 'notes') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

test('notes are added and listed newest first', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    for (const text of ['one', 'two', 'three']) {
        ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
        await request(ctx.app).post(`${base}/notes`).send({ text }).expect(201);
    }
    const res = await request(ctx.app).get(base).expect(200);
    assert.deepEqual(res.body.items.map(i => i.text), ['three', 'two', 'one']);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.items[0].kind, 'note');
    assert.equal(res.body.usage.items, 3);
});

test('notes keep their text exactly, including markup, and line breaks are normalised', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const text = '<script>alert(1)</script>\r\nline two  \n  indented';
    const res = await request(ctx.app).post(`${base}/notes`).send({ text }).expect(201);
    assert.equal(res.body.text, '<script>alert(1)</script>\nline two  \n  indented');
});

test('an empty note, or a note that is not text, is refused', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    for (const body of [{}, { text: '' }, { text: '   \n ' }, { text: 42 }]) {
        await request(ctx.app).post(`${base}/notes`).send(body).expect(400);
    }
});

test('a note over the size limit is refused', async () => {
    const ctx = makeApp({ maxNoteBytes: 100 });
    const base = await stash(ctx);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'x'.repeat(100) }).expect(201);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'x'.repeat(101) }).expect(413);
});

test('curl-style plain text notes and the latest endpoint work', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).get(`${base}/latest`).expect(404);
    await request(ctx.app).post(`${base}/notes`).set('Content-Type', 'text/plain').send('first thing').expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
    await request(ctx.app).post(`${base}/notes`).set('Content-Type', 'text/plain').send('copy me').expect(201);
    const res = await request(ctx.app).get(`${base}/latest`).expect(200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.equal(res.text, 'copy me');
});

test('an item can be deleted, and a missing one is a 404', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = (await request(ctx.app).post(`${base}/notes`).send({ text: 'gone soon' })).body;
    await request(ctx.app).delete(`${base}/items/${note.id}`).expect(200);
    await request(ctx.app).delete(`${base}/items/${note.id}`).expect(404);
    await request(ctx.app).delete(`${base}/items/abc`).expect(404);
    const res = await request(ctx.app).get(base).expect(200);
    assert.equal(res.body.total, 0);
});

test('items belong to one stash: another stash cannot read or delete them', async () => {
    const ctx = makeApp();
    const a = await stash(ctx, 'stash-a');
    const b = await stash(ctx, 'stash-b');
    const note = (await request(ctx.app).post(`${a}/notes`).send({ text: 'private to a' })).body;
    await request(ctx.app).delete(`${b}/items/${note.id}`).expect(404);
    const res = await request(ctx.app).get(b).expect(200);
    assert.equal(res.body.total, 0);
});

test('search matches note text, case-insensitively, and treats % and _ literally', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    for (const text of ['Deploy token: abc', 'lunch plan', '100% done', 'snake_case name']) {
        ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
        await request(ctx.app).post(`${base}/notes`).send({ text }).expect(201);
    }
    const texts = async q => (await request(ctx.app).get(base).query({ search: q }).expect(200)).body.items.map(i => i.text);
    assert.deepEqual(await texts('DEPLOY'), ['Deploy token: abc']);
    assert.deepEqual(await texts('100%'), ['100% done']);
    assert.deepEqual(await texts('%'), ['100% done']);
    assert.deepEqual(await texts('e_c'), ['snake_case name']);
    assert.deepEqual(await texts('nothing matches'), []);
});

test('the date range filters items, inclusive of both days', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const post = async (iso, text) => {
        ctx.clock.time = new Date(iso);
        await request(ctx.app).post(`${base}/notes`).send({ text }).expect(201);
    };
    await post('2026-01-10T08:00:00Z', 'ten');
    await post('2026-01-11T23:30:00Z', 'eleven-late');
    await post('2026-01-12T00:30:00Z', 'twelve');
    await post('2026-01-14T10:00:00Z', 'fourteen');
    const texts = async query => (await request(ctx.app).get(base).query(query).expect(200)).body.items.map(i => i.text).reverse();

    assert.deepEqual(await texts({ startDate: '2026-01-11', endDate: '2026-01-12' }), ['eleven-late', 'twelve']);
    assert.deepEqual(await texts({ startDate: '2026-01-12' }), ['twelve', 'fourteen']);
    assert.deepEqual(await texts({ endDate: '2026-01-10' }), ['ten']);
    assert.deepEqual(await texts({ startDate: '2026-01-11', endDate: '2026-01-11', search: 'late' }), ['eleven-late']);
});

test('the date range follows the caller time zone', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    // 2026-01-11 19:00 UTC is 2026-01-12 00:30 in India (UTC+5:30, getTimezoneOffset() = -330)
    ctx.clock.time = new Date('2026-01-11T19:00:00Z');
    await request(ctx.app).post(`${base}/notes`).send({ text: 'late evening' }).expect(201);
    const onDay = async (day, tz) =>
        (await request(ctx.app).get(base).query({ startDate: day, endDate: day, tz }).expect(200)).body.total;
    assert.equal(await onDay('2026-01-12', -330), 1);
    assert.equal(await onDay('2026-01-11', -330), 0);
    assert.equal(await onDay('2026-01-11', 0), 1);
});

test('bad dates are refused', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).get(base).query({ startDate: 'yesterday' }).expect(400);
    await request(ctx.app).get(base).query({ endDate: '2026-02-31' }).expect(400);
    await request(ctx.app).get(base).query({ startDate: '2026-03-02', endDate: '2026-03-01' }).expect(400);
});

test('a stash holds a limited number of items', async () => {
    const ctx = makeApp({ maxItemsPerStash: 2 });
    const base = await stash(ctx);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'a' }).expect(201);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'b' }).expect(201);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'c' }).expect(413);
});

test('malformed JSON is a 400', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').set('Content-Type', 'application/json').send('{not json').expect(400);
});

test('a note can have a title; without one the first five words are used', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);

    const titled = await request(ctx.app).post(`${base}/notes`).send({ title: '  Deploy   token ', text: 'abc123' }).expect(201);
    assert.equal(titled.body.title, 'Deploy token');
    assert.equal(titled.body.hasTitle, true);

    const auto = await request(ctx.app).post(`${base}/notes`).send({ text: 'one two three four five six seven' }).expect(201);
    assert.equal(auto.body.title, 'one two three four five');
    assert.equal(auto.body.hasTitle, false);

    const short = await request(ctx.app).post(`${base}/notes`).send({ title: '   ', text: 'two words\nand more lines' }).expect(201);
    assert.equal(short.body.title, 'two words and more lines');
    assert.equal(short.body.hasTitle, false);

    // a plain-text note from curl has no title either
    const curl = await request(ctx.app).post(`${base}/notes`).set('Content-Type', 'text/plain').send('from curl with a long sentence here').expect(201);
    assert.equal(curl.body.title, 'from curl with a long');
});

test('a title is at most 150 characters; one word of any length is cut to fit when derived', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const ok = await request(ctx.app).post(`${base}/notes`).send({ title: 'x'.repeat(150), text: 'body' }).expect(201);
    assert.equal(ok.body.title.length, 150);
    const tooLong = await request(ctx.app).post(`${base}/notes`).send({ title: 'x'.repeat(151), text: 'body' }).expect(400);
    assert.equal(tooLong.body.field, 'title');
    await request(ctx.app).post(`${base}/notes`).send({ title: 42, text: 'body' }).expect(400);

    const derived = await request(ctx.app).post(`${base}/notes`).send({ text: 'y'.repeat(400) }).expect(201);
    assert.equal(derived.body.title.length, 150);
});

test('search also matches titles', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).post(`${base}/notes`).send({ title: 'Wifi password', text: 'hunter2' }).expect(201);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'unrelated' }).expect(201);
    const found = await request(ctx.app).get(base).query({ search: 'wifi' }).expect(200);
    assert.deepEqual(found.body.items.map(i => i.text), ['hunter2']);
});

test('a database from before titles gets the column, and its notes show their first words', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const { connect } = require('../src/database/sqlite');
    const { StashModel } = require('../src/models/stashModel');
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-')), 'old.sqlite');

    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE stashes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, password_hash TEXT, password_salt TEXT, ttl_ms INTEGER, created_at TEXT NOT NULL, expires_at TEXT)`);
    old.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, stash_id INTEGER NOT NULL REFERENCES stashes(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT, file_name TEXT, file_type TEXT, file_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    old.exec(`INSERT INTO stashes (slug, created_at) VALUES ('legacy', '2026-01-01T00:00:00Z')`);
    old.exec(`INSERT INTO items (stash_id, kind, text, created_at) VALUES (1, 'note', 'an older note without any title', '2026-01-01T00:00:00Z')`);
    old.close();

    const db = connect(file);
    const model = new StashModel(db);
    const rows = model.listItems(1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, null);
    const added = model.addNote(1, 'new', new Date(), 'Given');
    assert.equal(added.title, 'Given');
    db.close();
});

test('a listing can be cut to the first few items, and total still counts every match', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'limited');
    const ids = [];
    for (const text of ['apple one', 'apple two', 'pear', 'apple three', 'apple four']) {
        ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
        ids.push((await request(ctx.app).post(`${base}/notes`).send({ text }).expect(201)).body.id);
    }
    // The oldest note is pinned, so it still comes first
    await request(ctx.app).post(`${base}/items/${ids[0]}/pin`).send({ pinned: true }).expect(200);

    const viaGet = await request(ctx.app).get(`${base}?limit=2`).expect(200);
    assert.deepEqual(viaGet.body.items.map(i => i.text), ['apple one', 'apple four']);
    assert.equal(viaGet.body.total, 5);

    // In the body, with a search, as the extension sends it
    const viaQuery = await request(ctx.app).post(`${base}/query`).send({ search: 'apple', limit: 3 }).expect(200);
    assert.deepEqual(viaQuery.body.items.map(i => i.text), ['apple one', 'apple four', 'apple three']);
    assert.equal(viaQuery.body.total, 4);

    // A limit above the number of matches returns them all
    const few = await request(ctx.app).post(`${base}/query`).send({ search: 'pear', limit: 10 }).expect(200);
    assert.deepEqual(few.body.items.map(i => i.text), ['pear']);
    assert.equal(few.body.total, 1);

    // A very large limit is capped rather than refused
    assert.equal((await request(ctx.app).get(`${base}?limit=100000`).expect(200)).body.items.length, 5);

    for (const limit of ['0', '-1', '1.5', 'abc']) {
        const bad = await request(ctx.app).get(`${base}?limit=${limit}`).expect(400);
        assert.equal(bad.body.field, 'limit');
    }
    await request(ctx.app).post(`${base}/query`).send({ limit: 0 }).expect(400);
});

test('without a limit the listing is unchanged: every item, and total is their number', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'unlimited');
    for (let i = 0; i < 30; i += 1) {
        ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
        await request(ctx.app).post(`${base}/notes`).send({ text: `note ${i}` }).expect(201);
    }
    for (const res of [await request(ctx.app).get(base).expect(200), await request(ctx.app).post(`${base}/query`).send({}).expect(200)]) {
        assert.equal(res.body.items.length, 30);
        assert.equal(res.body.total, 30);
        assert.equal(res.body.items[0].text, 'note 29');
    }
});
