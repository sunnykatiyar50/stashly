const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

const PASSWORD = 'correct horse';
const seconds = n => n * 1000;

async function stash(ctx, slug = 'undo-stash', body = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);
    return `/api/stashes/${slug}`;
}

const addNote = (ctx, base, text, extra = {}) => request(ctx.app).post(`${base}/notes`).send({ text, ...extra }).expect(201);
const addFile = (ctx, base, name = 'a.png', body = PNG) =>
    request(ctx.app).post(`${base}/files`).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(body).expect(201);
const advance = (ctx, ms) => {
    ctx.clock.time = new Date(ctx.clock.time.getTime() + ms);
};
const listed = async (ctx, base) => (await request(ctx.app).get(base).expect(200)).body;
const trashRows = ctx => ctx.db.prepare('SELECT id, deleted_at FROM trash ORDER BY id').all();

// ---- deleting and bringing back ----

test('deleting an item answers with how long it can be undone, and hides it everywhere', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const keep = await addNote(ctx, base, 'stays here');
    const note = await addNote(ctx, base, 'needle in the trash');
    const file = await addFile(ctx, base);
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ event, data });

    const res = await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.undoUntil, new Date(ctx.clock.time.getTime() + seconds(120)).toISOString());
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    assert.deepEqual(published, [
        { event: 'item-deleted', data: { id: note.body.id } },
        { event: 'item-deleted', data: { id: file.body.id } },
    ]);

    // Not in the listing, the counts, the search, latest, the single-item route, the file route or the export
    const body = await listed(ctx, base);
    assert.deepEqual(body.items.map(i => i.id), [keep.body.id]);
    assert.equal(body.total, 1);
    assert.deepEqual(body.usage, { items: 1, files: 0, bytes: 0 });
    assert.equal((await request(ctx.app).get(`${base}?search=needle`).expect(200)).body.items.length, 0);
    assert.equal((await request(ctx.app).post(`${base}/query`).send({ search: 'needle' }).expect(200)).body.items.length, 0);
    assert.equal((await request(ctx.app).get(`${base}/latest`).expect(200)).text, 'stays here');
    await request(ctx.app).get(`${base}/items/${note.body.id}`).expect(404);
    await request(ctx.app).get(file.body.url).expect(404);
    await request(ctx.app).get(`${base}/files/${file.body.id}/contents`).expect(404);
    const zip = await request(ctx.app).get(`${base}/export`).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    assert.equal(zip.status, 200);
    assert.ok(!zip.body.includes('needle in the trash'));
    assert.ok(!zip.body.includes('a.png'));
    assert.equal(ctx.model.totalBytes(), 0);
    assert.deepEqual(ctx.model.totals(), { stashes: 1, items: 1, files: 0, bytes: 0 });
    assert.equal(trashRows(ctx).length, 2);
});

test('a deleted note and file can be restored within the window, with the same id, place and pin', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const bottom = await addNote(ctx, base, 'bottom');
    const middle = await addNote(ctx, base, 'middle', { title: 'Mid' });
    const file = await addFile(ctx, base, 'pic.png');
    await addNote(ctx, base, 'top');
    await request(ctx.app).post(`${base}/items/${middle.body.id}/pin`).send({ pinned: true }).expect(200);
    const before = (await listed(ctx, base)).items;

    await request(ctx.app).delete(`${base}/items/${middle.body.id}`).expect(200);
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    advance(ctx, seconds(119));
    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ event, id: data.id, origin: data.origin });

    const note = await request(ctx.app).post(`${base}/items/${middle.body.id}/restore`).set('X-Tab-Id', 'tab1').expect(200);
    assert.equal(note.body.id, middle.body.id);
    assert.equal(note.body.text, 'middle');
    assert.equal(note.body.title, 'Mid');
    assert.equal(note.body.pinned, true);
    assert.equal(note.body.order, before.find(i => i.id === middle.body.id).order);
    const back = await request(ctx.app).post(`${base}/items/${file.body.id}/restore`).expect(200);
    assert.equal(back.body.fileName, 'pic.png');
    assert.equal(back.body.fileSize, PNG.length);
    assert.deepEqual(published.map(p => [p.event, p.id]), [['item-added', middle.body.id], ['item-added', file.body.id]]);
    assert.equal(published[0].origin, 'tab1');

    // Exactly the list it had before, in the same order, and the file downloads again
    assert.deepEqual((await listed(ctx, base)).items, before);
    assert.deepEqual(Buffer.from((await request(ctx.app).get(file.body.url).expect(200)).body), PNG);
    assert.equal(trashRows(ctx).length, 0);
    assert.ok(bottom.body.id);
});

