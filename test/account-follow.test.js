const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';
const STASH_PASSWORD = 'stash password one';

async function accountApp(overrides = {}) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides });
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    return { ...ctx, root };
}

async function addUser(ctx, username, role = 'user') {
    return (await ctx.root.post('/api/admin/users').send({ username, password: PASSWORD, role }).expect(201)).body;
}

async function signIn(ctx, username) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
    return agent;
}

// An app with one user, signed in. The stashes are made by anonymous requests, so the user's agent holds no stash cookie:
// whatever it can do in a stash comes from its follow list.
async function oneUser(overrides = {}) {
    const ctx = await accountApp(overrides);
    const user = await addUser(ctx, 'sam');
    const sam = await signIn(ctx, 'sam');
    return { ...ctx, user, sam };
}

// A password-protected stash and an agent that is its owner (holds the unlock cookie)
async function lockedStash(ctx, slug = 'locked-stash') {
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug, password: STASH_PASSWORD }).expect(201);
    return owner;
}

const followRows = ctx => ctx.db.prepare('SELECT * FROM user_stashes').all();
const dashboard = async agent => (await agent.get('/api/me/stashes').expect(200)).body.stashes;
const advance = (ctx, ms) => { ctx.clock.time = new Date(ctx.clock.time.getTime() + ms); };

function assertNoSecrets(body) {
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /password_hash|password_salt|session_version|grant_|view_token|drop_token|"hash"|"salt"/i);
    for (const secret of [PASSWORD, ADMIN, STASH_PASSWORD]) assert.ok(!text.includes(secret), `a response carries ${secret}`);
}

// ---- following ----

test('a stash with no password is followed by its name alone, with full access', async () => {
    const ctx = await oneUser();
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-stash-name' }).expect(201);
    const res = await ctx.sam.post('/api/me/stashes').send({ slug: 'open-stash-name' }).expect(200);
    assert.deepEqual(res.body, { ok: true, slug: 'open-stash-name', role: 'full' });
    const rows = followRows(ctx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grant_role, 'full');
    assert.equal(rows[0].grant_salt, null);
    // The name may be typed in any case, or pasted as an address
    await ctx.sam.post('/api/me/stashes').send({ slug: 'OPEN-Stash-Name' }).expect(200);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'https://stash.example.com/s/open-stash-name#view=abc' }).expect(200);
    assert.equal(followRows(ctx).length, 1);
});

test('only a signed-in user can follow, list or unfollow', async () => {
    const ctx = await accountApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-stash-name' }).expect(201);
    for (const [method, path] of [
        ['post', '/api/me/stashes'], ['get', '/api/me/stashes'], ['delete', '/api/me/stashes/open-stash-name'], ['post', '/api/me/stashes/open-stash-name/seen'],
    ]) {
        const res = await request(ctx.app)[method](path).send({ slug: 'open-stash-name' }).expect(401);
        assert.equal(res.body.signedIn, false, path);
    }
    assert.equal(followRows(ctx).length, 0);
});

test('a password stash is followed with its password; a wrong or missing one is refused like unlocking', async () => {
    const ctx = await oneUser();
    await lockedStash(ctx);
    const none = await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash' }).expect(401);
    assert.equal(none.body.locked, true);
    const wrong = await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: 'not the password' }).expect(401);
    assert.deepEqual(wrong.body, { error: 'That password is not right.', locked: true });
    assert.equal(followRows(ctx).length, 0);

    const ok = await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    assert.equal(ok.body.role, 'full');
    assertNoSecrets(ok.body);
    const row = followRows(ctx)[0];
    // The snapshot holds the stash's current salt and version, never the password
    const stash = ctx.model.findBySlug('locked-stash');
    assert.equal(row.grant_salt, stash.password_salt);
    assert.equal(row.grant_version, 0);
    assert.equal(row.grant_view_hash, null);
    assert.ok(!JSON.stringify(row).includes(STASH_PASSWORD));
    // Wrong types are just wrong
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: { $ne: 1 } }).expect(401);
    await ctx.sam.post('/api/me/stashes').send({ slug: ['locked-stash'] }).expect(400);
    await ctx.sam.post('/api/me/stashes').send({}).expect(400);
});

