// Settings that used to be set only in the environment and can now be changed in Admin > Settings, with no restart
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const ADMIN = 'admin-pass-123';

async function adminApp(overrides = {}) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    return { ...ctx, admin };
}

const save = (ctx, values) => ctx.admin.put('/api/admin/settings').send({ values });
const fieldOf = async (ctx, key) => (await ctx.admin.get('/api/admin/settings').expect(200)).body.fields.find(f => f.key === key);

test('the new settings are on the page with their environment values as the starting point', async () => {
    const ctx = await adminApp({ rateCreate: 7, userSessionDays: 3, stashUnlockFailures: 4, stashUnlockWindowMs: 5 * 60 * 1000, rateUserLogin: 6, rateAdminLogin: 6 });
    assert.equal((await fieldOf(ctx, 'rateCreate')).value, 7);
    assert.equal((await fieldOf(ctx, 'userSessionDays')).value, 3);
    assert.equal((await fieldOf(ctx, 'stashUnlockFailures')).value, 4);
    assert.equal((await fieldOf(ctx, 'stashUnlockWindowMin')).value, 5);
    assert.equal((await fieldOf(ctx, 'signInAttempts')).value, 6);
    // and each is told what it is for
    for (const key of ['rateCreate', 'ratePost', 'rateUpload', 'rateRead', 'userSessionDays', 'signInAttempts', 'stashUnlockFailures', 'stashUnlockWindowMin', 'defaultTtl']) {
        const field = await fieldOf(ctx, key);
        assert.ok(field.label && field.help, key);
    }
});

test('values are checked: whole numbers in range, and the default expiry must be on the list', async () => {
    const ctx = await adminApp();
    for (const [key, bad] of [['rateCreate', 0], ['rateRead', 5], ['userSessionDays', 91], ['signInAttempts', 0], ['stashUnlockWindowMin', 0], ['stashUnlockFailures', -1]]) {
        const res = await save(ctx, { [key]: bad }).expect(400);
        assert.ok(res.body.errors[key], key);
    }
    assert.ok((await save(ctx, { rateCreate: 1.5 }).expect(400)).body.errors.rateCreate);
    assert.ok((await save(ctx, { defaultTtl: 'a fortnight' }).expect(400)).body.errors.defaultTtl);
    // "Never" is not a choice until stashes that never expire are allowed
    assert.ok((await save(ctx, { defaultTtl: 'never' }).expect(400)).body.errors.defaultTtl);
});

test('the creation rate limit follows the setting at once', async () => {
    const ctx = await adminApp();
    // the test app starts with generous limits; make it tight, then loose again, without restarting anything
    await save(ctx, { rateCreate: 2 }).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'one-stash-name' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'two-stash-name' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'three-stash-name' }).expect(429);
    await save(ctx, { rateCreate: 1000 }).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'four-stash-name' }).expect(201);
});

test('the note and read limits follow the setting at once', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'busy-stash-name' }).expect(201);
    await save(ctx, { ratePost: 1 }).expect(200);
    await request(ctx.app).post('/api/stashes/busy-stash-name/notes').send({ text: 'one' }).expect(201);
    await request(ctx.app).post('/api/stashes/busy-stash-name/notes').send({ text: 'two' }).expect(429);
    await save(ctx, { ratePost: 1000 }).expect(200);
    await request(ctx.app).post('/api/stashes/busy-stash-name/notes').send({ text: 'three' }).expect(201);

    await save(ctx, { rateRead: 10 }).expect(200);
    for (let i = 0; i < 10; i++) await request(ctx.app).get('/api/stashes/busy-stash-name').expect(200);
    await request(ctx.app).get('/api/stashes/busy-stash-name').expect(429);
});