test('an item cannot be restored twice, and a restored item can be deleted and undone again', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'again');
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(200);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(200);
    assert.equal((await listed(ctx, base)).items.length, 1);
});

test('restoring something that never existed, or is not in the trash, is a 404', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'alive');
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    await request(ctx.app).post(`${base}/items/999/restore`).expect(404);
    await request(ctx.app).post(`${base}/items/abc/restore`).expect(404);
});

test('an item is only in the trash of its own stash', async () => {
    const ctx = makeApp();
    const a = await stash(ctx, 'stash-a');
    const b = await stash(ctx, 'stash-b');
    const note = await addNote(ctx, a, 'mine');
    await request(ctx.app).delete(`${a}/items/${note.body.id}`).expect(200);
    await request(ctx.app).post(`${b}/items/${note.body.id}/restore`).expect(404);
    assert.equal((await listed(ctx, b)).items.length, 0);
    await request(ctx.app).post(`${a}/items/${note.body.id}/restore`).expect(200);
});

test('a trashed item cannot be edited, pinned, reordered or revealed', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'gone for now');
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    await request(ctx.app).put(`${base}/items/${note.body.id}`).send({ text: 'x' }).expect(404);
    await request(ctx.app).post(`${base}/items/${note.body.id}/pin`).send({ pinned: true }).expect(404);
    await request(ctx.app).post(`${base}/reorder`).send({ ids: [note.body.id] }).expect(404);
    await request(ctx.app).post(`${base}/items/${note.body.id}/reveal`).expect(404);
    // And deleting it again finds nothing to delete
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(404);
});

// ---- the window ----

test('after the window the item cannot be restored, and the cleanup removes it for good', async () => {
    const ctx = makeApp({ undoSeconds: 60 });
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'late');
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);

    advance(ctx, seconds(59));
    ctx.controller.cleanup();
    assert.equal(trashRows(ctx).length, 1, 'still inside the window');

    advance(ctx, seconds(1));
    // Refused at once, even before the cleanup job has run
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    assert.equal(trashRows(ctx).length, 1);
    ctx.controller.cleanup();
    assert.equal(trashRows(ctx).length, 0);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    assert.equal((await listed(ctx, base)).items.length, 0);
});

test('the deleted text is removed from the database file when the trash is purged', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'purge-me-please');
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trash WHERE text = 'purge-me-please'").get().n, 1);
    advance(ctx, seconds(121));
    ctx.controller.cleanup();
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trash WHERE text LIKE '%purge-me%'").get().n, 0);
    assert.equal(ctx.db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
});

test('files stay in the file store while trashed, and are wiped when the trash is purged', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = await addFile(ctx, base);
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    assert.equal(ctx.fileStore.count(), 1);
    assert.ok(ctx.fileStore.exists(file.body.id));
    advance(ctx, seconds(60));
    ctx.controller.cleanup();
    assert.equal(ctx.fileStore.count(), 1, 'inside the window');
    advance(ctx, seconds(61));
    ctx.controller.cleanup();
    assert.equal(ctx.fileStore.count(), 0);
    assert.equal(trashRows(ctx).length, 0);
});

test('a restored file is not removed by the cleanup that follows', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = await addFile(ctx, base);
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    await request(ctx.app).post(`${base}/items/${file.body.id}/restore`).expect(200);
    advance(ctx, seconds(500));
    ctx.controller.cleanup();
    assert.equal(ctx.fileStore.count(), 1);
    await request(ctx.app).get(file.body.url).expect(200);
});

test('the startup sweep keeps the files of trashed items and removes real strays', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const trashed = await addFile(ctx, base, 'trashed.png');
    const live = await addFile(ctx, base, 'live.png');
    await request(ctx.app).delete(`${base}/items/${trashed.body.id}`).expect(200);
    ctx.fileStore.write(9999, Buffer.from('stray'));
    assert.deepEqual([...ctx.model.liveFileIds()].sort((a, b) => a - b), [trashed.body.id, live.body.id].sort((a, b) => a - b));
    assert.equal(ctx.fileStore.sweep(ctx.model.liveFileIds()), 1);
    assert.ok(ctx.fileStore.exists(trashed.body.id));
    assert.ok(ctx.fileStore.exists(live.body.id));
    assert.ok(!ctx.fileStore.exists(9999));
    // After a restart it can still be brought back
    await request(ctx.app).post(`${base}/items/${trashed.body.id}/restore`).expect(200);
    await request(ctx.app).get(trashed.body.url).expect(200);
});

