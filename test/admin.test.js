const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

const PASSWORD = 'admin-pass-123';

// An app with admin on, and an agent already signed in
async function adminApp(overrides = {}) {
    const ctx = makeApp({ adminPassword: PASSWORD, ...overrides });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: PASSWORD }).expect(200);
    return { ...ctx, admin };
}

test('admin is off unless ADMIN_PASSWORD is set', async () => {
    const ctx = makeApp();
    const status = await request(ctx.app).get('/api/admin/status').expect(200);
    assert.deepEqual(status.body, { enabled: false, signedIn: false });
    await request(ctx.app).post('/api/admin/login').send({ password: 'anything' }).expect(404);
    await request(ctx.app).get('/api/admin/overview').expect(404);
    await request(ctx.app).get('/api/admin/settings').expect(404);
});

test('the right password signs in, a wrong one does not', async () => {
    const ctx = makeApp({ adminPassword: PASSWORD });
    const agent = request.agent(ctx.app);
    await agent.post('/api/admin/login').send({ password: 'nope' }).expect(401);
    await agent.post('/api/admin/login').send({}).expect(401);
    assert.equal((await agent.get('/api/admin/status')).body.signedIn, false);

    const ok = await agent.post('/api/admin/login').send({ password: PASSWORD }).expect(200);
    const cookie = ok.headers['set-cookie'].join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.equal((await agent.get('/api/admin/status')).body.signedIn, true);

    await agent.post('/api/admin/logout').expect(200);
    assert.equal((await agent.get('/api/admin/status')).body.signedIn, false);
});

test('every admin endpoint needs the session', async () => {
    const ctx = makeApp({ adminPassword: PASSWORD });
    await request(ctx.app).get('/api/admin/overview').expect(401);
    await request(ctx.app).get('/api/admin/settings').expect(401);
    await request(ctx.app).put('/api/admin/settings').send({ values: { maxFileMb: 1 } }).expect(401);
    await request(ctx.app).post('/api/admin/settings/reset').expect(401);
    await request(ctx.app).delete('/api/admin/stashes/anything').expect(401);
    await request(ctx.app).post('/api/admin/stashes/anything/extend').expect(401);
});

test('a forged or expired admin cookie is refused, and a new password signs everyone out', async () => {
    const ctx = makeApp({ adminPassword: PASSWORD });
    const exp = ctx.clock.time.getTime() + 60000;
    await request(ctx.app).get('/api/admin/overview').set('Cookie', `stashly_admin=${exp}.${'0'.repeat(64)}`).expect(401);

    const agent = request.agent(ctx.app);
    await agent.post('/api/admin/login').send({ password: PASSWORD }).expect(200);
    await agent.get('/api/admin/overview').expect(200);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 13 * 60 * 60 * 1000);
    await agent.get('/api/admin/overview').expect(401);

    // Same cookie against an app whose ADMIN_PASSWORD changed
    const first = makeApp({ adminPassword: 'first-password' });
    const login = await request(first.app).post('/api/admin/login').send({ password: 'first-password' }).expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    await request(first.app).get('/api/admin/overview').set('Cookie', cookie).expect(200);
    first.config.adminPassword = 'second-password';
    await request(first.app).get('/api/admin/overview').set('Cookie', cookie).expect(401);
});

test('wrong admin passwords are rate limited, right ones are not', async () => {
    const ctx = makeApp({ adminPassword: PASSWORD, rateAdminLogin: 3 });
    for (let i = 0; i < 3; i++) await request(ctx.app).post('/api/admin/login').send({ password: 'nope' }).expect(401);
    await request(ctx.app).post('/api/admin/login').send({ password: 'nope' }).expect(429);

    const fine = makeApp({ adminPassword: PASSWORD, rateAdminLogin: 3 });
    for (let i = 0; i < 6; i++) await request(fine.app).post('/api/admin/login').send({ password: PASSWORD }).expect(200);
});

