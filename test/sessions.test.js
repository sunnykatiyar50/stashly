const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const PASSWORD = 'correct horse';
const HOUR = 60 * 60 * 1000;
const maxAge = res => {
    const match = /Max-Age=(\d+)/i.exec((res.headers['set-cookie'] || []).join(';'));
    return match ? Number(match[1]) : null;
};

async function protectedStash(ctx, slug = 'vault', extra = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, password: PASSWORD, ...extra }).expect(201);
    return `/api/stashes/${slug}`;
}

// ---- how long a sign-in lasts ----

test('the person picks how long to stay signed in; the default is 24 hours', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const short = await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD, session: '30m' }).expect(200);
    assert.equal(maxAge(short), 1800);
    assert.equal(short.body.sessionEndsAt, new Date(ctx.clock.time.getTime() + 30 * 60 * 1000).toISOString());

    const two = await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD, session: '2h' }).expect(200);
    assert.equal(maxAge(two), 2 * 3600);
    const normal = await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    assert.equal(maxAge(normal), 24 * 3600);
    const twelve = await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD, session: '12h' }).expect(200);
    assert.equal(maxAge(twelve), 12 * 3600);
});

test('7 and 30 day sessions work on a long-lived stash, and are cut short by a short-lived one', async () => {
    const ctx = makeApp();
    const long = await protectedStash(ctx, 'long-lived', { ttl: '30d' });
    const week = await request(ctx.app).post(`${long}/unlock`).send({ password: PASSWORD, session: '7d' }).expect(200);
    assert.equal(maxAge(week), 7 * 86400);
    const month = await request(ctx.app).post(`${long}/unlock`).send({ password: PASSWORD, session: '30d' }).expect(200);
    assert.equal(maxAge(month), 30 * 86400);

    // The default stash lives one day, so even a 30 day sign-in ends with the stash
    const base = await protectedStash(ctx, 'one-day');
    const capped = await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD, session: '30d' }).expect(200);
    assert.ok(maxAge(capped) <= 86400);
    assert.equal(capped.body.sessionEndsAt, new Date(ctx.clock.time.getTime() + 30 * 86400 * 1000).toISOString());
});

test('the removed 1 hour and 4 hour choices are no longer accepted', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    for (const session of ['1h', '4h']) {
        await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD, session }).expect(400);
    }
});

test('a session length that is not on the list is refused, and does not count as a wrong password', async () => {
    const ctx = makeApp({ stashUnlockFailures: 2 });
    const base = await protectedStash(ctx);
    for (const session of ['1y', 'forever', 5]) {
        await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD, session }).expect(400);
    }
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
});

test('a sign-in never lasts longer than the stash itself', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx, 'short-lived', { ttl: '1h' });
    const res = await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD, session: '12h' }).expect(200);
    assert.ok(maxAge(res) <= 3600);
    assert.equal(res.body.sessionEndsAt, new Date(ctx.clock.time.getTime() + 12 * HOUR).toISOString());
});

test('the sign-in ends when its time is up', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: PASSWORD, session: '30m' }).expect(200);
    await agent.get(base).expect(200);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 31 * 60 * 1000);
    await agent.get(base).expect(401);
});

test('the stash page can see when its sign-in ends; a stash with no password has none', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: PASSWORD, session: '2h' }).expect(200);
    const got = await agent.get(base).expect(200);
    assert.equal(got.body.sessionEndsAt, new Date(ctx.clock.time.getTime() + 2 * HOUR).toISOString());

    await request(ctx.app).post('/api/stashes').send({ slug: 'no-password' }).expect(201);
    assert.equal((await request(ctx.app).get('/api/stashes/no-password').expect(200)).body.sessionEndsAt, null);
});

test('the public config lists the session lengths', async () => {
    const res = await request(makeApp().app).get('/api/config').expect(200);
    assert.deepEqual(res.body.sessionOptions.map(o => o.key), ['30m', '2h', '12h', '24h', '7d', '30d']);
    assert.equal(res.body.defaultSession, '24h');
});

// ---- changing the length after signing in ----

test('a signed-in person can shorten their session, and the new end shows at once', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 30 * 60 * 1000);
    const res = await agent.post(`${base}/session`).send({ session: '30m' }).expect(200);
    assert.equal(maxAge(res), 1800);
    assert.equal(res.body.sessionEndsAt, new Date(ctx.clock.time.getTime() + 30 * 60 * 1000).toISOString());
    assert.equal((await agent.get(base)).body.sessionEndsAt, res.body.sessionEndsAt);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 31 * 60 * 1000);
    await agent.get(base).expect(401);
});

test('changing the session needs a sign-in, a listed length and a password on the stash', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    await request(ctx.app).post(`${base}/session`).send({ session: '30m' }).expect(401);
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    await agent.post(`${base}/session`).send({ session: '9y' }).expect(400);
    await agent.post(`${base}/session`).send({}).expect(400);

    await request(ctx.app).post('/api/stashes').send({ slug: 'no-password' }).expect(201);
    await request(ctx.app).post('/api/stashes/no-password/session').send({ session: '30m' }).expect(400);
});

test('a share-link visitor can shorten their session too, and stays read-only', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: link.token, session: '12h' }).expect(200);
    const res = await viewer.post(`${base}/session`).send({ session: '30m' }).expect(200);
    assert.match(res.headers['set-cookie'].join(';'), /stashlyv_vault=/);
    assert.equal((await viewer.get(base)).body.role, 'view');
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 31 * 60 * 1000);
    await viewer.get(base).expect(401);
});

