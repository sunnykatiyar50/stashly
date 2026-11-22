const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const request = require('supertest');
const { makeApp, PNG, PDF } = require('./helpers/app');
const { unzip, binary } = require('./helpers/unzip');
const { detectThumb } = require('../src/utils/fileType');

// Small stand-ins that start with the right magic bytes (the server judges by those and by size, nothing else)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(40, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 9)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

const MINUTE = 60 * 1000;
const advance = (ctx, ms) => {
    ctx.clock.time = new Date(ctx.clock.time.getTime() + ms);
};

async function stash(ctx, slug = 'thumbs', body = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);
    return `/api/stashes/${slug}`;
}
const addFile = (agent, base, name = 'a.png', body = PNG) =>
    agent.post(`${base}/files`).set('X-File-Name', encodeURIComponent(name)).set('Content-Type', 'application/octet-stream').send(body);
// The thumbnail is raw bytes; the Content-Type the sender claims does not matter
const putThumb = (agent, base, id, body, type = 'application/octet-stream') =>
    agent.put(`${base}/files/${id}/thumb`).set('Content-Type', type).send(body);
const getThumb = (agent, base, id) => agent.get(`${base}/files/${id}/thumb`).buffer(true).parse(binary);
const listed = async (ctx, base) => (await request(ctx.app).get(base).expect(200)).body;

// ---- attaching and serving ----

test('an image has no thumbnail until one is sent, then the item carries a thumbUrl and the thumbnail is served', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    assert.equal(up.body.thumbUrl, null);
    assert.equal((await request(ctx.app).get(`${base}/files/${up.body.id}/thumb`).expect(404)).body.error, 'No thumbnail.');

    const published = [];
    ctx.events.publish = (slug, event, data) => published.push({ slug, event, data });
    const before = ctx.db.prepare('SELECT edited_at FROM items WHERE id = ?').get(up.body.id).edited_at;
    const res = await putThumb(request(ctx.app), base, up.body.id, JPEG).expect(200);
    assert.equal(res.body.id, up.body.id);
    assert.equal(res.body.thumbUrl, `${base}/files/${up.body.id}/thumb`);
    // The full file and its details are untouched, and attaching a thumbnail is not an edit
    assert.equal(res.body.url, `${base}/files/${up.body.id}`);
    assert.equal(res.body.fileSize, PNG.length);
    assert.equal(res.body.editedAt, null);
    assert.equal(ctx.db.prepare('SELECT edited_at FROM items WHERE id = ?').get(up.body.id).edited_at, before);
    // Other open pages are told (the item comes with its thumbUrl)
    assert.deepEqual(published, [{ slug: 'thumbs', event: 'item-updated', data: res.body }]);

    const thumb = await getThumb(request(ctx.app), base, up.body.id).expect(200);
    assert.equal(thumb.headers['content-type'], 'image/jpeg');
    assert.match(thumb.headers['content-disposition'], /^inline/);
    assert.equal(thumb.headers['x-content-type-options'], 'nosniff');
    assert.match(thumb.headers['content-security-policy'], /sandbox/);
    assert.match(thumb.headers['cache-control'], /no-store/);
    assert.ok(thumb.body.equals(JPEG));
    // The full file is unchanged and still served
    assert.ok((await request(ctx.app).get(up.body.url).buffer(true).parse(binary)).body.equals(PNG));
});

test('listings carry thumbUrl but never thumbnail bytes, and the count of files on disk is unchanged', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addFile(request(ctx.app), base, 'a.png').expect(201);
    const b = await addFile(request(ctx.app), base, 'b.png').expect(201);
    await putThumb(request(ctx.app), base, a.body.id, PNG).expect(200);
    const body = await listed(ctx, base);
    const byId = Object.fromEntries(body.items.map(i => [i.id, i]));
    assert.equal(byId[a.body.id].thumbUrl, `${base}/files/${a.body.id}/thumb`);
    assert.equal(byId[b.body.id].thumbUrl, null);
    assert.ok(!JSON.stringify(body).includes('base64'));
    assert.deepEqual(body.usage, { items: 2, files: 2, bytes: PNG.length * 2 });
    // Thumbnails are not counted as files (nor against the stash's space)
    assert.equal(ctx.fileStore.count(), 2);
    assert.equal(ctx.fileStore.countThumbs(), 1);
    // Single item and the live added item carry it too
    assert.equal((await request(ctx.app).get(`${base}/items/${a.body.id}`).expect(200)).body.thumbUrl, `${base}/files/${a.body.id}/thumb`);
    // Notes have no thumbUrl
    const note = await request(ctx.app).post(`${base}/notes`).send({ text: 'hi' }).expect(201);
    assert.equal(note.body.thumbUrl, null);
});

