const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Writable, PassThrough } = require('node:stream');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');
const { unzip, binary } = require('./helpers/unzip');
const { listZip } = require('../src/utils/zip');
const { ZipWriter, safeEntryName, fitsInZip, STORE } = require('../src/utils/zipWriter');

const PASSWORD = 'correct horse';

const upload = (agent, base, name, body) =>
    agent.post(`${base}/files`).set('X-File-Name', encodeURIComponent(name)).set('Content-Type', 'application/octet-stream').send(body);
const note = (agent, base, text, headers = {}) => {
    const req = agent.post(`${base}/notes`).set('Content-Type', 'text/plain');
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(text);
};
const exportOf = (agent, base) => agent.get(`${base}/export`).buffer(true).parse(binary);

test('an export holds stash.json, every note and every file, byte for byte', async () => {
    const ctx = makeApp();
    const base = '/api/stashes/trip';
    await request(ctx.app).post('/api/stashes').send({ slug: 'trip' }).expect(201);
    const first = await request(ctx.app).post(`${base}/notes`).send({ title: 'Packing list', text: 'passport\nsocks – ünïcode ✓' }).expect(201);
    const second = await note(request(ctx.app), base, 'just words').expect(201);
    const text = Buffer.from('log line\n'.repeat(5000));
    const log = await upload(request(ctx.app), base, 'trip log.txt', text).expect(201);
    const png = await upload(request(ctx.app), base, 'shot.png', PNG).expect(201);
    await request(ctx.app).post(`${base}/items/${first.body.id}/pin`).send({ pinned: true }).expect(200);

    const res = await exportOf(request(ctx.app), base).expect(200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="trip.zip"');
    assert.match(res.headers['cache-control'], /no-store/);

    const files = unzip(res.body);
    assert.deepEqual([...files.keys()].sort(), [
        'stash.json',
        `files/${log.body.id}-trip log.txt`,
        `files/${png.body.id}-shot.png`,
        `notes/${first.body.id}-Packing list.txt`,
        `notes/${second.body.id}-just words.txt`,
    ].sort());
    assert.equal(files.get(`notes/${first.body.id}-Packing list.txt`).toString('utf8'), 'passport\nsocks – ünïcode ✓');
    assert.equal(files.get(`notes/${second.body.id}-just words.txt`).toString('utf8'), 'just words');
    assert.ok(files.get(`files/${log.body.id}-trip log.txt`).equals(text));
    assert.ok(files.get(`files/${png.body.id}-shot.png`).equals(PNG));

    // The built-in lister reads it too
    const listing = listZip(res.body);
    assert.equal(listing.total, 5);
    assert.ok(listing.entries.some(e => e.name === `files/${png.body.id}-shot.png` && e.size === PNG.length));

    const manifest = JSON.parse(files.get('stash.json').toString('utf8'));
    assert.equal(manifest.slug, 'trip');
    assert.equal(manifest.createdAt, '2026-01-15T12:00:00.000Z');
    assert.equal(manifest.expiresAt, '2026-01-16T12:00:00.000Z');
    assert.equal(manifest.items.length, 4);
    const pinned = manifest.items.find(i => i.id === first.body.id);
    assert.deepEqual(
        { kind: pinned.kind, title: pinned.title, pinned: pinned.pinned, editedAt: pinned.editedAt, path: pinned.path },
        { kind: 'note', title: 'Packing list', pinned: true, editedAt: null, path: `notes/${first.body.id}-Packing list.txt` }
    );
    const file = manifest.items.find(i => i.id === log.body.id);
    assert.equal(file.fileName, 'trip log.txt');
    assert.equal(file.fileSize, text.length);
    assert.match(file.fileType, /^text\/plain/);
    assert.equal(file.path, `files/${log.body.id}-trip log.txt`);
    assert.ok(file.createdAt);
});

test('an empty stash exports as a zip with just stash.json', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'empty' }).expect(201);
    const res = await exportOf(request(ctx.app), '/api/stashes/empty').expect(200);
    const files = unzip(res.body);
    assert.deepEqual([...files.keys()], ['stash.json']);
    assert.deepEqual(JSON.parse(files.get('stash.json')).items, []);
});