test('the overview lists every stash with its size, but never its contents', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'plain-one', ttl: '1h' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked-one', password: 'hunter22', ttl: '7d' }).expect(201);
    await request(ctx.app).post('/api/stashes/plain-one/notes').send({ text: 'top secret words' }).expect(201);
    await request(ctx.app)
        .post('/api/stashes/plain-one/files')
        .set('X-File-Name', 'a.png')
        .set('Content-Type', 'application/octet-stream')
        .send(PNG)
        .expect(201);

    const res = await ctx.admin.get('/api/admin/overview').expect(200);
    assert.equal(res.body.totals.stashes, 2);
    assert.equal(res.body.totals.items, 2);
    assert.equal(res.body.totals.files, 1);
    assert.equal(res.body.totals.bytes, PNG.length);
    const plain = res.body.stashes.find(s => s.slug === 'plain-one');
    assert.deepEqual(
        { items: plain.items, files: plain.files, bytes: plain.bytes, hasPassword: plain.hasPassword },
        { items: 2, files: 1, bytes: PNG.length, hasPassword: false }
    );
    assert.equal(res.body.stashes.find(s => s.slug === 'locked-one').hasPassword, true);
    assert.ok(!JSON.stringify(res.body).includes('top secret words'));
    assert.ok(!JSON.stringify(res.body).includes('hunter22'));
});

test('the overview can be searched by name', async () => {
    const ctx = await adminApp();
    for (const slug of ['alpha-team', 'beta-team', 'solo_one']) await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    const names = async q => (await ctx.admin.get('/api/admin/overview').query({ search: q }).expect(200)).body.stashes.map(s => s.slug).sort();
    assert.deepEqual(await names('team'), ['alpha-team', 'beta-team']);
    assert.deepEqual(await names('ALPHA'), ['alpha-team']);
    assert.deepEqual(await names('o_o'), ['solo_one']);
    assert.deepEqual(await names('zzz'), []);
});

test('the admin session does not unlock a password-protected stash', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'private-one', password: 'hunter22' }).expect(201);
    await ctx.admin.get('/api/stashes/private-one').expect(401);
});

test('the admin can delete and extend a stash', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'to-extend', ttl: '1h' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'to-delete' }).expect(201);
    await request(ctx.app).post('/api/stashes/to-delete/notes').send({ text: 'bye' }).expect(201);

    ctx.clock.time = new Date(ctx.clock.time.getTime() + 50 * 60 * 1000);
    const res = await ctx.admin.post('/api/admin/stashes/to-extend/extend').expect(200);
    assert.equal(res.body.expiresAt, new Date(ctx.clock.time.getTime() + 60 * 60 * 1000).toISOString());

    await ctx.admin.delete('/api/admin/stashes/to-delete').expect(200);
    await ctx.admin.delete('/api/admin/stashes/to-delete').expect(404);
    await request(ctx.app).get('/api/stashes/to-delete').expect(404);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
});

test('the settings page lists every limit with its value and default', async () => {
    const ctx = await adminApp();
    const res = await ctx.admin.get('/api/admin/settings').expect(200);
    const byKey = Object.fromEntries(res.body.fields.map(f => [f.key, f]));
    assert.equal(byKey.maxFileMb.value, 25);
    assert.equal(byKey.maxFileMb.default, 25);
    assert.equal(byKey.maxFilesPerStash.value, 500);
    assert.equal(byKey.maxItemsPerStash.value, 1000);
    assert.equal(byKey.maxStashMb.value, 100);
    assert.equal(byKey.requireAdminToCreate.type, 'bool');
    assert.ok(byKey.maxFileMb.label && byKey.maxFileMb.unit && byKey.maxFileMb.help);
});

