const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { makeApp, newFileStore, PNG } = require('./helpers/app');
const { unzip, binary } = require('./helpers/unzip');
const { connect } = require('../src/database/sqlite');

const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check) {
    for (let i = 0; i < 60 && !check(); i++) await wait(50);
}
const tmpFiles = ctx => (fs.existsSync(ctx.fileStore.tmpDir) ? fs.readdirSync(ctx.fileStore.tmpDir) : []);
const HOUR = 60 * 60 * 1000;

const CHUNK = 65536; // the smallest piece the server allows, to keep the tests quick
const small = (overrides = {}) => makeApp({ maxChunkBytes: CHUNK, ...overrides });

// Bytes that are recognisable at any position, so a misplaced or repeated piece cannot go unnoticed
const pattern = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8) * 7 + (i >> 16)) & 255));
// A "zip" (its first bytes are the zip signature, which is all the type check reads) with that pattern after it
const zipLike = n => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), pattern(n - 4)]);

async function stash(ctx, slug = 'resume-stash') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

const start = (agent, base, body) => agent.post(`${base}/uploads`).send(body);
const piece = (agent, base, id, offset, bytes) =>
    agent.patch(`${base}/uploads/${id}`).set('Upload-Offset', String(offset)).set('Content-Type', 'application/octet-stream').send(bytes);
const finish = (agent, base, id) => agent.post(`${base}/uploads/${id}/complete`);

// Sends all of `data` in pieces of `size` and returns the last answer
async function sendAll(agent, base, id, data, size = CHUNK) {
    let last = null;
    for (let at = 0; at < data.length; at += size) last = await piece(agent, base, id, at, data.subarray(at, at + size)).expect(200);
    return last;
}

// ---- the whole way ----

test('a multi-piece upload arrives byte for byte, as an item, with the same side effects as a single upload', async () => {
    const lines = [];
    const audit = [];
    const withLogs = makeApp({ maxChunkBytes: CHUNK, metricsToken: 'metrics-token-for-tests', logFormat: 'json', auditLog: 'stdout' }, { logOut: l => lines.push(l), auditOut: l => audit.push(l) });
    const base = await stash(withLogs);
    const data = zipLike(CHUNK * 3 + 12345);

    const published = [];
    const publish = withLogs.events.publish.bind(withLogs.events);
    withLogs.events.publish = (slug, event, payload) => { published.push({ slug, event, payload }); return publish(slug, event, payload); };

    const created = await start(request(withLogs.app), base, { name: 'big.zip', size: data.length, title: 'Big one' }).expect(201);
    assert.match(created.body.id, /^[A-Za-z0-9_-]{32,}$/); // 24 random bytes, base64url
    assert.equal(created.body.offset, 0);
    assert.equal(created.body.size, data.length);
    assert.equal(created.body.chunkSize, CHUNK);
    assert.equal(created.headers.location, `${base}/uploads/${created.body.id}`);
    const id = created.body.id;

    // Nothing counts as stored until it is complete
    assert.deepEqual((await request(withLogs.app).get(base).expect(200)).body.usage, { items: 0, files: 0, bytes: 0 });
    assert.equal(withLogs.fileStore.count(), 0);

    const last = await sendAll(request(withLogs.app), base, id, data);
    assert.equal(last.body.offset, data.length);
    assert.equal(last.headers['upload-offset'], String(data.length));

    const done = await finish(request(withLogs.app), base, id).set('X-Tab-Id', 'tab-1').expect(201);
    assert.equal(done.body.kind, 'file');
    assert.equal(done.body.fileName, 'big.zip');
    assert.equal(done.body.fileType, 'application/zip');
    assert.equal(done.body.fileSize, data.length);
    assert.equal(done.body.title, 'Big one');
    assert.equal(done.body.hasTitle, true);

    // The stored file is identical, nothing is left in tmp, and the upload is gone
    assert.ok(fs.readFileSync(withLogs.fileStore.pathOf(done.body.id)).equals(data));
    assert.deepEqual(tmpFiles(withLogs), []);
    assert.equal(withLogs.db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, 0);
    const served = await request(withLogs.app).get(done.body.url).buffer(true).parse(binary).expect(200);
    assert.ok(served.body.equals(data));
    await request(withLogs.app).get(`${base}/uploads/${id}`).expect(404);

    // The live event is the one a single upload sends (and carries the page's origin)
    const added = published.filter(p => p.event === 'item-added');
    assert.equal(added.length, 1);
    assert.equal(added[0].payload.id, done.body.id);
    assert.equal(added[0].payload.origin, 'tab-1');

    // The counters count it once, as a file of its full size
    const metrics = (await request(withLogs.app).get('/metrics').set({ Authorization: 'Bearer metrics-token-for-tests' }).expect(200)).text;
    assert.match(metrics, /^stashly_uploads_total 1$/m);
    assert.match(metrics, new RegExp(`^stashly_uploaded_bytes_total ${data.length}$`, 'm'));
    assert.match(metrics, /route="\/api\/stashes\/:slug\/uploads\/:id",status_class="2xx"/);

    // A single upload writes no audit line and neither does this; and no log line holds the secret id or the name
    assert.equal(audit.filter(l => /upload/i.test(l)).length, 0);
    for (const line of lines) assert.ok(!line.includes(id) && !line.includes('big.zip') && !line.includes('resume-stash'), line);
});

test('"keep the last N" trims after a completed upload, like after a single one', async () => {
    const ctx = small();
    const base = await stash(ctx);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 1 }).expect(200);
    await request(ctx.app).post(`${base}/notes`).set('Content-Type', 'text/plain').send('old note').expect(201);
    const data = zipLike(CHUNK + 10);
    const { body } = await start(request(ctx.app), base, { name: 'new.zip', size: data.length }).expect(201);
    await sendAll(request(ctx.app), base, body.id, data);
    await finish(request(ctx.app), base, body.id).expect(201);
    const list = (await request(ctx.app).get(base).expect(200)).body;
    assert.deepEqual(list.items.map(i => i.fileName), ['new.zip']);
});

