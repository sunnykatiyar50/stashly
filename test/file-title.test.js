const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

async function stash(ctx, slug = 'file-titles') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

const upload = (ctx, base, name, title) => {
    const req = request(ctx.app)
        .post(`${base}/files`)
        .set('X-File-Name', encodeURIComponent(name))
        .set('Content-Type', 'application/octet-stream');
    if (title !== undefined) req.set('X-Title', encodeURIComponent(title));
    return req.send(Buffer.from('some text'));
};

test('a file without a title of its own is titled with its name', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = (await upload(ctx, base, 'IMG_20261122_104512.txt').expect(201)).body;
    assert.equal(file.title, 'IMG_20261122_104512.txt');
    assert.equal(file.hasTitle, false);
    assert.equal(file.fileName, 'IMG_20261122_104512.txt');
});

test('a file can be given a title when it is uploaded', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = (await upload(ctx, base, 'IMG_2026.txt', '  Receipt for the  café  ').expect(201)).body;
    assert.equal(file.title, 'Receipt for the café');
    assert.equal(file.hasTitle, true);
    assert.equal(file.fileName, 'IMG_2026.txt');
    // An empty title header is the same as none
    const plain = (await upload(ctx, base, 'b.txt', '   ').expect(201)).body;
    assert.equal(plain.title, 'b.txt');
    assert.equal(plain.hasTitle, false);
    // A title that is too long is refused, and nothing is added
    await upload(ctx, base, 'c.txt', 'x'.repeat(151)).expect(400);
    const listed = (await request(ctx.app).get(base).expect(200)).body.items;
    assert.equal(listed.length, 2);
});

test("a file's title can be changed and cleared; its name, content and download stay the same", async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const file = (await upload(ctx, base, 'scan-0042.txt').expect(201)).body;
    const seen = [];
    const original = ctx.events.publish.bind(ctx.events);
    ctx.events.publish = (slug, name, data) => { seen.push({ name, data }); return original(slug, name, data); };

    const renamed = (await request(ctx.app).put(`${base}/items/${file.id}`).send({ title: 'Passport scan' }).expect(200)).body;
    assert.equal(renamed.title, 'Passport scan');
    assert.equal(renamed.hasTitle, true);
    assert.equal(renamed.fileName, 'scan-0042.txt');
    assert.ok(renamed.editedAt);
    assert.equal(seen.find(entry => entry.name === 'item-updated').data.title, 'Passport scan');

    // The title is found by search, and the download keeps the real name
    const found = (await request(ctx.app).post(`${base}/query`).send({ search: 'passport' }).expect(200)).body.items;
    assert.deepEqual(found.map(item => item.id), [file.id]);
    const download = await request(ctx.app).get(`${base}/files/${file.id}?download=1`).expect(200);
    assert.match(download.headers['content-disposition'], /scan-0042\.txt/);
    assert.equal(Buffer.isBuffer(download.body) ? download.body.toString() : download.text, 'some text');

    const cleared = (await request(ctx.app).put(`${base}/items/${file.id}`).send({ title: '' }).expect(200)).body;
    assert.equal(cleared.title, 'scan-0042.txt');
    assert.equal(cleared.hasTitle, false);
});

test("a file's title change is refused when it is too long, and only full access may change it", async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked-titles', password: 'secret-pw' }).expect(201);
    const base = '/api/stashes/locked-titles';
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: 'secret-pw' }).expect(200);
    const id = (await owner.post(`${base}/files`).set('X-File-Name', 'a.txt').set('Content-Type', 'application/octet-stream').send(Buffer.from('x')).expect(201)).body.id;

    await owner.put(`${base}/items/${id}`).send({ title: 'x'.repeat(151) }).expect(400);
    await owner.put(`${base}/items/${id}`).send({ title: 42 }).expect(400);
    await request(ctx.app).put(`${base}/items/${id}`).send({ title: 'Nope' }).expect(401);

    const link = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: link.token }).expect(200);
    await dropper.put(`${base}/items/${id}`).send({ title: 'Nope' }).expect(403);
    // A drop-box link may still name what it drops
    const dropped = (await dropper.post(`${base}/files`).set('X-File-Name', 'b.txt').set('X-Title', 'From the drop box').set('Content-Type', 'application/octet-stream').send(Buffer.from('y')).expect(201)).body;
    assert.equal(dropped.title, 'From the drop box');

    const items = (await owner.get(base).expect(200)).body.items;
    assert.equal(items.find(item => item.id === id).title, 'a.txt');
});
