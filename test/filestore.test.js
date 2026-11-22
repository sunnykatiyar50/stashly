const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const request = require('supertest');
const { makeApp, newFileStore, PNG } = require('./helpers/app');
const { connect, SCHEMA_VERSION } = require('../src/database/sqlite');
const { StashModel } = require('../src/models/stashModel');

const wait = ms => new Promise(done => setTimeout(done, ms));
const tmpFiles = ctx => (fs.existsSync(ctx.fileStore.tmpDir) ? fs.readdirSync(ctx.fileStore.tmpDir) : []);

async function stash(ctx, slug = 'disk-stash') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

const upload = (ctx, base, name, body) =>
    request(ctx.app).post(`${base}/files`).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(body);

// A PNG header followed by recognisable bytes, so a range can be checked
const bigPng = size => Buffer.concat([PNG, Buffer.from(Array.from({ length: size - PNG.length }, (_, i) => i % 251))]);

function bytes(res) {
    return Buffer.from(res.body);
}
const download = (ctx, url, headers = {}) =>
    request(ctx.app).get(url).set(headers).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    });

test('an upload is stored as a plain file named by its item id, and downloads byte for byte', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const data = bigPng(300000);
    const up = await upload(ctx, base, 'big.png', data).expect(201);
    assert.deepEqual(fs.readFileSync(ctx.fileStore.pathOf(up.body.id)), data);
    assert.equal(ctx.fileStore.count(), 1);
    assert.deepEqual(tmpFiles(ctx), []);
    const res = await download(ctx, up.body.url).expect(200);
    assert.equal(res.headers['content-length'], String(data.length));
    assert.deepEqual(bytes(res), data);
    // The database holds no copy of the bytes
    assert.ok(fs.statSync(ctx.fileStore.pathOf(up.body.id)).size === data.length);
});

test('byte ranges are served from disk', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const data = bigPng(100000);
    const up = await upload(ctx, base, 'seek.png', data).expect(201);
    const part = await download(ctx, up.body.url, { Range: 'bytes=1000-1999' }).expect(206);
    assert.equal(part.headers['content-range'], 'bytes 1000-1999/100000');
    assert.deepEqual(bytes(part), data.subarray(1000, 2000));
    const tail = await download(ctx, up.body.url, { Range: 'bytes=-10' }).expect(206);
    assert.deepEqual(bytes(tail), data.subarray(data.length - 10));
    await download(ctx, up.body.url, { Range: 'bytes=999999-' }).expect(416);
});

test('a refused upload leaves nothing on disk', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await upload(ctx, base, 'program.exe', Buffer.from('MZ-not-allowed')).expect(415);
    await upload(ctx, base, 'liar.png', Buffer.from('this is not a png')).expect(415);
    await upload(ctx, base, 'empty.png', Buffer.alloc(0)).expect(400);
    assert.equal(ctx.fileStore.count(), 0);
    assert.deepEqual(tmpFiles(ctx), []);
});

test('every way an item can go also removes its file', async () => {
    const ctx = makeApp();
    // delete one item
    const base = await stash(ctx, 'delete-one');
    const one = await upload(ctx, base, 'a.png', PNG).expect(201);
    await request(ctx.app).delete(`${base}/items/${one.body.id}`).expect(200);
    assert.equal(ctx.fileStore.count(), 0);

    // keep only the last 1
    await upload(ctx, base, 'b.png', PNG).expect(201);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 1 }).expect(200);
    await upload(ctx, base, 'c.png', PNG).expect(201);
    assert.equal(ctx.fileStore.count(), 1);

    // delete the whole stash
    await request(ctx.app).delete(base).expect(200);
    assert.equal(ctx.fileStore.count(), 0);

    // an expired stash
    const old = await stash(ctx, 'expiring-stash');
    await upload(ctx, old, 'd.png', PNG).expect(201);
    assert.equal(ctx.fileStore.count(), 1);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 3 * 24 * 60 * 60 * 1000);
    ctx.controller.cleanup();
    assert.equal(ctx.fileStore.count(), 0);
});

test('deleted file bytes are overwritten before the file is removed', () => {
    const store = newFileStore();
    store.write(7, Buffer.from('sensitive contents'));
    const file = store.pathOf(7);
    // Keep a second name for the same data, so what the delete did to the bytes can still be read afterwards
    fs.linkSync(file, file + '.alias');
    store.remove([7]);
    assert.equal(fs.existsSync(file), false);
    assert.ok(fs.readFileSync(file + '.alias').every(byte => byte === 0));
});

test('a file whose bytes have gone missing is not found, not a crash', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, 'a.png', PNG).expect(201);
    fs.rmSync(ctx.fileStore.pathOf(up.body.id));
    await request(ctx.app).get(up.body.url).expect(404);
    await request(ctx.app).get(base).expect(200);
});