test('a small file also works as one piece, and a title is optional', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const text = Buffer.from('just some text\n'.repeat(10));
    const { body } = await start(request(ctx.app), base, { name: 'hello.txt', size: text.length }).expect(201);
    await piece(request(ctx.app), base, body.id, 0, text).expect(200);
    const done = await finish(request(ctx.app), base, body.id).expect(201);
    assert.match(done.body.fileType, /^text\/plain/);
    assert.equal(done.body.hasTitle, false);
    assert.equal(done.body.title, 'hello.txt');
});

test('an image finished this way is an image: it can take a thumbnail like any other', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const png = Buffer.concat([PNG, pattern(CHUNK)]);
    const { body } = await start(request(ctx.app), base, { name: 'shot.png', size: png.length }).expect(201);
    await sendAll(request(ctx.app), base, body.id, png);
    const done = await finish(request(ctx.app), base, body.id).expect(201);
    assert.equal(done.body.isImage, true);
    assert.equal(done.body.thumbUrl, null);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 2)]);
    const thumbed = await request(ctx.app).put(`${base}/files/${done.body.id}/thumb`).send(jpeg).expect(200);
    assert.equal(thumbed.body.thumbUrl, `${base}/files/${done.body.id}/thumb`);
});

test('the single-request upload is unchanged', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const res = await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'plain.zip').set('X-Title', 'Plain').set('Content-Type', 'application/octet-stream').send(zipLike(5000)).expect(201);
    assert.equal(res.body.fileName, 'plain.zip');
    assert.equal(res.body.title, 'Plain');
    assert.equal(res.body.fileSize, 5000);
    await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'x.exe').send(Buffer.from('MZ')).expect(415);
    // A single upload is not limited by the piece size
    await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'big.zip').set('Content-Type', 'application/octet-stream').send(zipLike(CHUNK * 3)).expect(201);
});

// ---- starting an upload: everything that needs no bytes ----

test('starting an upload checks its input', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const a = request(ctx.app);
    assert.equal((await start(a, base, {}).expect(400)).body.field, 'name');
    assert.equal((await start(a, base, { name: 5, size: 10 }).expect(400)).body.field, 'name');
    assert.equal((await start(a, base, { name: 'a.txt' }).expect(400)).body.field, 'size');
    assert.equal((await start(a, base, { name: 'a.txt', size: '10' }).expect(400)).body.field, 'size');
    assert.equal((await start(a, base, { name: 'a.txt', size: -1 }).expect(400)).body.field, 'size');
    assert.equal((await start(a, base, { name: 'a.txt', size: 1.5 }).expect(400)).body.field, 'size');
    assert.match((await start(a, base, { name: 'a.txt', size: 0 }).expect(400)).body.error, /empty/);
    assert.equal((await start(a, base, { name: '///', size: 10 }).expect(400)).body.field, undefined);
    assert.equal((await start(a, base, { name: 'a.txt', size: 10, title: 'x'.repeat(151) }).expect(400)).body.field, 'title');
    assert.equal((await start(a, base, { name: 'a.txt', size: 10, title: 7 }).expect(400)).body.field, 'title');
    assert.equal(ctx.model.countUploads(), 0);
    assert.deepEqual(tmpFiles(ctx), []);
});

test('the file name is cleaned the way a single upload cleans it', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: '..\\..\\sneaky/dir\\notes.txt', size: 10 }).expect(201);
    assert.equal(ctx.model.getUpload(1, body.id).name, 'notes.txt');
});

