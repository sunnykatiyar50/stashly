const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

// There is no separate owner account: whoever knows the current password is the owner, and proves it when changing it.

const PASSWORD = 'correct horse';
const NEW = 'a fresh password';
const maxAge = res => {
    const match = /Max-Age=(\d+)/i.exec((res.headers['set-cookie'] || []).join(';'));
    return match ? Number(match[1]) : null;
};

async function protectedStash(ctx, slug = 'vault') {
    await request(ctx.app).post('/api/stashes').send({ slug, password: PASSWORD }).expect(201);
    return `/api/stashes/${slug}`;
}

async function signedIn(ctx, base, session) {
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: PASSWORD, session }).expect(200);
    return agent;
}

test('someone who knows the password can change it; others are signed out and this browser stays in', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const me = await signedIn(ctx, base);
    await me.post(`${base}/notes`).send({ text: 'kept' }).expect(201);
    const someoneElse = await signedIn(ctx, base);

    const res = await me.post(`${base}/password`).send({ currentPassword: PASSWORD, newPassword: NEW }).expect(200);
    assert.ok(res.body.sessionEndsAt);
    await me.get(base).expect(200); // still signed in here, with the new cookie
    await someoneElse.get(base).expect(401);
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(401);
    await request(ctx.app).post(`${base}/unlock`).send({ password: NEW }).expect(200);
    assert.equal((await me.get(base)).body.items[0].text, 'kept');
});

test('the current password has to be right, and wrong guesses count towards the lockout', async () => {
    const ctx = makeApp({ stashUnlockFailures: 2 });
    const base = await protectedStash(ctx);
    const me = await signedIn(ctx, base);

    const wrong = await me.post(`${base}/password`).send({ currentPassword: 'guess', newPassword: NEW }).expect(401);
    assert.equal(wrong.body.field, 'currentPassword');
    await me.post(`${base}/password`).send({ newPassword: NEW }).expect(401);
    // Two wrong tries: the stash is locked against guessing, even with the right current password
    await me.post(`${base}/password`).send({ currentPassword: PASSWORD, newPassword: NEW }).expect(429);
    // Nothing changed
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 16 * 60 * 1000);
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
});

test('the new password must be sensible and different', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const me = await signedIn(ctx, base);
    for (const newPassword of ['abc', 'x'.repeat(201), undefined, 42]) {
        const res = await me.post(`${base}/password`).send({ currentPassword: PASSWORD, newPassword }).expect(400);
        assert.equal(res.body.field, 'newPassword');
    }
    await me.post(`${base}/password`).send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
});

test('only a signed-in person with full access can change it, and only on a stash that has a password', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const body = { currentPassword: PASSWORD, newPassword: NEW };
    // Knowing the password is not enough on its own: the person must be signed in too
    await request(ctx.app).post(`${base}/password`).send(body).expect(401);

    const owner = await signedIn(ctx, base);
    const view = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body.token;
    const drop = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body.token;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: view }).expect(200);
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: drop }).expect(200);
    await viewer.post(`${base}/password`).send(body).expect(403);
    await dropper.post(`${base}/password`).send(body).expect(403);

    // No password: anyone with the name could lock everyone else out, so it is refused
    await request(ctx.app).post('/api/stashes').send({ slug: 'no-password' }).expect(201);
    await request(ctx.app).post('/api/stashes/no-password/password').send(body).expect(400);
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
});

test('changing the password cancels the share links and clears a lockout', async () => {
    const ctx = makeApp({ stashUnlockFailures: 3 });
    const base = await protectedStash(ctx);
    const me = await signedIn(ctx, base);
    const link = (await me.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: link.token }).expect(200);
    // One wrong guess is on the board; a successful change clears it
    await request(ctx.app).post(`${base}/unlock`).send({ password: 'nope' }).expect(401);

    await me.post(`${base}/password`).send({ currentPassword: PASSWORD, newPassword: NEW }).expect(200);
    await viewer.get(base).expect(401);
    await request(ctx.app).post(`${base}/redeem`).send({ token: link.token }).expect(401);
    assert.equal(ctx.controller.failures.has('vault'), false);
});

test('this browser keeps the time it had left, and other pages are told to ask again', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const me = await signedIn(ctx, base, '1h');
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 30 * 60 * 1000);

    const closed = [];
    ctx.events.closeAll = (slug, event, data) => closed.push({ slug, event, origin: data.origin });
    const res = await me.post(`${base}/password`).set('X-Tab-Id', 'tab-1').send({ currentPassword: PASSWORD, newPassword: NEW }).expect(200);
    assert.equal(maxAge(res), 1800);
    assert.equal(res.body.sessionEndsAt, new Date(ctx.clock.time.getTime() + 30 * 60 * 1000).toISOString());
    // The page that made the change is named, so it does not sign itself out
    assert.deepEqual(closed, [{ slug: 'vault', event: 'access-changed', origin: 'tab-1' }]);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 31 * 60 * 1000);
    await me.get(base).expect(401);
});

test('the password is stored hashed and the old hash is gone', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const me = await signedIn(ctx, base);
    const before = ctx.model.findBySlug('vault');
    await me.post(`${base}/password`).send({ currentPassword: PASSWORD, newPassword: NEW }).expect(200);
    const after = ctx.model.findBySlug('vault');
    assert.notEqual(after.password_hash, before.password_hash);
    assert.notEqual(after.password_salt, before.password_salt);
    assert.ok(!JSON.stringify(after).includes(NEW));
});