test('JPEG, PNG and WebP are accepted, and a full-access visitor can replace a thumbnail', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    for (const [bytes, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp']]) {
        await putThumb(request(ctx.app), base, up.body.id, bytes).expect(200);
        const thumb = await getThumb(request(ctx.app), base, up.body.id).expect(200);
        assert.equal(thumb.headers['content-type'], type);
        assert.ok(thumb.body.equals(bytes));
    }
    assert.equal(ctx.fileStore.countThumbs(), 1);
    // A later full-access replacement works however old the image is
    advance(ctx, 120 * MINUTE);
    await putThumb(request(ctx.app), base, up.body.id, JPEG).expect(200);
});

// ---- what is refused ----

test('the content is checked by its magic bytes: an SVG called .jpg, a GIF, text and an empty body are refused', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    // An SVG that claims to be a JPEG (by its Content-Type and by being sent for a .jpg image)
    const jpgItem = await addFile(request(ctx.app), base, 'photo.jpg', JPEG).expect(201);
    for (const body of [SVG, GIF, Buffer.from('plain text, not an image'), Buffer.from([0xff, 0xd8])]) {
        const res = await putThumb(request(ctx.app), base, jpgItem.body.id, body, 'image/jpeg').expect(415);
        assert.match(res.body.error, /JPEG, PNG or WebP/);
    }
    await putThumb(request(ctx.app), base, up.body.id, Buffer.alloc(0)).expect(400);
    assert.equal((await listed(ctx, base)).items.every(i => i.thumbUrl === null), true);
    assert.equal(ctx.fileStore.countThumbs(), 0);
    // The detector alone: SVG is never a thumbnail, whatever it is called
    assert.equal(detectThumb(SVG), null);
    assert.equal(detectThumb(JPEG), 'image/jpeg');
    assert.equal(detectThumb('not a buffer'), null);
});

test('a thumbnail over the limit is refused with 413, and the limit follows the config', async () => {
    const ctx = makeApp();
    assert.equal(ctx.config.maxThumbBytes, 200 * 1024);
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    const big = Buffer.concat([PNG, Buffer.alloc(200 * 1024 - PNG.length + 1, 1)]);
    assert.equal(big.length, 200 * 1024 + 1);
    await putThumb(request(ctx.app), base, up.body.id, big).expect(413);
    // Exactly at the limit is fine
    await putThumb(request(ctx.app), base, up.body.id, big.subarray(0, 200 * 1024)).expect(200);

    const small = makeApp({ maxThumbBytes: 1000 });
    const smallBase = await stash(small, 'small-limit');
    const item = await addFile(request(small.app), smallBase).expect(201);
    await putThumb(request(small.app), smallBase, item.body.id, Buffer.concat([PNG, Buffer.alloc(1000)])).expect(413);
    await putThumb(request(small.app), smallBase, item.body.id, PNG).expect(200);
    assert.equal(small.fileStore.countThumbs(), 1);
    // The page learns the limit from the config
    const cfg = await request(small.app).get('/api/config').expect(200);
    assert.equal(cfg.body.limits.maxThumbBytes, 1000);
});

test('only images have thumbnails, and the item has to exist in this stash', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const other = await stash(ctx, 'other-stash');
    const pdf = await addFile(request(ctx.app), base, 'doc.pdf', PDF).expect(201);
    const text = await addFile(request(ctx.app), base, 'a.txt', Buffer.from('words')).expect(201);
    const note = await request(ctx.app).post(`${base}/notes`).send({ text: 'hi' }).expect(201);
    const image = await addFile(request(ctx.app), other, 'x.png').expect(201);
    await putThumb(request(ctx.app), base, pdf.body.id, PNG).expect(400);
    await putThumb(request(ctx.app), base, text.body.id, PNG).expect(400);
    await putThumb(request(ctx.app), base, note.body.id, PNG).expect(404);
    await putThumb(request(ctx.app), base, 99999, PNG).expect(404);
    await putThumb(request(ctx.app), base, 'abc', PNG).expect(404);
    // An image of another stash is not reachable through this one
    await putThumb(request(ctx.app), base, image.body.id, PNG).expect(404);
    await request(ctx.app).get(`${base}/files/${image.body.id}/thumb`).expect(404);
    assert.equal(ctx.fileStore.countThumbs(), 0);
});