test('a trashed file whose bytes have vanished is dropped, not restored', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = await addFile(ctx, base);
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    ctx.fileStore.remove([file.body.id]);
    await request(ctx.app).post(`${base}/items/${file.body.id}/restore`).expect(404);
    assert.equal(trashRows(ctx).length, 0);
    assert.equal((await listed(ctx, base)).items.length, 0);
});

test('a note whose own expiry passed while it was trashed is not brought back', async () => {
    const ctx = makeApp({ undoSeconds: 3600 });
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'short lived', { expires: '5m' });
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    advance(ctx, seconds(100));
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(200);
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    advance(ctx, 6 * 60 * 1000);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    assert.equal(trashRows(ctx).length, 0);
});

// ---- deletes that are never undoable ----

test('burn-after-reading and secret notes are deleted for good', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const burn = await addNote(ctx, base, 'burn text', { burn: true });
    const secret = await addNote(ctx, base, 'secret text', { secret: true });
    for (const note of [burn, secret]) {
        const res = await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
        assert.equal(res.body.undoUntil, null);
        await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    }
    assert.equal(trashRows(ctx).length, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
});

test('revealing or POSTing latest on a burn note leaves nothing in the trash', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const one = await addNote(ctx, base, 'reveal me', { burn: true });
    await request(ctx.app).post(`${base}/items/${one.body.id}/reveal`).expect(200);
    await addNote(ctx, base, 'read me', { burn: true });
    await request(ctx.app).post(`${base}/latest`).expect(200);
    assert.equal(trashRows(ctx).length, 0);
    await request(ctx.app).post(`${base}/items/${one.body.id}/restore`).expect(404);
});

test('keep-last trimming and a note\'s own expiry delete for good', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 1 }).expect(200);
    const first = await addNote(ctx, base, 'trimmed away');
    advance(ctx, 1000);
    await addNote(ctx, base, 'newest');
    assert.equal((await listed(ctx, base)).items.length, 1);
    await request(ctx.app).post(`${base}/items/${first.body.id}/restore`).expect(404);

    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: null }).expect(200);
    const short = await addNote(ctx, base, 'expires soon', { expires: '5m' });
    advance(ctx, 6 * 60 * 1000);
    ctx.controller.cleanup();
    await request(ctx.app).post(`${base}/items/${short.body.id}/restore`).expect(404);
    // Lowering keep-last later trims for good too
    advance(ctx, 1000);
    await addNote(ctx, base, 'a');
    advance(ctx, 1000);
    const b = await addNote(ctx, base, 'b');
    advance(ctx, 1000);
    await addNote(ctx, base, 'c');
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 1 }).expect(200);
    await request(ctx.app).post(`${base}/items/${b.body.id}/restore`).expect(404);
    assert.equal(trashRows(ctx).length, 0);
});

test('a note already past its own expiry is deleted for good', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'expired but not yet cleaned', { expires: '5m' });
    advance(ctx, 6 * 60 * 1000);
    const res = await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    assert.equal(res.body.undoUntil, null);
    assert.equal(trashRows(ctx).length, 0);
});

test('deleting a stash removes its trashed rows and files, and so does a stash expiring', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'to-delete');
    const note = await addNote(ctx, base, 'bye');
    const file = await addFile(ctx, base);
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    assert.equal(ctx.fileStore.count(), 1);
    await request(ctx.app).delete(base).expect(200);
    assert.equal(ctx.fileStore.count(), 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM trash').get().n, 0);

    const short = await stash(ctx, 'short-lived', { ttl: '1h' });
    const f2 = await addFile(ctx, short);
    const n2 = await addNote(ctx, short, 'x');
    await request(ctx.app).delete(`${short}/items/${f2.body.id}`).expect(200);
    await request(ctx.app).delete(`${short}/items/${n2.body.id}`).expect(200);
    assert.equal(ctx.fileStore.count(), 1);
    advance(ctx, 2 * 60 * 60 * 1000);
    ctx.controller.cleanup();
    assert.equal(ctx.fileStore.count(), 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM trash').get().n, 0);
});

test('an expired stash opened by someone also takes its trash with it', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'opened-late', { ttl: '1h' });
    const file = await addFile(ctx, base);
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    advance(ctx, 2 * 60 * 60 * 1000);
    await request(ctx.app).get(base).expect(404);
    assert.equal(ctx.fileStore.count(), 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM trash').get().n, 0);
});

// ---- limits on restore ----

