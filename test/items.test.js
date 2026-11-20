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
