const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

async function stash(ctx, slug = 'conflicts') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

const addNote = (ctx, base, text, extra = {}) => request(ctx.app).post(`${base}/notes`).send({ text, ...extra }).expect(201);
const addFile = (ctx, base, name = 'IMG_0001.png') =>
    request(ctx.app).post(`${base}/files`).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
const advance = (ctx, ms = 1000) => {
    ctx.clock.time = new Date(ctx.clock.time.getTime() + ms);
};
const put = (ctx, base, id, body) => request(ctx.app).put(`${base}/items/${id}`).send(body);

// ---- notes ----

test('an edit that sends the editedAt it started from is saved, and the new editedAt is the next base', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0');
    assert.equal(note.body.editedAt, null);

    advance(ctx);
    const one = await put(ctx, base, note.body.id, { text: 'v1', baseEditedAt: null }).expect(200);
    assert.equal(one.body.text, 'v1');
    assert.equal(one.body.editedAt, ctx.clock.time.toISOString());

    advance(ctx);
    const two = await put(ctx, base, note.body.id, { text: 'v2', baseEditedAt: one.body.editedAt }).expect(200);
    assert.equal(two.body.text, 'v2');
    assert.notEqual(two.body.editedAt, one.body.editedAt);
});

test('an edit based on an older version is refused with 409 and the current note, and changes nothing', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0', { title: 'Title' });
    // Two people open the note at the same moment: both have editedAt null
    advance(ctx);
    const theirs = await put(ctx, base, note.body.id, { title: 'Theirs', text: 'their words', baseEditedAt: null }).expect(200);
    const published = [];
    ctx.events.publish = (slug, event) => published.push(event);

    advance(ctx);
    const mine = await put(ctx, base, note.body.id, { title: 'Mine', text: 'my words', baseEditedAt: null }).expect(409);
    assert.equal(mine.body.conflict, true);
    assert.match(mine.body.error, /Someone else changed this note/);
    assert.equal(mine.body.item.id, note.body.id);
    assert.equal(mine.body.item.text, 'their words');
    assert.equal(mine.body.item.title, 'Theirs');
    assert.equal(mine.body.item.editedAt, theirs.body.editedAt);
    assert.deepEqual(published, [], 'a refused edit is not announced');

    const stored = (await request(ctx.app).get(`${base}/items/${note.body.id}`).expect(200)).body;
    assert.equal(stored.text, 'their words');
    assert.equal(stored.editedAt, theirs.body.editedAt);
});

test('the 409 carries the whole note, not a preview', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const long = 'long line\n'.repeat(500);
    const note = await addNote(ctx, base, long);
    advance(ctx);
    await put(ctx, base, note.body.id, { text: long + 'more', baseEditedAt: null }).expect(200);
    const res = await put(ctx, base, note.body.id, { text: 'mine', baseEditedAt: null }).expect(409);
    assert.equal(res.body.item.text, long + 'more');
    assert.equal(res.body.item.truncated, undefined);
});

test('after a conflict the person can overwrite by resending with the editedAt from the 409', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0');
    advance(ctx);
    await put(ctx, base, note.body.id, { text: 'theirs', baseEditedAt: null }).expect(200);
    advance(ctx);
    const conflict = await put(ctx, base, note.body.id, { text: 'mine', baseEditedAt: null }).expect(409);
    advance(ctx);
    const saved = await put(ctx, base, note.body.id, { text: 'mine', baseEditedAt: conflict.body.item.editedAt }).expect(200);
    assert.equal(saved.body.text, 'mine');
    assert.equal((await request(ctx.app).get(`${base}/items/${note.body.id}`)).body.text, 'mine');
    // And the first person's old base is stale now
    await put(ctx, base, note.body.id, { text: 'again', baseEditedAt: conflict.body.item.editedAt }).expect(409);
});