test('every setting names the tab it is shown under', async () => {
    const ctx = await adminApp();
    const res = await ctx.admin.get('/api/admin/settings').expect(200);
    for (const field of res.body.fields) assert.ok(field.group, `${field.key} has no group`);
    const byKey = Object.fromEntries(res.body.fields.map(f => [f.key, f.group]));
    assert.equal(byKey.maxFileMb, 'Limits');
    assert.equal(byKey.maxStashes, 'Limits');
    assert.equal(byKey.minOpenNameLength, 'Security');
    assert.equal(byKey.minPasswordLength, 'Security');
    assert.equal(byKey.reserveOldNamesDays, 'Security');
    assert.equal(byKey.fileTypes, 'Files');
    assert.equal(byKey.allowNoExpiry, 'Stashes');
    assert.equal(byKey.requireAdminToCreate, 'Stashes');
    assert.equal(byKey.defaultTtl, 'Stashes');
    for (const key of ['userSessionDays', 'signInAttempts', 'stashUnlockFailures', 'stashUnlockWindowMin']) assert.equal(byKey[key], 'Security', key);
    for (const key of ['rateCreate', 'ratePost', 'rateUpload', 'rateRead']) assert.equal(byKey[key], 'Rate limits', key);
    // Tabs follow the order the groups first appear in
    const order = [...new Set(res.body.fields.map(f => f.group))];
    assert.deepEqual(order, ['Limits', 'Security', 'Files', 'Stashes', 'Rate limits', 'Email']);
});

test('changed limits apply at once, with no restart', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'live-limits' }).expect(201);
    const upload = size =>
        request(ctx.app)
            .post('/api/stashes/live-limits/files')
            .set('X-File-Name', 'a.png')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.concat([PNG, Buffer.alloc(size)]));

    await upload(1.5 * 1024 * 1024).expect(201);
    await ctx.admin.put('/api/admin/settings').send({ values: { maxFileMb: 1 } }).expect(200);
    // An oversized upload is refused from its Content-Length before the body is read (checkUploadSize), so
    // the server can close the socket while a large body is still being sent. The client then sees either
    // the 413 or ECONNRESET; both mean "refused". Anything else (a 201, say) fails the test.
    const refused = await upload(1.5 * 1024 * 1024).then(
        res => res.status,
        err => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? 413 : Promise.reject(err))
    );
    assert.equal(refused, 413);
    await ctx.admin.put('/api/admin/settings').send({ values: { maxFileMb: 5 } }).expect(200);
    await upload(1.5 * 1024 * 1024).expect(201);

    await ctx.admin.put('/api/admin/settings').send({ values: { maxFilesPerStash: 2 } }).expect(200);
    await upload(10).expect(413);
    const config = await request(ctx.app).get('/api/config').expect(200);
    assert.equal(config.body.limits.maxFilesPerStash, 2);
    assert.equal(config.body.limits.maxFileBytes, 5 * 1024 * 1024);
});

test('note size and the stash count follow the settings too', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'notes-limit' }).expect(201);
    await ctx.admin.put('/api/admin/settings').send({ values: { maxNoteKb: 1, maxStashes: 2 } }).expect(200);
    await request(ctx.app).post('/api/stashes/notes-limit/notes').send({ text: 'x'.repeat(1025) }).expect(413);
    await request(ctx.app).post('/api/stashes/notes-limit/notes').send({ text: 'x'.repeat(1024) }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'second-one' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'third-one' }).expect(503);
});

test('bad settings are refused, and nothing is applied', async () => {
    const ctx = await adminApp();
    const put = values => ctx.admin.put('/api/admin/settings').send({ values });
    for (const values of [
        { maxFileMb: 0 },
        { maxFileMb: -3 },
        { maxFileMb: 1.5 },
        { maxFileMb: '10' },
        { maxFileMb: 999999 },
        { allowNoExpiry: 'yes' },
        { nonsense: 1 },
    ]) {
        const res = await put(values).expect(400);
        assert.ok(res.body.errors, `expected errors for ${JSON.stringify(values)}`);
    }
    await ctx.admin.put('/api/admin/settings').send({}).expect(400);
    await ctx.admin.put('/api/admin/settings').send({ values: [1, 2] }).expect(400);

    // A valid change in the same request as a bad one is not applied
    await put({ maxFileMb: 3, maxStashMb: 0 }).expect(400);
    assert.equal(ctx.config.maxFileBytes, 25 * 1024 * 1024);
});

test('items per stash cannot be set below files per stash', async () => {
    const ctx = await adminApp();
    const res = await ctx.admin.put('/api/admin/settings').send({ values: { maxItemsPerStash: 100 } }).expect(400);
    assert.match(res.body.errors.maxItemsPerStash, /at least/);
    await ctx.admin.put('/api/admin/settings').send({ values: { maxItemsPerStash: 100, maxFilesPerStash: 50 } }).expect(200);
    const low = await ctx.admin.put('/api/admin/settings').send({ values: { maxFilesPerStash: 200 } }).expect(400);
    assert.ok(low.body.errors.maxItemsPerStash);
});

