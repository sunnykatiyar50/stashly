const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { loadConfig, checkConfig } = require('../src/config');
const { connect } = require('../src/database/sqlite');
const { UserModel } = require('../src/models/userModel');
const { syncAdminUser } = require('../src/utils/adminUser');
const { hashPasswordSync, verifyPasswordSync } = require('../src/utils/password');

const ADMIN = 'the-admin-password-1';
const PASSWORD = 'correct horse battery';
const MANAGED = 'This account is set by ADMIN_USERNAME and ADMIN_PASSWORD in the server environment.';

const views = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8').replace(/\r\n/g, '\n');

async function signIn(app, username, password) {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username, password }).expect(200);
    return agent;
}

// ---- the admin account is made from the environment ----

test('ADMIN_USERNAME defaults to admin, is stored lowercase and is checked like any username', () => {
    assert.equal(loadConfig({}).adminUsername, 'admin');
    assert.equal(loadConfig({ ADMIN_USERNAME: '' }).adminUsername, 'admin');
    assert.equal(loadConfig({ ADMIN_USERNAME: '  Boss.One ' }).adminUsername, 'boss.one');
    for (const bad of ['ab', 'a'.repeat(41), 'has space', 'semi;colon', 'ünï', 'slash/name']) {
        assert.throws(() => checkConfig(loadConfig({ ADMIN_USERNAME: bad })), /ADMIN_USERNAME must be 3 to 40/, bad);
        // ...and the app refuses to start with it (app.js shows the message and stops)
        assert.throws(() => makeApp({ adminPassword: ADMIN, adminUsername: bad }), /ADMIN_USERNAME/, bad);
    }
    checkConfig(loadConfig({ ADMIN_USERNAME: 'x.y-z_1' }));
});

test('at startup the admin account is a real user row: role admin, managed, with ADMIN_PASSWORD as its password', () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const row = ctx.users.findByUsername('admin');
    assert.equal(row.role, 'admin');
    assert.equal(row.managed, 1);
    assert.equal(row.disabled, 0);
    assert.equal(row.created_by, 'environment');
    assert.notEqual(row.password_hash, ADMIN);
    assert.ok(verifyPasswordSync(ADMIN, row.password_hash, row.password_salt));
    assert.equal(ctx.users.count(), 1);

    const named = makeApp({ adminPassword: ADMIN, adminUsername: 'boss' });
    assert.equal(named.users.findByUsername('boss').managed, 1);
    assert.equal(named.users.findByUsername('admin'), null);
});

test('without ADMIN_PASSWORD no account is made and accounts stay off', async () => {
    const ctx = makeApp({ adminUsername: 'boss' });
    assert.equal(ctx.users.count(), 0);
    await request(ctx.app).post('/api/auth/login').send({ username: 'boss', password: ADMIN }).expect(404);
});

test('a restart with the same ADMIN_PASSWORD changes nothing and signs nobody out', async () => {
    const db = connect(':memory:');
    const first = makeApp({ adminPassword: ADMIN }, { db });
    const agent = await signIn(first.app, 'admin', ADMIN);
    const before = { ...first.users.findByUsername('admin') };

    const second = makeApp({ adminPassword: ADMIN }, { db });
    const after = second.users.findByUsername('admin');
    assert.deepEqual({ ...after }, before);
    assert.equal(second.users.count(), 1);
    // the same session (same secret in the tests) still works on the restarted app
    const me = await request(second.app).get('/api/me').set('Cookie', agent.jar.getCookies({ path: '/', domain: '127.0.0.1', secure: false, script: false }).map(c => `${c.name}=${c.value}`)).expect(200);
    assert.equal(me.body.user && me.body.user.username, 'admin');
});

test('a new ADMIN_PASSWORD rehashes the account and ends the old sessions; the old password stops working', async () => {
    const db = connect(':memory:');
    const first = makeApp({ adminPassword: ADMIN }, { db });
    const login = await request(first.app).post('/api/auth/login').send({ username: 'admin', password: ADMIN }).expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const before = first.users.findByUsername('admin');

    const second = makeApp({ adminPassword: 'a-completely-new-password' }, { db });
    const after = second.users.findByUsername('admin');
    assert.notEqual(after.password_hash, before.password_hash);
    assert.equal(after.session_version, before.session_version + 1);
    assert.equal(after.id, before.id);
    assert.equal((await request(second.app).get('/api/me').set('Cookie', cookie)).body.user, null);
    await request(second.app).post('/api/auth/login').send({ username: 'admin', password: ADMIN }).expect(401);
    await request(second.app).post('/api/auth/login').send({ username: 'admin', password: 'a-completely-new-password' }).expect(200);
});

