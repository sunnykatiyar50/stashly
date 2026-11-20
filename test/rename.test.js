const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const PASSWORD = 'correct horse';
const maxAge = res => {
    const match = /Max-Age=(\d+)/i.exec((res.headers['set-cookie'] || []).join(';'));
    return match ? Number(match[1]) : null;
};

async function openStash(ctx, slug = 'old-name') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    return `/api/stashes/${slug}`;
}

async function protectedStash(ctx, slug = 'old-name') {
    await request(ctx.app).post('/api/stashes').send({ slug, password: PASSWORD }).expect(201);
    return `/api/stashes/${slug}`;
}

test('a stash can be renamed: the new name works, the old one is gone, nothing inside changes', async () => {
    const ctx = makeApp();
    const base = await openStash(ctx);
    const note = await request(ctx.app).post(`${base}/notes`).send({ title: 'kept', text: 'inside' }).expect(201);
    await request(ctx.app).post(`${base}/items/${note.body.id}/pin`).send({ pinned: true }).expect(200);
    await request(ctx.app).put(`${base}/keep-last`).send({ keepLast: 5 }).expect(200);
    const before = (await request(ctx.app).get(base)).body;

    const res = await request(ctx.app).post(`${base}/rename`).send({ slug: 'new-name' }).expect(200);
    assert.equal(res.body.slug, 'new-name');
    assert.equal(res.body.url, '/s/new-name');

    await request(ctx.app).get(base).expect(404);
    const after = (await request(ctx.app).get('/api/stashes/new-name').expect(200)).body;
    assert.equal(after.slug, 'new-name');
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(after.keepLast, 5);
    assert.equal(after.items.length, 1);
    assert.equal(after.items[0].id, note.body.id);
    assert.equal(after.items[0].text, 'inside');
    assert.equal(after.items[0].pinned, true);
});

test('the new name follows the same rules as a new stash, and is lower-cased', async () => {
    const ctx = makeApp();
    const base = await openStash(ctx);
    for (const slug of ['abc', 'has space', 'bad/slash', 'x'.repeat(65), '', 'suggest', 'config', 42, null]) {
        const res = await request(ctx.app).post(`${base}/rename`).send({ slug }).expect(400);
        assert.equal(res.body.field, 'slug', JSON.stringify(slug));
    }
    await request(ctx.app).post(`${base}/rename`).send({}).expect(400);
    const res = await request(ctx.app).post(`${base}/rename`).send({ slug: '  Mixed-Case  ' }).expect(200);
    assert.equal(res.body.slug, 'mixed-case');
});

test('a name that is taken is refused, and so is the name it already has', async () => {
    const ctx = makeApp();
    const base = await openStash(ctx);
    await openStash(ctx, 'taken-name');
    const taken = await request(ctx.app).post(`${base}/rename`).send({ slug: 'taken-name' }).expect(409);
    assert.equal(taken.body.field, 'slug');
    await request(ctx.app).post(`${base}/rename`).send({ slug: 'old-name' }).expect(400);
    await request(ctx.app).post(`${base}/rename`).send({ slug: 'OLD-NAME' }).expect(400);
    // Nothing moved
    await request(ctx.app).get(base).expect(200);
});

test('without a password the new name must be long enough; with one it need not be', async () => {
    const ctx = makeApp({ minOpenNameLength: 10 });
    const open = await openStash(ctx, 'long-enough-name');
    const refused = await request(ctx.app).post(`${open}/rename`).send({ slug: 'short' }).expect(400);
    assert.match(refused.body.error, /at least 10 characters/);
    await request(ctx.app).post(`${open}/rename`).send({ slug: 'another-long-name' }).expect(200);

    const base = await protectedStash(ctx, 'protected-stash');
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    await agent.post(`${base}/rename`).send({ slug: 'short' }).expect(200);
});

test('the old name becomes free: a new stash can take it, empty', async () => {
    const ctx = makeApp();
    const base = await openStash(ctx);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'stays with the renamed one' }).expect(201);
    await request(ctx.app).post(`${base}/rename`).send({ slug: 'new-name' }).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'old-name' }).expect(201);
    assert.equal((await request(ctx.app).get(base)).body.items.length, 0);
    assert.equal((await request(ctx.app).get('/api/stashes/new-name')).body.items.length, 1);
});