test('two edits sent at the same time with the same base: exactly one wins', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0');
    const [a, b] = await Promise.all([
        put(ctx, base, note.body.id, { text: 'from a', baseEditedAt: null }),
        put(ctx, base, note.body.id, { text: 'from b', baseEditedAt: null }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    assert.equal(loser.body.item.text, winner.body.text);
    assert.equal((await request(ctx.app).get(`${base}/items/${note.body.id}`)).body.text, winner.body.text);
});

test('edits made within the same clock tick still get different editedAt values, so none is missed', async () => {
    const ctx = makeApp(); // the test clock does not move at all
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0');
    const one = await put(ctx, base, note.body.id, { text: 'v1', baseEditedAt: null }).expect(200);
    const two = await put(ctx, base, note.body.id, { text: 'v2', baseEditedAt: one.body.editedAt }).expect(200);
    assert.ok(two.body.editedAt > one.body.editedAt);
    // Someone still holding version one is refused
    await put(ctx, base, note.body.id, { text: 'late', baseEditedAt: one.body.editedAt }).expect(409);
    assert.equal((await request(ctx.app).get(`${base}/items/${note.body.id}`)).body.text, 'v2');
});

test('a request with no baseEditedAt still works and the last write wins (older clients and scripts)', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0');
    advance(ctx);
    await put(ctx, base, note.body.id, { text: 'v1' }).expect(200);
    advance(ctx);
    await put(ctx, base, note.body.id, { text: 'v2' }).expect(200);
    assert.equal((await request(ctx.app).get(`${base}/items/${note.body.id}`)).body.text, 'v2');
});

test('baseEditedAt must match exactly, null means "never edited", and other types are refused', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0');
    // Never edited, but the client claims an edit time
    await put(ctx, base, note.body.id, { text: 'x', baseEditedAt: '2026-01-01T00:00:00.000Z' }).expect(409);
    advance(ctx);
    const edited = await put(ctx, base, note.body.id, { text: 'v1', baseEditedAt: null }).expect(200);
    // Edited, but the client claims it never was
    await put(ctx, base, note.body.id, { text: 'x', baseEditedAt: null }).expect(409);
    await put(ctx, base, note.body.id, { text: 'x', baseEditedAt: '' }).expect(409);
    for (const bad of [5, true, {}, []]) {
        const res = await put(ctx, base, note.body.id, { text: 'x', baseEditedAt: bad }).expect(400);
        assert.equal(res.body.field, 'baseEditedAt');
    }
    await put(ctx, base, note.body.id, { text: 'v2', baseEditedAt: edited.body.editedAt }).expect(200);
});

test('other refusals still come first: missing, trashed and burn notes', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'v0');
    const burn = await addNote(ctx, base, 'burn', { burn: true });
    await put(ctx, base, 999, { text: 'x', baseEditedAt: null }).expect(404);
    await put(ctx, base, burn.body.id, { text: 'x', baseEditedAt: null }).expect(400);
    await put(ctx, base, note.body.id, { text: '  ', baseEditedAt: null }).expect(400);
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    await put(ctx, base, note.body.id, { text: 'x', baseEditedAt: null }).expect(404);
    await put(ctx, base, note.body.id, { text: 'x' }).expect(404);
});

test('only full access can edit, so a refused edit cannot be used to read', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'vault', password: 'correct horse' }).expect(201);
    const base = '/api/stashes/vault';
    const note = await owner.post(`${base}/notes`).send({ text: 'private' }).expect(201);
    const drop = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: drop.token }).expect(200);
    await owner.put(`${base}/items/${note.body.id}`).send({ text: 'changed', baseEditedAt: null }).expect(200);
    // A drop-box visitor cannot read, so a stale edit gets a 403 and not the note; a stranger is asked for the password
    await dropper.put(`${base}/items/${note.body.id}`).send({ text: 'x', baseEditedAt: null }).expect(403);
    await request(ctx.app).put(`${base}/items/${note.body.id}`).send({ text: 'x', baseEditedAt: null }).expect(401);
});

// ---- file titles ----

test('a file title edit is checked the same way', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = await addFile(ctx, base);
    advance(ctx);
    const theirs = await put(ctx, base, file.body.id, { title: 'Receipt', baseEditedAt: null }).expect(200);
    advance(ctx);
    const published = [];
    ctx.events.publish = (slug, event) => published.push(event);
    const mine = await put(ctx, base, file.body.id, { title: 'Holiday', baseEditedAt: null }).expect(409);
    assert.equal(mine.body.conflict, true);
    assert.match(mine.body.error, /this file/);
    assert.equal(mine.body.item.title, 'Receipt');
    assert.equal(mine.body.item.fileName, 'IMG_0001.png');
    assert.equal(mine.body.item.editedAt, theirs.body.editedAt);
    assert.deepEqual(published, []);
    assert.equal((await request(ctx.app).get(`${base}/items/${file.body.id}`)).body.title, 'Receipt');

    advance(ctx);
    const saved = await put(ctx, base, file.body.id, { title: 'Holiday', baseEditedAt: mine.body.item.editedAt }).expect(200);
    assert.equal(saved.body.title, 'Holiday');
});

test('a file title edit with no baseEditedAt still works, and a stale file edit never touches the file', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = await addFile(ctx, base);
    advance(ctx);
    await put(ctx, base, file.body.id, { title: 'One' }).expect(200);
    advance(ctx);
    await put(ctx, base, file.body.id, { title: 'Two' }).expect(200);
    await put(ctx, base, file.body.id, { title: 'Three', baseEditedAt: null }).expect(409);
    const current = (await request(ctx.app).get(`${base}/items/${file.body.id}`)).body;
    assert.equal(current.title, 'Two');
    await request(ctx.app).get(file.body.url).expect(200);
    // The content is still not editable, with or without a base
    await put(ctx, base, file.body.id, { text: 'x', baseEditedAt: current.editedAt }).expect(400);
});

test('a trashed file title cannot be edited, even with a base', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = await addFile(ctx, base);
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    await put(ctx, base, file.body.id, { title: 'x', baseEditedAt: null }).expect(404);
});
