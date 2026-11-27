// The "file types" modes, media and zip previews, byte ranges, and opening a PDF in its own tab
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PDF } = require('./helpers/app');

async function stash(ctx, slug = 'types') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

const upload = (ctx, base, name, body) =>
    request(ctx.app)
        .post(`${base}/files`)
        .set('X-File-Name', encodeURIComponent(name))
        .set('Content-Type', 'application/octet-stream')
        .send(body);

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(40, 7)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40, 2)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(40)]);
const MZ = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40)]);
const BINARY = Buffer.from([0x01, 0x00, 0x02, 0x00, 0xff, 0xfe]);

// A zip file with stored (uncompressed) entries: enough for a directory listing
function makeZip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name);
        const data = Buffer.from(file.data || '');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        parts.push(local, name, data);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += 30 + name.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
}

test('audio and video upload on the safe list when the content matches', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    for (const [name, body, type] of [
        ['clip.mp4', MP4, 'video/mp4'],
        ['song.mp3', MP3, 'audio/mpeg'],
        ['movie.webm', WEBM, 'video/webm'],
        ['sound.wav', WAV, 'audio/wav'],
    ]) {
        const up = await upload(ctx, base, name, body).expect(201);
        assert.equal(up.body.fileType, type, name);
        assert.equal(up.body.isImage, false);
    }
    await upload(ctx, base, 'fake.mp4', Buffer.from('not a video at all')).expect(415);
    await upload(ctx, base, 'fake.mp3', BINARY).expect(415);
});

test('the safe list still refuses unknown binaries', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    for (const name of ['data.bin', 'backup.tar.gz', 'setup.exe']) {
        await upload(ctx, base, name, BINARY).expect(415);
    }
});

test('the "any file except programs" mode accepts other binaries but not programs', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).put(`${base}/file-types`).send({ fileTypes: 'no-programs' }).expect(200);
    for (const name of ['data.bin', 'backup.tar.gz', 'pack.7z', 'app.apk', 'noextension']) {
        const up = await upload(ctx, base, name, BINARY).expect(201);
        assert.equal(up.body.fileType, 'application/octet-stream', name);
    }
    // programs are refused by name and by content, even under another name
    for (const name of ['setup.exe', 'x.dll', 'logo.svg', 'macro.docm', 'a.vbs']) {
        await upload(ctx, base, name, BINARY).expect(415);
    }
    await upload(ctx, base, 'renamed.bin', MZ).expect(415);
    await upload(ctx, base, 'tool.dat', ELF).expect(415);
    await upload(ctx, base, 'renamed.png', MZ).expect(415);
    // a known extension with the wrong (text) content is stored as plain text, not as that type
    const odd = await upload(ctx, base, 'notreally.png', Buffer.from('<html>hello</html>')).expect(201);
    assert.match(odd.body.fileType, /^text\/plain/);
    assert.equal(odd.body.isImage, false);
});

test('the "any file" mode accepts everything, stored so nothing is shown or run', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).put(`${base}/file-types`).send({ fileTypes: 'any' }).expect(200);
    for (const [name, body] of [
        ['setup.exe', MZ],
        ['logo.svg', Buffer.from('<svg onload=alert(1)>')],
        ['macro.docm', BINARY],
        ['tool.bin', ELF],
    ]) {
        const up = await upload(ctx, base, name, body).expect(201);
        assert.equal(up.body.isImage, false, name);
        assert.ok(!up.body.fileType.startsWith('image/'), name);
    }
    const svg = await upload(ctx, base, 'again.svg', Buffer.from('<svg onload=alert(1)>')).expect(201);
    const served = await request(ctx.app).get(svg.body.url).expect(200);
    assert.match(served.headers['content-disposition'], /^attachment/);
    assert.match(served.headers['content-security-policy'], /sandbox/);
});