test('following shares the unlock lockout: wrong passwords from either count towards both, and it cannot be used to guess', async () => {
    const ctx = await oneUser({ stashUnlockFailures: 3 });
    await lockedStash(ctx);
    const stranger = request.agent(ctx.app);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: 'wrong one one' }).expect(401);
    await stranger.post('/api/stashes/locked-stash/unlock').send({ password: 'wrong two two' }).expect(401);
    assert.equal(ctx.controller.failures.get('locked-stash').count, 2);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: 'wrong three' }).expect(401);
    assert.equal(ctx.controller.failures.get('locked-stash').count, 3);

    // Locked for this visitor on both doors, even with the right password
    const follow = await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(429);
    assert.match(follow.body.error, /Too many wrong passwords/);
    assert.equal(follow.body.locked, true);
    assert.ok(Number(follow.headers['retry-after']) > 0);
    await stranger.post('/api/stashes/locked-stash/unlock').send({ password: STASH_PASSWORD }).expect(429);
    assert.equal(followRows(ctx).length, 0);

    // When the window is over the right password works and clears the counts
    advance(ctx, 16 * 60 * 1000);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    assert.equal(ctx.controller.failures.has('locked-stash'), false);
});

test('following has its own per-address limit on wrong passwords, and on names that do not exist', async () => {
    const ctx = await oneUser({ rateUnlock: 3, rateNotFound: 3 });
    await lockedStash(ctx);
    for (let i = 0; i < 3; i++) await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: 'wrong wrong 1' }).expect(401);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(429);

    const guessing = await oneUser({ rateNotFound: 3 });
    for (let i = 0; i < 3; i++) await guessing.sam.post('/api/me/stashes').send({ slug: `no-such-stash-${i}` }).expect(404);
    await guessing.sam.post('/api/me/stashes').send({ slug: 'no-such-stash-9' }).expect(429);
});

test('a missing or expired stash gets the same plain answer as everywhere else', async () => {
    const ctx = await oneUser();
    const missing = await ctx.sam.post('/api/me/stashes').send({ slug: 'does-not-exist' }).expect(404);
    const plain = await request(ctx.app).get('/api/stashes/does-not-exist').expect(404);
    assert.equal(missing.body.error, plain.body.error);
    await request(ctx.app).post('/api/stashes').send({ slug: 'short-lived', ttl: '1h' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'short-lived' }).expect(200);
    advance(ctx, 2 * 60 * 60 * 1000);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'short-lived' }).expect(404);
    assert.equal(followRows(ctx).length, 0);
});

test('a read-only link follows as read-only: the token or the whole address, and a drop-box link is refused', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    const view = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    const drop = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'drop' }).expect(201)).body;

    // A made-up link, and a link for another stash's token, are refused and counted
    const bad = await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: 'x'.repeat(32) }).expect(401);
    assert.equal(bad.body.locked, true);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: 'not a link at all' }).expect(401);
    assert.equal(ctx.controller.failures.get('locked-stash').count, 1);

    const dropped = await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: drop.token }).expect(400);
    assert.match(dropped.body.error, /drop-box/);
    await ctx.sam.post('/api/me/stashes').send({ link: `https://host.example/s/locked-stash#drop=${drop.token}` }).expect(400);
    assert.equal(followRows(ctx).length, 0);

    // The bare token, with the name in its own field
    const bare = await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: view.token }).expect(200);
    assert.deepEqual(bare.body, { ok: true, slug: 'locked-stash', role: 'view' });
    await ctx.sam.delete('/api/me/stashes/locked-stash').expect(200);
    // The whole address: the name comes from it, so it is enough alone
    const whole = await ctx.sam.post('/api/me/stashes').send({ link: `https://host.example/s/Locked-Stash#view=${view.token}` }).expect(200);
    assert.equal(whole.body.role, 'view');
    const row = followRows(ctx)[0];
    assert.equal(row.grant_role, 'view');
    assert.equal(row.grant_view_hash, ctx.model.findBySlug('locked-stash').view_token_hash);
    // A link with the wrong kind label is not valid
    await ctx.sam.post('/api/me/stashes').send({ link: `/s/locked-stash#drop=${view.token}` }).expect(401);
    assert.equal(followRows(ctx).length, 1);
});