test('burn-after-reading notes are never exported and are not used up', async () => {
    const ctx = makeApp();
    const base = '/api/stashes/burny';
    await request(ctx.app).post('/api/stashes').send({ slug: 'burny' }).expect(201);
    const burn = await note(request(ctx.app), base, 'TOP-SECRET-BURN-TEXT', { 'X-Burn-After-Read': '1' }).expect(201);
    await note(request(ctx.app), base, 'kept note').expect(201);

    const res = await exportOf(request(ctx.app), base).expect(200);
    assert.ok(!res.body.includes('TOP-SECRET-BURN-TEXT'));
    const files = unzip(res.body);
    assert.ok(![...files.keys()].some(name => name.includes(`${burn.body.id}-`)));
    assert.ok(![...files.values()].some(data => data.includes('TOP-SECRET-BURN-TEXT')));
    const manifest = JSON.parse(files.get('stash.json'));
    const skipped = manifest.items.filter(i => i.burn);
    assert.deepEqual(skipped, [{ kind: 'note', burn: true, skipped: true }]);
    assert.equal(manifest.items.length, 2);

    // Exporting did not read it: it can still be revealed once
    const reveal = await request(ctx.app).post(`${base}/items/${burn.body.id}/reveal`).expect(200);
    assert.equal(reveal.body.text, 'TOP-SECRET-BURN-TEXT');
});

test('secret notes are exported (anyone who may read can already see them)', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'secrets' }).expect(201);
    const secret = await note(request(ctx.app), '/api/stashes/secrets', 'hush hush', { 'X-Secret': '1' }).expect(201);
    const files = unzip((await exportOf(request(ctx.app), '/api/stashes/secrets').expect(200)).body);
    const name = [...files.keys()].find(n => n.startsWith(`notes/${secret.body.id}-`));
    assert.equal(files.get(name).toString(), 'hush hush');
    // the name does not give the secret away
    assert.ok(!name.includes('hush'));
});

test('who may export: full and read-only access, not a drop-box link, and not a locked stash', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'vault', password: PASSWORD }).expect(201);
    const base = '/api/stashes/vault';
    await note(owner, base, 'inside').expect(201);

    await request(ctx.app).get(`${base}/export`).expect(401);
    await exportOf(owner, base).expect(200);

    const view = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: view.token }).expect(200);
    const viewed = await exportOf(viewer, base).expect(200);
    assert.equal(unzip(viewed.body).size, 2);

    const drop = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: drop.token }).expect(200);
    const refused = await dropper.get(`${base}/export`).expect(403);
    assert.match(refused.body.error, /drop-box/);
    assert.ok(!refused.headers['content-type'].includes('zip'));
});

test('an export of a stash that does not exist is a 404', async () => {
    const ctx = makeApp();
    await request(ctx.app).get('/api/stashes/nothing-here/export').expect(404);
});

test('exports use the read rate limit', async () => {
    const ctx = makeApp({ rateRead: 2 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'limited' }).expect(201);
    await exportOf(request(ctx.app), '/api/stashes/limited').expect(200);
    await exportOf(request(ctx.app), '/api/stashes/limited').expect(200);
    await request(ctx.app).get('/api/stashes/limited/export').expect(429);
});