test('restoring respects the items limit', async () => {
    const ctx = makeApp({ maxItemsPerStash: 2 });
    const base = await stash(ctx);
    const first = await addNote(ctx, base, 'one');
    await addNote(ctx, base, 'two');
    await request(ctx.app).delete(`${base}/items/${first.body.id}`).expect(200);
    await addNote(ctx, base, 'three');
    const res = await request(ctx.app).post(`${base}/items/${first.body.id}/restore`).expect(413);
    assert.match(res.body.error, /stash is full \(2 items\)/);
    // Still in the trash, so it can be restored once there is room
    const list = (await listed(ctx, base)).items;
    await request(ctx.app).delete(`${base}/items/${list[0].id}`).expect(200);
    await request(ctx.app).post(`${base}/items/${first.body.id}/restore`).expect(200);
});

test('restoring a file respects the files, stash size and server size limits', async () => {
    const ctx = makeApp({ maxFilesPerStash: 1, maxItemsPerStash: 10 });
    const base = await stash(ctx);
    const first = await addFile(ctx, base, 'one.png');
    await request(ctx.app).delete(`${base}/items/${first.body.id}`).expect(200);
    await addFile(ctx, base, 'two.png');
    const res = await request(ctx.app).post(`${base}/items/${first.body.id}/restore`).expect(413);
    assert.match(res.body.error, /1 files/);

    const big = makeApp({ maxStashBytes: PNG.length + 10 });
    const bigBase = await stash(big);
    const a = await addFile(big, bigBase, 'a.png');
    await request(big.app).delete(`${bigBase}/items/${a.body.id}`).expect(200);
    await addFile(big, bigBase, 'b.png');
    const over = await request(big.app).post(`${bigBase}/items/${a.body.id}/restore`).expect(413);
    assert.match(over.body.error, /would pass its/);

    const full = makeApp({ maxTotalBytes: PNG.length + 10 });
    const fullBase = await stash(full);
    const c = await addFile(full, fullBase, 'c.png');
    await request(full.app).delete(`${fullBase}/items/${c.body.id}`).expect(200);
    await addFile(full, fullBase, 'd.png');
    const none = await request(full.app).post(`${fullBase}/items/${c.body.id}/restore`).expect(507);
    assert.match(none.body.error, /out of file space/);
    // A refused restore leaves the item waiting, file included
    assert.equal(full.fileStore.count(), 2);
    assert.equal(trashRows(full).length, 1);
});

test('restoring does not trim a keep-last stash straight away', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'a');
    advance(ctx, 1000);
    await addNote(ctx, base, 'b');
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 2 }).expect(200);
    await request(ctx.app).delete(`${base}/items/${a.body.id}`).expect(200);
    advance(ctx, 1000);
    await addNote(ctx, base, 'c');
    await request(ctx.app).post(`${base}/items/${a.body.id}/restore`).expect(200);
    assert.equal((await listed(ctx, base)).items.length, 3);
});

// ---- who may do it ----

test('only full access can delete or restore; read-only and drop-box links cannot', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'vault', password: PASSWORD }).expect(201);
    const base = '/api/stashes/vault';
    const note = await owner.post(`${base}/notes`).send({ text: 'kept safe' }).expect(201);
    const view = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const drop = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: view.token }).expect(200);
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: drop.token }).expect(200);

    // Neither can delete
    await viewer.delete(`${base}/items/${note.body.id}`).expect(403);
    await dropper.delete(`${base}/items/${note.body.id}`).expect(403);
    await owner.delete(`${base}/items/${note.body.id}`).expect(200);
    // Neither can restore, and a visitor with no sign-in is asked for the password
    await viewer.post(`${base}/items/${note.body.id}/restore`).expect(403);
    await dropper.post(`${base}/items/${note.body.id}/restore`).expect(403);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(401);
    assert.equal(trashRows(ctx).length, 1);
    await owner.post(`${base}/items/${note.body.id}/restore`).expect(200);
});

test('restoring is rate limited like adding', async () => {
    const ctx = makeApp({ ratePost: 3 });
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'x');
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(429);
});

// ---- UNDO_SECONDS = 0 ----

test('with undo off a delete is immediate and final, as before', async () => {
    const ctx = makeApp({ undoSeconds: 0 });
    const base = await stash(ctx);
    const note = await addNote(ctx, base, 'gone at once');
    const file = await addFile(ctx, base);
    const res = await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(200);
    assert.deepEqual(res.body, { ok: true, undoUntil: null });
    await request(ctx.app).delete(`${base}/items/${file.body.id}`).expect(200);
    assert.equal(trashRows(ctx).length, 0);
    assert.equal(ctx.fileStore.count(), 0);
    await request(ctx.app).post(`${base}/items/${note.body.id}/restore`).expect(404);
    await request(ctx.app).post(`${base}/items/${file.body.id}/restore`).expect(404);
    await request(ctx.app).delete(`${base}/items/${note.body.id}`).expect(404);
});

