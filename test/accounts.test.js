const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';

// An app with accounts on (they follow the admin area), and an agent signed in as the ADMIN_PASSWORD admin
async function accountApp(overrides = {}, options) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides }, options);
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    return { ...ctx, root };
}

// The root admin makes a user; returns the created user (as the API shows it)
async function addUser(ctx, username, { role = 'user', password = PASSWORD, displayName } = {}) {
    const res = await ctx.root.post('/api/admin/users').send({ username, password, role, displayName }).expect(201);
    return res.body;
}

// An agent signed in as that user
async function signIn(ctx, username, password = PASSWORD) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ username, password }).expect(200);
    return agent;
}

// No response from any endpoint may carry a password, a hash, a salt or a token. `secrets` are the literal values to look for.
function assertNoSecrets(body, secrets = []) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    assert.doesNotMatch(text, /password_hash|password_salt|session_version|"hash"|"salt"/i);
    for (const secret of [PASSWORD, ADMIN, ...secrets]) assert.ok(!text.includes(secret), `a response carries ${secret}`);
}

// ---- accounts exist only with the admin area ----

test('accounts are off when there is no ADMIN_PASSWORD: every account endpoint says so', async () => {
    const ctx = makeApp();
    const me = await request(ctx.app).get('/api/me').expect(200);
    assert.deepEqual(me.body, { enabled: false });
    for (const [method, path] of [
        ['post', '/api/auth/login'], ['post', '/api/auth/logout'], ['post', '/api/me/password'], ['get', '/api/me/stashes'],
        ['post', '/api/me/stashes'], ['delete', '/api/me/stashes/some-stash'], ['post', '/api/me/stashes/some-stash/seen'],
    ]) {
        const res = await request(ctx.app)[method](path).send({ username: 'sam', password: PASSWORD }).expect(404);
        assert.equal(res.body.error, 'Accounts are not enabled on this server.', path);
    }
    await request(ctx.app).get('/api/admin/users').expect(404);
    const config = await request(ctx.app).get('/api/config').expect(200);
    assert.equal(config.body.accountsEnabled, false);
    // The switches that need accounts cannot be turned on without them
    const off = makeApp({ requireLoginToCreate: true });
    assert.equal(off.config.requireLoginToCreate, false);
    assert.equal(off.settings.update({ requireLoginToCreate: true }).errors.requireLoginToCreate, 'Accounts are not enabled (they need the admin area).');
    await request(off.app).post('/api/stashes').send({ slug: 'open-door' }).expect(201);
});

test('with ADMIN_PASSWORD set, accounts are on and /api/me says nobody is signed in', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const me = await request(ctx.app).get('/api/me').expect(200);
    assert.deepEqual(me.body, { enabled: true, user: null, resetByEmail: false });
    assert.equal((await request(ctx.app).get('/api/config')).body.accountsEnabled, true);
    // Protected endpoints ask for a sign-in rather than pretending the feature is off
    await request(ctx.app).get('/api/me/stashes').expect(401);
    await request(ctx.app).post('/api/me/password').send({}).expect(401);
});

test('the account page is served, with no inline script or style (the content policy allows neither)', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const res = await request(ctx.app).get('/account').expect(200);
    assert.match(res.headers['content-type'], /html/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.match(res.text, /id="loginForm"/);
    assert.match(res.text, /src="\/account\.js"/);
    assert.doesNotMatch(res.text, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(res.text, /<style|\sstyle=|\sonclick=|\sonsubmit=/i);
    await request(ctx.app).get('/account.js').expect(200);
});

// ---- admin: managing users ----

test('the admin makes users: the answer never carries the password, and the list shows what an admin needs', async () => {
    const ctx = await accountApp();
    const sam = await ctx.root.post('/api/admin/users').send({ username: 'Sam.Lee', displayName: '  Sam Lee ', password: PASSWORD, role: 'user' }).expect(201);
    assert.equal(sam.body.username, 'sam.lee');
    assert.equal(sam.body.displayName, 'Sam Lee');
    assert.equal(sam.body.role, 'user');
    assert.equal(sam.body.disabled, false);
    assert.equal(sam.body.lastLoginAt, null);
    assertNoSecrets(sam.body);

    // role defaults to user; an admin account can be made too
    const kim = (await ctx.root.post('/api/admin/users').send({ username: 'kim_admin', password: PASSWORD, role: 'admin' }).expect(201)).body;
    assert.equal(kim.role, 'admin');
    assert.equal((await addUser(ctx, 'plain-one', {})).role, 'user');

    const list = await ctx.root.get('/api/admin/users').expect(200);
    assertNoSecrets(list.body);
    // ("admin" is the account the server's environment makes from ADMIN_USERNAME; it is listed with the others)
    assert.deepEqual(list.body.users.map(u => u.username), ['admin', 'kim_admin', 'plain-one', 'sam.lee']);
    assert.deepEqual(Object.keys(list.body.users[1]).sort(), ['createdAt', 'disabled', 'displayName', 'email', 'id', 'lastLoginAt', 'managed', 'role', 'stashCount', 'username']);
    assert.equal(list.body.users[1].stashCount, 0);

    // The row in the database holds a hash, not the password, and who made the account
    const row = ctx.db.prepare("SELECT * FROM users WHERE username = 'sam.lee'").get();
    assert.notEqual(row.password_hash, PASSWORD);
    assert.match(row.password_hash, /^[0-9a-f]{128}$/);
    assert.equal(row.created_by, 'admin');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 4);
});

