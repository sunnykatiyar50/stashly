const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { connect } = require('../src/database/sqlite');
const { parseCookies } = require('../src/utils/token');

const DAY = 24 * 60 * 60 * 1000;

// ---- secure delete ----

test('the database overwrites deleted content', () => {
    const db = connect(':memory:');
    assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
});

test('a burned note leaves no trace of its text in the database file or its log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-'));
    const file = path.join(dir, 'test.sqlite');
    const db = connect(file);
    try {
        const ctx = makeApp({}, { db });
        const secret = 'TOKEN-' + 'x9Q2'.repeat(40);
        await request(ctx.app).post('/api/stashes').send({ slug: 'burner' }).expect(201);
        const note = await request(ctx.app).post('/api/stashes/burner/notes').send({ text: secret, burn: true }).expect(201);
        await request(ctx.app).post(`/api/stashes/burner/items/${note.body.id}/reveal`).expect(200);
        for (const name of fs.readdirSync(dir)) {
            const bytes = fs.readFileSync(path.join(dir, name));
            assert.equal(bytes.includes(Buffer.from(secret)), false, `${name} still holds the burned text`);
        }
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---- password length ----

test('a new stash password must be at least the configured length', async () => {
    const { app } = makeApp({ minPasswordLength: 10 });
    const short = await request(app).post('/api/stashes').send({ slug: 'short-pw', password: 'nine-char' }).expect(400);
    assert.equal(short.body.field, 'password');
    assert.match(short.body.error, /10/);
    await request(app).post('/api/stashes').send({ slug: 'long-pw', password: 'ten-chars!' }).expect(201);
    const config = await request(app).get('/api/config').expect(200);
    assert.equal(config.body.minPasswordLength, 10);
});

test('changing a password applies the minimum, but an existing short password still unlocks', async () => {
    const ctx = makeApp({ minPasswordLength: 4 });
    const agent = request.agent(ctx.app);
    await agent.post('/api/stashes').send({ slug: 'legacy', password: 'abcd' }).expect(201);
    ctx.config.minPasswordLength = 12;
    await request(ctx.app).post('/api/stashes/legacy/unlock').send({ password: 'abcd' }).expect(200);
    const res = await agent.post('/api/stashes/legacy/password').send({ currentPassword: 'abcd', newPassword: 'eleven-char' }).expect(400);
    assert.equal(res.body.field, 'newPassword');
    await agent.post('/api/stashes/legacy/password').send({ currentPassword: 'abcd', newPassword: 'twelve-chars' }).expect(200);
});

// ---- reserved names ----

test('the name of a deleted stash cannot be taken again while it is reserved', async () => {
    const ctx = makeApp({ reserveOldNamesDays: 30 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'team-tokens' }).expect(201);
    await request(ctx.app).delete('/api/stashes/team-tokens').expect(200);
    const res = await request(ctx.app).post('/api/stashes').send({ slug: 'team-tokens' }).expect(409);
    assert.equal(res.body.field, 'slug');
    assert.match(res.body.error, /reserved/);

    // Once the reservation has passed (and the cleanup has run), the name is free again
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 31 * DAY);
    ctx.controller.cleanup();
    await request(ctx.app).post('/api/stashes').send({ slug: 'team-tokens' }).expect(201);
});

test('an expired stash keeps its name reserved', async () => {
    const ctx = makeApp({ reserveOldNamesDays: 30 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'short-lived', ttl: '1h' }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * 60 * 60 * 1000);
    ctx.controller.cleanup();
    await request(ctx.app).post('/api/stashes').send({ slug: 'short-lived' }).expect(409);
});

test('an expired stash found on opening also keeps its name reserved', async () => {
    const ctx = makeApp({ reserveOldNamesDays: 30 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'opened-late', ttl: '1h' }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * 60 * 60 * 1000);
    await request(ctx.app).get('/api/stashes/opened-late').expect(404);
    await request(ctx.app).post('/api/stashes').send({ slug: 'opened-late' }).expect(409);
});

test('the old name of a renamed stash is reserved, for new stashes and renames alike', async () => {
    const ctx = makeApp({ reserveOldNamesDays: 30 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'old-name' }).expect(201);
    await request(ctx.app).post('/api/stashes/old-name/rename').send({ slug: 'new-name' }).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'old-name' }).expect(409);
    await request(ctx.app).post('/api/stashes').send({ slug: 'another' }).expect(201);
    await request(ctx.app).post('/api/stashes/another/rename').send({ slug: 'old-name' }).expect(409);
});