test('following again updates the grant instead of adding a row: a password upgrades a read-only follow, a link downgrades', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    const view = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;

    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: view.token }).expect(200);
    assert.equal((await dashboard(ctx.sam))[0].role, 'view');
    const added = followRows(ctx)[0].added_at;
    advance(ctx, 60000);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    assert.equal(followRows(ctx).length, 1);
    assert.equal((await dashboard(ctx.sam))[0].role, 'full');
    assert.equal(followRows(ctx)[0].grant_view_hash, null);
    // (when it was added is kept)
    assert.equal(followRows(ctx)[0].added_at, added);

    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: view.token }).expect(200);
    assert.equal(followRows(ctx).length, 1);
    assert.equal((await dashboard(ctx.sam))[0].role, 'view');
});

test('the stash page can follow with the access the browser already has (full or read-only); a drop-box visit cannot', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    const view = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    const drop = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'drop' }).expect(201)).body;

    // No access at all: refused
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', current: true }).expect(401);

    const readerCookies = (await request(ctx.app).post('/api/stashes/locked-stash/redeem').send({ token: view.token }).expect(200)).headers['set-cookie'].map(c => c.split(';')[0]);
    const dropperCookies = (await request(ctx.app).post('/api/stashes/locked-stash/redeem').send({ token: drop.token }).expect(200)).headers['set-cookie'].map(c => c.split(';')[0]);
    const ownerCookies = (await request(ctx.app).post('/api/stashes/locked-stash/unlock').send({ password: STASH_PASSWORD }).expect(200)).headers['set-cookie'].map(c => c.split(';')[0]);
    const withUser = async cookies => {
        const login = await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(200);
        return [...cookies, login.headers['set-cookie'][0].split(';')[0]].join('; ');
    };

    const dropRes = await request(ctx.app).post('/api/me/stashes').set('Cookie', await withUser(dropperCookies)).send({ slug: 'locked-stash', current: true }).expect(400);
    assert.match(dropRes.body.error, /drop-box/);
    const viewRes = await request(ctx.app).post('/api/me/stashes').set('Cookie', await withUser(readerCookies)).send({ slug: 'locked-stash', current: true }).expect(200);
    assert.equal(viewRes.body.role, 'view');
    const fullRes = await request(ctx.app).post('/api/me/stashes').set('Cookie', await withUser(ownerCookies)).send({ slug: 'locked-stash', current: true }).expect(200);
    assert.equal(fullRes.body.role, 'full');
    assert.equal(followRows(ctx).length, 1);
    // `current` is only the access the browser really has: it is no way around the password
    assert.equal(ctx.controller.failures.size, 0);
});

// ---- access through the follow list ----

test('a full follow lets the user work in the stash with no stash cookie: read, add, pin, edit, delete, extend', async () => {
    const ctx = await oneUser();
    await lockedStash(ctx);
    await ctx.sam.get('/api/stashes/locked-stash').expect(401);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);

    const listing = await ctx.sam.get('/api/stashes/locked-stash').expect(200);
    assert.equal(listing.body.role, 'full');
    assert.equal(listing.body.sessionEndsAt, null);
    const note = await ctx.sam.post('/api/stashes/locked-stash/notes').send({ text: 'from the account' }).expect(201);
    await ctx.sam.put(`/api/stashes/locked-stash/items/${note.body.id}`).send({ text: 'edited' }).expect(200);
    await ctx.sam.post(`/api/stashes/locked-stash/items/${note.body.id}/pin`).send({ pinned: true }).expect(200);
    await ctx.sam.post('/api/stashes/locked-stash/files').set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
    await ctx.sam.post('/api/stashes/locked-stash/extend').expect(200);
    await ctx.sam.get('/api/stashes/locked-stash/export').expect(200);
    await ctx.sam.delete(`/api/stashes/locked-stash/items/${note.body.id}`).expect(200);
    // Someone with no account and no cookie still cannot
    await request(ctx.app).get('/api/stashes/locked-stash').expect(401);
});