// ---- roles and the drop-box window ----

async function protectedStash(ctx) {
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'guarded', password: 'correct horse' }).expect(201);
    const view = await owner.post('/api/stashes/guarded/share-links').send({ kind: 'view' }).expect(201);
    const drop = await owner.post('/api/stashes/guarded/share-links').send({ kind: 'drop' }).expect(201);
    const viewer = request.agent(ctx.app);
    await viewer.post('/api/stashes/guarded/redeem').send({ token: view.body.token }).expect(200);
    const dropper = request.agent(ctx.app);
    await dropper.post('/api/stashes/guarded/redeem').send({ token: drop.body.token }).expect(200);
    return { owner, viewer, dropper, base: '/api/stashes/guarded' };
}

test('a read-only link and a locked-out visitor cannot attach a thumbnail', async () => {
    const ctx = makeApp();
    const { owner, viewer, base } = await protectedStash(ctx);
    const up = await addFile(owner, base).expect(201);
    const res = await putThumb(viewer, base, up.body.id, PNG).expect(403);
    assert.match(res.body.error, /read-only/);
    await putThumb(request(ctx.app), base, up.body.id, PNG).expect(401);
    assert.equal(ctx.fileStore.countThumbs(), 0);
});

test('a drop-box link can give a thumbnail to what it just uploaded, once, and only for 5 minutes', async () => {
    const ctx = makeApp();
    const { owner, dropper, base } = await protectedStash(ctx);
    // The drop-box link uploads an image and attaches its thumbnail
    const mine = await addFile(dropper, base, 'mine.png').expect(201);
    await putThumb(dropper, base, mine.body.id, JPEG).expect(200);
    // Not again: it cannot replace what is there
    const again = await putThumb(dropper, base, mine.body.id, PNG).expect(403);
    assert.match(again.body.error, /already has a thumbnail/);
    assert.ok((await getThumb(owner, base, mine.body.id).expect(200)).body.equals(JPEG));

    // An image of the owner's, made just now by someone else, is also inside the window (the link cannot tell whose)
    // but once the 5 minutes are over the drop-box link can no longer attach anything
    const late = await addFile(owner, base, 'late.png').expect(201);
    advance(ctx, 5 * MINUTE + 1000);
    const tooLate = await putThumb(dropper, base, late.body.id, PNG).expect(403);
    assert.match(tooLate.body.error, /too long ago/);
    assert.equal((await owner.get(`${base}/files/${late.body.id}`).expect(200)).status, 200);
    assert.equal((await listed2(owner, base)).items.find(i => i.id === late.body.id).thumbUrl, null);
    // Full access can still do it
    await putThumb(owner, base, late.body.id, PNG).expect(200);
    // The drop-box link cannot read thumbnails (it cannot read anything)
    await getThumb(dropper, base, mine.body.id).expect(403);
});

test('a drop-box link is inside the window at exactly 5 minutes', async () => {
    const ctx = makeApp();
    const { dropper, base } = await protectedStash(ctx);
    const up = await addFile(dropper, base, 'edge.png').expect(201);
    advance(ctx, 5 * MINUTE);
    await putThumb(dropper, base, up.body.id, PNG).expect(200);
});

async function listed2(agent, base) {
    return (await agent.get(base).expect(200)).body;
}

test('a read-only link can fetch thumbnails, a locked-out visitor cannot', async () => {
    const ctx = makeApp();
    const { owner, viewer, base } = await protectedStash(ctx);
    const up = await addFile(owner, base).expect(201);
    await putThumb(owner, base, up.body.id, WEBP).expect(200);
    const res = await getThumb(viewer, base, up.body.id).expect(200);
    assert.equal(res.headers['content-type'], 'image/webp');
    await getThumb(request(ctx.app), base, up.body.id).expect(401);
});

// ---- thumbnails go with their item ----

const thumbOnDisk = (ctx, id) => ctx.fileStore.existsThumb(id);