test('an admin delete reserves the name too, and 0 turns reservation off', async () => {
    const ctx = makeApp({ reserveOldNamesDays: 0 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'reusable' }).expect(201);
    await request(ctx.app).delete('/api/stashes/reusable').expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'reusable' }).expect(201);
    assert.equal(ctx.model.isRetired('reusable', new Date(0)), true);
});

// ---- share target ----

test('a POST from the share sheet is handed to the page in the fragment, not the address', async () => {
    const { app } = makeApp();
    const res = await request(app)
        .post('/share')
        .type('form')
        .send({ title: 'Key', text: 'sk-secret value', url: 'https://example.com/x' })
        .expect(303);
    const location = res.headers.location;
    assert.ok(location.startsWith('/share#'), location);
    const params = new URLSearchParams(location.slice('/share#'.length));
    assert.equal(params.get('title'), 'Key');
    assert.equal(params.get('text'), 'sk-secret value');
    assert.equal(params.get('url'), 'https://example.com/x');
    await request(app).post('/share').type('form').send({}).expect(303).expect('Location', '/share');
});

// ---- cookies ----

test('a malformed cookie from another app does not break requests', async () => {
    assert.deepEqual(parseCookies('bad=%E0%A4%A; good=ok'), { bad: '%E0%A4%A', good: 'ok' });
    const { app } = makeApp();
    await request(app).post('/api/stashes').send({ slug: 'cookies' }).expect(201);
    await request(app).get('/api/stashes/cookies').set('Cookie', 'other=%zz').expect(200);
});

// ---- search stays out of the address ----

test('the stash can be searched with the words in the body', async () => {
    const { app } = makeApp();
    await request(app).post('/api/stashes').send({ slug: 'searchable' }).expect(201);
    await request(app).post('/api/stashes/searchable/notes').send({ text: 'the deploy token is here' }).expect(201);
    await request(app).post('/api/stashes/searchable/notes').send({ text: 'shopping list' }).expect(201);
    const found = await request(app).post('/api/stashes/searchable/query').send({ search: 'deploy', tz: '0' }).expect(200);
    assert.deepEqual(found.body.items.map(item => item.text), ['the deploy token is here']);
    const all = await request(app).post('/api/stashes/searchable/query').send({}).expect(200);
    assert.equal(all.body.items.length, 2);
    await request(app).post('/api/stashes/searchable/query').send({ startDate: 'nope' }).expect(400);
    // Scripts using the address still work
    const viaGet = await request(app).get('/api/stashes/searchable?search=shopping').expect(200);
    assert.equal(viaGet.body.items.length, 1);
});

test('searching a locked stash needs the password, and a drop-box link sees nothing', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'locked-search', password: 'long-enough-pw' }).expect(201);
    await owner.post('/api/stashes/locked-search/notes').send({ text: 'secret thing' }).expect(201);
    await request(ctx.app).post('/api/stashes/locked-search/query').send({ search: 'secret' }).expect(401);
    const link = await owner.post('/api/stashes/locked-search/share-links').send({ kind: 'drop' }).expect(201);
    const dropper = request.agent(ctx.app);
    await dropper.post('/api/stashes/locked-search/redeem').send({ token: link.body.token }).expect(200);
    const res = await dropper.post('/api/stashes/locked-search/query').send({ search: 'secret' }).expect(200);
    assert.deepEqual(res.body.items, []);
});

// ---- signing out other devices ----

const VAULT_PW = 'correct horse battery';

async function vault(ctx, slug = 'vault-x', extra = {}) {
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug, password: VAULT_PW, ttl: '30d', ...extra }).expect(201);
    return { owner, base: `/api/stashes/${slug}` };
}

test('"sign out other devices" ends every other sign-in and keeps this one', async () => {
    const ctx = makeApp();
    const { owner, base } = await vault(ctx);
    const laptop = request.agent(ctx.app);
    await laptop.post(`${base}/unlock`).send({ password: VAULT_PW }).expect(200);
    const link = await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201);
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: link.body.token }).expect(200);
    await laptop.get(base).expect(200);
    await viewer.get(base).expect(200);

    const res = await owner.post(`${base}/sign-out-others`).expect(200);
    assert.ok(res.body.sessionEndsAt);
    await owner.get(base).expect(200);
    await laptop.get(base).expect(401);
    await viewer.get(base).expect(401);

    // The password, and the share link itself, still work for a new sign-in
    await laptop.post(`${base}/unlock`).send({ password: VAULT_PW }).expect(200);
    await laptop.get(base).expect(200);
    await viewer.post(`${base}/redeem`).send({ token: link.body.token }).expect(200);
    await viewer.get(base).expect(200);
});

