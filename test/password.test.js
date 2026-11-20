const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

async function locked(ctx, slug = 'secret', password = 'hunter22') {
    await request(ctx.app).post('/api/stashes').send({ slug, password }).expect(201);
    return `/api/stashes/${slug}`;
}

test('a protected stash is locked until the password is given', async () => {
    const ctx = makeApp();
    const base = await locked(ctx);
    const res = await request(ctx.app).get(base).expect(401);
    assert.equal(res.body.locked, true);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'sneaky' }).expect(401);
    await request(ctx.app).get(`${base}/events`).expect(401);
    await request(ctx.app).get(`${base}/latest`).expect(401);
    await request(ctx.app).delete(base).expect(401);
});

test('the right password unlocks it, the wrong one does not', async () => {
    const ctx = makeApp();
    const base = await locked(ctx);
    const agent = request.agent(ctx.app);
    const wrong = await agent.post(`${base}/unlock`).send({ password: 'nope' }).expect(401);
    assert.equal(wrong.body.locked, true);
    await agent.get(base).expect(401);

    const ok = await agent.post(`${base}/unlock`).send({ password: 'hunter22' }).expect(200);
    const cookie = ok.headers['set-cookie'].join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    await agent.get(base).expect(200);
    await agent.post(`${base}/notes`).send({ text: 'hello' }).expect(201);
});

test('the person who creates a protected stash is let straight in', async () => {
    const ctx = makeApp();
    const agent = request.agent(ctx.app);
    await agent.post('/api/stashes').send({ slug: 'mine', password: 'hunter22' }).expect(201);
    await agent.get('/api/stashes/mine').expect(200);
});

test('the password is stored hashed, not as text', async () => {
    const ctx = makeApp();
    await locked(ctx);
    const row = ctx.db.prepare('SELECT * FROM stashes WHERE slug = ?').get('secret');
    assert.ok(row.password_hash && row.password_salt);
    assert.ok(!JSON.stringify(row).includes('hunter22'));
});

test('an unlock cookie only works for its own stash', async () => {
    const ctx = makeApp();
    const a = await locked(ctx, 'stash-a', 'password-a');
    const b = await locked(ctx, 'stash-b', 'password-b');
    const agent = request.agent(ctx.app);
    await agent.post(`${a}/unlock`).send({ password: 'password-a' }).expect(200);
    await agent.get(a).expect(200);
    await agent.get(b).expect(401);
});

test('a cookie does not carry over to a new stash that reuses the name', async () => {
    const ctx = makeApp();
    const base = await locked(ctx, 'reused', 'first-pass');
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: 'first-pass' }).expect(200);
    await agent.delete(base).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'reused', password: 'second-pass' }).expect(201);
    await agent.get(base).expect(401);
});

test('an unlock cookie stops working when the clock passes its expiry', async () => {
    const ctx = makeApp();
    const base = await locked(ctx);
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: 'hunter22' }).expect(200);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 13 * 60 * 60 * 1000);
    // The stash itself (1 day) is still alive, but the 12 hour cookie is not
    await agent.get(base).expect(401);
});

test('a forged cookie is refused', async () => {
    const ctx = makeApp();
    const base = await locked(ctx);
    const exp = ctx.clock.time.getTime() + 60000;
    await request(ctx.app).get(base).set('Cookie', `stashly_secret=${exp}.${'0'.repeat(64)}`).expect(401);
    await request(ctx.app).get(base).set('Cookie', 'stashly_secret=garbage').expect(401);
});

test('a short or oversized password is refused when creating', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'abcd', password: 'abc' }).expect(400);
    await request(ctx.app).post('/api/stashes').send({ slug: 'abcd', password: 'x'.repeat(201) }).expect(400);
    await request(ctx.app).post('/api/stashes').send({ slug: 'abcd', password: 12345678 }).expect(400);
});

test('unlock tells an unprotected stash it is open, and an unknown one is a 404', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-one' }).expect(201);
    const res = await request(ctx.app).post('/api/stashes/open-one/unlock').send({ password: 'x' }).expect(200);
    assert.equal(res.body.hasPassword, false);
    await request(ctx.app).post('/api/stashes/missing/unlock').send({ password: 'x' }).expect(404);
});

test('wrong passwords are rate limited, but right ones never are', async () => {
    const ctx = makeApp({ rateUnlock: 3 });
    const base = await locked(ctx);
    for (let i = 0; i < 3; i++) await request(ctx.app).post(`${base}/unlock`).send({ password: 'wrong' }).expect(401);
    await request(ctx.app).post(`${base}/unlock`).send({ password: 'wrong' }).expect(429);

    const fresh = makeApp({ rateUnlock: 3 });
    const freshBase = await locked(fresh);
    for (let i = 0; i < 6; i++) await request(fresh.app).post(`${freshBase}/unlock`).send({ password: 'hunter22' }).expect(200);
});

test('a protected file download needs the cookie', async () => {
    const ctx = makeApp();
    const agent = request.agent(ctx.app);
    await agent.post('/api/stashes').send({ slug: 'files', password: 'hunter22' }).expect(201);
    const up = await agent
        .post('/api/stashes/files/files')
        .set('X-File-Name', 'pic.png')
        .set('Content-Type', 'application/octet-stream')
        .send(PNG)
        .expect(201);
    await agent.get(up.body.url).expect(200);
    await request(ctx.app).get(up.body.url).expect(401);
});