test('entry names are made safe: no folders, control characters, dots or overlong names', () => {
    assert.equal(safeEntryName('../../etc/passwd'), '_etc_passwd');
    assert.equal(safeEntryName('..\\..\\windows\\system32'), '_windows_system32');
    assert.equal(safeEntryName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(safeEntryName('tab\there\u0000nul\u0085end'), 'tab_here_nul_end');
    assert.equal(safeEntryName('..'), 'file');
    assert.equal(safeEntryName('...'), 'file');
    assert.equal(safeEntryName(''), 'file');
    assert.equal(safeEntryName(null, 100, 'note'), 'note');
    assert.equal(safeEntryName('  .hidden. '), 'hidden');
    assert.equal(safeEntryName('a..b'), 'a_b');
    assert.ok(!safeEntryName('x/../../y').includes('..'));
    const long = safeEntryName('é'.repeat(500) + '.pdf', 100);
    assert.equal(Array.from(long).length, 100);
    assert.ok(long.endsWith('.pdf'));
    // a character outside the BMP is never cut in half
    assert.ok(!/[\ud800-\udbff]$/.test(safeEntryName('\u{1F600}'.repeat(200), 51)));
});

test('hostile titles and file names cannot escape or collide inside the zip', async () => {
    const ctx = makeApp();
    const base = '/api/stashes/evil';
    await request(ctx.app).post('/api/stashes').send({ slug: 'evil' }).expect(201);
    const a = await request(ctx.app).post(`${base}/notes`).send({ title: '../../../evil/..\\x', text: 'one' }).expect(201);
    const b = await request(ctx.app).post(`${base}/notes`).send({ title: '../../../evil/..\\x', text: 'two' }).expect(201);
    const c = await request(ctx.app).post(`${base}/notes`).send({ title: 'A'.repeat(150), text: 'long' }).expect(201);
    const f = await upload(request(ctx.app), base, '..%2F..%2Fsecret.txt', Buffer.from('file')).expect(201);

    const res = await exportOf(request(ctx.app), base).expect(200);
    const names = [...unzip(res.body).keys()];
    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
        assert.ok(!name.includes('..'), name);
        assert.ok(!name.includes('\\'), name);
        assert.ok(!name.startsWith('/'), name);
        assert.ok(/^(stash\.json|(notes|files)\/[^/]+)$/.test(name), name);
        assert.ok(Buffer.byteLength(name) < 140, name);
    }
    assert.ok(names.some(n => n.startsWith(`notes/${a.body.id}-`)));
    assert.ok(names.some(n => n.startsWith(`notes/${b.body.id}-`)));
    assert.ok(names.some(n => n.startsWith(`notes/${c.body.id}-`)));
    assert.ok(names.some(n => n.startsWith(`files/${f.body.id}-`) && n.endsWith('secret.txt')));
});

test('a file that has gone missing from the disk is listed as missing, not left as a broken entry', async () => {
    const ctx = makeApp();
    const base = '/api/stashes/gone';
    await request(ctx.app).post('/api/stashes').send({ slug: 'gone' }).expect(201);
    const kept = await upload(request(ctx.app), base, 'kept.txt', Buffer.from('kept')).expect(201);
    const lost = await upload(request(ctx.app), base, 'lost.txt', Buffer.from('lost')).expect(201);
    fs.rmSync(ctx.fileStore.pathOf(lost.body.id));
    const res = await exportOf(request(ctx.app), base).expect(200);
    const files = unzip(res.body);
    assert.ok(files.has(`files/${kept.body.id}-kept.txt`));
    assert.ok(![...files.keys()].some(n => n.includes('lost.txt')));
    const entry = JSON.parse(files.get('stash.json')).items.find(i => i.id === lost.body.id);
    assert.equal(entry.missing, true);
    assert.equal(entry.path, undefined);
});

