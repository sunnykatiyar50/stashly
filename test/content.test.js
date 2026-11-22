const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const upload = (agent, base) => agent
    .post(`${base}/files`)
    .set('X-File-Name', 'hello.txt')
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('file text'));

test('a new stash takes notes and files', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'content-all' }).expect(201);
    const base = '/api/stashes/content-all';
    assert.equal((await request(ctx.app).get(base).expect(200)).body.content, 'all');
    await request(ctx.app).post(`${base}/notes`).send({ text: 'hello' }).expect(201);
    await upload(request(ctx.app), base).expect(201);
});

test('a notes-only stash refuses files, and a files-only stash refuses notes', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'content-pick' }).expect(201);
    const base = '/api/stashes/content-pick';
    const seen = [];
    const original = ctx.events.publish.bind(ctx.events);
    ctx.events.publish = (slug, name, data) => { seen.push({ name, data }); return original(slug, name, data); };

    await request(ctx.app).put(`${base}/content`).send({ content: 'notes' }).expect(200);
    assert.deepEqual(seen.find(entry => entry.name === 'content-changed').data, { content: 'notes' });
    assert.equal((await request(ctx.app).get(base).expect(200)).body.content, 'notes');
    await request(ctx.app).post(`${base}/notes`).send({ text: 'still fine' }).expect(201);
    const refused = await upload(request(ctx.app), base).expect(403);
    assert.match(refused.body.error, /only takes notes/);

    await request(ctx.app).put(`${base}/content`).send({ content: 'files' }).expect(200);
    await upload(request(ctx.app), base).expect(201);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'no' }).expect(403);
    // A plain-text note from a terminal is refused too
    await request(ctx.app).post(`${base}/notes`).set('Content-Type', 'text/plain').send('no').expect(403);

    // What was already there stays
    const items = (await request(ctx.app).get(base).expect(200)).body.items;
    assert.deepEqual(items.map(item => item.kind).sort(), ['file', 'note']);

    await request(ctx.app).put(`${base}/content`).send({ content: 'all' }).expect(200);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'back again' }).expect(201);
});

test('only the listed choices are accepted', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'content-bad' }).expect(201);
    const base = '/api/stashes/content-bad';
    for (const body of [{}, { content: 'images' }, { content: '' }, { content: ['notes'] }, { content: null }]) {
        await request(ctx.app).put(`${base}/content`).send(body).expect(400);
    }
    assert.equal((await request(ctx.app).get(base).expect(200)).body.content, 'all');
});

test('the choice also holds for a drop-box link, and only full access may change it', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'content-lock', password: 'secret-pw' }).expect(201);
    const base = '/api/stashes/content-lock';
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: 'secret-pw' }).expect(200);

    // Not signed in
    await request(ctx.app).put(`${base}/content`).send({ content: 'notes' }).expect(401);

    await owner.put(`${base}/content`).send({ content: 'notes' }).expect(200);
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: link.token }).expect(200);
    await dropper.post(`${base}/notes`).send({ text: 'dropped' }).expect(201);
    await upload(dropper, base).expect(403);
    await dropper.put(`${base}/content`).send({ content: 'all' }).expect(403);

    const viewLink = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: viewLink.token }).expect(200);
    await viewer.put(`${base}/content`).send({ content: 'all' }).expect(403);
});
