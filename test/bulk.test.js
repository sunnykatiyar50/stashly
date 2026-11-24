const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

const seconds = n => n * 1000;

async function stash(ctx, slug = 'bulk-stash', body = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);
    return `/api/stashes/${slug}`;
}

const addNote = (ctx, base, text, extra = {}) => request(ctx.app).post(`${base}/notes`).send({ text, ...extra }).expect(201);
const addFile = (ctx, base, name = 'a.png') =>
    request(ctx.app).post(`${base}/files`).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
const advance = (ctx, ms) => {
    ctx.clock.time = new Date(ctx.clock.time.getTime() + ms);
};
const listed = async (ctx, base) => (await request(ctx.app).get(base).expect(200)).body;
const bulk = (ctx, base, action, ids) => request(ctx.app).post(`${base}/items/bulk`).send({ action, ids });

// ---- delete ----

test('a bulk delete removes every named clip, tells the open pages, and can be undone in one go', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const keep = await addNote(ctx, base, 'stays');
    const a = await addNote(ctx, base, 'first');
    const b = await addNote(ctx, base, 'second');
    const file = await addFile(ctx, base);
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ event, id: data.id });

    const res = await bulk(ctx, base, 'delete', [a.body.id, b.body.id, file.body.id]).expect(200);
    assert.deepEqual(res.body.deleted, [a.body.id, b.body.id, file.body.id]);
    assert.deepEqual(res.body.undoable, [a.body.id, b.body.id, file.body.id]);
    assert.deepEqual(res.body.missing, []);
    assert.equal(res.body.undoUntil, new Date(ctx.clock.time.getTime() + seconds(120)).toISOString());
    assert.deepEqual(published, [a, b, file].map(x => ({ event: 'item-deleted', id: x.body.id })));
    assert.deepEqual((await listed(ctx, base)).items.map(i => i.id), [keep.body.id]);

    // Undo: all come back, with the same ids
    advance(ctx, seconds(60));
    published.length = 0;
    const back = await bulk(ctx, base, 'restore', [a.body.id, b.body.id, file.body.id]).expect(200);
    assert.deepEqual(back.body.items.map(i => i.id).sort(), [a.body.id, b.body.id, file.body.id].sort());
    assert.deepEqual(back.body.missing, []);
    assert.equal(back.body.error, null);
    assert.deepEqual(published.map(p => p.event), ['item-added', 'item-added', 'item-added']);
    assert.equal((await listed(ctx, base)).items.length, 4);
});

test('a bulk delete skips clips that are gone and repeated ids, and keeps secret and burn notes out of the trash', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const plain = await addNote(ctx, base, 'plain');
    const secret = await addNote(ctx, base, 'hidden', { secret: true });
    const burn = await addNote(ctx, base, 'burn me', { burn: true });

    const res = await bulk(ctx, base, 'delete', [plain.body.id, plain.body.id, secret.body.id, burn.body.id, 99999]).expect(200);
    assert.deepEqual(res.body.deleted, [plain.body.id, secret.body.id, burn.body.id]);
    assert.deepEqual(res.body.undoable, [plain.body.id]);
    assert.deepEqual(res.body.missing, [99999]);

    // Only the plain one can be brought back
    const back = await bulk(ctx, base, 'restore', [plain.body.id, secret.body.id, burn.body.id]).expect(200);
    assert.deepEqual(back.body.items.map(i => i.id), [plain.body.id]);
    assert.deepEqual(back.body.missing, [secret.body.id, burn.body.id]);
});

test('with undo turned off a bulk delete is final and offers no undo', async () => {
    const ctx = makeApp({ undoSeconds: 0 });
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'one');
    const b = await addNote(ctx, base, 'two');
    const res = await bulk(ctx, base, 'delete', [a.body.id, b.body.id]).expect(200);
    assert.deepEqual(res.body.deleted, [a.body.id, b.body.id]);
    assert.deepEqual(res.body.undoable, []);
    assert.equal(res.body.undoUntil, null);
});