test('usernames and passwords are checked, and a username is unique whatever its case', async () => {
    const ctx = await accountApp({ minPasswordLength: 10 });
    const make = body => ctx.root.post('/api/admin/users').send({ password: PASSWORD, ...body });
    for (const username of ['ab', 'a'.repeat(41), 'has space', 'semi;colon', 'ünï', '', undefined, 42, 'slash/name']) {
        const res = await make({ username }).expect(400);
        assert.equal(res.body.field, 'username', String(username));
    }
    assert.equal((await make({ username: 'abc' }).expect(201)).body.username, 'abc');
    assert.equal((await make({ username: 'a'.repeat(40) }).expect(201)).body.username, 'a'.repeat(40));
    assert.equal((await make({ username: 'x.y-z_1' }).expect(201)).body.username, 'x.y-z_1');
    // Same name in another case is the same account
    assert.equal((await make({ username: 'ABC' }).expect(409)).body.field, 'username');

    assert.equal((await make({ username: 'pw-short', password: 'short' }).expect(400)).body.field, 'password');
    assert.equal((await make({ username: 'pw-long', password: 'x'.repeat(201) }).expect(400)).body.field, 'password');
    assert.equal((await make({ username: 'pw-none', password: undefined }).expect(400)).body.field, 'password');
    assert.equal((await make({ username: 'role-bad', role: 'member' }).expect(400)).body.field, 'role');
    assert.equal((await make({ username: 'role-bad', role: 'superuser' }).expect(400)).body.field, 'role');
    assert.equal((await make({ username: 'name-long', displayName: 'n'.repeat(61) }).expect(400)).body.field, 'displayName');
    assert.equal((await make({ username: 'name-ctl', displayName: 'bad\nname' }).expect(400)).body.field, 'displayName');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 4);

    // The password rule follows the live setting
    await ctx.root.put('/api/admin/settings').send({ values: { minPasswordLength: 16 } }).expect(200);
    await make({ username: 'now-longer', password: 'only-fourteen-ch' }).expect(201);
    await make({ username: 'now-longer2', password: 'only-fifteen-c' }).expect(400);
});

test('the admin can change a role, disable and enable, rename, reset a password, sign a user out and delete', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');

    const renamed = await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ displayName: 'Sam' }).expect(200);
    assert.equal(renamed.body.displayName, 'Sam');
    assert.equal((await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ displayName: null }).expect(200)).body.displayName, null);
    assert.equal((await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ role: 'admin' }).expect(200)).body.role, 'admin');
    assert.equal((await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ role: 'user', disabled: true }).expect(200)).body.disabled, true);
    assert.equal((await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ disabled: false }).expect(200)).body.disabled, false);
    // Bad input
    assert.equal((await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ role: 'member' }).expect(400)).body.field, 'role');
    assert.equal((await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ disabled: 'yes' }).expect(400)).body.field, 'disabled');
    await ctx.root.patch('/api/admin/users/999').send({ role: 'user' }).expect(404);
    await ctx.root.patch('/api/admin/users/abc').send({ role: 'user' }).expect(404);
    await ctx.root.post('/api/admin/users/999/sign-out').expect(404);
    await ctx.root.post('/api/admin/users/999/password').send({ password: PASSWORD }).expect(404);
    await ctx.root.delete('/api/admin/users/999').expect(404);

    // Reset: the old password stops working, the new one works; the reset must be a sensible password too
    await ctx.root.post(`/api/admin/users/${sam.id}/password`).send({ password: 'abc' }).expect(400);
    const reset = await ctx.root.post(`/api/admin/users/${sam.id}/password`).send({ password: 'a brand new password' }).expect(200);
    assertNoSecrets(reset.body, ['a brand new password']);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'a brand new password' }).expect(200);

    await ctx.root.post(`/api/admin/users/${sam.id}/sign-out`).expect(200);
    await ctx.root.delete(`/api/admin/users/${sam.id}`).expect(200);
    // (only the environment's admin account is left)
    assert.deepEqual((await ctx.root.get('/api/admin/users')).body.users.map(u => u.username), ['admin']);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'a brand new password' }).expect(401);
});

test('every user-management endpoint needs an admin: nobody, and users, are refused', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');
    const agent = await signIn(ctx, 'sam');
    const calls = [
        ['get', '/api/admin/users'], ['post', '/api/admin/users'], ['patch', `/api/admin/users/${sam.id}`],
        ['post', `/api/admin/users/${sam.id}/password`], ['post', `/api/admin/users/${sam.id}/sign-out`], ['delete', `/api/admin/users/${sam.id}`],
    ];
    for (const [method, path] of calls) {
        await request(ctx.app)[method](path).send({ username: 'evil', password: PASSWORD, role: 'admin' }).expect(401);
        const res = await agent[method](path).send({ username: 'evil', password: PASSWORD, role: 'admin' }).expect(403);
        assert.equal(res.body.signedIn, false);
    }
    // Nothing happened: still one user, still a user
    const list = (await ctx.root.get('/api/admin/users')).body.users;
    assert.deepEqual(list.map(u => [u.username, u.role]), [['admin', 'admin'], ['sam', 'user']]);
});

