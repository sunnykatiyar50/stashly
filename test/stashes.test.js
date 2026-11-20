const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

test('suggest returns a random 12-character name that can be used', async () => {
    const { app } = makeApp();
    const a = await request(app).get('/api/stashes/suggest').expect(200);
    const b = await request(app).get('/api/stashes/suggest').expect(200);
    assert.match(a.body.slug, /^[a-z2-7]{12}$/);
    assert.notEqual(a.body.slug, b.body.slug);
    await request(app).post('/api/stashes').send({ slug: a.body.slug }).expect(201);
});

test('creating a stash returns its link and expiry', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/stashes').send({ slug: 'my-stash', ttl: '1h' }).expect(201);
    assert.equal(res.body.slug, 'my-stash');
    assert.equal(res.body.url, '/s/my-stash');
    assert.equal(res.body.hasPassword, false);
    assert.equal(res.body.expiresAt, '2026-01-15T13:00:00.000Z');
    const get = await request(app).get('/api/stashes/my-stash').expect(200);
    assert.equal(get.body.total, 0);
    assert.equal(get.body.hasPassword, false);
});

test('the name is required, at least 4 characters, and only safe characters', async () => {
    const { app } = makeApp();
    for (const slug of [undefined, '', '   ', 'abc', 'a b c d', 'café', 'x/y/z/w', 'a'.repeat(65), 'suggest']) {
        const res = await request(app).post('/api/stashes').send({ slug });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(slug)}`);
        assert.equal(res.body.field, 'slug');
    }
    await request(app).post('/api/stashes').send({ slug: 'abcd' }).expect(201);
    await request(app).post('/api/stashes').send({ slug: 'a'.repeat(64) }).expect(201);
});

test('names are case-insensitive and unique', async () => {
    const { app } = makeApp();
    await request(app).post('/api/stashes').send({ slug: 'Team-Notes' }).expect(201);
    const dup = await request(app).post('/api/stashes').send({ slug: 'team-notes' }).expect(409);
    assert.equal(dup.body.field, 'slug');
    await request(app).get('/api/stashes/TEAM-NOTES').expect(200);
});

test('an unknown expiry is refused, and "never" is off unless allowed', async () => {
    const { app } = makeApp();
    await request(app).post('/api/stashes').send({ slug: 'abcd', ttl: 'forever' }).expect(400);
    await request(app).post('/api/stashes').send({ slug: 'abcd', ttl: 'never' }).expect(400);
    const allowed = makeApp({ ...makeApp().config, ttlOptions: [{ key: 'never', label: 'Never', ms: null }] });
    const res = await request(allowed.app).post('/api/stashes').send({ slug: 'abcd', ttl: 'never' }).expect(201);
    assert.equal(res.body.expiresAt, null);
});

test('an unknown stash is a 404', async () => {
    const { app } = makeApp();
    await request(app).get('/api/stashes/nothing-here').expect(404);
    await request(app).get('/api/nope').expect(404);
});

test('the config and health endpoints work, and stashes are never cached or indexed', async () => {
    const { app } = makeApp();
    const config = await request(app).get('/api/config').expect(200);
    assert.ok(config.body.ttlOptions.some(o => o.key === '1d'));
    assert.equal(config.body.defaultTtl, '1d');
    const health = await request(app).get('/health').expect(200);
    assert.equal(health.body.status, 'ok');
    assert.match(health.headers['cache-control'], /no-store/);
    assert.match(health.headers['x-robots-tag'], /noindex/);
});

test('the pages are served', async () => {
    const { app } = makeApp();
    const stash = await request(app).get('/s/any-name');
    assert.equal(stash.status, 200);
    assert.match(stash.headers['content-type'], /html/);
});

test('the number of stashes is capped', async () => {
    const { app } = makeApp({ maxStashes: 1 });
    await request(app).post('/api/stashes').send({ slug: 'first' }).expect(201);
    await request(app).post('/api/stashes').send({ slug: 'second' }).expect(503);
});

test('creating stashes is rate limited', async () => {
    const { app } = makeApp({ rateCreate: 2 });
    await request(app).post('/api/stashes').send({ slug: 'aaaa' }).expect(201);
    await request(app).post('/api/stashes').send({ slug: 'bbbb' }).expect(201);
    await request(app).post('/api/stashes').send({ slug: 'cccc' }).expect(429);
});