test('deleting an item for good (undo off) removes its thumbnail', async () => {
    const ctx = makeApp({ undoSeconds: 0 });
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    await putThumb(request(ctx.app), base, up.body.id, PNG).expect(200);
    assert.equal(thumbOnDisk(ctx, up.body.id), true);
    await request(ctx.app).delete(`${base}/items/${up.body.id}`).expect(200);
    assert.equal(thumbOnDisk(ctx, up.body.id), false);
    assert.equal(ctx.fileStore.exists(up.body.id), false);
});

test('a trashed image keeps its thumbnail (restore brings both back); the purge removes both', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    await putThumb(request(ctx.app), base, up.body.id, JPEG).expect(200);
    await request(ctx.app).delete(`${base}/items/${up.body.id}`).expect(200);
    // Invisible while it waits, thumbnail included
    await request(ctx.app).get(`${base}/files/${up.body.id}/thumb`).expect(404);
    assert.equal(thumbOnDisk(ctx, up.body.id), true);
    assert.equal(ctx.db.prepare('SELECT has_thumb FROM trash WHERE id = ?').get(up.body.id).has_thumb, 1);
    // A restart inside the undo window must not sweep it
    assert.equal(ctx.fileStore.sweep(ctx.model.liveFileIds(), ctx.model.liveThumbIds()), 0);

    const restored = await request(ctx.app).post(`${base}/items/${up.body.id}/restore`).expect(200);
    assert.equal(restored.body.thumbUrl, `${base}/files/${up.body.id}/thumb`);
    assert.ok((await getThumb(request(ctx.app), base, up.body.id).expect(200)).body.equals(JPEG));

    // Deleted again, and left until the undo time is up: the purge wipes the file and its thumbnail
    await request(ctx.app).delete(`${base}/items/${up.body.id}`).expect(200);
    advance(ctx, 121 * 1000);
    ctx.controller.cleanup();
    assert.equal(thumbOnDisk(ctx, up.body.id), false);
    assert.equal(ctx.fileStore.exists(up.body.id), false);
    assert.equal(ctx.model.countTrash(), 0);
});

test('a trashed image that cannot be restored any more drops its thumbnail too', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    await putThumb(request(ctx.app), base, up.body.id, PNG).expect(200);
    await request(ctx.app).delete(`${base}/items/${up.body.id}`).expect(200);
    ctx.model.dropTrashed(1, up.body.id);
    assert.equal(thumbOnDisk(ctx, up.body.id), false);
});

test('deleting or expiring a stash removes the thumbnails of its images, trashed ones included', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'doomed');
    const a = await addFile(request(ctx.app), base, 'a.png').expect(201);
    const b = await addFile(request(ctx.app), base, 'b.png').expect(201);
    await putThumb(request(ctx.app), base, a.body.id, PNG).expect(200);
    await putThumb(request(ctx.app), base, b.body.id, PNG).expect(200);
    await request(ctx.app).delete(`${base}/items/${b.body.id}`).expect(200); // in the trash
    assert.equal(ctx.fileStore.countThumbs(), 2);
    await request(ctx.app).delete(base).expect(200);
    assert.equal(ctx.fileStore.countThumbs(), 0);
    assert.equal(ctx.fileStore.count(), 0);

    // Expiry
    const ttl = makeApp();
    await request(ttl.app).post('/api/stashes').send({ slug: 'short-lived', ttl: '1h' }).expect(201);
    const c = await addFile(request(ttl.app), '/api/stashes/short-lived').expect(201);
    await putThumb(request(ttl.app), '/api/stashes/short-lived', c.body.id, PNG).expect(200);
    advance(ttl, 2 * 60 * 60 * 1000);
    ttl.controller.cleanup();
    assert.equal(ttl.fileStore.countThumbs(), 0);
    assert.equal(ttl.fileStore.count(), 0);
});

test('"keep the last N" removes the thumbnail of an image it trims', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const old = await addFile(request(ctx.app), base, 'old.png').expect(201);
    await putThumb(request(ctx.app), base, old.body.id, PNG).expect(200);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 1 }).expect(200);
    advance(ctx, 1000);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'newer' }).expect(201);
    assert.equal(ctx.fileStore.exists(old.body.id), false);
    assert.equal(thumbOnDisk(ctx, old.body.id), false);
    assert.equal(ctx.fileStore.countThumbs(), 0);
});

// ---- the startup sweep ----