test('only full access can sign the others out, and a stash without a password has nobody to sign out', async () => {
    const ctx = makeApp();
    const { owner, base } = await vault(ctx);
    const link = await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201);
    const viewer = request.agent(ctx.app);
    await viewer.post(`${base}/redeem`).send({ token: link.body.token }).expect(200);
    await viewer.post(`${base}/sign-out-others`).expect(403);
    await request(ctx.app).post(`${base}/sign-out-others`).expect(401);
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-stash' }).expect(201);
    await request(ctx.app).post('/api/stashes/open-stash/sign-out-others').expect(400);
});

test('a copied cookie stays dead after the others are signed out', async () => {
    const ctx = makeApp();
    const { owner, base } = await vault(ctx);
    const unlocked = await request(ctx.app).post(`${base}/unlock`).send({ password: VAULT_PW }).expect(200);
    const copied = unlocked.headers['set-cookie'][0].split(';')[0];
    await request(ctx.app).get(base).set('Cookie', copied).expect(200);
    await owner.post(`${base}/sign-out-others`).expect(200);
    await owner.post(`${base}/sign-out-others`).expect(200);
    await request(ctx.app).get(base).set('Cookie', copied).expect(401);
    await owner.get(base).expect(200);
});

// ---- a sign-in cannot be stretched forever ----

test('changing the session cannot keep a sign-in going past 30 days from when it started', async () => {
    const ttlOptions = [...require('../src/config').loadConfig({}).ttlOptions, { key: 'never', label: 'Never', ms: null }];
    const ctx = makeApp({ allowNoExpiry: true, ttlOptions });
    const { owner, base } = await vault(ctx, 'forever', { ttl: 'never' });
    // Sign in for 30 days; 29 days later, ask for 30 more
    await owner.post(`${base}/unlock`).send({ password: VAULT_PW, session: '30d' }).expect(200);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 29 * DAY);
    const res = await owner.post(`${base}/session`).send({ session: '30d' }).expect(200);
    assert.equal(res.body.capped, true);
    assert.equal(new Date(res.body.sessionEndsAt).getTime(), ctx.clock.time.getTime() + DAY);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + DAY + 1000);
    await owner.get(base).expect(401);
    // Unlocking again starts a new 30 days
    await owner.post(`${base}/unlock`).send({ password: VAULT_PW, session: '30d' }).expect(200);
    await owner.get(base).expect(200);
});

test('a session can still be shortened, and an ordinary change is not reported as capped', async () => {
    const ctx = makeApp();
    const { owner, base } = await vault(ctx);
    const res = await owner.post(`${base}/session`).send({ session: '2h' }).expect(200);
    assert.equal(res.body.capped, false);
    assert.equal(new Date(res.body.sessionEndsAt).getTime(), ctx.clock.time.getTime() + 2 * 60 * 60 * 1000);
});

test('a sign-in cookie in the older format (no sign-in time) keeps working, and a forged time is refused', async () => {
    const { signToken } = require('../src/utils/token');
    const ctx = makeApp();
    await vault(ctx, 'legacy-cookie');
    const stash = ctx.model.findBySlug('legacy-cookie');
    const old = signToken('test-secret', stash.slug, stash.password_salt, ctx.clock.time.getTime() + DAY);
    assert.equal(old.split('.').length, 2);
    await request(ctx.app).get('/api/stashes/legacy-cookie').set('Cookie', `stashly_legacy-cookie=${old}`).expect(200);
    // Changing the sign-in time (to dodge the 30-day limit) breaks the signature
    const fresh = signToken('test-secret', stash.slug, stash.password_salt, ctx.clock.time.getTime() + DAY, ctx.clock.time.getTime());
    const [expiry, , mac] = fresh.split('.');
    await request(ctx.app).get('/api/stashes/legacy-cookie').set('Cookie', `stashly_legacy-cookie=${fresh}`).expect(200);
    await request(ctx.app).get('/api/stashes/legacy-cookie').set('Cookie', `stashly_legacy-cookie=${expiry}.${ctx.clock.time.getTime() + DAY}.${mac}`).expect(401);
});