test('a read-only follow can read and copy but not add, edit, pin or delete', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    const note = await owner.post('/api/stashes/locked-stash/notes').send({ text: 'readable' }).expect(201);
    const view = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: view.token }).expect(200);

    const listing = await ctx.sam.get('/api/stashes/locked-stash').expect(200);
    assert.equal(listing.body.role, 'view');
    assert.equal(listing.body.items.length, 1);
    assert.equal(listing.body.shareLinks, null);
    await ctx.sam.get('/api/stashes/locked-stash/latest').expect(200);
    await ctx.sam.get(`/api/stashes/locked-stash/items/${note.body.id}`).expect(200);
    for (const [method, path, body] of [
        ['post', '/api/stashes/locked-stash/notes', { text: 'no' }],
        ['put', `/api/stashes/locked-stash/items/${note.body.id}`, { text: 'no' }],
        ['post', `/api/stashes/locked-stash/items/${note.body.id}/pin`, { pinned: true }],
        ['delete', `/api/stashes/locked-stash/items/${note.body.id}`, {}],
        ['delete', '/api/stashes/locked-stash', {}],
        ['post', '/api/stashes/locked-stash/password', { currentPassword: STASH_PASSWORD, newPassword: 'another password' }],
        ['post', '/api/stashes/locked-stash/share-links', { kind: 'view' }],
        ['post', '/api/stashes/locked-stash/sign-out-others', {}],
    ]) {
        const res = await ctx.sam[method](path).send(body).expect(403);
        assert.equal(res.body.role, 'view', path);
    }
    assert.equal(ctx.model.listItems(ctx.model.findBySlug('locked-stash').id).length, 1);
});

test('a cookie that gives more than the follow wins; a follow that gives more than a cookie wins too', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    const view = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    // sam follows with the password (full) and also redeems the read-only link in the same browser (a view cookie)
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await ctx.sam.post('/api/stashes/locked-stash/redeem').send({ token: view.token }).expect(200);
    assert.equal((await ctx.sam.get('/api/stashes/locked-stash').expect(200)).body.role, 'full');
});

// ---- grants end like cookies do ----

test('a new stash password ends the follow: it stays in the list as "needs the password", and following again fixes it', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(200);

    await owner.post('/api/stashes/locked-stash/password').send({ currentPassword: STASH_PASSWORD, newPassword: 'the new password' }).expect(200);
    const refused = await ctx.sam.get('/api/stashes/locked-stash').expect(401);
    assert.equal(refused.body.locked, true);
    await ctx.sam.post('/api/stashes/locked-stash/notes').send({ text: 'x' }).expect(401);
    // The row remains; the dashboard says what is needed and shows nothing about the stash
    assert.equal(followRows(ctx).length, 1);
    const [stale] = await dashboard(ctx.sam);
    assert.deepEqual(Object.keys(stale).sort(), ['addedAt', 'needsPassword', 'owned', 'pinned', 'role', 'slug']);
    assert.equal(stale.role, null);
    assert.equal(stale.needsPassword, true);

    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(401);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: 'the new password' }).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(200);
    assert.equal((await dashboard(ctx.sam))[0].needsPassword, false);
    assert.equal(followRows(ctx).length, 1);
});

test('"sign out other devices" ends follows of the stash too, and the person who did it keeps their own', async () => {
    const ctx = await oneUser();
    await addUser(ctx, 'kim');
    const kim = await signIn(ctx, 'kim');
    const owner = await lockedStash(ctx);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await kim.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);

    // sam signs out the others using the access their own follow gives them
    await ctx.sam.post('/api/stashes/locked-stash/sign-out-others').expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(200);
    await kim.get('/api/stashes/locked-stash').expect(401);
    await owner.get('/api/stashes/locked-stash').expect(401);
    assert.equal((await dashboard(kim))[0].needsPassword, true);
    assert.equal((await dashboard(ctx.sam))[0].needsPassword, false);
    // kim follows again
    await kim.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await kim.get('/api/stashes/locked-stash').expect(200);
});

test('a user who changes the stash password with their own follow keeps their follow; other users lose theirs', async () => {
    const ctx = await oneUser();
    await addUser(ctx, 'kim');
    const kim = await signIn(ctx, 'kim');
    await lockedStash(ctx);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await kim.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await ctx.sam.post('/api/stashes/locked-stash/password').send({ currentPassword: STASH_PASSWORD, newPassword: 'the new password' }).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(200);
    await kim.get('/api/stashes/locked-stash').expect(401);
});