test('a user cannot use the admin area: the data endpoints, settings and backup are all refused, the status says not signed in', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const agent = await signIn(ctx, 'sam');
    for (const path of ['/api/admin/overview', '/api/admin/settings', '/api/admin/backup', '/api/admin/users']) {
        await agent.get(path).expect(403);
    }
    await agent.put('/api/admin/settings').send({ values: { maxFileMb: 1 } }).expect(403);
    await agent.delete('/api/admin/stashes/anything').expect(403);
    const status = await agent.get('/api/admin/status').expect(200);
    assert.equal(status.body.signedIn, false);
    // ...and they cannot become admin by logging in to the admin area with their own password
    await agent.post('/api/admin/login').send({ password: PASSWORD }).expect(401);
});

test('a user with the admin role can use the admin area like the ADMIN_PASSWORD admin, and manage users', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'boss', { role: 'admin' });
    const boss = await signIn(ctx, 'boss');
    await request(ctx.app).post('/api/stashes').send({ slug: 'some-stash' }).expect(201);

    const status = await boss.get('/api/admin/status').expect(200);
    assert.deepEqual(status.body, { enabled: true, signedIn: true, via: 'account' });
    assert.equal((await ctx.root.get('/api/admin/status')).body.via, 'password');
    const overview = await boss.get('/api/admin/overview').expect(200);
    assert.equal(overview.body.totals.stashes, 1);
    assert.equal(overview.body.userCount, 2); // boss and the environment's admin account
    await boss.get('/api/admin/settings').expect(200);
    await boss.put('/api/admin/settings').send({ values: { maxFileMb: 7 } }).expect(200);
    await boss.post('/api/admin/stashes/some-stash/extend').expect(200);
    await boss.get('/api/admin/backup').expect(200);

    const made = await boss.post('/api/admin/users').send({ username: 'new-one', password: PASSWORD, role: 'user' }).expect(201);
    assert.equal(ctx.db.prepare("SELECT created_by FROM users WHERE username = 'new-one'").get().created_by, 'boss');
    await boss.patch(`/api/admin/users/${made.body.id}`).send({ role: 'admin' }).expect(200);
    await boss.delete(`/api/admin/users/${made.body.id}`).expect(200);
    await boss.delete('/api/admin/stashes/some-stash').expect(200);

    // Take the role away and the admin area closes at once (the role change also ends the session)
    const boss2 = (await ctx.root.get('/api/admin/users')).body.users.find(u => u.username === 'boss');
    await ctx.root.patch(`/api/admin/users/${boss2.id}`).send({ role: 'user' }).expect(200);
    await boss.get('/api/admin/overview').expect(401);
});

test('an admin account cannot demote, disable or delete itself; the ADMIN_PASSWORD admin can do all of that to anyone', async () => {
    const ctx = await accountApp();
    const boss = await addUser(ctx, 'boss', { role: 'admin' });
    const other = await addUser(ctx, 'other', { role: 'admin' });
    const agent = await signIn(ctx, 'boss');
    const self = `/api/admin/users/${boss.id}`;

    assert.match((await agent.patch(self).send({ role: 'user' }).expect(400)).body.error, /your own account/);
    await agent.patch(self).send({ disabled: true }).expect(400);
    await agent.patch(self).send({ role: 'user', disabled: true }).expect(400);
    await agent.delete(self).expect(400);
    // Harmless edits to yourself are fine, and so is changing someone else
    await agent.patch(self).send({ displayName: 'The Boss' }).expect(200);
    await agent.patch(self).send({ role: 'admin', disabled: false }).expect(200);
    await agent.patch(`/api/admin/users/${other.id}`).send({ role: 'user' }).expect(200);
    await agent.patch(`/api/admin/users/${other.id}`).send({ disabled: true }).expect(200);
    await agent.delete(`/api/admin/users/${other.id}`).expect(200);
    // Still signed in and still an admin after all that
    await agent.get('/api/admin/overview').expect(200);

    // The root admin is not a user row, so no guard applies to it
    await ctx.root.patch(self).send({ role: 'user' }).expect(200);
    await ctx.root.patch(self).send({ disabled: true }).expect(200);
    await ctx.root.delete(self).expect(200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1); // the environment's admin account stays
});

// ---- signing in ----

test('the right username and password sign in: a cookie with the right flags, and /api/me shows who', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam', { displayName: 'Sam Lee' });
    const agent = request.agent(ctx.app);
    // Username case and surrounding spaces do not matter
    const res = await agent.post('/api/auth/login').send({ username: '  SAM ', password: PASSWORD }).expect(200);
    assertNoSecrets(res.body);
    assert.equal(res.body.user.username, 'sam');
    assert.deepEqual(Object.keys(res.body.user).sort(), ['displayName', 'email', 'id', 'managed', 'role', 'username']);
    const cookie = res.headers['set-cookie'].find(c => c.startsWith('stashly_user='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//i);
    assert.match(cookie, /Max-Age=604800/); // 7 days
    assert.doesNotMatch(cookie, /Secure/i);
    assert.doesNotMatch(cookie, new RegExp(PASSWORD));

    const me = await agent.get('/api/me').expect(200);
    assert.deepEqual(me.body, { enabled: true, user: { id: res.body.user.id, username: 'sam', displayName: 'Sam Lee', email: null, role: 'user', managed: false }, resetByEmail: false });
    // last login is recorded and shown to the admin
    const row = (await ctx.root.get('/api/admin/users')).body.users.find(u => u.username === 'sam');
    assert.equal(row.lastLoginAt, ctx.clock.time.toISOString());

    await agent.post('/api/auth/logout').expect(200);
    assert.deepEqual((await agent.get('/api/me')).body, { enabled: true, user: null, resetByEmail: false });
});

test('the session cookie is Secure when COOKIE_SECURE=true, and its length follows USER_SESSION_DAYS', async () => {
    const ctx = await accountApp({ userSessionDays: 3 });
    await addUser(ctx, 'sam');
    // (the admin's own cookie would not come back over plain http once it is Secure, so it is switched on after)
    ctx.config.cookieSecure = 'true';
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(200);
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /; Secure/i);
    assert.match(cookie, /Max-Age=259200/);
    // A session is over when its time is: the cookie's own expiry is signed, so it cannot be stretched
    ctx.config.cookieSecure = 'false';
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(200);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * 86400000);
    assert.equal((await agent.get('/api/me')).body.user.username, 'sam');
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * 86400000);
    assert.equal((await agent.get('/api/me')).body.user, null);
    // The setting is clamped to 1..90 days
    const { loadConfig } = require('../src/config');
    assert.equal(loadConfig({ USER_SESSION_DAYS: '0' }).userSessionDays, 1);
    assert.equal(loadConfig({ USER_SESSION_DAYS: '500' }).userSessionDays, 90);
    assert.equal(loadConfig({}).userSessionDays, 7);
});

