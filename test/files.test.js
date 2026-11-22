const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG, PDF } = require('./helpers/app');

async function stash(ctx, slug = 'files') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

const upload = (ctx, base, name, body) =>
    request(ctx.app)
        .post(`${base}/files`)
        .set('X-File-Name', encodeURIComponent(name))
        .set('Content-Type', 'application/octet-stream')
        .send(body);

test('an image uploads, appears in the list and is served inline', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, 'shot.png', PNG).expect(201);
    assert.equal(up.body.kind, 'file');
    assert.equal(up.body.fileName, 'shot.png');
    assert.equal(up.body.fileType, 'image/png');
    assert.equal(up.body.fileSize, PNG.length);
    assert.equal(up.body.isImage, true);
    assert.equal(up.body.url, `${base}/files/${up.body.id}`);

    const list = await request(ctx.app).get(base).expect(200);
    assert.equal(list.body.items[0].fileName, 'shot.png');
    assert.equal(list.body.usage.files, 1);

    const file = await request(ctx.app).get(up.body.url).expect(200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.match(file.headers['content-disposition'], /^inline/);
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.match(file.headers['content-security-policy'], /sandbox/);
    assert.ok(Buffer.compare(file.body, PNG) === 0);

    const forced = await request(ctx.app).get(`${up.body.url}?download=1`).expect(200);
    assert.match(forced.headers['content-disposition'], /^attachment/);
});

test('other files are always downloaded, never shown in the page', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, 'report final.pdf', PDF).expect(201);
    assert.equal(up.body.isImage, false);
    const file = await request(ctx.app).get(up.body.url).expect(200);
    assert.match(file.headers['content-disposition'], /^attachment; filename\*=UTF-8''report%20final\.pdf/);
});

test('text files upload when they really are text', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, 'notes.txt', Buffer.from('plain words\nand more')).expect(201);
    assert.match(up.body.fileType, /^text\/plain/);
    await upload(ctx, base, 'data.json', Buffer.from('{"a":1}')).expect(201);
    await upload(ctx, base, 'table.csv', Buffer.from('a,b\n1,2')).expect(201);
});

test('any file whose content is text is accepted, and stored and served as plain text', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const names = [
        'values.yaml', 'values.yml', 'page.html', 'app.conf', 'job.py', 'app.properties', 'tool.js',
        'run.sh', 'Dockerfile', 'settings.ini', 'query.sql', 'ca.pem', 'site.crt', 'site.cer', 'archive.tar.gz',
    ];
    for (const name of names) {
        const up = await upload(ctx, base, name, Buffer.from('key: value\n<script>alert(1)</script>\n')).expect(201);
        assert.equal(up.body.isImage, false, name);
        assert.match(up.body.fileType, /^text\/plain/, `${name} is stored as ${up.body.fileType}`);
    }
    // HTML is never rendered: it comes back as a sandboxed attachment
    const html = await upload(ctx, base, 'again.html', Buffer.from('<h1>hi</h1>')).expect(201);
    const served = await request(ctx.app).get(html.body.url).expect(200);
    assert.match(served.headers['content-disposition'], /^attachment/);
    assert.match(served.headers['content-security-policy'], /sandbox/);
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
});

test('binary DER certificates are accepted; other binary files with unknown types are not', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const der = Buffer.from([0x30, 0x82, 0x03, 0x1a, 0x30, 0x82, 0x02, 0x02, 0x00, 0x01, 0x02, 0x00]);
    const up = await upload(ctx, base, 'site.cer', der).expect(201);
    assert.equal(up.body.fileType, 'application/x-x509-ca-cert');
    await upload(ctx, base, 'blob.bin', Buffer.from([0x01, 0x00, 0x02, 0x00, 0xff])).expect(415);
    await upload(ctx, base, 'archive.tar.gz', Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00])).expect(415);
    await upload(ctx, base, 'noextension', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00])).expect(415);
});

test('SVG, programs, Windows script launchers and macro documents are refused even as text', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    for (const name of ['logo.svg', 'run.exe', 'x.dll', 'setup.msi', 'a.vbs', 'a.hta', 'a.lnk', 'macro.docm', 'macro.xlsm']) {
        const res = await upload(ctx, base, name, Buffer.from('<svg onload=alert(1)>'));
        assert.equal(res.status, 415, `expected 415 for ${name}`);
    }
});