test('a blocked extension is refused before any byte is sent, but only in the modes that block it', async () => {
    const ctx = small();
    const base = await stash(ctx);
    assert.match((await start(request(ctx.app), base, { name: 'setup.exe', size: 100 }).expect(415)).body.error, /\.exe files aren't allowed/);
    await start(request(ctx.app), base, { name: 'logo.svg', size: 100 }).expect(415);
    ctx.config.fileTypes = 'no-programs';
    await start(request(ctx.app), base, { name: 'setup.exe', size: 100 }).expect(415);
    await start(request(ctx.app), base, { name: 'backup.7z', size: 100 }).expect(201);
    ctx.config.fileTypes = 'any';
    await start(request(ctx.app), base, { name: 'setup.exe', size: 100 }).expect(201);
});

test('the declared size must fit the file limit, and the stash and server quotas', async () => {
    const ctx = small({ maxFileBytes: 1000000, maxStashBytes: 1500000, maxFilesPerStash: 2, maxTotalBytes: 2000000 });
    const base = await stash(ctx);
    const a = request(ctx.app);
    const big = await start(a, base, { name: 'a.zip', size: 1000001 }).expect(413);
    assert.match(big.body.error, /at most/);

    // Room in the stash: 1.5 MB. A file of 1 MB fits; a second of 600 KB would not once the first is stored.
    const data = zipLike(1000000);
    const first = await start(a, base, { name: 'one.zip', size: data.length }).expect(201);
    await sendAll(a, base, first.body.id, data);
    await finish(a, base, first.body.id).expect(201);
    assert.match((await start(a, base, { name: 'two.zip', size: 600000 }).expect(413)).body.error, /limit/);
    await start(a, base, { name: 'two.zip', size: 400000 }).expect(201);

    // The file count
    const roomy = small({ maxFilesPerStash: 1, maxItemsPerStash: 5 });
    const b = await stash(roomy, 'count-stash');
    await request(roomy.app).post(`${b}/files`).set('X-File-Name', 'a.txt').send(Buffer.from('x')).expect(201);
    assert.match((await start(request(roomy.app), b, { name: 'b.txt', size: 5 }).expect(413)).body.error, /1 files/);

    // The item count
    const full = small({ maxItemsPerStash: 1 });
    const c = await stash(full, 'item-stash');
    await request(full.app).post(`${c}/notes`).set('Content-Type', 'text/plain').send('a note').expect(201);
    assert.match((await start(request(full.app), c, { name: 'b.txt', size: 5 }).expect(413)).body.error, /full/);

    // The server's space
    const tight = small({ maxTotalBytes: 100000 });
    const d = await stash(tight, 'space-stash');
    assert.match((await start(request(tight.app), d, { name: 'b.zip', size: 200000 }).expect(507)).body.error, /out of file space/);
});

test('the declared sizes of open uploads count against the server space, so many of them cannot fill the disk', async () => {
    const ctx = small({ maxTotalBytes: 1000000, maxOpenUploads: 10 });
    const base = await stash(ctx);
    const other = await stash(ctx, 'other-stash');
    const a = request(ctx.app);
    await start(a, base, { name: 'a.zip', size: 400000 }).expect(201);
    await start(a, other, { name: 'b.zip', size: 400000 }).expect(201);
    // 800000 of 1000000 is spoken for: 300000 more does not fit, 200000 does
    assert.match((await start(a, base, { name: 'c.zip', size: 300000 }).expect(507)).body.error, /out of file space/);
    const fits = await start(a, base, { name: 'd.zip', size: 200000 }).expect(201);
    // Cancelling gives the space back
    await a.delete(`${base}/uploads/${fits.body.id}`).expect(204);
    await start(a, base, { name: 'e.zip', size: 200000 }).expect(201);
});

test('a stash and the server only hold so many unfinished uploads', async () => {
    const ctx = small({ maxOpenUploads: 2, maxOpenUploadsServer: 3 });
    const one = await stash(ctx, 'stash-one');
    const two = await stash(ctx, 'stash-two');
    const a = request(ctx.app);
    const first = await start(a, one, { name: 'a.txt', size: 10 }).expect(201);
    await start(a, one, { name: 'b.txt', size: 10 }).expect(201);
    const refused = await start(a, one, { name: 'c.txt', size: 10 }).expect(429);
    assert.match(refused.body.error, /2 unfinished uploads/);
    // Another stash has its own allowance, up to the server's
    await start(a, two, { name: 'd.txt', size: 10 }).expect(201);
    assert.match((await start(a, two, { name: 'e.txt', size: 10 }).expect(429)).body.error, /server has too many/);
    // Finishing or cancelling one makes room
    await a.delete(`${one}/uploads/${first.body.id}`).expect(204);
    await start(a, two, { name: 'e.txt', size: 10 }).expect(201);
});

test('starting uploads is rate limited like uploading, and pieces have their own, looser limit', async () => {
    const ctx = small({ rateUpload: 2, rateChunk: 3, maxOpenUploads: 50, maxOpenUploadsServer: 50 });
    const base = await stash(ctx);
    const a = request(ctx.app);
    const { body } = await start(a, base, { name: 'a.txt', size: 5 * 3 }).expect(201);
    await start(a, base, { name: 'b.txt', size: 10 }).expect(201);
    await start(a, base, { name: 'c.txt', size: 10 }).expect(429);
    // Pieces are counted apart: three pass, the fourth is slowed
    for (let i = 0; i < 3; i++) await piece(a, base, body.id, i * 5, Buffer.from('hello')).expect(200);
    await piece(a, base, body.id, 15, Buffer.from('x')).expect(429);
});

// ---- who may do what ----

const PASSWORD = 'correct horse';
async function protectedStash(ctx, slug = 'vault') {
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug, password: PASSWORD }).expect(201);
    return { owner, base: `/api/stashes/${slug}` };
}
async function visitor(ctx, base, token) {
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/redeem`).send({ token }).expect(200);
    return agent;
}

test('a stash that takes only notes refuses every step', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'a.txt', size: 10 }).expect(201);
    await request(ctx.app).put(`${base}/content`).send({ content: 'notes' }).expect(200);
    assert.match((await start(request(ctx.app), base, { name: 'b.txt', size: 10 }).expect(403)).body.error, /only takes notes/);
    await piece(request(ctx.app), base, body.id, 0, Buffer.from('0123456789')).expect(403);
    await finish(request(ctx.app), base, body.id).expect(403);
});

test('a locked stash asks for the password, and a read-only link cannot start, send or finish an upload', async () => {
    const ctx = small();
    const { owner, base } = await protectedStash(ctx);
    await start(request(ctx.app), base, { name: 'a.txt', size: 10 }).expect(401);
    const mine = await start(owner, base, { name: 'a.txt', size: 10 }).expect(201);

    const link = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = await visitor(ctx, base, link.token);
    await start(viewer, base, { name: 'b.txt', size: 10 }).expect(403);
    await viewer.get(`${base}/uploads/${mine.body.id}`).expect(403);
    await piece(viewer, base, mine.body.id, 0, Buffer.from('0123456789')).expect(403);
    await finish(viewer, base, mine.body.id).expect(403);
    await viewer.delete(`${base}/uploads/${mine.body.id}`).expect(403);
    assert.equal(ctx.model.countUploads(), 1);
});

test('a drop-box link can upload in pieces, but only touches uploads it started itself', async () => {
    const ctx = small();
    const { owner, base } = await protectedStash(ctx);
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    const dropper = await visitor(ctx, base, link.token);

    const full = await start(owner, base, { name: 'owner.txt', size: 10 }).expect(201);
    // The drop-box visitor cannot see or change what full access started (even knowing the id)
    await dropper.get(`${base}/uploads/${full.body.id}`).expect(404);
    await piece(dropper, base, full.body.id, 0, Buffer.from('0123456789')).expect(404);
    await finish(dropper, base, full.body.id).expect(404);
    await dropper.delete(`${base}/uploads/${full.body.id}`).expect(404);

    const data = zipLike(CHUNK * 2 + 5);
    const mine = await start(dropper, base, { name: 'dropped.zip', size: data.length }).expect(201);
    await sendAll(dropper, base, mine.body.id, data);
    const done = await finish(dropper, base, mine.body.id).expect(201);
    assert.equal(done.body.fileName, 'dropped.zip');
    assert.ok(fs.readFileSync(ctx.fileStore.pathOf(done.body.id)).equals(data));
    // Full access may handle the drop-box upload as well
    const another = await start(dropper, base, { name: 'again.txt', size: 4 }).expect(201);
    await owner.get(`${base}/uploads/${another.body.id}`).expect(200);
    await owner.delete(`${base}/uploads/${another.body.id}`).expect(204);
});

test('an upload belongs to its stash: another stash (or a made-up id) cannot reach it', async () => {
    const ctx = small();
    const one = await stash(ctx, 'stash-one');
    const two = await stash(ctx, 'stash-two');
    const { body } = await start(request(ctx.app), one, { name: 'a.txt', size: 10 }).expect(201);
    const a = request(ctx.app);
    await a.get(`${two}/uploads/${body.id}`).expect(404);
    await piece(a, two, body.id, 0, Buffer.from('0123456789')).expect(404);
    await finish(a, two, body.id).expect(404);
    await a.delete(`${two}/uploads/${body.id}`).expect(404);
    for (const id of ['short', 'x'.repeat(32), '../../etc/passwd', `${body.id}x`]) {
        await a.get(`${one}/uploads/${encodeURIComponent(id)}`).expect(404);
        await piece(a, one, encodeURIComponent(id), 0, Buffer.from('0123456789')).expect(404);
    }
    // It is still there and untouched
    assert.equal((await a.get(`${one}/uploads/${body.id}`).expect(200)).body.offset, 0);
    await a.get(`${stashUrl('nonexistent')}/uploads/${body.id}`).expect(404);
});
const stashUrl = slug => `/api/stashes/${slug}`;

// ---- asking where it stands ----

test('GET and HEAD say where an upload stands', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const data = zipLike(CHUNK * 2);
    const { body } = await start(request(ctx.app), base, { name: 'a.zip', size: data.length }).expect(201);
    await piece(request(ctx.app), base, body.id, 0, data.subarray(0, CHUNK)).expect(200);

    const got = await request(ctx.app).get(`${base}/uploads/${body.id}`).expect(200);
    assert.deepEqual({ id: got.body.id, offset: got.body.offset, size: got.body.size }, { id: body.id, offset: CHUNK, size: data.length });
    assert.equal(got.headers['upload-offset'], String(CHUNK));
    const head = await request(ctx.app).head(`${base}/uploads/${body.id}`).expect(200);
    assert.equal(head.headers['upload-offset'], String(CHUNK));
    assert.equal(head.headers['upload-length'], String(data.length));
    assert.equal(head.text, undefined);
});

// ---- sending pieces ----

test('a piece must start where the server is: a wrong offset is a 409 that says where to go on', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const data = zipLike(CHUNK * 2);
    const { body } = await start(request(ctx.app), base, { name: 'a.zip', size: data.length }).expect(201);
    const a = request(ctx.app);
    const ahead = await piece(a, base, body.id, CHUNK, data.subarray(CHUNK)).expect(409);
    assert.equal(ahead.body.offset, 0);
    assert.equal(ahead.headers['upload-offset'], '0');
    await piece(a, base, body.id, 0, data.subarray(0, CHUNK)).expect(200);
    // Sending the same piece again (a lost answer) is told where the upload really is, and nothing is written twice
    const again = await piece(a, base, body.id, 0, data.subarray(0, CHUNK)).expect(409);
    assert.equal(again.body.offset, CHUNK);
    assert.equal(ctx.fileStore.partSize(body.id), CHUNK);
    await piece(a, base, body.id, CHUNK, data.subarray(CHUNK)).expect(200);
    await finish(a, base, body.id).expect(201);
});

test('the offset header is required and must be a number', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'a.txt', size: 10 }).expect(201);
    const bare = await request(ctx.app).patch(`${base}/uploads/${body.id}`).set('Content-Type', 'application/octet-stream').send(Buffer.from('0123456789')).expect(400);
    assert.match(bare.body.error, /Upload-Offset/);
    for (const bad of ['abc', '-1', '1.5', '0x10', '']) {
        await request(ctx.app).patch(`${base}/uploads/${body.id}`).set('Upload-Offset', bad).set('Content-Type', 'application/octet-stream').send(Buffer.from('0123456789')).expect(400);
    }
    assert.equal(ctx.fileStore.partSize(body.id), 0);
});

test('a piece that is too big is refused: by its Content-Length, by its real size, and past the declared size', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const a = request(ctx.app);
    const data = zipLike(CHUNK * 3);
    const { body } = await start(a, base, { name: 'a.zip', size: data.length }).expect(201);

    // Over the piece size, by the Content-Length header alone
    const over = await piece(a, base, body.id, 0, data.subarray(0, CHUNK + 1)).expect(413);
    assert.match(over.body.error, /at most 64 KB/);
    assert.equal(ctx.fileStore.partSize(body.id), 0);
    assert.deepEqual(tmpFiles(ctx).filter(n => !n.startsWith('part-')), []);

    // A body of unknown length (chunked transfer, no Content-Length) is cut off at the limit
    const server = ctx.app.listen(0);
    try {
        const status = await new Promise(resolve => {
            const req = http.request({ port: server.address().port, path: `${base}/uploads/${body.id}`, method: 'PATCH', headers: { 'Upload-Offset': '0', 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, res => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on('error', () => resolve('error'));
            req.write(data.subarray(0, CHUNK));
            req.write(Buffer.alloc(10, 1));
            req.end();
        });
        assert.equal(status, 413);
        await until(() => tmpFiles(ctx).every(n => n.startsWith('part-')));
        assert.equal(ctx.fileStore.partSize(body.id), 0);
    } finally {
        server.closeAllConnections();
        server.close();
    }

    // Pieces that together would pass the size declared at the start
    await sendAll(a, base, body.id, data);
    const past = await piece(a, base, body.id, data.length, Buffer.from('one more byte')).expect(413);
    assert.match(past.body.error, /past the size/);
    const small2 = await start(a, base, { name: 'b.zip', size: 100 }).expect(201);
    await piece(a, base, small2.body.id, 0, zipLike(101)).expect(413);
    assert.equal(ctx.fileStore.partSize(small2.body.id), 0);
    // exactly the declared size is fine
    await piece(a, base, small2.body.id, 0, zipLike(100)).expect(200);
});

test('an empty piece is refused', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'a.txt', size: 10 }).expect(201);
    assert.match((await piece(request(ctx.app), base, body.id, 0, Buffer.alloc(0)).expect(400)).body.error, /empty/);
});

test('a piece sent as application/json is still read as raw bytes', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'a.txt', size: 8 }).expect(201);
    await request(ctx.app).patch(`${base}/uploads/${body.id}`).set('Upload-Offset', '0').set('Content-Type', 'application/json').send('{"a":1} ').expect(200);
    assert.equal(fs.readFileSync(ctx.fileStore.partPath(body.id), 'utf8'), '{"a":1} ');
});

test('two pieces of one upload cannot interleave: the second is refused while the first is arriving', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const data = zipLike(2000);
    const { body } = await start(request(ctx.app), base, { name: 'a.zip', size: data.length }).expect(201);
    const server = ctx.app.listen(0);
    try {
        const first = http.request({ port: server.address().port, path: `${base}/uploads/${body.id}`, method: 'PATCH', headers: { 'Upload-Offset': '0', 'Content-Type': 'application/octet-stream', 'Content-Length': '1000' } });
        const firstDone = new Promise(resolve => first.on('response', res => { res.resume(); resolve(res.statusCode); }));
        first.write(data.subarray(0, 400));
        await until(() => ctx.controller.uploadLocks.has(body.id));
        assert.ok(ctx.controller.uploadLocks.has(body.id));

        const second = await request(server).patch(`${base}/uploads/${body.id}`).set('Upload-Offset', '0').set('Content-Type', 'application/octet-stream').send(data.subarray(0, 1000));
        assert.equal(second.status, 409);
        assert.equal(second.body.busy, true);
        // Finishing and cancelling are held off as well while a piece arrives
        assert.equal((await request(server).post(`${base}/uploads/${body.id}/complete`)).status, 409);
        assert.equal((await request(server).delete(`${base}/uploads/${body.id}`)).status, 409);
        // ...while asking where it stands still works, and says the last whole piece
        assert.equal((await request(server).get(`${base}/uploads/${body.id}`)).body.offset, 0);

        first.end(data.subarray(400, 1000));
        assert.equal(await firstDone, 200);
        assert.equal(ctx.controller.uploadLocks.size, 0);
        assert.ok(fs.readFileSync(ctx.fileStore.partPath(body.id)).equals(data.subarray(0, 1000)));
        // The lock is released: the next piece goes through
        await piece(request(server), base, body.id, 1000, data.subarray(1000)).expect(200);
        await finish(request(server), base, body.id).expect(201);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test('a piece cut off half way changes nothing: the offset stays at the last whole piece and the file stays intact', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const data = zipLike(CHUNK * 3);
    const { body } = await start(request(ctx.app), base, { name: 'a.zip', size: data.length }).expect(201);
    const id = body.id;
    await piece(request(ctx.app), base, id, 0, data.subarray(0, CHUNK)).expect(200);

    const server = ctx.app.listen(0);
    try {
        // The second piece promises CHUNK bytes, sends 20000 and the connection dies
        await new Promise(resolve => {
            const req = http.request({ port: server.address().port, path: `${base}/uploads/${id}`, method: 'PATCH', headers: { 'Upload-Offset': String(CHUNK), 'Content-Type': 'application/octet-stream', 'Content-Length': String(CHUNK) } });
            req.on('error', () => {});
            req.write(data.subarray(CHUNK, CHUNK + 20000));
            setTimeout(() => {
                req.destroy();
                resolve();
            }, 80);
        });
        await until(() => !ctx.controller.uploadLocks.has(id) && tmpFiles(ctx).every(n => n.startsWith('part-')));
        assert.equal(ctx.controller.uploadLocks.has(id), false);
        // Nothing but the partial file is left, and it holds exactly the first piece
        assert.deepEqual(tmpFiles(ctx), [ctx.fileStore.partName(id)]);
        assert.equal(ctx.fileStore.partSize(id), CHUNK);
        assert.ok(fs.readFileSync(ctx.fileStore.partPath(id)).equals(data.subarray(0, CHUNK)));
        const stands = await request(server).get(`${base}/uploads/${id}`).expect(200);
        assert.equal(stands.body.offset, CHUNK);

        // The client asks, sees CHUNK, and sends from there: the finished file is correct
        await piece(request(server), base, id, CHUNK, data.subarray(CHUNK, CHUNK * 2)).expect(200);
        await piece(request(server), base, id, CHUNK * 2, data.subarray(CHUNK * 2)).expect(200);
        const done = await finish(request(server), base, id).expect(201);
        assert.ok(fs.readFileSync(ctx.fileStore.pathOf(done.body.id)).equals(data));
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test('a piece that fails while it is copied onto the partial file is cut back, leaving only whole pieces', () => {
    const store = newFileStore();
    store.ensure();
    store.createPart('abc');
    const first = path.join(store.tmpDir, 'piece-1');
    fs.writeFileSync(first, Buffer.from('0123456789'));
    return store.appendPart('abc', first, 0).then(async size => {
        assert.equal(size, 10);
        // Garbage past the good offset (as a crash mid-copy could leave) and a piece that cannot be read
        fs.appendFileSync(store.partPath('abc'), 'GARBAGE');
        await assert.rejects(store.appendPart('abc', path.join(store.tmpDir, 'missing'), 10));
        assert.equal(store.partSize('abc'), 10);
        assert.equal(fs.readFileSync(store.partPath('abc'), 'utf8'), '0123456789');
        // Writing is positional: a repeat at the same offset cannot double the bytes
        fs.writeFileSync(first, Buffer.from('ABCDE'));
        assert.equal(await store.appendPart('abc', first, 10), 15);
        assert.equal(await store.appendPart('abc', first, 10), 15);
        assert.equal(fs.readFileSync(store.partPath('abc'), 'utf8'), '0123456789ABCDE');
        store.removePart('abc');
        assert.equal(store.partSize('abc'), null);
    });
});

// ---- finishing ----

test('finishing is refused until every byte is there, and the upload can be carried on afterwards', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const data = zipLike(CHUNK * 2);
    const { body } = await start(request(ctx.app), base, { name: 'a.zip', size: data.length }).expect(201);
    const a = request(ctx.app);
    const none = await finish(a, base, body.id).expect(409);
    assert.equal(none.body.offset, 0);
    await piece(a, base, body.id, 0, data.subarray(0, CHUNK)).expect(200);
    const half = await finish(a, base, body.id).expect(409);
    assert.equal(half.body.offset, CHUNK);
    assert.equal(half.body.size, data.length);
    assert.equal(ctx.model.countUploads(), 1);
    assert.equal(ctx.fileStore.count(), 0);
    await piece(a, base, body.id, CHUNK, data.subarray(CHUNK)).expect(200);
    await finish(a, base, body.id).expect(201);
    // A second complete finds nothing
    await finish(a, base, body.id).expect(404);
});

test('the content is checked when it is complete: a bad type is a 415 and the partial upload is deleted', async () => {
    const ctx = small();
    const base = await stash(ctx);
    // Says it is a zip, is plain bytes with no text and no zip signature
    const data = Buffer.concat([Buffer.from([1, 2, 3, 0, 0, 0]), pattern(CHUNK)]);
    const { body } = await start(request(ctx.app), base, { name: 'fake.zip', size: data.length }).expect(201);
    await sendAll(request(ctx.app), base, body.id, data);
    const refused = await finish(request(ctx.app), base, body.id).expect(415);
    assert.match(refused.body.error, /doesn't look like a \.zip/);
    assert.equal(ctx.model.countUploads(), 0);
    assert.deepEqual(tmpFiles(ctx), []);
    assert.equal(ctx.fileStore.count(), 0);
    await request(ctx.app).get(`${base}/uploads/${body.id}`).expect(404);
    assert.deepEqual((await request(ctx.app).get(base).expect(200)).body.items, []);

    // Binary content under a name with no known type is refused in the safe mode as well
    const blob = Buffer.concat([Buffer.from([0, 1, 2, 3]), pattern(500)]);
    const other = await start(request(ctx.app), base, { name: 'thing.bin', size: blob.length }).expect(201);
    await piece(request(ctx.app), base, other.body.id, 0, blob).expect(200);
    await finish(request(ctx.app), base, other.body.id).expect(415);
    assert.equal(ctx.model.countUploads(), 0);
    // ...but is stored in the "any" mode
    ctx.config.fileTypes = 'any';
    const third = await start(request(ctx.app), base, { name: 'thing.bin', size: blob.length }).expect(201);
    await piece(request(ctx.app), base, third.body.id, 0, blob).expect(200);
    const stored = await finish(request(ctx.app), base, third.body.id).expect(201);
    assert.equal(stored.body.fileType, 'application/octet-stream');
});

test('the file types mode in force at the end decides the content check', async () => {
    const ctx = small();
    const base = await stash(ctx);
    // A program, called .bin: accepted by "any", refused by "no-programs"
    ctx.config.fileTypes = 'any';
    const exe = Buffer.concat([Buffer.from('MZ'), pattern(300)]);
    const { body } = await start(request(ctx.app), base, { name: 'tool.bin', size: exe.length }).expect(201);
    await piece(request(ctx.app), base, body.id, 0, exe).expect(200);
    ctx.config.fileTypes = 'no-programs';
    assert.match((await finish(request(ctx.app), base, body.id).expect(415)).body.error, /Programs/);
    assert.equal(ctx.model.countUploads(), 0);
});

test('the limits are checked again at the end; the upload is kept so it can finish once there is room', async () => {
    const ctx = small({ maxStashBytes: CHUNK * 4 });
    const base = await stash(ctx);
    const a = request(ctx.app);
    const data = zipLike(CHUNK * 3);
    const { body } = await start(a, base, { name: 'a.zip', size: data.length }).expect(201);
    await sendAll(a, base, body.id, data);
    // Meanwhile the stash filled up with a single upload
    const filler = await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'filler.zip').send(zipLike(CHUNK * 2)).expect(201);
    assert.match((await finish(a, base, body.id).expect(413)).body.error, /limit/);
    assert.equal(ctx.model.countUploads(), 1);
    assert.equal(ctx.fileStore.partSize(body.id), data.length);
    await a.delete(`${base}/items/${filler.body.id}`).expect(200);
    const done = await finish(a, base, body.id).expect(201);
    assert.ok(fs.readFileSync(ctx.fileStore.pathOf(done.body.id)).equals(data));

    // And the server's space, which may have been used up by others since
    const tight = small({ maxTotalBytes: CHUNK * 3 });
    const t = await stash(tight, 'tight-stash');
    const { body: up } = await start(request(tight.app), t, { name: 'a.zip', size: CHUNK * 2 }).expect(201);
    await sendAll(request(tight.app), t, up.id, zipLike(CHUNK * 2));
    tight.config.maxTotalBytes = CHUNK;
    await finish(request(tight.app), t, up.id).expect(507);
    assert.equal(tight.model.countUploads(), 1);
});

test('the title and the name given at the start are what the item gets', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'Résumé final.txt', size: 5, title: '  My résumé  ' }).expect(201);
    await piece(request(ctx.app), base, body.id, 0, Buffer.from('hello')).expect(200);
    const done = await finish(request(ctx.app), base, body.id).expect(201);
    assert.equal(done.body.fileName, 'Résumé final.txt');
    assert.equal(done.body.title, 'My résumé');
});

// ---- cancelling ----

test('cancelling removes the upload and its partial file', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'a.txt', size: CHUNK * 2 }).expect(201);
    await piece(request(ctx.app), base, body.id, 0, Buffer.alloc(CHUNK, 65)).expect(200);
    assert.equal(tmpFiles(ctx).length, 1);
    await request(ctx.app).delete(`${base}/uploads/${body.id}`).expect(204);
    assert.deepEqual(tmpFiles(ctx), []);
    assert.equal(ctx.model.countUploads(), 0);
    await request(ctx.app).get(`${base}/uploads/${body.id}`).expect(404);
    await request(ctx.app).delete(`${base}/uploads/${body.id}`).expect(404);
});

// ---- time: idle uploads are given up ----

test('an upload with no new piece for UPLOAD_IDLE_HOURS is removed by the cleanup, and a piece keeps it alive', async () => {
    const ctx = small();
    await request(ctx.app).post('/api/stashes').send({ slug: 'idle-stash', ttl: '30d' }).expect(201);
    const base = '/api/stashes/idle-stash';
    ctx.clock.time = new Date('2026-01-15T12:00:00Z');
    const idle = await start(request(ctx.app), base, { name: 'idle.txt', size: CHUNK * 2 }).expect(201);
    const busy = await start(request(ctx.app), base, { name: 'busy.txt', size: CHUNK * 2 }).expect(201);
    assert.equal(ctx.config.uploadIdleHours, 24);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 20 * HOUR);
    await piece(request(ctx.app), base, busy.body.id, 0, Buffer.alloc(CHUNK, 66)).expect(200);
    ctx.controller.cleanup();
    assert.equal(ctx.model.countUploads(), 2);

    // 25 hours after the start: the idle one is past its day, the one that got a piece 5 hours ago is not
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 5 * HOUR);
    ctx.controller.cleanup();
    assert.equal(ctx.model.countUploads(), 1);
    assert.deepEqual(tmpFiles(ctx), [ctx.fileStore.partName(busy.body.id)]);
    await request(ctx.app).get(`${base}/uploads/${idle.body.id}`).expect(404);
    assert.equal((await request(ctx.app).get(`${base}/uploads/${busy.body.id}`).expect(200)).body.offset, CHUNK);

    // ...and 25 hours of quiet end that one too
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 25 * HOUR);
    ctx.controller.cleanup();
    assert.equal(ctx.model.countUploads(), 0);
    assert.deepEqual(tmpFiles(ctx), []);
});

test('the idle time can be set, and an upload with a piece arriving right now is not expired under it', async () => {
    const ctx = small({ uploadIdleHours: 1 });
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'a.txt', size: 10 }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * HOUR);
    ctx.controller.uploadLocks.add(body.id);
    ctx.controller.cleanup();
    assert.equal(ctx.model.countUploads(), 1);
    ctx.controller.uploadLocks.delete(body.id);
    ctx.controller.cleanup();
    assert.equal(ctx.model.countUploads(), 0);
});

// ---- stashes that go away ----

test('deleting, expiring or renaming a stash removes its unfinished uploads and their partial files', async () => {
    const ctx = small({ reserveOldNamesDays: 0 });
    const a = request(ctx.app);
    const names = ['gone-by-hand', 'gone-by-time', 'gone-by-rename', 'stays-put'];
    const ids = {};
    for (const name of names) {
        const created = await a.post('/api/stashes').send({ slug: name, ttl: name === 'gone-by-time' ? '1h' : '1d' }).expect(201);
        assert.ok(created.body.slug);
        const up = await start(a, `/api/stashes/${name}`, { name: 'a.txt', size: CHUNK * 2 }).expect(201);
        await piece(a, `/api/stashes/${name}`, up.body.id, 0, Buffer.alloc(CHUNK, 67)).expect(200);
        ids[name] = up.body.id;
    }
    assert.equal(tmpFiles(ctx).length, 4);

    await a.delete('/api/stashes/gone-by-hand').expect(200);
    assert.equal(ctx.fileStore.partSize(ids['gone-by-hand']), null);

    await a.post('/api/stashes/gone-by-rename/rename').send({ slug: 'renamed-stash' }).expect(200);
    assert.equal(ctx.fileStore.partSize(ids['gone-by-rename']), null);
    await a.get(`/api/stashes/renamed-stash/uploads/${ids['gone-by-rename']}`).expect(404);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * HOUR);
    ctx.controller.cleanup();
    assert.equal(ctx.fileStore.partSize(ids['gone-by-time']), null);

    // Only the untouched stash's upload is left, in the table and on disk
    assert.deepEqual(ctx.db.prepare('SELECT id FROM uploads').all().map(r => r.id), [ids['stays-put']]);
    assert.deepEqual(tmpFiles(ctx), [ctx.fileStore.partName(ids['stays-put'])]);
});

test('a stash found to be expired when opened takes its unfinished uploads with it', async () => {
    const ctx = small();
    const a = request(ctx.app);
    await a.post('/api/stashes').send({ slug: 'short-lived', ttl: '1h' }).expect(201);
    const up = await start(a, '/api/stashes/short-lived', { name: 'a.txt', size: 10 }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * HOUR);
    await a.get(`/api/stashes/short-lived/uploads/${up.body.id}`).expect(404);
    assert.equal(ctx.model.countUploads(), 0);
    assert.deepEqual(tmpFiles(ctx), []);
});

// ---- restarts ----

test('an upload survives a restart: same database, same files folder, and it carries on from where it was', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-resume-'));
    const fileStore = newFileStore();
    const dbFile = path.join(dir, 'stashly.sqlite');
    const open = [];
    const connectTracked = () => { const d = connect(dbFile, { fileStore }); open.push(d); return d; };
    try {
        const first = makeApp({ maxChunkBytes: CHUNK }, { db: connectTracked(), fileStore });
        const base = await stash(first, 'restart-stash');
        const data = zipLike(CHUNK * 3 + 99);
        const { body } = await start(request(first.app), base, { name: 'big.zip', size: data.length, title: 'Survivor' }).expect(201);
        await piece(request(first.app), base, body.id, 0, data.subarray(0, CHUNK)).expect(200);
        await piece(request(first.app), base, body.id, CHUNK, data.subarray(CHUNK, CHUNK * 2)).expect(200);
        // A leftover of something else in tmp, which the startup sweep must still remove
        fs.writeFileSync(path.join(fileStore.tmpDir, 'abandoned'), 'x');
        first.db.close();

        // "Restart": what src/app.js does at startup, on the same database and folder
        const db = connectTracked();
        const second = makeApp({ maxChunkBytes: CHUNK }, { db, fileStore });
        assert.equal(second.model.reconcileUploads(), 0);
        const removed = fileStore.sweep(second.model.liveFileIds(), second.model.liveThumbIds(), second.model.livePartNames());
        assert.equal(removed, 1);
        assert.deepEqual(tmpFiles(second), [fileStore.partName(body.id)]);

        // The client asks where it is: the answer comes from the file
        const head = await request(second.app).head(`${base}/uploads/${body.id}`).expect(200);
        assert.equal(head.headers['upload-offset'], String(CHUNK * 2));
        await piece(request(second.app), base, body.id, CHUNK * 2, data.subarray(CHUNK * 2, CHUNK * 3)).expect(200);
        await piece(request(second.app), base, body.id, CHUNK * 3, data.subarray(CHUNK * 3)).expect(200);
        const done = await finish(request(second.app), base, body.id).expect(201);
        assert.equal(done.body.title, 'Survivor');
        assert.ok(fs.readFileSync(fileStore.pathOf(done.body.id)).equals(data));
        assert.deepEqual(tmpFiles(second), []);
    } finally {
        for (const d of open) { try { d.close(); } catch { /* already closed */ } }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the partial file is the truth: a different offset in the table is corrected, and a missing file drops the upload', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const a = request(ctx.app);
    const data = zipLike(CHUNK * 2);
    const one = await start(a, base, { name: 'one.zip', size: data.length }).expect(201);
    const two = await start(a, base, { name: 'two.zip', size: data.length }).expect(201);
    await piece(a, base, one.body.id, 0, data.subarray(0, CHUNK)).expect(200);
    // The table is wrong about progress (a crash between the file and the table): the file wins
    ctx.db.prepare('UPDATE uploads SET received = 12345 WHERE id = ?').run(one.body.id);
    assert.equal((await a.get(`${base}/uploads/${one.body.id}`).expect(200)).body.offset, CHUNK);
    assert.equal(ctx.db.prepare('SELECT received FROM uploads WHERE id = ?').get(one.body.id).received, CHUNK);
    // A piece that was being copied when the process died leaves more bytes than the table knows: they are real bytes
    fs.appendFileSync(ctx.fileStore.partPath(one.body.id), data.subarray(CHUNK, CHUNK + 1000));
    assert.equal((await a.get(`${base}/uploads/${one.body.id}`).expect(200)).body.offset, CHUNK + 1000);
    await piece(a, base, one.body.id, CHUNK + 1000, data.subarray(CHUNK + 1000)).expect(200);
    const done = await finish(a, base, one.body.id).expect(201);
    assert.ok(fs.readFileSync(ctx.fileStore.pathOf(done.body.id)).equals(data));

    // The file is gone: the upload is too (found out on use, or at startup)
    fs.rmSync(ctx.fileStore.partPath(two.body.id));
    const three = await start(a, base, { name: 'three.zip', size: 10 }).expect(201);
    fs.rmSync(ctx.fileStore.partPath(three.body.id));
    assert.equal(ctx.model.reconcileUploads(), 2);
    assert.equal(ctx.model.countUploads(), 0);
    await a.get(`${base}/uploads/${two.body.id}`).expect(404);
    const four = await start(a, base, { name: 'four.zip', size: 10 }).expect(201);
    fs.rmSync(ctx.fileStore.partPath(four.body.id));
    await a.get(`${base}/uploads/${four.body.id}`).expect(404);
    assert.equal(ctx.model.countUploads(), 0);
});

test('the startup sweep keeps the partial files of open uploads and removes every other tmp file', async () => {
    const ctx = small();
    const base = await stash(ctx);
    const { body } = await start(request(ctx.app), base, { name: 'a.txt', size: CHUNK * 2 }).expect(201);
    await piece(request(ctx.app), base, body.id, 0, Buffer.alloc(CHUNK, 68)).expect(200);
    const orphanPart = ctx.fileStore.partPath('an-upload-nobody-remembers');
    fs.writeFileSync(orphanPart, 'orphaned bytes');
    fs.writeFileSync(path.join(ctx.fileStore.tmpDir, 'half-received-upload'), 'x');
    assert.equal(tmpFiles(ctx).length, 3);

    const removed = ctx.fileStore.sweep(ctx.model.liveFileIds(), ctx.model.liveThumbIds(), ctx.model.livePartNames());
    assert.equal(removed, 2);
    assert.deepEqual(tmpFiles(ctx), [ctx.fileStore.partName(body.id)]);
    assert.equal(ctx.fileStore.partSize(body.id), CHUNK);

    // Without the third argument the old behaviour stays: all of tmp goes
    assert.equal(ctx.fileStore.sweep(ctx.model.liveFileIds(), ctx.model.liveThumbIds()), 1);
    assert.deepEqual(tmpFiles(ctx), []);
});

// ---- backup and export ----

test('a partial upload is in neither the backup nor the export', async () => {
    const ADMIN = 'admin-pass-123';
    const ctx = small({ adminPassword: ADMIN });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    const base = await stash(ctx, 'backed-up');
    const stored = await request(ctx.app).post(`${base}/files`).set('X-File-Name', 'a.txt').send(Buffer.from('kept')).expect(201);
    const { body } = await start(request(ctx.app), base, { name: 'big.zip', size: CHUNK * 2 }).expect(201);
    await piece(request(ctx.app), base, body.id, 0, zipLike(CHUNK)).expect(200);

    assert.deepEqual(ctx.fileStore.storedNames(), [String(stored.body.id)]);
    const backup = await admin.get('/api/admin/backup').buffer(true).parse(binary).expect(200);
    const names = [...unzip(backup.body).keys()].sort();
    assert.deepEqual(names, ['stashly.sqlite', `files/${stored.body.id}`].sort());

    const exported = await request(ctx.app).get(`${base}/export`).buffer(true).parse(binary).expect(200);
    const exportedNames = [...unzip(exported.body).keys()];
    assert.ok(exportedNames.every(n => n === 'stash.json' || n.startsWith('files/')));
    assert.equal(exportedNames.filter(n => n.startsWith('files/')).length, 1);
    // The upload goes on undisturbed
    assert.equal(ctx.fileStore.partSize(body.id), CHUNK);
    assert.equal((await request(ctx.app).get(`${base}`).expect(200)).body.usage.files, 1);
});
