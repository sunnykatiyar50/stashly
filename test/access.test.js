const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const PASSWORD = 'correct horse';
const minutes = n => n * 60 * 1000;

// A password-protected stash, with the creator's agent already unlocked
async function protectedStash(ctx, slug = 'vault') {
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug, password: PASSWORD }).expect(201);
    return { owner, base: `/api/stashes/${slug}` };
}

async function shareLink(owner, base, kind) {
    const res = await owner.post(`${base}/share-links`).send({ kind }).expect(201);
    return res.body;
}

// A fresh visitor (no cookies) who opens a share link
async function visitor(ctx, base, token) {
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/redeem`).send({ token }).expect(200);
    return agent;
}

// ---- name strength ----

test('a stash with no password needs a long enough name; a password lifts the rule', async () => {
    const ctx = makeApp({ minOpenNameLength: 10 });
    const short = await request(ctx.app).post('/api/stashes').send({ slug: 'laptop' }).expect(400);
    assert.equal(short.body.field, 'slug');
    assert.match(short.body.error, /at least 10 characters/);
    await request(ctx.app).post('/api/stashes').send({ slug: 'laptop', password: PASSWORD }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'a-longer-name' }).expect(201);
});

test('the name rule is shown in the public config and can be switched off', async () => {
    assert.equal((await request(makeApp({ minOpenNameLength: 12 }).app).get('/api/config')).body.minOpenNameLength, 12);
    const off = makeApp({ minOpenNameLength: 0 });
    await request(off.app).post('/api/stashes').send({ slug: 'tiny' }).expect(201);
});

test('the admin can change the shortest name, and existing stashes are left alone', async () => {
    const ctx = makeApp({ adminPassword: 'admin-pass', minOpenNameLength: 0 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'oldone' }).expect(201);
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: 'admin-pass' }).expect(200);
    const saved = await admin.put('/api/admin/settings').send({ values: { minOpenNameLength: 16 } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await request(ctx.app).post('/api/stashes').send({ slug: 'fifteen-chars-x' }).expect(400);
    await request(ctx.app).post('/api/stashes').send({ slug: 'sixteen-chars-xx' }).expect(201);
    await request(ctx.app).get('/api/stashes/oldone').expect(200);
});

// ---- per-stash lockout ----

test('after too many wrong passwords from anyone, unlocking the stash is refused for a while', async () => {
    const ctx = makeApp({ stashUnlockFailures: 3 });
    await protectedStash(ctx);
    const url = '/api/stashes/vault/unlock';
    for (let i = 0; i < 3; i++) {
        await request(ctx.app).post(url).send({ password: 'nope' }).expect(401);
    }
    // Even the right password is refused now, so guessing cannot continue
    const refused = await request(ctx.app).post(url).send({ password: PASSWORD }).expect(429);
    assert.ok(Number(refused.headers['retry-after']) > 0);
    assert.match(refused.body.error, /Too many wrong passwords/);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + minutes(16));
    await request(ctx.app).post(url).send({ password: PASSWORD }).expect(200);
});

test('the lockout does not shut out someone already unlocked, and a right password clears the count', async () => {
    const ctx = makeApp({ stashUnlockFailures: 3 });
    const { owner, base } = await protectedStash(ctx);
    for (let i = 0; i < 3; i++) await request(ctx.app).post(`${base}/unlock`).send({ password: 'nope' }).expect(401);
    await request(ctx.app).post(`${base}/unlock`).send({ password: PASSWORD }).expect(429);
    // The owner's cookie still works while unlocking is refused
    await owner.get(base).expect(200);

    // Two wrong, one right, then two more wrong: the right one reset the count, so no lockout yet
    const other = makeApp({ stashUnlockFailures: 3 });
    await protectedStash(other, 'second');
    const u = '/api/stashes/second/unlock';
    await request(other.app).post(u).send({ password: 'x' }).expect(401);
    await request(other.app).post(u).send({ password: 'x' }).expect(401);
    await request(other.app).post(u).send({ password: PASSWORD }).expect(200);
    await request(other.app).post(u).send({ password: 'x' }).expect(401);
    await request(other.app).post(u).send({ password: 'x' }).expect(401);
    await request(other.app).post(u).send({ password: PASSWORD }).expect(200);
});

test('one stash being locked does not affect another', async () => {
    const ctx = makeApp({ stashUnlockFailures: 2 });
    await protectedStash(ctx, 'first');
    await protectedStash(ctx, 'second');
    for (let i = 0; i < 2; i++) await request(ctx.app).post('/api/stashes/first/unlock').send({ password: 'x' }).expect(401);
    await request(ctx.app).post('/api/stashes/first/unlock').send({ password: PASSWORD }).expect(429);
    await request(ctx.app).post('/api/stashes/second/unlock').send({ password: PASSWORD }).expect(200);
});

// ---- share links ----

test('share links need a password on the stash and full access to create', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-stash' }).expect(201);
    await request(ctx.app).post('/api/stashes/open-stash/share-links').send({ kind: 'view' }).expect(400);

    const { owner, base } = await protectedStash(ctx);
    await owner.post(`${base}/share-links`).send({ kind: 'nonsense' }).expect(400);
    await request(ctx.app).post(`${base}/share-links`).send({ kind: 'view' }).expect(401);
    const link = await shareLink(owner, base, 'view');
    assert.match(link.path, /^\/s\/vault#view=[A-Za-z0-9_-]{20,}$/);
});

test('only the hash of a link token is stored', async () => {
    const ctx = makeApp();
    const { owner, base } = await protectedStash(ctx);
    const link = await shareLink(owner, base, 'view');
    const row = ctx.model.findBySlug('vault');
    assert.ok(row.view_token_hash);
    assert.notEqual(row.view_token_hash, link.token);
    assert.ok(!JSON.stringify(row).includes(link.token));
});

test('a read-only link can read but not change anything', async () => {
    const ctx = makeApp();
    const { owner, base } = await protectedStash(ctx);
    const note = await owner.post(`${base}/notes`).send({ text: 'for reading' }).expect(201);
    const burn = await owner.post(`${base}/notes`).send({ text: 'burn me', burn: true }).expect(201);
    const link = await shareLink(owner, base, 'view');
    const viewer = await visitor(ctx, base, link.token);

    const list = await viewer.get(base).expect(200);
    assert.equal(list.body.role, 'view');
    assert.deepEqual(list.body.items.map(i => i.text).filter(Boolean), ['for reading']);
    assert.equal(list.body.shareLinks, null);
    assert.equal(list.body.canExtend, false);
    assert.equal((await viewer.get(`${base}/latest`).expect(200)).text, 'for reading');

    await viewer.post(`${base}/notes`).send({ text: 'x' }).expect(403);
    await viewer.delete(`${base}/items/${note.body.id}`).expect(403);
    await viewer.post(`${base}/items/${burn.body.id}/reveal`).expect(403);
    await viewer.post(`${base}/extend`).expect(403);
    await viewer.post(`${base}/share-links`).send({ kind: 'drop' }).expect(403);
    await viewer.delete(`${base}/share-links/view`).expect(403);
    await viewer.delete(base).expect(403);
    // Nothing was changed
    assert.equal((await owner.get(base).expect(200)).body.items.length, 2);
});

test('a drop-box link can add notes and files but cannot read anything', async () => {
    const ctx = makeApp();
    const { owner, base } = await protectedStash(ctx);
    await owner.post(`${base}/notes`).send({ text: 'private' }).expect(201);
    const link = await shareLink(owner, base, 'drop');
    const dropper = await visitor(ctx, base, link.token);

    const list = await dropper.get(base).expect(200);
    assert.equal(list.body.role, 'drop');
    assert.deepEqual(list.body.items, []);
    assert.deepEqual(list.body.usage, { items: 0, files: 0, bytes: 0 });

    await dropper.post(`${base}/notes`).send({ text: 'dropped in' }).expect(201);
    await dropper
        .post(`${base}/files`)
        .set('X-File-Name', 'hello.txt')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('file text'))
        .expect(201);

    await dropper.get(`${base}/latest`).expect(403);
    await dropper.get(`${base}/events`).expect(403);
    await dropper.get(`${base}/files/1`).expect(403);
    await dropper.delete(`${base}/items/1`).expect(403);

    // The owner sees what was dropped
    const seen = await owner.get(base).expect(200);
    assert.deepEqual(seen.body.items.map(i => i.text || i.fileName), ['hello.txt', 'dropped in', 'private']);
});

test('a wrong or revoked link is refused, and revoking ends sessions already using it', async () => {
    const ctx = makeApp();
    const { owner, base } = await protectedStash(ctx);
    const link = await shareLink(owner, base, 'view');
    await request(ctx.app).post(`${base}/redeem`).send({ token: 'wrong' }).expect(401);
    await request(ctx.app).post(`${base}/redeem`).send({}).expect(401);

    const viewer = await visitor(ctx, base, link.token);
    await viewer.get(base).expect(200);

    await owner.delete(`${base}/share-links/view`).expect(200);
    await viewer.get(base).expect(401);
    await request(ctx.app).post(`${base}/redeem`).send({ token: link.token }).expect(401);
});

test('making a new link voids the old one and the cookies it gave out', async () => {
    const ctx = makeApp();
    const { owner, base } = await protectedStash(ctx);
    const first = await shareLink(owner, base, 'view');
    const viewer = await visitor(ctx, base, first.token);
    const second = await shareLink(owner, base, 'view');
    assert.notEqual(first.token, second.token);
    await viewer.get(base).expect(401);
    await request(ctx.app).post(`${base}/redeem`).send({ token: first.token }).expect(401);
    await visitor(ctx, base, second.token);
});

test('a read-only link and a drop-box link are separate, and a link only works for its own stash', async () => {
    const ctx = makeApp();
    const a = await protectedStash(ctx, 'stash-a');
    const b = await protectedStash(ctx, 'stash-b');
    const view = await shareLink(a.owner, a.base, 'view');
    const drop = await shareLink(a.owner, a.base, 'drop');
    assert.equal((await a.owner.get(a.base)).body.shareLinks.view, true);
    assert.equal((await a.owner.get(a.base)).body.shareLinks.drop, true);

    const viewer = await visitor(ctx, a.base, view.token);
    // The view token does not open the drop role, and a cookie for stash A means nothing in stash B
    await viewer.post(`${a.base}/notes`).send({ text: 'x' }).expect(403);
    await viewer.get(b.base).expect(401);
    await request(ctx.app).post(`${b.base}/redeem`).send({ token: view.token }).expect(401);
    await request(ctx.app).post(`${b.base}/redeem`).send({ token: drop.token }).expect(401);
});

test('the share link cookie is HttpOnly and SameSite=Strict', async () => {
    const ctx = makeApp();
    const { owner, base } = await protectedStash(ctx);
    const link = await shareLink(owner, base, 'view');
    const res = await request(ctx.app).post(`${base}/redeem`).send({ token: link.token }).expect(200);
    const cookie = res.headers['set-cookie'].join(';');
    assert.match(cookie, /stashlyv_vault=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
});

// ---- cookies ----

test('COOKIE_SECURE=true marks the unlock cookie Secure even over plain HTTP', async () => {
    const forced = makeApp({ cookieSecure: 'true' });
    const res = await request(forced.app).post('/api/stashes').send({ slug: 'vault', password: PASSWORD }).expect(201);
    assert.match(res.headers['set-cookie'].join(';'), /Secure/i);

    const auto = makeApp({ cookieSecure: 'auto' });
    const plain = await request(auto.app).post('/api/stashes').send({ slug: 'vault', password: PASSWORD }).expect(201);
    assert.doesNotMatch(plain.headers['set-cookie'].join(';'), /Secure/i);
});

test('responses carry the hardening headers, and the API is never cached', async () => {
    const ctx = makeApp();
    for (const url of ['/', '/api/config', '/s/anything']) {
        const res = await request(ctx.app).get(url);
        assert.equal(res.headers['cache-control'], 'no-store', url);
        assert.match(res.headers['permissions-policy'], /camera=\(\)/, url);
        assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
        assert.equal(res.headers['referrer-policy'], 'no-referrer', url);
        assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/, url);
    }
});

test('an unexpected server error logs no request content', async () => {
    const ctx = makeApp();
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    try {
        // A malformed JSON body is a client error (400), handled without logging the body
        await request(ctx.app).post('/api/stashes').set('Content-Type', 'application/json').send('{"text": "super secret note').expect(400);
    } finally {
        console.error = original;
    }
    assert.ok(!logged.join('\n').includes('super secret'));
});