test('a file whose content does not match its extension is refused', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await upload(ctx, base, 'fake.png', Buffer.from('<html><script>alert(1)</script></html>')).expect(415);
    await upload(ctx, base, 'fake.pdf', PNG).expect(415);
    await upload(ctx, base, 'fake.jpg', PDF).expect(415);
    await upload(ctx, base, 'fake.txt', Buffer.from([0x00, 0x01, 0x02, 0x03])).expect(415);
    await upload(ctx, base, 'fake.docx', Buffer.from('not a zip')).expect(415);
});

test('an empty upload and a missing name are refused', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await upload(ctx, base, 'empty.png', Buffer.alloc(0)).expect(400);
    await request(ctx.app).post(`${base}/files`).set('Content-Type', 'application/octet-stream').send(PNG).expect(400);
});

test('file names are cleaned: no folders, no control characters', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, '..\\..\\windows\\evil/../shot.png', PNG).expect(201);
    assert.equal(up.body.fileName, 'shot.png');
    const odd = await upload(ctx, base, 'a<b>c"d.png', PNG).expect(201);
    assert.equal(odd.body.fileName, 'abcd.png');
});

test('a file over the size limit is refused, with or without a Content-Length header', async () => {
    const ctx = makeApp({ maxFileBytes: 100 });
    const base = await stash(ctx);
    const big = Buffer.concat([PNG, Buffer.alloc(100)]);
    await upload(ctx, base, 'big.png', big).expect(413);
    const small = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(50)]);
    await upload(ctx, base, 'ok.png', small).expect(201);
});

test('a stash holds a limited number of files and bytes', async () => {
    const ctx = makeApp({ maxFilesPerStash: 2 });
    const base = await stash(ctx);
    await upload(ctx, base, 'a.png', PNG).expect(201);
    await upload(ctx, base, 'b.png', PNG).expect(201);
    await upload(ctx, base, 'c.png', PNG).expect(413);
    // notes are still fine
    await request(ctx.app).post(`${base}/notes`).send({ text: 'still ok' }).expect(201);

    const small = makeApp({ maxStashBytes: PNG.length * 2 - 1 });
    const base2 = await stash(small);
    await upload(small, base2, 'a.png', PNG).expect(201);
    await upload(small, base2, 'b.png', PNG).expect(413);
});

test('the server-wide file space is capped', async () => {
    const ctx = makeApp({ maxTotalBytes: PNG.length * 2 - 1 });
    const one = await stash(ctx, 'one-stash');
    const two = await stash(ctx, 'two-stash');
    await upload(ctx, one, 'a.png', PNG).expect(201);
    await upload(ctx, two, 'b.png', PNG).expect(507);
});

test('deleting a file item removes its content', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, 'a.png', PNG).expect(201);
    await request(ctx.app).delete(`${base}/items/${up.body.id}`).expect(200);
    await request(ctx.app).get(up.body.url).expect(404);
    assert.equal(ctx.fileStore.count(), 0);
});

test('a file is only reachable through its own stash', async () => {
    const ctx = makeApp();
    const a = await stash(ctx, 'stash-a');
    const b = await stash(ctx, 'stash-b');
    const up = await upload(ctx, a, 'a.png', PNG).expect(201);
    await request(ctx.app).get(`${b}/files/${up.body.id}`).expect(404);
    await request(ctx.app).get(`${a}/files/${up.body.id}`).expect(200);
    await request(ctx.app).get(`${a}/files/notanumber`).expect(404);
});

test('search finds files by name', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await upload(ctx, base, 'invoice-march.pdf', PDF).expect(201);
    await upload(ctx, base, 'photo.png', PNG).expect(201);
    const res = await request(ctx.app).get(base).query({ search: 'invoice' }).expect(200);
    assert.deepEqual(res.body.items.map(i => i.fileName), ['invoice-march.pdf']);
});

test('uploads are rate limited', async () => {
    const ctx = makeApp({ rateUpload: 1 });
    const base = await stash(ctx);
    await upload(ctx, base, 'a.png', PNG).expect(201);
    await upload(ctx, base, 'b.png', PNG).expect(429);
});