test('replacing or cancelling the read-only link ends read-only follows; a new link can be followed', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    const first = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: first.token }).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(200);

    // Replaced by a new link
    const second = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    await ctx.sam.get('/api/stashes/locked-stash').expect(401);
    assert.equal((await dashboard(ctx.sam))[0].needsPassword, true);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: first.token }).expect(401);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: second.token }).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(200);

    // Cancelled
    await owner.delete('/api/stashes/locked-stash/share-links/view').expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(401);
    assert.equal((await dashboard(ctx.sam))[0].needsPassword, true);
    // A read-only follow is not revived by a different link of the same hash column being null
    assert.equal(ctx.model.findBySlug('locked-stash').view_token_hash, null);
});

test('the admin setting a stash password ends follows, and a password added to a stash that had none does too', async () => {
    const ctx = await oneUser();
    await lockedStash(ctx);
    await request(ctx.app).post('/api/stashes').send({ slug: 'was-open-stash' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'was-open-stash' }).expect(200);
    // No password: the name is the proof, so the follow works for everyone anyway
    await ctx.sam.get('/api/stashes/was-open-stash').expect(200);

    await ctx.root.put('/api/admin/stashes/locked-stash/password').send({ password: 'admin chosen pass' }).expect(200);
    await ctx.root.put('/api/admin/stashes/was-open-stash/password').send({ password: 'admin chosen pass' }).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(401);
    await ctx.sam.get('/api/stashes/was-open-stash').expect(401);
    const list = await dashboard(ctx.sam);
    assert.deepEqual(list.map(s => s.needsPassword), [true, true]);
});

test('renaming a stash keeps the follow of someone with full access, and ends read-only follows (the link is cancelled)', async () => {
    const ctx = await oneUser();
    await addUser(ctx, 'kim');
    const kim = await signIn(ctx, 'kim');
    const owner = await lockedStash(ctx);
    const view = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await kim.post('/api/me/stashes').send({ slug: 'locked-stash', link: view.token }).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-renamed-one' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'open-renamed-one' }).expect(200);

    await owner.post('/api/stashes/locked-stash/rename').send({ slug: 'renamed-stash' }).expect(200);
    await ctx.sam.post('/api/stashes/open-renamed-one/rename').send({ slug: 'open-new-name' }).expect(200);

    const list = await dashboard(ctx.sam);
    assert.deepEqual(list.map(s => s.slug).sort(), ['open-new-name', 'renamed-stash']);
    assert.ok(list.every(s => s.role === 'full'));
    await ctx.sam.get('/api/stashes/renamed-stash').expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(404);
    assert.equal(followRows(ctx).length, 3);
    // kim's read-only follow went with the cancelled link
    assert.equal((await dashboard(kim))[0].needsPassword, true);
    assert.equal((await dashboard(kim))[0].slug, 'renamed-stash');
});

test('deleting or expiring a stash removes its follow rows (the users stay); the model delete paths work with foreign keys on', async () => {
    const ctx = await oneUser();
    await addUser(ctx, 'kim');
    const kim = await signIn(ctx, 'kim');
    const owner = await lockedStash(ctx, 'deleted-by-owner');
    await lockedStash(ctx, 'deleted-by-admin');
    await request(ctx.app).post('/api/stashes').send({ slug: 'will-expire-soon', ttl: '1h' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'stays-around-one' }).expect(201);
    for (const agent of [ctx.sam, kim]) {
        for (const slug of ['deleted-by-owner', 'deleted-by-admin']) await agent.post('/api/me/stashes').send({ slug, password: STASH_PASSWORD }).expect(200);
        await agent.post('/api/me/stashes').send({ slug: 'will-expire-soon' }).expect(200);
        await agent.post('/api/me/stashes').send({ slug: 'stays-around-one' }).expect(200);
    }
    assert.equal(followRows(ctx).length, 8);

    await owner.delete('/api/stashes/deleted-by-owner').expect(200);
    assert.equal(followRows(ctx).filter(r => r.stash_id === 1).length, 0);
    await ctx.root.delete('/api/admin/stashes/deleted-by-admin').expect(200);
    assert.equal(followRows(ctx).length, 4);
    advance(ctx, 2 * 60 * 60 * 1000);
    ctx.controller.cleanup();
    assert.equal(followRows(ctx).length, 2);
    assert.deepEqual((await dashboard(ctx.sam)).map(s => s.slug), ['stays-around-one']);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3); // (one more: the environment's admin account)
});