// ---- logging out ----

test('logging out clears the cookie, so the stash is locked again for that browser', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    await agent.get(base).expect(200);

    const out = await agent.post(`${base}/logout`).expect(200);
    assert.match(out.headers['set-cookie'].join(';'), /stashly_vault=;/);
    await agent.get(base).expect(401);
    // Someone else's browser is not affected
    const other = request.agent(ctx.app);
    await other.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    await agent.post(`${base}/logout`).expect(200);
    await other.get(base).expect(200);
});

test('logging out always works: with no sign-in, on a stash with no password, and for a missing stash it is a 404', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    await request(ctx.app).post(`${base}/logout`).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'no-password' }).expect(201);
    await request(ctx.app).post('/api/stashes/no-password/logout').expect(200);
    await request(ctx.app).post('/api/stashes/nothing-here/logout').expect(404);
});

test('logging out ends a share-link session as well', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: link.token }).expect(200);
    await dropper.get(base).expect(200);
    await dropper.post(`${base}/logout`).expect(200);
    await dropper.get(base).expect(401);
    // The link itself still works for a fresh visit: signing out is not cancelling the link
    await request(ctx.app).post(`${base}/redeem`).send({ token: link.token }).expect(200);
});

// ---- the admin sets a stash's password ----

async function adminApp(overrides = {}) {
    const ctx = makeApp({ adminPassword: 'admin-pass', ...overrides });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: 'admin-pass' }).expect(200);
    return { ctx, admin };
}

test('only the admin can set a stash password, with a sensible password, on a stash that exists', async () => {
    const { ctx, admin } = await adminApp();
    const base = await protectedStash(ctx);
    await request(ctx.app).put(`${base.replace('/stashes/', '/admin/stashes/')}/password`).send({ password: 'new password' }).expect(401);
    await admin.put('/api/admin/stashes/vault/password').send({ password: 'abc' }).expect(400);
    await admin.put('/api/admin/stashes/vault/password').send({ password: 'x'.repeat(201) }).expect(400);
    await admin.put('/api/admin/stashes/vault/password').send({}).expect(400);
    await admin.put('/api/admin/stashes/missing-stash/password').send({ password: 'new password' }).expect(404);
    // Still the old password
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
});

test('a new password replaces the old one and signs everyone out of the stash', async () => {
    const { ctx, admin } = await adminApp();
    const base = await protectedStash(ctx);
    const person = request.agent(ctx.app);
    await person.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    await person.post(`${base}/notes`).send({ text: 'kept' }).expect(201);

    await admin.put('/api/admin/stashes/vault/password').send({ password: 'brand new one' }).expect(200);
    await person.get(base).expect(401);
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(401);
    await person.post(`${base}/unlock`).send({ password: 'brand new one' }).expect(200);
    // The content is untouched
    assert.equal((await person.get(base).expect(200)).body.items[0].text, 'kept');
});

test('the admin session still does not open a protected stash on its own', async () => {
    const { ctx, admin } = await adminApp();
    const base = await protectedStash(ctx);
    await admin.get(base).expect(401);
    await admin.put('/api/admin/stashes/vault/password').send({ password: 'brand new one' }).expect(200);
    await admin.get(base).expect(401);
});

test('a new password cancels the share links and clears a wrong-password lockout', async () => {
    const { ctx, admin } = await adminApp({ stashUnlockFailures: 2 });
    const base = await protectedStash(ctx);
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: link.token }).expect(200);

    for (let i = 0; i < 2; i++) await request(ctx.app).post(`${base}/unlock`).send({ password: 'nope' }).expect(401);
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(429);

    await admin.put('/api/admin/stashes/vault/password').send({ password: 'brand new one' }).expect(200);
    await viewer.get(base).expect(401);
    await request(ctx.app).post(`${base}/redeem`).send({ token: link.token }).expect(401);
    const row = ctx.model.findBySlug('vault');
    assert.equal(row.view_token_hash, null);
    // The lockout is gone, so the new password works straight away
    await request(ctx.app).post(`${base}/unlock`).send({ password: 'brand new one' }).expect(200);
});

test('open pages are told their access changed, and the password is stored hashed', async () => {
    const { ctx, admin } = await adminApp();
    await protectedStash(ctx);
    const closed = [];
    ctx.events.closeAll = (slug, event) => closed.push({ slug, event });
    await admin.put('/api/admin/stashes/vault/password').send({ password: 'brand new one' }).expect(200);
    assert.deepEqual(closed, [{ slug: 'vault', event: 'access-changed' }]);
    const row = ctx.model.findBySlug('vault');
    assert.ok(row.password_hash && !JSON.stringify(row).includes('brand new one'));
});

test('the admin can put a password on a stash that had none, which locks it', async () => {
    const { ctx, admin } = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'was-open' }).expect(201);
    await request(ctx.app).get('/api/stashes/was-open').expect(200);
    await admin.put('/api/admin/stashes/was-open/password').send({ password: 'now locked' }).expect(200);
    await request(ctx.app).get('/api/stashes/was-open').expect(401);
    await request(ctx.app).post('/api/stashes/was-open/unlock').send({ password: 'now locked' }).expect(200);
});