test('on a protected stash this browser stays signed in under the new name, others are signed out', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const me = request.agent(ctx.app);
    await me.post(`${base}/unlock`).send({ password: PASSWORD, session: '2h' }).expect(200);
    const other = request.agent(ctx.app);
    await other.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    await me.post(`${base}/notes`).send({ text: 'kept' }).expect(201);

    const res = await me.post(`${base}/rename`).send({ slug: 'new-name' }).expect(200);
    const cookies = res.headers['set-cookie'].join(';');
    assert.match(cookies, /stashly_old-name=;/); // the old cookie is cleared
    assert.match(cookies, /stashly_new-name=/); // a new one is issued
    assert.equal(maxAge(res), 7200);

    const newBase = '/api/stashes/new-name';
    assert.equal((await me.get(newBase).expect(200)).body.items[0].text, 'kept');
    await other.get(newBase).expect(401);
    // The password is the same
    await request(ctx.app).post(`${newBase}/unlock`).send({ password: PASSWORD }).expect(200);
});

test('this browser keeps only the time it had left', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const me = request.agent(ctx.app);
    await me.post(`${base}/unlock`).send({ password: PASSWORD, session: '2h' }).expect(200);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 30 * 60 * 1000);
    const res = await me.post(`${base}/rename`).send({ slug: 'new-name' }).expect(200);
    assert.equal(maxAge(res), 90 * 60);
});

test('share links are cancelled by a rename, because they carry the old name', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: link.token }).expect(200);

    await owner.post(`${base}/rename`).send({ slug: 'new-name' }).expect(200);
    await viewer.get('/api/stashes/new-name').expect(401);
    await request(ctx.app).post('/api/stashes/new-name/redeem').send({ token: link.token }).expect(401);
    assert.equal(ctx.model.findBySlug('new-name').view_token_hash, null);
    assert.equal((await owner.get('/api/stashes/new-name')).body.shareLinks.view, false);
});

test('a wrong-password count belongs to the stash, so a rename does not clear it', async () => {
    const ctx = makeApp({ stashUnlockFailures: 2 });
    const base = await protectedStash(ctx);
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    for (let i = 0; i < 2; i++) await request(ctx.app).post(`${base}/unlock`).send({ password: 'nope' }).expect(401);

    await owner.post(`${base}/rename`).send({ slug: 'new-name' }).expect(200);
    await request(ctx.app).post('/api/stashes/new-name/unlock').send({ password: PASSWORD }).expect(429);
    assert.equal(ctx.controller.failures.has('old-name'), false);
    assert.equal(ctx.controller.failures.has('new-name'), true);
});

test('open pages are told the new address, naming the page that made the change', async () => {
    const ctx = makeApp();
    const base = await openStash(ctx);
    const closed = [];
    ctx.events.closeAll = (slug, event, data) => closed.push({ slug, event, data });
    await request(ctx.app).post(`${base}/rename`).set('X-Tab-Id', 'tab-1').send({ slug: 'new-name' }).expect(200);
    assert.deepEqual(closed, [{ slug: 'old-name', event: 'stash-renamed', data: { slug: 'new-name', origin: 'tab-1' } }]);
});

test('only someone with full access can rename', async () => {
    const ctx = makeApp();
    const base = await protectedStash(ctx);
    await request(ctx.app).post(`${base}/rename`).send({ slug: 'new-name' }).expect(401);

    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    const view = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body.token;
    const drop = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body.token;
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: view }).expect(200);
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: drop }).expect(200);
    await viewer.post(`${base}/rename`).send({ slug: 'new-name' }).expect(403);
    await dropper.post(`${base}/rename`).send({ slug: 'new-name' }).expect(403);
    await owner.get(base).expect(200);
});

test('renaming a missing stash is a 404', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes/nothing-here/rename').send({ slug: 'new-name' }).expect(404);
});

test('renaming is rate limited like other writes', async () => {
    const ctx = makeApp({ ratePost: 2 });
    const base = await openStash(ctx);
    await request(ctx.app).post(`${base}/rename`).send({ slug: 'one-name' }).expect(200);
    await request(ctx.app).post('/api/stashes/one-name/rename').send({ slug: 'two-name' }).expect(200);
    await request(ctx.app).post('/api/stashes/two-name/rename').send({ slug: 'three-name' }).expect(429);
});