test('a regular user who already has the name stops the start with a clear message; nothing is taken over', () => {
    const db = connect(':memory:');
    const users = new UserModel(db);
    const hashed = hashPasswordSync(PASSWORD);
    users.create({ username: 'admin', hash: hashed.hash, salt: hashed.salt, role: 'user' });

    const config = loadConfig({}, { adminPassword: ADMIN });
    assert.throws(() => syncAdminUser({ users, config }), /A user named "admin" already exists.*another name, or delete that user/);
    // The same through the app (app.js prints "Stashly cannot start: ..." and exits)
    assert.throws(() => makeApp({ adminPassword: ADMIN }, { db }), /already exists/);
    const row = users.findByUsername('admin');
    assert.equal(row.managed, 0);
    assert.equal(row.role, 'user');
    assert.ok(verifyPasswordSync(PASSWORD, row.password_hash, row.password_salt));
    // Nothing is done while the admin area is off
    assert.equal(syncAdminUser({ users, config: loadConfig({}) }), 'unchanged');
});

test('syncAdminUser says what it did: created, unchanged, updated; a row someone edited in the database is put back', () => {
    const users = new UserModel(connect(':memory:'));
    const config = loadConfig({}, { adminPassword: ADMIN });
    assert.equal(syncAdminUser({ users, config }), 'created');
    assert.equal(syncAdminUser({ users, config }), 'unchanged');
    const id = users.findByUsername('admin').id;
    users.db.prepare("UPDATE users SET role = 'user', disabled = 1 WHERE id = ?").run(id);
    assert.equal(syncAdminUser({ users, config }), 'updated');
    const row = users.findById(id);
    assert.equal(row.role, 'admin');
    assert.equal(row.disabled, 0);
    assert.equal(row.session_version, 1);
});

test('changing ADMIN_USERNAME releases the old managed account: an ordinary, disabled user that can be deleted', () => {
    const db = connect(':memory:');
    const users = new UserModel(db);
    const lines = [];
    syncAdminUser({ users, config: loadConfig({}, { adminPassword: ADMIN, adminUsername: 'first' }) });
    syncAdminUser({ users, config: loadConfig({}, { adminPassword: ADMIN, adminUsername: 'second' }), log: line => lines.push(line) });
    const old = users.findByUsername('first');
    assert.equal(old.managed, 0);
    assert.equal(old.disabled, 1);
    assert.equal(users.findByUsername('second').managed, 1);
    assert.equal(users.managedUsers().length, 1);
    assert.match(lines[0], /"first".*disabled/);
});

// ---- one sign-in, the role decides ----

test('the admin signs in with ADMIN_USERNAME and ADMIN_PASSWORD and gets an admin session that opens the admin area', async () => {
    const ctx = makeApp({ adminPassword: ADMIN, adminUsername: 'boss' });
    const agent = request.agent(ctx.app);
    const res = await agent.post('/api/auth/login').send({ username: ' BOSS ', password: ADMIN }).expect(200);
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.managed, true);
    assert.doesNotMatch(JSON.stringify(res.body), /hash|salt/i);
    assert.deepEqual((await agent.get('/api/admin/status')).body, { enabled: true, signedIn: true, via: 'account' });
    await agent.get('/api/admin/overview').expect(200);
    const users = await agent.get('/api/admin/users').expect(200);
    assert.deepEqual(users.body.users.map(u => [u.username, u.managed]), [['boss', true]]);
    await agent.get('/api/admin/settings').expect(200);
    // The admin is a normal account too: it follows stashes
    await request(ctx.app).post('/api/stashes').send({ slug: 'some-stash' }).expect(201);
    await agent.post('/api/me/stashes').send({ slug: 'some-stash' }).expect(200);
    assert.equal((await agent.get('/api/me/stashes')).body.stashes.length, 1);
});