test('unfollowing takes the stash off the list only; deleting a user removes their follows and never a stash', async () => {
    const ctx = await oneUser();
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-stash-name' }).expect(201);
    await request(ctx.app).post('/api/stashes/open-stash-name/notes').send({ text: 'still here' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'open-stash-name' }).expect(200);
    assert.equal((await dashboard(ctx.sam)).length, 1);
    await ctx.sam.delete('/api/me/stashes/open-stash-name').expect(200);
    assert.deepEqual(await dashboard(ctx.sam), []);
    // Nothing to unfollow, or no such stash: still fine
    await ctx.sam.delete('/api/me/stashes/open-stash-name').expect(200);
    await ctx.sam.delete('/api/me/stashes/never-existed').expect(200);
    assert.equal((await request(ctx.app).get('/api/stashes/open-stash-name').expect(200)).body.items.length, 1);

    await ctx.sam.post('/api/me/stashes').send({ slug: 'open-stash-name' }).expect(200);
    await ctx.root.delete(`/api/admin/users/${ctx.user.id}`).expect(200);
    assert.equal(followRows(ctx).length, 0);
    assert.equal((await request(ctx.app).get('/api/stashes/open-stash-name').expect(200)).body.items.length, 1);
});

test('a disabled user, or a user signed out, loses the access their follows gave at once', async () => {
    const ctx = await oneUser();
    await lockedStash(ctx);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(200);
    await ctx.root.post(`/api/admin/users/${ctx.user.id}/sign-out`).expect(200);
    await ctx.sam.get('/api/stashes/locked-stash').expect(401);
    // Signing in again brings the follows back (they were never touched)
    const again = await signIn(ctx, 'sam');
    await again.get('/api/stashes/locked-stash').expect(200);
    await ctx.root.patch(`/api/admin/users/${ctx.user.id}`).send({ disabled: true }).expect(200);
    await again.get('/api/stashes/locked-stash').expect(401);
});

// ---- the dashboard ----

test('the dashboard shows counts, files, new items, latest activity and expiry, newest activity first', async () => {
    const ctx = await oneUser();
    await request(ctx.app).post('/api/stashes').send({ slug: 'quiet-stash-one', ttl: '7d' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'busy-stash-one', ttl: '1h' }).expect(201);
    await request(ctx.app).post('/api/stashes/quiet-stash-one/notes').send({ text: 'q1' }).expect(201);
    advance(ctx, 1000);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'quiet-stash-one' }).expect(200);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'busy-stash-one' }).expect(200);

    // Followed now: what was already there is not "new"
    let list = await dashboard(ctx.sam);
    assert.equal(list.find(s => s.slug === 'quiet-stash-one').items, 1);
    assert.equal(list.find(s => s.slug === 'quiet-stash-one').newItems, 0);

    advance(ctx, 5000);
    await request(ctx.app).post('/api/stashes/busy-stash-one/notes').send({ text: 'b1' }).expect(201);
    advance(ctx, 1000);
    await request(ctx.app).post('/api/stashes/busy-stash-one/notes').send({ text: 'b2' }).expect(201);
    await request(ctx.app).post('/api/stashes/busy-stash-one/files').set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);

    list = await dashboard(ctx.sam);
    assert.deepEqual(list.map(s => s.slug), ['busy-stash-one', 'quiet-stash-one']);
    const busy = list[0];
    assert.deepEqual(Object.keys(busy).sort(), ['addedAt', 'expiresAt', 'files', 'hasPassword', 'items', 'latestAt', 'needsPassword', 'newItems', 'owned', 'pinned', 'role', 'slug']);
    assert.equal(busy.items, 3);
    assert.equal(busy.files, 1);
    assert.equal(busy.newItems, 3);
    assert.equal(busy.role, 'full');
    assert.equal(busy.hasPassword, false);
    assert.equal(busy.latestAt, ctx.clock.time.toISOString());
    assert.equal(busy.expiresAt, ctx.model.findBySlug('busy-stash-one').expires_at);
    assert.equal(list[1].newItems, 0);
    assert.equal(list[1].latestAt, '2026-01-15T12:00:00.000Z');
    assertNoSecrets(list);
});