test('a stash that would not fit in a plain zip is refused with a 413 before anything is streamed', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'huge' }).expect(201);
    const stash = ctx.model.findBySlug('huge');
    ctx.db.exec('BEGIN');
    const insert = ctx.db.prepare("INSERT INTO items (stash_id, kind, text, created_at, sort_order) VALUES (?, 'note', 'x', '2026-01-15T12:00:00.000Z', ?)");
    for (let i = 1; i <= 65535; i++) insert.run(stash.id, i);
    ctx.db.exec('COMMIT');
    const res = await request(ctx.app).get('/api/stashes/huge/export').expect(413);
    assert.match(res.body.error, /too large to export/);
    assert.ok(!(res.headers['content-type'] || '').includes('zip'));
    assert.equal(res.headers['content-disposition'], undefined);

    assert.equal(fitsInZip(10, 5 * 1024 ** 3, 100), false);
    assert.equal(fitsInZip(10, 3 * 1024 ** 3, 100), true);
    assert.equal(fitsInZip(65536, 10, 100), false);
});

// ---- the writer itself ----

test('the zip writer refuses repeated names, and a store entry is written as is', async () => {
    const out = new PassThrough();
    const chunks = [];
    out.on('data', c => chunks.push(c));
    const zip = new ZipWriter(out);
    await zip.addBuffer('a.txt', 'hello');
    await assert.rejects(zip.addBuffer('a.txt', 'again'), /repeated/);
    await assert.rejects(zip.addBuffer('', 'x'), /Bad/);
    const raw = Buffer.from('already compressed');
    await zip.addBuffer('raw.bin', raw, { method: STORE });
    await zip.finish();
    const files = unzip(Buffer.concat(chunks));
    assert.equal(files.get('a.txt').toString(), 'hello');
    assert.ok(files.get('raw.bin').equals(raw));
    assert.equal(files.size, 2);
});

test('names with non-ASCII characters survive in the zip', async () => {
    const out = new PassThrough();
    const chunks = [];
    out.on('data', c => chunks.push(c));
    const zip = new ZipWriter(out);
    await zip.addBuffer('files/1-résumé 日本語.txt', 'x');
    await zip.finish();
    assert.deepEqual([...unzip(Buffer.concat(chunks)).keys()], ['files/1-résumé 日本語.txt']);
});

test('a client that goes away mid-download closes the file being read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-zipw-'));
    try {
        const big = path.join(dir, 'big.bin');
        fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 7));
        // An output that takes one chunk and then never drains, like a stalled client
        const out = new Writable({ highWaterMark: 16, write() { /* never calls back */ } });
        const zip = new ZipWriter(out);
        const source = fs.createReadStream(big);
        const pending = zip.addStream('big.bin', source, { method: STORE });
        setTimeout(() => out.destroy(), 50);
        await assert.rejects(pending);
        assert.equal(source.destroyed, true);
        // nothing still holds the file (on Windows this fails if a handle leaks)
        fs.rmSync(big);
        // and the writer refuses anything more
        await assert.rejects(zip.addBuffer('late.txt', 'x'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a real disconnect during an export leaves no file open and the server keeps working', async () => {
    const ctx = makeApp({ maxFileBytes: 50 * 1024 * 1024, maxStashBytes: 200 * 1024 * 1024 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'drop' }).expect(201);
    const body = Buffer.alloc(12 * 1024 * 1024, 'abcdefgh');
    const up = await upload(request(ctx.app), '/api/stashes/drop', 'big.txt', body).expect(201);
    const server = ctx.app.listen(0);
    try {
        const { port } = server.address();
        await new Promise((resolve, reject) => {
            const req = http.get({ port, path: '/api/stashes/drop/export' }, res => {
                res.once('data', () => { req.destroy(); resolve(); });
            });
            req.on('error', err => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
        });
        // The file must become movable once the server notices (on Windows an open handle would block this)
        const file = ctx.fileStore.pathOf(up.body.id);
        let moved = false;
        for (let i = 0; i < 60 && !moved; i++) {
            try {
                fs.renameSync(file, `${file}.moved`);
                moved = true;
            } catch {
                await new Promise(r => setTimeout(r, 50));
            }
        }
        assert.ok(moved, 'the file stayed open after the client left');
        fs.renameSync(`${file}.moved`, file);
        await exportOf(request(ctx.app), '/api/stashes/drop').expect(200);
    } finally {
        server.close();
    }
});