test('a regular user signs in on the same page and does not get the admin area', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const root = await signIn(ctx.app, 'admin', ADMIN);
    await root.post('/api/admin/users').send({ username: 'sam', password: PASSWORD, role: 'user' }).expect(201);
    const sam = await signIn(ctx.app, 'sam', PASSWORD);
    assert.equal((await sam.get('/api/me')).body.user.role, 'user');
    assert.deepEqual((await sam.get('/api/admin/status')).body, { enabled: true, signedIn: false });
    await sam.get('/api/admin/overview').expect(403);
    await sam.get('/api/admin/users').expect(403);
    // the admin password does not open anything for a user who tries it on the old login either
    await sam.post('/api/admin/login').send({ password: PASSWORD }).expect(401);
});

test('a wrong password is the same generic answer as for an unknown user, and the admin account is locked out like any other', async () => {
    const ctx = makeApp({ adminPassword: ADMIN, stashUnlockFailures: 3 });
    const wrong = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'not the password' }).expect(401);
    const unknown = await request(ctx.app).post('/api/auth/login').send({ username: 'nobody', password: 'not the password' }).expect(401);
    assert.equal(wrong.body.error, unknown.body.error);
    for (let i = 0; i < 2; i++) await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'not the password' }).expect(401);
    // Locked after STASH_UNLOCK_FAILURES wrong passwords: even the right one is refused for a while
    const locked = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: ADMIN }).expect(429);
    assert.match(locked.body.error, /Too many wrong attempts/);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 16 * 60 * 1000);
    await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: ADMIN }).expect(200);
});

test('the failure rate limit applies to the admin account name too', async () => {
    const ctx = makeApp({ adminPassword: ADMIN, rateUserLogin: 3 });
    for (let i = 0; i < 3; i++) await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: `wrong ${i}` }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: ADMIN }).expect(429);
});

test('the old script login, POST /api/admin/login with only the password, still works', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const legacy = request.agent(ctx.app);
    await legacy.post('/api/admin/login').send({ password: 'wrong' }).expect(401);
    await legacy.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    assert.deepEqual((await legacy.get('/api/admin/status')).body, { enabled: true, signedIn: true, via: 'password' });
    await legacy.get('/api/admin/overview').expect(200);
    await legacy.get('/api/admin/users').expect(200);
    await legacy.post('/api/admin/logout').expect(200);
    await legacy.get('/api/admin/overview').expect(401);
});

// ---- the managed account cannot be edited anywhere ----

test('nobody can change the environment account: reset, role, disable, delete, sign-out and its own password are refused', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const boss = await signIn(ctx.app, 'admin', ADMIN);
    const legacy = request.agent(ctx.app);
    await legacy.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    await boss.post('/api/admin/users').send({ username: 'other-admin', password: PASSWORD, role: 'admin' }).expect(201);
    const other = await signIn(ctx.app, 'other-admin', PASSWORD);

    const list = (await boss.get('/api/admin/users')).body.users;
    const self = list.find(u => u.username === 'admin');
    assert.equal(self.managed, true);
    assert.equal(list.find(u => u.username === 'other-admin').managed, false);

    const before = { ...ctx.users.findByUsername('admin') };
    for (const agent of [boss, legacy, other]) {
        for (const [method, url, body] of [
            ['patch', `/api/admin/users/${self.id}`, { role: 'user' }],
            ['patch', `/api/admin/users/${self.id}`, { disabled: true }],
            ['patch', `/api/admin/users/${self.id}`, { displayName: 'Renamed' }],
            ['post', `/api/admin/users/${self.id}/password`, { password: 'another good password' }],
            ['post', `/api/admin/users/${self.id}/sign-out`, {}],
            ['delete', `/api/admin/users/${self.id}`, {}],
        ]) {
            const res = await agent[method](url).send(body).expect(409);
            assert.equal(res.body.error, MANAGED, `${method} ${url}`);
        }
    }
    assert.deepEqual({ ...ctx.users.findByUsername('admin') }, before);

    // It cannot change its own password either (that is ADMIN_PASSWORD in the environment)
    const own = await boss.post('/api/me/password').send({ currentPassword: ADMIN, newPassword: 'another good password' }).expect(409);
    assert.equal(own.body.error, MANAGED);
    await signIn(ctx.app, 'admin', ADMIN);
    // ...but another admin account can change its own
    await other.post('/api/me/password').send({ currentPassword: PASSWORD, newPassword: 'another good password' }).expect(200);
});