test('an unknown username, a wrong password and a disabled account all get the same answer', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const dis = await addUser(ctx, 'dis');
    await ctx.root.patch(`/api/admin/users/${dis.id}`).send({ disabled: true }).expect(200);

    const attempts = [
        { username: 'nobody-here', password: PASSWORD },
        { username: 'sam', password: 'not the password' },
        { username: 'dis', password: PASSWORD }, // right password, disabled
        { username: 'SAM', password: 'x'.repeat(5000) },
    ];
    const answers = [];
    for (const body of attempts) {
        const res = await request(ctx.app).post('/api/auth/login').send(body);
        answers.push([res.status, res.body, res.headers['set-cookie']]);
    }
    for (const [status, body, cookie] of answers) {
        assert.equal(status, 401);
        assert.deepEqual(body, { error: 'That username or password is not right.' });
        assert.equal(cookie, undefined);
    }
    // Missing fields are a plain 400 (nothing about any account)
    await request(ctx.app).post('/api/auth/login').send({}).expect(400);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam' }).expect(400);
    await request(ctx.app).post('/api/auth/login').send({ username: ['sam'], password: PASSWORD }).expect(400);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: { $ne: 1 } }).expect(400);
    // The dummy hash the unknown name was checked against is made once and is a real scrypt hash
    const dummy = await ctx.userController.dummy;
    assert.match(dummy.hash, /^[0-9a-f]{128}$/);
});

test('too many wrong passwords for a username lock that username from that address, known name or not', async () => {
    const ctx = await accountApp({ stashUnlockFailures: 3, trustProxy: '1' });
    await addUser(ctx, 'sam');
    await addUser(ctx, 'lee');
    const wrong = name => request(ctx.app).post('/api/auth/login').send({ username: name, password: 'wrong password' });

    for (let i = 0; i < 3; i++) await wrong('sam').expect(401);
    // Locked: even the right password is refused until the window ends
    const locked = await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(429);
    assert.match(locked.body.error, /Try again in about 15 minutes/);
    assert.ok(Number(locked.headers['retry-after']) > 0);
    // Another account is not affected
    await request(ctx.app).post('/api/auth/login').send({ username: 'lee', password: PASSWORD }).expect(200);
    // A name that does not exist locks the same way, so the lockout does not tell which names exist
    for (let i = 0; i < 3; i++) await wrong('ghost').expect(401);
    await wrong('ghost').expect(429);
    // Another visitor (address) can still try the locked account
    await request(ctx.app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ username: 'sam', password: PASSWORD }).expect(200);

    // The window passes: signing in works again
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 16 * 60 * 1000);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(200);
});

test('the lockout counts do not mix with a stash that has the same name as a user', async () => {
    const ctx = await accountApp({ stashUnlockFailures: 2 });
    await addUser(ctx, 'vault-1');
    await request(ctx.app).post('/api/stashes').send({ slug: 'vault-1', password: 'stash password' }).expect(201);
    const anon = request.agent(ctx.app);
    for (let i = 0; i < 2; i++) await anon.post('/api/stashes/vault-1/unlock').send({ password: 'nope nope nope' }).expect(401);
    await anon.post('/api/stashes/vault-1/unlock').send({ password: 'stash password' }).expect(429);
    await request(ctx.app).post('/api/auth/login').send({ username: 'vault-1', password: PASSWORD }).expect(200);
});

test('wrong sign-in passwords are rate limited per address, right ones are not', async () => {
    const ctx = await accountApp({ rateUserLogin: 3 });
    await addUser(ctx, 'sam');
    for (let i = 0; i < 3; i++) await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'nope nope nope' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'nope nope nope' }).expect(429);

    const fine = await accountApp({ rateUserLogin: 3 });
    await addUser(fine, 'sam');
    for (let i = 0; i < 6; i++) await request(fine.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(200);
});

// ---- sessions end when they should ----