test('files are served with byte ranges so audio and video can seek', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, 'clip.mp4', MP4).expect(201);

    const whole = await request(ctx.app).get(up.body.url).expect(200);
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.equal(whole.headers['content-length'], String(MP4.length));

    const part = await request(ctx.app).get(up.body.url).set('Range', 'bytes=4-11').expect(206);
    assert.equal(part.headers['content-range'], `bytes 4-11/${MP4.length}`);
    assert.equal(part.headers['content-length'], '8');
    assert.equal(part.body.toString(), 'ftypmp42');

    const open = await request(ctx.app).get(up.body.url).set('Range', 'bytes=40-').expect(206);
    assert.equal(open.headers['content-range'], `bytes 40-${MP4.length - 1}/${MP4.length}`);
    const tail = await request(ctx.app).get(up.body.url).set('Range', 'bytes=-4').expect(206);
    assert.equal(tail.body.length, 4);

    const past = await request(ctx.app).get(up.body.url).set('Range', `bytes=${MP4.length + 5}-`).expect(416);
    assert.equal(past.headers['content-range'], `bytes */${MP4.length}`);
    await request(ctx.app).get(up.body.url).set('Range', 'bytes=abc').expect(416);
});

test('a PDF opens inline in its own tab only on request, and is otherwise sandboxed', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const up = await upload(ctx, base, 'doc.pdf', PDF).expect(201);

    const plain = await request(ctx.app).get(up.body.url).expect(200);
    assert.match(plain.headers['content-disposition'], /^attachment/);
    assert.match(plain.headers['content-security-policy'], /sandbox/);

    const view = await request(ctx.app).get(`${up.body.url}?view=1`).expect(200);
    assert.match(view.headers['content-disposition'], /^inline/);
    assert.equal(view.headers['content-type'], 'application/pdf');
    assert.equal(view.headers['x-content-type-options'], 'nosniff');
    assert.doesNotMatch(view.headers['content-security-policy'], /sandbox/);
    assert.match(view.headers['content-security-policy'], /default-src 'none'/);

    // ?view=1 does nothing for other types
    const text = await upload(ctx, base, 'a.txt', Buffer.from('hello')).expect(201);
    const same = await request(ctx.app).get(`${text.body.url}?view=1`).expect(200);
    assert.match(same.headers['content-disposition'], /^attachment/);
    assert.match(same.headers['content-security-policy'], /sandbox/);
});

test('the names inside a zip file can be listed, and only for zip files', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const zip = makeZip([{ name: 'docs/' }, { name: 'docs/readme.txt', data: 'hello' }, { name: 'data.csv', data: 'a,b\n1,2' }]);
    const up = await upload(ctx, base, 'bundle.zip', zip).expect(201);

    const list = await request(ctx.app).get(`${up.body.url}/contents`).expect(200);
    assert.equal(list.body.total, 3);
    assert.equal(list.body.truncated, false);
    assert.deepEqual(
        list.body.entries.map(e => [e.name, e.size, e.isDir]),
        [['docs/', 0, true], ['docs/readme.txt', 5, false], ['data.csv', 7, false]]
    );

    const many = makeZip(Array.from({ length: 600 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
    const big = await upload(ctx, base, 'many.zip', many).expect(201);
    const capped = await request(ctx.app).get(`${big.body.url}/contents`).expect(200);
    assert.equal(capped.body.total, 600);
    assert.equal(capped.body.entries.length, 500);
    assert.equal(capped.body.truncated, true);

    // a zip header with no directory is reported, not crashed on
    const broken = await upload(ctx, base, 'broken.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0])).expect(201);
    await request(ctx.app).get(`${broken.body.url}/contents`).expect(422);

    const text = await upload(ctx, base, 'a.txt', Buffer.from('hello')).expect(201);
    await request(ctx.app).get(`${text.body.url}/contents`).expect(400);
    await request(ctx.app).get(`${base}/files/9999/contents`).expect(404);
});

test('listing a zip needs access to the stash', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked-zip', password: 'secret1' }).expect(201);
    await request(ctx.app).get('/api/stashes/locked-zip/files/1/contents').expect(401);
});