test('the admin cannot create a user with the reserved ADMIN_USERNAME, in any case', async () => {
    const ctx = makeApp({ adminPassword: ADMIN, adminUsername: 'boss' });
    const boss = await signIn(ctx.app, 'boss', ADMIN);
    for (const username of ['boss', 'BOSS', 'Boss']) {
        const res = await boss.post('/api/admin/users').send({ username, password: PASSWORD }).expect(409);
        assert.equal(res.body.field, 'username');
    }
    assert.equal(ctx.users.count(), 1);
});

test('an audit line is written for the admin account like for any sign-in, without the name or the password', async () => {
    const lines = [];
    const ctx = makeApp({ adminPassword: ADMIN, auditLog: 'stdout' }, { auditOut: line => lines.push(line) });
    await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'wrong wrong' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: ADMIN }).expect(200);
    const text = lines.join('\n');
    assert.match(text, /user\.login_failed/);
    assert.match(text, /user\.login_succeeded/);
    assert.ok(!text.includes(ADMIN));
    assert.doesNotMatch(text, /"admin"[^}]*password/);
});

// ---- the pages ----

test('/admin has no password form: nobody signed in is sent to the account page and back, a plain user is told it is not an admin page', async () => {
    const html = views('admin.html');
    assert.doesNotMatch(html, /Admin password|autocomplete="current-password"/);
    assert.doesNotMatch(html, /id="loginForm"|id="loginInput"|stateLogin/);
    assert.match(html, /Sign in to open the admin area/);
    assert.match(html, /href="\/account\?next=%2Fadmin"/);
    assert.match(html, /This account is not an admin/);
    assert.match(html, /<a class="button-link" href="\/account">My stashes<\/a>/);
    assert.doesNotMatch(html, /A user with the admin role signs in/);

    const js = views('admin.js');
    assert.doesNotMatch(js, /api\/admin\/login/);
    // Sign out calls both: the account's and the old admin cookie's
    assert.match(js, /\/api\/auth\/logout/);
    assert.match(js, /\/api\/admin\/logout/);
    assert.match(js, /Set in the server environment/);
});

test('the account page is the one sign-in and says the admin signs in there too, without printing the admin username', async () => {
    const ctx = makeApp({ adminPassword: ADMIN, adminUsername: 'secretish-boss' });
    const html = (await request(ctx.app).get('/account').expect(200)).text;
    assert.match(html, /id="loginForm"/);
    assert.match(html, /The admin signs in here too/);
    assert.ok(!html.includes('secretish-boss'));
    assert.ok(!(await request(ctx.app).get('/api/config')).text.includes('secretish-boss'));
    assert.ok(!(await request(ctx.app).get('/api/me')).text.includes('secretish-boss'));
});

// The same function as in account.js, taken from the file so the test checks what the browser runs
function loadNextTarget() {
    const source = views('account.js');
    const match = /function nextTarget\(search\) \{[\s\S]*?\n    \}\n/.exec(source);
    assert.ok(match, 'nextTarget is in account.js');
    return new Function(`${match[0]}; return nextTarget;`)();
}

test('after sign-in only next=/admin is followed; any other value is ignored (no open redirect)', () => {
    const nextTarget = loadNextTarget();
    assert.equal(nextTarget('?next=%2Fadmin'), '/admin');
    assert.equal(nextTarget('?next=/admin'), '/admin');
    assert.equal(nextTarget('?a=1&next=%2Fadmin'), '/admin');
    for (const search of [
        '', '?', '?next=', '?next=%2Fadmin%2F', '?next=%2Fadmin%2Fusers', '?next=%2Fadmin%3Fx%3D1', '?next=%2FAdmin', '?next=admin',
        '?next=%2F%2Fevil.example', '?next=https%3A%2F%2Fevil.example', '?next=%2F%2Fevil.example%2Fadmin', '?next=%5C%5Cevil.example',
        '?next=javascript%3Aalert(1)', '?next=%2Faccount', '?next=%2F', '?next=%2Fadmin%0A', '?next=%E0%A4%A', '?prev=%2Fadmin',
    ]) {
        assert.equal(nextTarget(search), '', search);
    }
    // Only an admin who just signed in is sent, and only to what nextTarget returned
    const js = views('account.js');
    assert.match(js, /justSignedIn && me\.role === 'admin' && nextTarget\(location\.search\)/);
    assert.match(js, /location\.href = nextTarget\(location\.search\)/);
    assert.match(js, /passwordButton'\)\.classList\.toggle\('hidden', Boolean\(me\.managed\)\)/);
});