test('the stash lockout follows the settings at once: attempts before it, and how long it lasts', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked-stash-name', password: 'a long stash password' }).expect(201);
    await save(ctx, { stashUnlockFailures: 2, stashUnlockWindowMin: 10 }).expect(200);
    const wrong = () => request(ctx.app).post('/api/stashes/locked-stash-name/unlock').send({ password: 'not it at all' });
    await wrong().expect(401);
    await wrong().expect(401);
    const locked = await wrong().expect(429);
    assert.ok(locked.body.retryAfterSeconds === undefined || locked.body.retryAfterSeconds <= 600);
    // the right password is refused while it lasts, and works after the wait
    await request(ctx.app).post('/api/stashes/locked-stash-name/unlock').send({ password: 'a long stash password' }).expect(429);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 11 * 60 * 1000);
    await request(ctx.app).post('/api/stashes/locked-stash-name/unlock').send({ password: 'a long stash password' }).expect(200);
});

test('the account sign-in length and the sign-in attempts follow the settings', async () => {
    const ctx = await adminApp();
    await ctx.admin.post('/api/admin/users').send({ username: 'sam', password: 'correct horse battery', role: 'user' }).expect(201);
    await save(ctx, { userSessionDays: 2, signInAttempts: 2 }).expect(200);
    assert.equal(ctx.config.userSessionDays, 2);
    assert.equal(ctx.config.rateUserLogin, 2);
    assert.equal(ctx.config.rateAdminLogin, 2);

    const wrong = () => request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'wrong wrong wrong' });
    await wrong().expect(401);
    await wrong().expect(401);
    await wrong().expect(429);
    // raising the setting lets the address try again at once (the limiter counts in real time, so the test cannot wait it out)
    await save(ctx, { signInAttempts: 1000 }).expect(200);
    // typing it right works, and the cookie lasts the number of days chosen
    const ok = await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'correct horse battery' }).expect(200);
    const cookie = [].concat(ok.headers['set-cookie']).join(';');
    assert.match(cookie, /Max-Age=172800/);
});

test('the default expiry is a choice that follows the expiry list, and falls back when "Never" goes away', async () => {
    const ctx = await adminApp();
    assert.equal((await fieldOf(ctx, 'defaultTtl')).value, '1d');
    const keys = (await fieldOf(ctx, 'defaultTtl')).options.map(o => o.value);
    assert.deepEqual(keys, ['1h', '8h', '1d', '7d', '30d']);

    await save(ctx, { defaultTtl: '7d' }).expect(200);
    assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.defaultTtl, '7d');
    // a stash made with no expiry chosen gets the default
    const made = await request(ctx.app).post('/api/stashes').send({ slug: 'default-expiry-stash' }).expect(201);
    const days = (new Date(made.body.expiresAt) - new Date(made.body.createdAt)) / 86400000;
    assert.equal(days, 7);

    // "Never" can be the default once it is allowed, in the same save
    await save(ctx, { allowNoExpiry: true, defaultTtl: 'never' }).expect(200);
    assert.equal((await fieldOf(ctx, 'defaultTtl')).value, 'never');
    assert.ok((await fieldOf(ctx, 'defaultTtl')).options.some(o => o.value === 'never'));
    // and when "Never" stops being allowed, the default goes back to a day instead of pointing at nothing
    await save(ctx, { allowNoExpiry: false }).expect(200);
    assert.equal((await fieldOf(ctx, 'defaultTtl')).value, '1d');
});

test('the new settings are saved, come back after a restart, and "Reset to defaults" puts the environment values back', async () => {
    const ctx = await adminApp({ rateCreate: 20 });
    await save(ctx, { rateCreate: 5, defaultTtl: '8h', stashUnlockFailures: 3, userSessionDays: 14, rateRead: 900 }).expect(200);

    // a new server on the same database: the saved values win over the environment
    const again = makeApp({ adminPassword: ADMIN, rateCreate: 20 }, { db: ctx.db });
    assert.equal(again.config.rateCreate, 5);
    assert.equal(again.config.defaultTtl, '8h');
    assert.equal(again.config.stashUnlockFailures, 3);
    assert.equal(again.config.userSessionDays, 14);
    assert.equal(again.config.rateRead, 900);

    await ctx.admin.post('/api/admin/settings/reset').expect(200);
    assert.equal(ctx.config.rateCreate, 20);
    assert.equal(ctx.config.defaultTtl, '1d');
    assert.equal(ctx.config.userSessionDays, 7);
});