test('a bulk restore after the undo time has passed brings nothing back', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'late');
    await bulk(ctx, base, 'delete', [a.body.id]).expect(200);
    advance(ctx, seconds(121));
    const back = await bulk(ctx, base, 'restore', [a.body.id]).expect(200);
    assert.deepEqual(back.body.items, []);
    assert.deepEqual(back.body.missing, [a.body.id]);
    assert.equal((await listed(ctx, base)).items.length, 0);
});

test('a bulk restore stops and says so when the stash is full', async () => {
    const ctx = makeApp({ maxItemsPerStash: 3 });
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'one');
    const b = await addNote(ctx, base, 'two');
    const c = await addNote(ctx, base, 'three');
    await bulk(ctx, base, 'delete', [a.body.id, b.body.id, c.body.id]).expect(200);
    // Three new notes take the places that were freed
    await addNote(ctx, base, 'new one');
    await addNote(ctx, base, 'new two');
    const back = await bulk(ctx, base, 'restore', [a.body.id, b.body.id, c.body.id]).expect(200);
    assert.equal(back.body.items.length, 1);
    assert.match(back.body.error, /./);
    assert.equal((await listed(ctx, base)).items.length, 3);
});

// ---- pin ----

test('a bulk pin and unpin change every named clip and tell the open pages', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'one');
    const b = await addNote(ctx, base, 'two');
    const c = await addNote(ctx, base, 'three');
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ event, id: data.id });

    const res = await bulk(ctx, base, 'pin', [a.body.id, c.body.id, 99999]).expect(200);
    assert.deepEqual(res.body.items.map(i => [i.id, i.pinned]), [[a.body.id, true], [c.body.id, true]]);
    assert.deepEqual(res.body.missing, [99999]);
    assert.deepEqual(published, [
        { event: 'item-updated', id: a.body.id },
        { event: 'item-updated', id: c.body.id },
    ]);
    // Pinned ones come first
    const items = (await listed(ctx, base)).items;
    assert.deepEqual(items.map(i => i.id).slice(0, 2).sort(), [a.body.id, c.body.id].sort());
    assert.equal(items[2].id, b.body.id);

    const undone = await bulk(ctx, base, 'unpin', [a.body.id, c.body.id]).expect(200);
    assert.deepEqual(undone.body.items.map(i => i.pinned), [false, false]);
});

// ---- what is refused ----

test('a bulk request must name a known action and between 1 and 500 whole clip ids', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'one');
    await bulk(ctx, base, 'explode', [note.body.id]).expect(400);
    await bulk(ctx, base, 'delete', []).expect(400);
    await bulk(ctx, base, 'delete', 'all').expect(400);
    await bulk(ctx, base, 'delete', [1.5]).expect(400);
    await bulk(ctx, base, 'delete', [-1]).expect(400);
    await bulk(ctx, base, 'delete', ['1']).expect(400);
    await bulk(ctx, base, 'delete', Array.from({ length: 501 }, (_, i) => i + 1)).expect(400);
    await request(ctx.app).post(`${base}/items/bulk`).send({ ids: [note.body.id] }).expect(400);
    assert.equal((await listed(ctx, base)).items.length, 1);
});

test('only someone with full access can use bulk actions', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'vault', password: 'correct horse' }).expect(201);
    const base = '/api/stashes/vault';
    const note = await owner.post(`${base}/notes`).send({ text: 'mine' }).expect(201);
    // Not signed in
    await bulk(ctx, base, 'delete', [note.body.id]).expect(401);
    // A read-only link
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: link.token }).expect(200);
    await viewer.post(`${base}/items/bulk`).send({ action: 'delete', ids: [note.body.id] }).expect(403);
    await viewer.post(`${base}/items/bulk`).send({ action: 'pin', ids: [note.body.id] }).expect(403);
    assert.equal((await owner.get(base).expect(200)).body.items.length, 1);
});