test('the startup sweep keeps thumbnails of existing items and removes orphan ones', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const keep = await addFile(request(ctx.app), base, 'keep.png').expect(201);
    const none = await addFile(request(ctx.app), base, 'none.png').expect(201);
    await putThumb(request(ctx.app), base, keep.body.id, PNG).expect(200);
    // A thumbnail whose item is gone, and one that is not named like a thumbnail
    ctx.fileStore.writeThumb(9999, PNG);
    fs.writeFileSync(`${ctx.fileStore.dir}/12.thumb.bak`, 'someone put this here');
    fs.writeFileSync(`${ctx.fileStore.dir}/x.thumb`, 'neither');

    const removed = ctx.fileStore.sweep(ctx.model.liveFileIds(), ctx.model.liveThumbIds());
    assert.equal(removed, 3);
    assert.equal(thumbOnDisk(ctx, keep.body.id), true);
    assert.equal(thumbOnDisk(ctx, 9999), false);
    assert.equal(ctx.fileStore.exists(keep.body.id), true);
    assert.equal(ctx.fileStore.exists(none.body.id), true);
    assert.ok((await getThumb(request(ctx.app), base, keep.body.id).expect(200)).body.equals(PNG));
});

test('a thumbnail on disk for an item that never got the flag (a crash between the two steps) is swept; the default sweep keeps it', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await addFile(request(ctx.app), base).expect(201);
    ctx.fileStore.writeThumb(up.body.id, PNG); // written, but the flag was never set
    // Called with just the ids of items (as older callers do), a thumbnail of an existing item stays
    assert.equal(ctx.fileStore.sweep(ctx.model.liveFileIds()), 0);
    assert.equal(thumbOnDisk(ctx, up.body.id), true);
    // The server's startup sweep also knows which items have a thumbnail, and clears the stray one
    assert.equal(ctx.fileStore.sweep(ctx.model.liveFileIds(), ctx.model.liveThumbIds()), 1);
    assert.equal(thumbOnDisk(ctx, up.body.id), false);
    assert.equal((await listed(ctx, base)).items[0].thumbUrl, null);
});

test('FileStore keeps thumbnails apart from files in its counts and writes them in one step', () => {
    const ctx = makeApp();
    ctx.fileStore.write(5, Buffer.from('file'));
    ctx.fileStore.writeThumb(5, PNG);
    ctx.fileStore.writeThumb(5, JPEG); // replaced
    assert.equal(ctx.fileStore.count(), 1);
    assert.equal(ctx.fileStore.countThumbs(), 1);
    assert.ok(fs.readFileSync(ctx.fileStore.pathOfThumb(5)).equals(JPEG));
    assert.deepEqual(fs.readdirSync(ctx.fileStore.tmpDir), []);
    assert.deepEqual(ctx.fileStore.storedNames().sort(), ['5', '5.thumb']);
    ctx.fileStore.remove([5]);
    assert.deepEqual(ctx.fileStore.storedNames(), []);
});

// ---- backup and export ----

const PASSWORD = 'admin-pass-123';

test('the backup includes thumbnails (files/<id>.thumb) and the export leaves them out', async () => {
    const ctx = makeApp({ adminPassword: PASSWORD });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: PASSWORD }).expect(200);
    const base = await stash(ctx, 'precious');
    const up = await addFile(request(ctx.app), base, 'shot.png').expect(201);
    const plain = await addFile(request(ctx.app), base, 'plain.png').expect(201);
    await putThumb(request(ctx.app), base, up.body.id, JPEG).expect(200);

    const backup = await admin.get('/api/admin/backup').buffer(true).parse(binary).expect(200);
    const entries = unzip(backup.body);
    assert.deepEqual([...entries.keys()].sort(), ['stashly.sqlite', `files/${up.body.id}`, `files/${up.body.id}.thumb`, `files/${plain.body.id}`].sort());
    assert.ok(entries.get(`files/${up.body.id}.thumb`).equals(JPEG));
    assert.ok(entries.get(`files/${up.body.id}`).equals(PNG));

    const exported = await request(ctx.app).get(`${base}/export`).buffer(true).parse(binary).expect(200);
    const names = [...unzip(exported.body).keys()];
    assert.ok(names.some(name => name.startsWith(`files/${up.body.id}-`)));
    assert.ok(!names.some(name => /thumb/i.test(name)));
    assert.equal(names.length, 3); // stash.json and the two images
});