test('a forged, mangled or expired session cookie is ignored: the visitor is anonymous', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');
    const exp = ctx.clock.time.getTime() + 60000;
    for (const cookie of [
        `stashly_user=${sam.id}.${exp}.${'0'.repeat(64)}`, `stashly_user=999.${exp}.${'0'.repeat(64)}`, 'stashly_user=garbage',
        'stashly_user=.', 'stashly_user=1', 'stashly_user=0.1.2', 'stashly_user=-1.5.5', `stashly_user=${sam.id}.${exp}`, 'stashly_user=%E0%A4%A',
    ]) {
        const me = await request(ctx.app).get('/api/me').set('Cookie', cookie).expect(200);
        assert.equal(me.body.user, null, cookie);
        await request(ctx.app).get('/api/me/stashes').set('Cookie', cookie).expect(401);
        // A bad cookie never blocks the rest of the app
        await request(ctx.app).post('/api/stashes').set('Cookie', cookie).send({ slug: `still-works-${Math.random().toString(36).slice(2, 8)}` }).expect(201);
    }
    // A real cookie of one user does not work for another id
    const login = await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(200);
    const value = decodeURIComponent(login.headers['set-cookie'][0].split(';')[0].split('=')[1]);
    const lee = await addUser(ctx, 'lee');
    const swapped = value.replace(/^\d+/, String(lee.id));
    assert.equal((await request(ctx.app).get('/api/me').set('Cookie', `stashly_user=${swapped}`)).body.user, null);
    assert.equal((await request(ctx.app).get('/api/me').set('Cookie', `stashly_user=${value}`)).body.user.username, 'sam');
});

test('a password change ends other sessions and keeps this one; wrong current passwords count towards the lockout', async () => {
    const ctx = await accountApp({ stashUnlockFailures: 3 });
    await addUser(ctx, 'sam');
    const here = await signIn(ctx, 'sam');
    const there = await signIn(ctx, 'sam');

    await here.post('/api/me/password').send({ currentPassword: PASSWORD, newPassword: 'abc' }).expect(400);
    await here.post('/api/me/password').send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
    await here.post('/api/me/password').send({ currentPassword: PASSWORD }).expect(400);
    // a wrong current password is refused and counted
    for (let i = 0; i < 2; i++) await here.post('/api/me/password').send({ currentPassword: 'wrong wrong wrong', newPassword: 'another good one' }).expect(401);
    const changed = await here.post('/api/me/password').send({ currentPassword: PASSWORD, newPassword: 'another good one' }).expect(200);
    assertNoSecrets(changed.body, ['another good one']);

    assert.equal((await here.get('/api/me')).body.user.username, 'sam');
    assert.equal((await there.get('/api/me')).body.user, null);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'another good one' }).expect(200);

    // Three wrong ones lock the account for this address, the change form included
    const third = await signIn(ctx, 'sam', 'another good one');
    for (let i = 0; i < 3; i++) await third.post('/api/me/password').send({ currentPassword: 'wrong wrong wrong', newPassword: 'yet another one' }).expect(401);
    await third.post('/api/me/password').send({ currentPassword: 'another good one', newPassword: 'yet another one' }).expect(429);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'another good one' }).expect(429);
});

test('a role change, a disable, "sign out" and a password reset by the admin each end every session of that user', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');
    const actions = [
        () => ctx.root.patch(`/api/admin/users/${sam.id}`).send({ role: 'admin' }),
        () => ctx.root.patch(`/api/admin/users/${sam.id}`).send({ role: 'user' }),
        () => ctx.root.patch(`/api/admin/users/${sam.id}`).send({ disabled: true }),
        () => ctx.root.post(`/api/admin/users/${sam.id}/sign-out`),
        () => ctx.root.post(`/api/admin/users/${sam.id}/password`).send({ password: 'a brand new password' }),
    ];
    let password = PASSWORD;
    for (const act of actions) {
        const a = await signIn(ctx, 'sam', password);
        const b = await signIn(ctx, 'sam', password);
        assert.equal((await a.get('/api/me')).body.user.username, 'sam');
        await act().expect(200);
        assert.equal((await a.get('/api/me')).body.user, null);
        assert.equal((await b.get('/api/me')).body.user, null);
        if (act === actions[4]) password = 'a brand new password';
        // A disabled account cannot sign in again until it is enabled
        if (act === actions[2]) {
            await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password }).expect(401);
            await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ disabled: false }).expect(200);
        }
    }
    // A harmless edit (a display name) leaves sessions alone
    const keep = await signIn(ctx, 'sam', password);
    await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ displayName: 'Sam' }).expect(200);
    assert.equal((await keep.get('/api/me')).body.user.displayName, 'Sam');
    // Deleting the account ends its sessions too
    await ctx.root.delete(`/api/admin/users/${sam.id}`).expect(200);
    assert.equal((await keep.get('/api/me')).body.user, null);
});

test('a user disabled while signed in loses admin access straight away', async () => {
    const ctx = await accountApp();
    const boss = await addUser(ctx, 'boss', { role: 'admin' });
    const agent = await signIn(ctx, 'boss');
    await agent.get('/api/admin/overview').expect(200);
    await ctx.root.patch(`/api/admin/users/${boss.id}`).send({ disabled: true }).expect(200);
    await agent.get('/api/admin/overview').expect(401);
});

test('turning accounts off (no ADMIN_PASSWORD any more) makes every session worthless', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'boss', { role: 'admin' });
    const agent = await signIn(ctx, 'boss');
    await agent.get('/api/admin/overview').expect(200);
    ctx.config.adminPassword = '';
    assert.deepEqual((await agent.get('/api/me')).body, { enabled: false });
    await agent.get('/api/admin/overview').expect(404);
});

// ---- who may create stashes ----

