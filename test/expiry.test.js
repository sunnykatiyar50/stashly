const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

const HOUR = 60 * 60 * 1000;

async function stash(ctx, slug = 'temp', ttl = '1h') {
    await request(ctx.app).post('/api/stashes').send({ slug, ttl }).expect(201);
    return `/api/stashes/${slug}`;
}

test('a stash works until its time is up, then it is gone', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'hello' }).expect(201);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 59 * 60 * 1000);
    await request(ctx.app).get(base).expect(200);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * 60 * 1000);
    await request(ctx.app).get(base).expect(404);
    // Deleted for real, with its notes
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM stashes').get().n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
});

test('an expired name can be used again', async () => {
    const ctx = makeApp();
    await stash(ctx, 'reuse');
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * HOUR);
    await request(ctx.app).post('/api/stashes').send({ slug: 'reuse' }).expect(409); // not purged yet
    await request(ctx.app).get('/api/stashes/reuse').expect(404); // opening it purges it
    await request(ctx.app).post('/api/stashes').send({ slug: 'reuse' }).expect(201);
});

test('extend restarts the timer from now', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 50 * 60 * 1000);
    const res = await request(ctx.app).post(`${base}/extend`).expect(200);
    assert.equal(res.body.expiresAt, new Date(ctx.clock.time.getTime() + HOUR).toISOString());
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 55 * 60 * 1000);
    await request(ctx.app).get(base).expect(200);
});

test('a stash that never expires cannot be extended', async () => {
    const ctx = makeApp({ ttlOptions: [{ key: 'never', label: 'Never', ms: null }] });
    await request(ctx.app).post('/api/stashes').send({ slug: 'forever', ttl: 'never' }).expect(201);
    const base = '/api/stashes/forever';
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000 * 24 * HOUR);
    const res = await request(ctx.app).get(base).expect(200);
    assert.equal(res.body.canExtend, false);
    await request(ctx.app).post(`${base}/extend`).expect(400);
});

test('the cleanup job removes expired stashes with their files, and leaves the rest', async () => {
    const ctx = makeApp();
    const old = await stash(ctx, 'old-one', '1h');
    await stash(ctx, 'new-one', '7d');
    await request(ctx.app)
        .post(`${old}/files`)
        .set('X-File-Name', 'a.png')
        .set('Content-Type', 'application/octet-stream')
        .send(PNG)
        .expect(201);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * HOUR);
    assert.deepEqual(ctx.controller.cleanup(), ['old-one']);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
    await request(ctx.app).get('/api/stashes/new-one').expect(200);
    assert.deepEqual(ctx.controller.cleanup(), []);
});

test('a stash can be deleted by someone who has access', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'bye' }).expect(201);
    await request(ctx.app).delete(base).expect(200);
    await request(ctx.app).get(base).expect(404);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
});