test('saved settings survive a restart, and untouched ones keep following the environment', async () => {
    const first = await adminApp();
    await first.admin.put('/api/admin/settings').send({ values: { maxFileMb: 7 } }).expect(200);

    const restarted = makeApp({ adminPassword: PASSWORD }, { db: first.db });
    assert.equal(restarted.config.maxFileBytes, 7 * 1024 * 1024);
    assert.equal(restarted.config.maxFilesPerStash, 500);

    // Only the changed value is stored
    assert.deepEqual(restarted.model.loadSettings(), { maxFileMb: 7 });
    // A different environment value for an untouched setting wins
    const withEnv = makeApp({ adminPassword: PASSWORD, maxFilesPerStash: 42 }, { db: first.db });
    assert.equal(withEnv.config.maxFilesPerStash, 42);
    assert.equal(withEnv.config.maxFileBytes, 7 * 1024 * 1024);
});

test('reset to defaults puts the environment values back', async () => {
    const ctx = await adminApp();
    await ctx.admin.put('/api/admin/settings').send({ values: { maxFileMb: 3, maxStashMb: 7, allowNoExpiry: true } }).expect(200);
    assert.ok(ctx.config.ttlOptions.some(o => o.key === 'never'));
    const res = await ctx.admin.post('/api/admin/settings/reset').expect(200);
    const byKey = Object.fromEntries(res.body.fields.map(f => [f.key, f.value]));
    assert.equal(byKey.maxFileMb, 25);
    assert.equal(byKey.maxStashMb, 100);
    assert.equal(byKey.allowNoExpiry, false);
    assert.ok(!ctx.config.ttlOptions.some(o => o.key === 'never'));
    assert.deepEqual(ctx.model.loadSettings(), {});
});

test('"never expires" can be switched on from the settings page', async () => {
    const ctx = await adminApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'forever-one', ttl: 'never' }).expect(400);
    await ctx.admin.put('/api/admin/settings').send({ values: { allowNoExpiry: true } }).expect(200);
    const config = await request(ctx.app).get('/api/config').expect(200);
    assert.ok(config.body.ttlOptions.some(o => o.key === 'never'));
    const created = await request(ctx.app).post('/api/stashes').send({ slug: 'forever-one', ttl: 'never' }).expect(201);
    assert.equal(created.body.expiresAt, null);
});

test('only the admin can create stashes when that is switched on', async () => {
    const ctx = await adminApp();
    await ctx.admin.put('/api/admin/settings').send({ values: { requireAdminToCreate: true } }).expect(200);

    const visitor = await request(ctx.app).get('/api/config').expect(200);
    assert.equal(visitor.body.canCreate, false);
    assert.equal(visitor.body.adminEnabled, true);
    await request(ctx.app).post('/api/stashes').send({ slug: 'visitor-try' }).expect(403);

    const adminConfig = await ctx.admin.get('/api/config').expect(200);
    assert.equal(adminConfig.body.canCreate, true);
    await ctx.admin.post('/api/stashes').send({ slug: 'admin-made' }).expect(201);

    // Visitors can still use a stash the admin made
    await request(ctx.app).post('/api/stashes/admin-made/notes').send({ text: 'hi' }).expect(201);
});

test('"admin only" cannot be switched on, or forced by the environment, when admin is off', async () => {
    const off = makeApp({ requireAdminToCreate: true });
    // The setting store switches it off at startup
    assert.equal(off.config.requireAdminToCreate, false);
    await request(off.app).post('/api/stashes').send({ slug: 'open-door' }).expect(201);
    assert.equal(off.settings.update({ requireAdminToCreate: true }).errors.requireAdminToCreate, 'Admin is not enabled.');
});

test('the admin page is served', async () => {
    const ctx = makeApp({ adminPassword: PASSWORD });
    const res = await request(ctx.app).get('/admin').expect(200);
    assert.match(res.headers['content-type'], /html/);
});