test('by default anyone can create a stash, signed in or not', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const config = await request(ctx.app).get('/api/config').expect(200);
    assert.equal(config.body.canCreate, true);
    assert.equal(config.body.createRule, 'open');
    await request(ctx.app).post('/api/stashes').send({ slug: 'anon-made' }).expect(201);
    const sam = await signIn(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sam-made' }).expect(201);
});

test('with REQUIRE_LOGIN_TO_CREATE only signed-in users and admins can create; everyone can still open and use stashes', async () => {
    const ctx = await accountApp({ requireLoginToCreate: true });
    await addUser(ctx, 'sam');
    await addUser(ctx, 'boss', { role: 'admin' });
    // Made before anyone signs in: guests keep using it
    await ctx.root.post('/api/stashes').send({ slug: 'existing-one' }).expect(201);

    const visitor = await request(ctx.app).get('/api/config').expect(200);
    assert.equal(visitor.body.canCreate, false);
    assert.equal(visitor.body.createRule, 'login');
    const refused = await request(ctx.app).post('/api/stashes').send({ slug: 'anon-try' }).expect(403);
    assert.match(refused.body.error, /sign in/i);

    const sam = await signIn(ctx, 'sam');
    assert.equal((await sam.get('/api/config')).body.canCreate, true);
    await sam.post('/api/stashes').send({ slug: 'sam-made' }).expect(201);
    const boss = await signIn(ctx, 'boss');
    await boss.post('/api/stashes').send({ slug: 'boss-made' }).expect(201);
    await ctx.root.post('/api/stashes').send({ slug: 'root-made' }).expect(201);

    // Guests are not locked out of anything else
    await request(ctx.app).post('/api/stashes/existing-one/notes').send({ text: 'from a guest' }).expect(201);
    await request(ctx.app).get('/api/stashes/sam-made').expect(200);
    // Signing out closes creating again
    await sam.post('/api/auth/logout').expect(200);
    await sam.post('/api/stashes').send({ slug: 'sam-again' }).expect(403);
});

test('with REQUIRE_ADMIN_TO_CREATE only admins create: the ADMIN_PASSWORD admin and users with the admin role, not plain users', async () => {
    const ctx = await accountApp({ requireAdminToCreate: true });
    await addUser(ctx, 'sam');
    await addUser(ctx, 'boss', { role: 'admin' });
    const sam = await signIn(ctx, 'sam');
    const boss = await signIn(ctx, 'boss');
    assert.equal((await sam.get('/api/config')).body.canCreate, false);
    assert.match((await sam.post('/api/stashes').send({ slug: 'sam-try' }).expect(403)).body.error, /Only the admin/);
    await request(ctx.app).post('/api/stashes').send({ slug: 'anon-try' }).expect(403);
    assert.equal((await boss.get('/api/config')).body.canCreate, true);
    await boss.post('/api/stashes').send({ slug: 'boss-made' }).expect(201);
    await ctx.root.post('/api/stashes').send({ slug: 'root-made' }).expect(201);
    assert.equal((await boss.get('/api/config')).body.createRule, 'admin');
});

test('with both switches on, "only the admin" wins; and both can be changed in the admin Settings, live', async () => {
    const ctx = await accountApp({ requireAdminToCreate: true, requireLoginToCreate: true });
    await addUser(ctx, 'sam');
    const sam = await signIn(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sam-try' }).expect(403);

    const fields = (await ctx.root.get('/api/admin/settings').expect(200)).body.fields;
    const login = fields.find(f => f.key === 'requireLoginToCreate');
    assert.equal(login.type, 'bool');
    assert.equal(login.group, 'Stashes');
    assert.equal(login.value, true);
    await ctx.root.put('/api/admin/settings').send({ values: { requireAdminToCreate: false } }).expect(200);
    await sam.post('/api/stashes').send({ slug: 'sam-ok' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'anon-try' }).expect(403);
    await ctx.root.put('/api/admin/settings').send({ values: { requireLoginToCreate: false } }).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'anon-ok' }).expect(201);
    // Saved across a restart, like the other settings
    await ctx.root.put('/api/admin/settings').send({ values: { requireLoginToCreate: true } }).expect(200);
    const fresh = await accountApp();
    await fresh.root.put('/api/admin/settings').send({ values: { requireLoginToCreate: true } }).expect(200);
    const again = makeApp({ adminPassword: ADMIN }, { db: fresh.db });
    assert.equal(again.config.requireLoginToCreate, true);
    await request(again.app).post('/api/stashes').send({ slug: 'after-restart' }).expect(403);
});

// ---- accounts change nothing for people who do not use them ----