test('an upload with no Content-Length that grows past the limit is cut off and cleaned up', async () => {
    const ctx = makeApp({ maxFileBytes: 1000 });
    const base = await stash(ctx);
    const server = ctx.app.listen(0);
    try {
        const status = await new Promise((resolve, reject) => {
            const req = http.request(
                { port: server.address().port, path: `${base}/files`, method: 'POST', headers: { 'X-File-Name': 'big.png', 'Transfer-Encoding': 'chunked' } },
                res => {
                    res.resume();
                    resolve(res.statusCode);
                }
            );
            req.on('error', err => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve(413) : reject(err)));
            req.write(PNG);
            req.write(Buffer.alloc(2000));
            req.end();
        });
        assert.equal(status, 413);
    } finally {
        server.closeAllConnections();
        server.close();
    }
    await wait(50);
    assert.equal(ctx.fileStore.count(), 0);
    assert.deepEqual(tmpFiles(ctx), []);
});

test('an upload the client abandons leaves nothing behind', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const server = ctx.app.listen(0);
    try {
        await new Promise(resolve => {
            const req = http.request({ port: server.address().port, path: `${base}/files`, method: 'POST', headers: { 'X-File-Name': 'half.png', 'Content-Length': '100000' } });
            req.on('error', () => {});
            req.write(PNG);
            setTimeout(() => {
                req.destroy();
                resolve();
            }, 50);
        });
        await wait(100);
    } finally {
        server.closeAllConnections();
        server.close();
    }
    assert.equal(ctx.fileStore.count(), 0);
    assert.deepEqual(tmpFiles(ctx), []);
});

test('zip files are listed from disk', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    // A minimal zip with one entry "hi.txt": local header, central directory, end record
    const name = Buffer.from('hi.txt');
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), name]);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(name.length, 28);
    name.copy(central, 46);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(local.length, 16);
    const up = await upload(ctx, base, 'tiny.zip', Buffer.concat([local, central, end])).expect(201);
    const listing = await request(ctx.app).get(`${up.body.url}/contents`).expect(200);
    assert.deepEqual(listing.body.entries.map(e => e.name), ['hi.txt']);
});

test('the startup sweep removes files with no item and unfinished uploads, and keeps the rest', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const keep = await upload(ctx, base, 'keep.png', PNG).expect(201);
    ctx.fileStore.write(9999, Buffer.from('orphan'));
    ctx.fileStore.ensure();
    fs.writeFileSync(path.join(ctx.fileStore.tmpDir, 'unfinished'), 'half');
    fs.writeFileSync(path.join(ctx.fileStore.dir, 'notes.txt'), 'someone put this here');
    const removed = ctx.fileStore.sweep(ctx.model.liveFileIds());
    assert.equal(removed, 3);
    assert.equal(ctx.fileStore.exists(keep.body.id), true);
    assert.equal(ctx.fileStore.exists(9999), false);
    assert.deepEqual(tmpFiles(ctx), []);
});

// ---- moving files out of an older database ----

function oldDatabase(file) {
    // Schema 1: file bytes in a `files` table
    const db = connect(file);
    db.close();
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 1');
    raw.exec('CREATE TABLE files (item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, content BLOB NOT NULL)');
    raw.exec("INSERT INTO stashes (slug, created_at) VALUES ('legacy', '2025-01-01T00:00:00Z')");
    for (let i = 1; i <= 25; i++) {
        raw.prepare("INSERT INTO items (stash_id, kind, file_name, file_type, file_size, created_at, sort_order) VALUES (1, 'file', ?, 'image/png', ?, '2025-01-01T00:00:00Z', ?)").run(`f${i}.png`, 4, i);
        raw.prepare('INSERT INTO files (item_id, content) VALUES (?, ?)').run(i, Buffer.from([i, i, i, i]));
    }
    raw.close();
}

test('files stored in an older database are moved to disk, and the old table is dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-move-'));
    try {
        const file = path.join(dir, 'old.sqlite');
        oldDatabase(file);
        const store = newFileStore();
        const db = connect(file, { fileStore: store });
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        assert.equal(store.count(), 25);
        assert.deepEqual(fs.readFileSync(store.pathOf(13)), Buffer.from([13, 13, 13, 13]));
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'files'").get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 25);
        // The moved files are served like any other
        const model = new StashModel(db, store);
        assert.equal(model.liveFileIds().size, 25);
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an older database with files is not changed when there is nowhere to move them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-move-'));
    try {
        const file = path.join(dir, 'old.sqlite');
        oldDatabase(file);
        assert.throws(() => connect(file), /no files folder/);
        const raw = new DatabaseSync(file);
        assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
        assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM files').get().n, 25);
        raw.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