test('opening a stash marks it seen: the new count goes back to zero and counts only what arrives after', async () => {
    const ctx = await oneUser();
    await request(ctx.app).post('/api/stashes').send({ slug: 'watched-stash-1' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'watched-stash-1' }).expect(200);
    advance(ctx, 1000);
    await request(ctx.app).post('/api/stashes/watched-stash-1/notes').send({ text: 'n1' }).expect(201);
    advance(ctx, 1000);
    await request(ctx.app).post('/api/stashes/watched-stash-1/notes').send({ text: 'n2' }).expect(201);
    assert.equal((await dashboard(ctx.sam))[0].newItems, 2);
    // Merely reading the dashboard or the stash's listing changes nothing
    await ctx.sam.get('/api/stashes/watched-stash-1').expect(200);
    assert.equal((await dashboard(ctx.sam))[0].newItems, 2);

    advance(ctx, 1000);
    await ctx.sam.post('/api/me/stashes/watched-stash-1/seen').expect(200);
    assert.equal((await dashboard(ctx.sam))[0].newItems, 0);
    advance(ctx, 1000);
    await request(ctx.app).post('/api/stashes/watched-stash-1/notes').send({ text: 'n3' }).expect(201);
    const [row] = await dashboard(ctx.sam);
    assert.equal(row.newItems, 1);
    assert.equal(row.items, 3);
    // A stash that is not followed, or does not exist, is quietly ignored
    await ctx.sam.post('/api/me/stashes/nothing-here/seen').expect(200);
});

test('burn-after-reading and short-lived notes: burn notes count as items without their text; expired ones are not counted', async () => {
    const ctx = await oneUser();
    await request(ctx.app).post('/api/stashes').send({ slug: 'burn-stash-one' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'burn-stash-one' }).expect(200);
    advance(ctx, 1000);
    await request(ctx.app).post('/api/stashes/burn-stash-one/notes').set('Content-Type', 'text/plain').set('X-Burn-After-Read', '1').send('the burn text nobody may see').expect(201);
    await request(ctx.app).post('/api/stashes/burn-stash-one/notes').set('Content-Type', 'text/plain').set('X-Expires', '5m').send('short lived').expect(201);
    let list = await dashboard(ctx.sam);
    assert.equal(list[0].items, 2);
    assert.equal(list[0].newItems, 2);
    assert.ok(!JSON.stringify(list).includes('the burn text'));
    advance(ctx, 6 * 60 * 1000);
    list = await dashboard(ctx.sam);
    assert.equal(list[0].items, 1);
    assert.equal(list[0].newItems, 1);
    // The burn note is still unread on the server
    assert.equal(ctx.model.listItems(ctx.model.findBySlug('burn-stash-one').id, { now: ctx.clock.time }).length, 1);
});

test('each user sees only their own follows, and a stash that has expired drops off the list', async () => {
    const ctx = await oneUser();
    await addUser(ctx, 'kim');
    const kim = await signIn(ctx, 'kim');
    await request(ctx.app).post('/api/stashes').send({ slug: 'sams-only-stash' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'kims-only-stash', ttl: '1h' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'sams-only-stash' }).expect(200);
    await kim.post('/api/me/stashes').send({ slug: 'kims-only-stash' }).expect(200);
    assert.deepEqual((await dashboard(ctx.sam)).map(s => s.slug), ['sams-only-stash']);
    assert.deepEqual((await dashboard(kim)).map(s => s.slug), ['kims-only-stash']);
    advance(ctx, 2 * 60 * 60 * 1000);
    // Not yet purged by the cleanup job, but already gone from the list
    assert.deepEqual(await dashboard(kim), []);
    // The admin's user list counts follows
    const row = (await ctx.root.get('/api/admin/users')).body.users.find(u => u.username === 'sam');
    assert.equal(row.stashCount, 1);
});

test('a grant that no longer works shows nothing about the stash: no counts, times or access in the dashboard', async () => {
    const ctx = await oneUser();
    const owner = await lockedStash(ctx);
    await owner.post('/api/stashes/locked-stash/notes').send({ text: 'private contents' }).expect(201);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
    assert.equal((await dashboard(ctx.sam))[0].items, 1);
    await owner.post('/api/stashes/locked-stash/sign-out-others').expect(200);
    const res = await ctx.sam.get('/api/me/stashes').expect(200);
    const text = JSON.stringify(res.body);
    assert.deepEqual(Object.keys(res.body.stashes[0]).sort(), ['addedAt', 'needsPassword', 'owned', 'pinned', 'role', 'slug']);
    assert.ok(!/items|files|latestAt|expiresAt|hasPassword|newItems|private contents/.test(text));
});