test('guests work exactly as before on a server where users exist: create, open, add, read, delete, with and without a password', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    await addUser(ctx, 'boss', { role: 'admin' });
    await signIn(ctx, 'sam'); // someone else is signed in elsewhere: it must not matter to this visitor

    const guest = request.agent(ctx.app);
    const config = await guest.get('/api/config').expect(200);
    assert.equal(config.body.canCreate, true);

    // A stash with no password: made, used and deleted with no login at all
    await guest.post('/api/stashes').send({ slug: 'guest-open-stash' }).expect(201);
    const note = await guest.post('/api/stashes/guest-open-stash/notes').send({ text: 'hello' }).expect(201);
    assert.equal((await guest.get('/api/stashes/guest-open-stash')).body.role, 'full');
    await guest.put(`/api/stashes/guest-open-stash/items/${note.body.id}`).send({ text: 'edited' }).expect(200);
    await guest.post(`/api/stashes/guest-open-stash/items/${note.body.id}/pin`).send({ pinned: true }).expect(200);
    await guest.delete(`/api/stashes/guest-open-stash/items/${note.body.id}`).expect(200);
    // A different visitor (no cookies at all) can use it by name
    await request(ctx.app).post('/api/stashes/guest-open-stash/notes').send({ text: 'second visitor' }).expect(201);
    await request(ctx.app).get('/api/stashes/guest-open-stash/latest').expect(200);
    await guest.delete('/api/stashes/guest-open-stash').expect(200);
    await guest.get('/api/stashes/guest-open-stash').expect(404);

    // A stash with a password: locked for strangers, unlocked with the password, share links work
    await guest.post('/api/stashes').send({ slug: 'guest-locked', password: 'guest password' }).expect(201);
    await guest.post('/api/stashes/guest-locked/notes').send({ text: 'secret-ish' }).expect(201);
    await request(ctx.app).get('/api/stashes/guest-locked').expect(401);
    const other = request.agent(ctx.app);
    await other.post('/api/stashes/guest-locked/unlock').send({ password: 'wrong wrong' }).expect(401);
    await other.post('/api/stashes/guest-locked/unlock').send({ password: 'guest password' }).expect(200);
    assert.equal((await other.get('/api/stashes/guest-locked')).body.items.length, 1);
    const link = (await guest.post('/api/stashes/guest-locked/share-links').send({ kind: 'view' }).expect(201)).body;
    const reader = request.agent(ctx.app);
    await reader.post('/api/stashes/guest-locked/redeem').send({ token: link.token }).expect(200);
    await reader.get('/api/stashes/guest-locked').expect(200);
    await reader.post('/api/stashes/guest-locked/notes').send({ text: 'nope' }).expect(403);
    await guest.delete('/api/stashes/guest-locked').expect(200);

    // The admin pages still ask for the ADMIN_PASSWORD, and the old status shape holds for a guest
    await guest.get('/api/admin/overview').expect(401);
    assert.deepEqual((await guest.get('/api/admin/status')).body, { enabled: true, signedIn: false });
});

test('a guest on a server with accounts is not affected by a stranger cookie or by a signed-in user following the same stash', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const sam = await signIn(ctx, 'sam');
    await request(ctx.app).post('/api/stashes').send({ slug: 'shared-by-name-12', password: 'the password' }).expect(201);
    await sam.post('/api/me/stashes').send({ slug: 'shared-by-name-12', password: 'the password' }).expect(200);
    // sam's follow gives sam access only: a visitor with no cookie and no account is still locked out
    await sam.get('/api/stashes/shared-by-name-12').expect(200);
    await request(ctx.app).get('/api/stashes/shared-by-name-12').expect(401);
    await request(ctx.app).get('/api/stashes/shared-by-name-12').set('Cookie', 'stashly_user=1.123.abc').expect(401);
});

// ---- creating while signed in ----

test('a signed-in user who creates a stash follows it at once, with full access and no cookie needed', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const sam = await signIn(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'made-by-sam', password: 'sam password' }).expect(201);
    await sam.post('/api/stashes').send({ slug: 'made-open-by-sam' }).expect(201);
    // A guest creating one follows nothing
    await request(ctx.app).post('/api/stashes').send({ slug: 'made-by-guest' }).expect(201);

    const list = (await sam.get('/api/me/stashes').expect(200)).body.stashes;
    assert.deepEqual(list.map(s => s.slug).sort(), ['made-by-sam', 'made-open-by-sam']);
    assert.ok(list.every(s => s.role === 'full' && s.needsPassword === false));
    assert.equal(list.find(s => s.slug === 'made-by-sam').hasPassword, true);
    // ... and sam can open it from a browser that never unlocked it
    const fresh = request.agent(ctx.app);
    const cookie = (await sam.get('/api/me')).body && sam; // same agent has the stash cookie; use the user cookie only below
    assert.ok(cookie);
    const userOnly = await signIn(ctx, 'sam');
    const open = await userOnly.get('/api/stashes/made-by-sam').expect(200);
    assert.equal(open.body.role, 'full');
    await userOnly.post('/api/stashes/made-by-sam/notes').send({ text: 'added through the account' }).expect(201);
    await fresh.get('/api/stashes/made-by-sam').expect(401);
});

// ---- logs and metrics ----