test('UNDO_SECONDS comes from the environment, 120 by default, and is capped', () => {
    const { loadConfig } = require('../src/config');
    assert.equal(loadConfig({}).undoSeconds, 120);
    assert.equal(loadConfig({ UNDO_SECONDS: '0' }).undoSeconds, 0);
    assert.equal(loadConfig({ UNDO_SECONDS: '30' }).undoSeconds, 30);
    assert.equal(loadConfig({ UNDO_SECONDS: '999999' }).undoSeconds, 3600);
    assert.equal(loadConfig({ UNDO_SECONDS: 'nonsense' }).undoSeconds, 120);
    assert.equal(loadConfig({ UNDO_SECONDS: '-5' }).undoSeconds, 120);
});

// ---- the admin setting ----

async function adminApp(overrides = {}) {
    const ctx = makeApp({ adminPassword: 'admin-pass-123', ...overrides });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: 'admin-pass-123' }).expect(200);
    return { ...ctx, admin };
}

test('the undo time is on the admin Settings page, with its own checks', async () => {
    const ctx = await adminApp();
    const res = await ctx.admin.get('/api/admin/settings').expect(200);
    const field = res.body.fields.find(f => f.key === 'undoSeconds');
    assert.equal(field.value, 120);
    assert.equal(field.default, 120);
    assert.equal(field.type, 'int');
    assert.equal(field.unit, 'seconds');
    assert.equal(field.group, 'Stashes');
    assert.ok(field.label && field.help);
    assert.equal(field.min, 0);

    for (const value of [-1, 3601, 1.5, '60', null]) {
        const bad = await ctx.admin.put('/api/admin/settings').send({ values: { undoSeconds: value } }).expect(400);
        assert.ok(bad.body.errors.undoSeconds, `expected an error for ${JSON.stringify(value)}`);
    }
    assert.equal(ctx.config.undoSeconds, 120);
});

test('changing the undo time applies at once; 0 turns undo off and clears what is waiting', async () => {
    const ctx = await adminApp();
    const base = await stash(ctx);
    const first = await addNote(ctx, base, 'first');
    await ctx.admin.put('/api/admin/settings').send({ values: { undoSeconds: 30 } }).expect(200);
    const res = await request(ctx.app).delete(`${base}/items/${first.body.id}`).expect(200);
    assert.equal(res.body.undoUntil, new Date(ctx.clock.time.getTime() + seconds(30)).toISOString());

    const second = await addNote(ctx, base, 'second');
    await request(ctx.app).delete(`${base}/items/${second.body.id}`).expect(200);
    await ctx.admin.put('/api/admin/settings').send({ values: { undoSeconds: 0 } }).expect(200);
    // Nothing can be brought back any more, and the cleanup removes what was waiting
    await request(ctx.app).post(`${base}/items/${second.body.id}/restore`).expect(404);
    assert.equal(trashRows(ctx).length, 2);
    ctx.controller.cleanup();
    assert.equal(trashRows(ctx).length, 0);
    const third = await addNote(ctx, base, 'third');
    assert.equal((await request(ctx.app).delete(`${base}/items/${third.body.id}`).expect(200)).body.undoUntil, null);
});

test('the undo time is saved across a restart and "Reset to defaults" goes back to the environment value', async () => {
    const first = await adminApp({ undoSeconds: 90 });
    await first.admin.put('/api/admin/settings').send({ values: { undoSeconds: 45 } }).expect(200);
    const restarted = makeApp({ adminPassword: 'admin-pass-123', undoSeconds: 90 }, { db: first.db });
    assert.equal(restarted.config.undoSeconds, 45);

    const admin = request.agent(restarted.app);
    await admin.post('/api/admin/login').send({ password: 'admin-pass-123' }).expect(200);
    const reset = await admin.post('/api/admin/settings/reset').expect(200);
    assert.equal(reset.body.fields.find(f => f.key === 'undoSeconds').value, 90);
    assert.equal(restarted.config.undoSeconds, 90);
    // An untouched setting follows the environment
    const again = makeApp({ adminPassword: 'admin-pass-123', undoSeconds: 20 }, { db: first.db });
    assert.equal(again.config.undoSeconds, 20);
});