// ---- live stream ----

function listen(server, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const events = [];
        let buffer = '';
        const req = http.get({ port: server.address().port, path, headers }, res => {
            const stream = {
                status: res.statusCode,
                events,
                ended: new Promise(done => res.on('end', done)),
                close: () => req.destroy(),
                waitFor: (count, ms = 3000) =>
                    new Promise((ok, fail) => {
                        const started = Date.now();
                        const timer = setInterval(() => {
                            if (events.length >= count) { clearInterval(timer); ok(events); }
                            else if (Date.now() - started > ms) { clearInterval(timer); fail(new Error(`Only ${events.length} of ${count} events arrived`)); }
                        }, 10);
                    }),
            };
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buffer += chunk;
                let index;
                while ((index = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const event = /^event: (.+)$/m.exec(frame);
                    if (event && event[1] !== 'presence') events.push(event[1]);
                }
            });
            resolve(stream);
        });
        req.on('error', err => (err.code === 'ECONNRESET' ? null : reject(err)));
    });
}

async function userCookie(ctx, username = 'sam') {
    const login = await request(ctx.app).post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
    return login.headers['set-cookie'][0].split(';')[0];
}

async function withServer(ctx, fn) {
    const server = ctx.app.listen(0);
    try { await fn(server); } finally { server.closeAllConnections(); server.close(); }
}

test('a live stream opened through a follow is ended when the user is disabled or signed out', async () => {
    for (const end of [
        ctx => ctx.root.patch(`/api/admin/users/${ctx.user.id}`).send({ disabled: true }),
        ctx => ctx.root.post(`/api/admin/users/${ctx.user.id}/sign-out`),
        ctx => ctx.root.delete(`/api/admin/users/${ctx.user.id}`),
    ]) {
        const ctx = await oneUser();
        ctx.events.heartbeatMs = 30;
        await lockedStash(ctx);
        await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', password: STASH_PASSWORD }).expect(200);
        const cookie = await userCookie(ctx);
        await withServer(ctx, async server => {
            const stream = await listen(server, '/api/stashes/locked-stash/events', { Cookie: cookie });
            assert.equal(stream.status, 200);
            // Still allowed: a heartbeat passes without ending it
            await new Promise(r => setTimeout(r, 100));
            assert.equal(stream.events.length, 0);
            await end(ctx).expect(200);
            await stream.waitFor(1);
            assert.equal(stream.events[0], 'access-changed');
            await stream.ended;
        });
    }
});

test('a live stream opened through a follow is ended when the grant stops matching, and a read-only follow may stream', async () => {
    const ctx = await oneUser();
    ctx.events.heartbeatMs = 30;
    const owner = await lockedStash(ctx);
    const view = (await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    await ctx.sam.post('/api/me/stashes').send({ slug: 'locked-stash', link: view.token }).expect(200);
    const cookie = await userCookie(ctx);
    await withServer(ctx, async server => {
        const stream = await listen(server, '/api/stashes/locked-stash/events', { Cookie: cookie });
        assert.equal(stream.status, 200);
        await request(ctx.app).post('/api/stashes/locked-stash/notes').set('Cookie', (await request(ctx.app).post('/api/stashes/locked-stash/unlock').send({ password: STASH_PASSWORD })).headers['set-cookie'][0].split(';')[0]).send({ text: 'live note' }).expect(201);
        await stream.waitFor(1);
        assert.equal(stream.events[0], 'item-added');
        // The owner makes a new link: the old one, and so the follow, stops working
        await owner.post('/api/stashes/locked-stash/share-links').send({ kind: 'view' }).expect(201);
        await stream.waitFor(2);
        assert.equal(stream.events[1], 'access-changed');
        await stream.ended;
    });
    // Without a follow or cookie there is no stream at all
    await request(ctx.app).get('/api/stashes/locked-stash/events').expect(401);
});