test('the audit log and the access log record account events and never a password, username, token or stash name', async () => {
    const access = [];
    const audit = [];
    const ctx = await accountApp({ logFormat: 'json', auditLog: 'stdout', stashUnlockFailures: 2 }, { logOut: l => access.push(l), auditOut: l => audit.push(l) });
    const sam = await addUser(ctx, 'secret.user.name', { displayName: 'Hidden Display' });
    await request(ctx.app).post('/api/auth/login').send({ username: 'unknown.person', password: 'guess one two' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'secret.user.name', password: 'wrong wrong 1' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'secret.user.name', password: 'wrong wrong 2' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'secret.user.name', password: PASSWORD }).expect(429);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 16 * 60 * 1000);
    const agent = await signIn(ctx, 'secret.user.name');
    // made by a guest, so the user follows it with the password (and can unfollow it: only stashes someone else made can be)
    await request(ctx.app).post('/api/stashes').send({ slug: 'audit-stash-name', password: 'stash secret pw' }).expect(201);
    await agent.post('/api/me/stashes').send({ slug: 'audit-stash-name', password: 'stash secret pw' }).expect(200);
    await agent.delete('/api/me/stashes/audit-stash-name').expect(200);
    await agent.post('/api/me/password').send({ currentPassword: PASSWORD, newPassword: 'changed secret pw' }).expect(200);
    await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ role: 'admin', displayName: 'Other Display' }).expect(200);
    await ctx.root.post(`/api/admin/users/${sam.id}/password`).send({ password: 'reset secret pw' }).expect(200);
    await ctx.root.post(`/api/admin/users/${sam.id}/sign-out`).expect(200);
    const login = await request(ctx.app).post('/api/auth/login').send({ username: 'secret.user.name', password: 'reset secret pw' }).expect(200);
    await request(ctx.app).post('/api/auth/logout').set('Cookie', login.headers['set-cookie'][0]).expect(200);
    await ctx.root.delete(`/api/admin/users/${sam.id}`).expect(200);
    await new Promise(r => setTimeout(r, 40));

    const events = audit.map(l => JSON.parse(l));
    const names = new Set(events.map(e => e.event));
    for (const name of [
        'user.created', 'user.login_failed', 'user.locked_out', 'user.login_succeeded', 'user.followed', 'user.unfollowed',
        'user.password_changed', 'user.updated', 'user.password_reset', 'user.signed_out', 'user.logout', 'user.deleted',
    ]) assert.ok(names.has(name), `${name} is audited`);
    const updated = events.find(e => e.event === 'user.updated');
    assert.deepEqual(updated.detail.keys.sort(), ['displayName', 'role']);
    assert.equal(updated.actor, 'admin');
    assert.equal(events.find(e => e.event === 'user.login_succeeded').actor, 'user');
    assert.equal(events.find(e => e.event === 'user.followed').stash, ctx.audit.tag('audit-stash-name'));

    const all = [...audit, ...access].join('\n');
    for (const secret of [
        'secret.user.name', 'unknown.person', 'Hidden Display', 'Other Display', PASSWORD, ADMIN, 'guess one two', 'wrong wrong 1', 'stash secret pw',
        'changed secret pw', 'reset secret pw', 'audit-stash-name', 'stashly_user',
    ]) assert.ok(!all.includes(secret), `a log line carries ${secret}`);
    const cookieValue = decodeURIComponent(login.headers['set-cookie'][0].split(';')[0].split('=')[1]);
    assert.ok(!all.includes(cookieValue.split('.').pop()), 'a log line carries a session token');
    // The routes in the access log are patterns
    const routes = access.map(l => JSON.parse(l).route);
    assert.ok(routes.includes('/api/auth/login'));
    assert.ok(routes.includes('/api/me/stashes/:slug'));
});

test('metrics count sign-ins by result and users by role', async () => {
    const ctx = await accountApp({ metricsToken: 'metrics-token-1234567890' });
    await addUser(ctx, 'sam');
    await addUser(ctx, 'lee');
    await addUser(ctx, 'boss', { role: 'admin' });
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'nope nope nope' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'ghost', password: 'nope nope nope' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(200);
    const text = (await request(ctx.app).get('/metrics').set('Authorization', 'Bearer metrics-token-1234567890').expect(200)).text;
    assert.match(text, /^stashly_user_logins_total\{result="failure"\} 2$/m);
    assert.match(text, /^stashly_user_logins_total\{result="success"\} 1$/m);
    assert.match(text, /^stashly_users\{role="user"\} 2$/m);
    assert.match(text, /^stashly_users\{role="admin"\} 2$/m); // boss and the environment's admin account
    assert.doesNotMatch(text, /sam|boss|lee/);
});

test('the admin status of the page tells how the admin is signed in, and "via" is absent for a guest', async () => {
    const ctx = await accountApp();
    assert.deepEqual((await request(ctx.app).get('/api/admin/status')).body, { enabled: true, signedIn: false });
    assert.deepEqual((await ctx.root.get('/api/admin/status')).body, { enabled: true, signedIn: true, via: 'password' });
});

// ---- the pages ----

test('the pages carry the account parts: Users in admin, the Follow button on a stash, the sign-in link on home; none with inline code', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const admin = (await request(ctx.app).get('/admin').expect(200)).text;
    assert.match(admin, /id="viewUsers"/);
    assert.match(admin, /id="userForm"/);
    assert.match(admin, /id="userPasswordDialog"/);
    // The initial password is only ever an input, and the form asks for a role from the two that exist
    assert.match(admin, /<option value="user">User<\/option>\s*<option value="admin">Admin<\/option>/);
    assert.doesNotMatch(admin, /member/i);

    const stash = (await request(ctx.app).get('/s/any-name').expect(200)).text;
    assert.match(stash, /id="followStashButton"/);
    const scripts = [...stash.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(scripts.indexOf('/stash-account.js') > 0 && scripts.indexOf('/stash-account.js') < scripts.indexOf('/stash.js'));
    assert.equal(scripts[scripts.length - 1], '/stash.js');

    const home = (await request(ctx.app).get('/').expect(200)).text;
    assert.match(home, /id="accountLink"/);
    assert.match(home, /id="loginNotice"/);

    for (const html of [admin, stash, home]) {
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
        assert.doesNotMatch(html, /<style|\sstyle=|\sonclick=/i);
    }
    for (const file of ['/stash-account.js', '/account.js', '/admin.js', '/home.js']) {
        const res = await request(ctx.app).get(file).expect(200);
        assert.match(res.headers['content-type'], /javascript/);
    }
});
