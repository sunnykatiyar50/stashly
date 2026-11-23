// Stash owners: a signed-in user owns what they create (a guest's stash has no owner), the owner is always let in and
// always has the stash in their list, and an admin cannot take over an owned stash by choosing its password.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { DatabaseSync } = require('node:sqlite');
const { connect } = require('../src/database/sqlite');
const { makeApp } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';
const STASH_PASSWORD = 'a long stash password';

async function accountApp(overrides = {}) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides });
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    return { ...ctx, root };
}

async function addUser(ctx, username) {
    return (await ctx.root.post('/api/admin/users').send({ username, password: PASSWORD, role: 'user' }).expect(201)).body;
}

async function signIn(ctx, username) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
    return agent;
}

const overviewOf = async (ctx, slug) => (await ctx.root.get('/api/admin/overview').expect(200)).body.stashes.find(s => s.slug === slug);

test('a stash made by a signed-in user has that user as its owner; one made by a guest has none', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const sam = await signIn(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-stash-123' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'guests-stash-123' }).expect(201);

    const owned = await overviewOf(ctx, 'sams-stash-123');
    assert.equal(owned.owner, 'sam');
    assert.equal(owned.canResetPassword, false);
    const guest = await overviewOf(ctx, 'guests-stash-123');
    assert.equal(guest.owner, null);
    assert.equal(guest.canResetPassword, true);
});

test('the owner opens their own password-protected stash with no password and no cookie; nobody else does', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    await addUser(ctx, 'lee');
    const first = await signIn(ctx, 'sam');
    await first.post('/api/stashes').send({ slug: 'sams-locked-123', password: STASH_PASSWORD }).expect(201);

    // a brand new browser, signed in as the owner: no unlock cookie at all
    const again = await signIn(ctx, 'sam');
    const open = await again.get('/api/stashes/sams-locked-123').expect(200);
    assert.equal(open.body.role, 'full');
    assert.equal(open.body.owned, true);
    await again.post('/api/stashes/sams-locked-123/notes').send({ text: 'mine' }).expect(201);

    // another account, a guest and a guest with a cookie-less browser are locked out
    const lee = await signIn(ctx, 'lee');
    await lee.get('/api/stashes/sams-locked-123').expect(401);
    await request(ctx.app).get('/api/stashes/sams-locked-123').expect(401);
    // being signed in as a different user does not make the stash look owned
    await lee.post('/api/stashes/sams-locked-123/unlock').send({ password: STASH_PASSWORD }).expect(200);
    const unlocked = await lee.get('/api/stashes/sams-locked-123').expect(200);
    assert.equal(unlocked.body.owned, false);
});

test('own stashes are always in the list, first, with no way to unfollow; stashes a guest made can be followed and unfollowed', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');
    const agent = await signIn(ctx, 'sam');
    await request(ctx.app).post('/api/stashes').send({ slug: 'guests-locked-123', password: STASH_PASSWORD }).expect(201);
    await agent.post('/api/me/stashes').send({ slug: 'guests-locked-123', password: STASH_PASSWORD }).expect(200);
    await agent.post('/api/stashes').send({ slug: 'sams-stash-123' }).expect(201);

    let list = (await agent.get('/api/me/stashes').expect(200)).body.stashes;
    assert.deepEqual(list.map(s => [s.slug, s.owned]), [['sams-stash-123', true], ['guests-locked-123', false]]);
    assert.equal(list[0].role, 'full');
    assert.equal(list[0].needsPassword, false);

    // an own stash cannot be unfollowed
    const refused = await agent.delete('/api/me/stashes/sams-stash-123').expect(409);
    assert.equal(refused.body.owned, true);
    // a stash someone else made can
    await agent.delete('/api/me/stashes/guests-locked-123').expect(200);
    list = (await agent.get('/api/me/stashes').expect(200)).body.stashes;
    assert.deepEqual(list.map(s => s.slug), ['sams-stash-123']);

    // even if its row is lost, the list puts the owned stash back
    const stash = ctx.model.findBySlug('sams-stash-123');
    ctx.users.unfollow(sam.id, stash.id);
    list = (await agent.get('/api/me/stashes').expect(200)).body.stashes;
    assert.deepEqual(list.map(s => s.slug), ['sams-stash-123']);

    // following a stash you own is a harmless no-op that says so
    const follow = await agent.post('/api/me/stashes').send({ slug: 'sams-stash-123', current: true }).expect(200);
    assert.equal(follow.body.owned, true);
});

test('an owned stash never "needs the password again", even after its password changes', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const agent = await signIn(ctx, 'sam');
    await agent.post('/api/stashes').send({ slug: 'sams-locked-123', password: STASH_PASSWORD }).expect(201);

    // the owner changes it without the old password
    await agent.post('/api/stashes/sams-locked-123/password').send({ newPassword: 'a brand new password' }).expect(200);
    const list = (await agent.get('/api/me/stashes').expect(200)).body.stashes;
    assert.equal(list[0].needsPassword, false);
    assert.equal(list[0].owned, true);
    // the old password no longer opens it for anyone else; the new one does
    await request(ctx.app).post('/api/stashes/sams-locked-123/unlock').send({ password: STASH_PASSWORD }).expect(401);
    await request(ctx.app).post('/api/stashes/sams-locked-123/unlock').send({ password: 'a brand new password' }).expect(200);
});

test('only the owner may change the password without the current one', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    await addUser(ctx, 'lee');
    const sam = await signIn(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-locked-123', password: STASH_PASSWORD }).expect(201);

    const lee = await signIn(ctx, 'lee');
    await lee.post('/api/stashes/sams-locked-123/unlock').send({ password: STASH_PASSWORD }).expect(200);
    // lee knows the password, so lee has to give it again
    await lee.post('/api/stashes/sams-locked-123/password').send({ newPassword: 'lees new password' }).expect(401);
    await lee.post('/api/stashes/sams-locked-123/password').send({ currentPassword: STASH_PASSWORD, newPassword: 'lees new password' }).expect(200);
});

test('an admin cannot reset the password of an owned stash, can for a guest stash, and the stash shows that it happened', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const sam = await signIn(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-locked-123', password: STASH_PASSWORD }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'guests-locked-123', password: STASH_PASSWORD }).expect(201);

    const refused = await ctx.root.put('/api/admin/stashes/sams-locked-123/password').send({ password: 'chosen by the admin' }).expect(409);
    assert.match(refused.body.error, /has an owner/);
    // the owner still gets in with the old password and nothing was marked
    await request(ctx.app).post('/api/stashes/sams-locked-123/unlock').send({ password: STASH_PASSWORD }).expect(200);
    assert.equal((await sam.get('/api/stashes/sams-locked-123').expect(200)).body.passwordResetAt, null);

    await ctx.root.put('/api/admin/stashes/guests-locked-123/password').send({ password: 'chosen by the admin' }).expect(200);
    const holder = request.agent(ctx.app);
    await holder.post('/api/stashes/guests-locked-123/unlock').send({ password: 'chosen by the admin' }).expect(200);
    const marked = await holder.get('/api/stashes/guests-locked-123').expect(200);
    assert.equal(marked.body.passwordResetAt, ctx.clock.time.toISOString());

    // whoever holds the password choosing a new one clears the mark: the admin no longer knows the current one
    await holder.post('/api/stashes/guests-locked-123/password').send({ currentPassword: 'chosen by the admin', newPassword: 'chosen by the holder' }).expect(200);
    assert.equal((await holder.get('/api/stashes/guests-locked-123').expect(200)).body.passwordResetAt, null);
});

test('ADMIN_CAN_RESET_STASH_PASSWORDS turns the admin\'s reset off for every stash, and it can be switched in the settings', async () => {
    const off = await accountApp({ adminCanResetStashPasswords: false });
    await request(off.app).post('/api/stashes').send({ slug: 'guests-locked-123', password: STASH_PASSWORD }).expect(201);
    const refused = await off.root.put('/api/admin/stashes/guests-locked-123/password').send({ password: 'chosen by the admin' }).expect(403);
    assert.match(refused.body.error, /switched off/);
    assert.equal((await overviewOf(off, 'guests-locked-123')).canResetPassword, false);

    const on = await accountApp();
    await request(on.app).post('/api/stashes').send({ slug: 'guests-locked-123', password: STASH_PASSWORD }).expect(201);
    const field = (await on.root.get('/api/admin/settings').expect(200)).body.fields.find(f => f.key === 'adminCanResetStashPasswords');
    assert.equal(field.type, 'bool');
    assert.equal(field.value, true);
    await on.root.put('/api/admin/settings').send({ values: { adminCanResetStashPasswords: false } }).expect(200);
    await on.root.put('/api/admin/stashes/guests-locked-123/password').send({ password: 'chosen by the admin' }).expect(403);
});

test('ADMIN_CAN_RESET_STASH_PASSWORDS from the environment: on by default, off only when it says false', () => {
    const { loadConfig } = require('../src/config');
    assert.equal(loadConfig({}).adminCanResetStashPasswords, true);
    assert.equal(loadConfig({ ADMIN_CAN_RESET_STASH_PASSWORDS: '' }).adminCanResetStashPasswords, true);
    assert.equal(loadConfig({ ADMIN_CAN_RESET_STASH_PASSWORDS: 'true' }).adminCanResetStashPasswords, true);
    assert.equal(loadConfig({ ADMIN_CAN_RESET_STASH_PASSWORDS: 'false' }).adminCanResetStashPasswords, false);
});

test('deleting the owner makes their stash a guest stash: it stays, and its password still opens it', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');
    const agent = await signIn(ctx, 'sam');
    await agent.post('/api/stashes').send({ slug: 'sams-locked-123', password: STASH_PASSWORD }).expect(201);
    assert.equal((await overviewOf(ctx, 'sams-locked-123')).owner, 'sam');

    await ctx.root.delete(`/api/admin/users/${sam.id}`).expect(200);
    const after = await overviewOf(ctx, 'sams-locked-123');
    assert.ok(after, 'the stash is still there');
    assert.equal(after.owner, null);
    assert.equal(after.canResetPassword, true);
    await request(ctx.app).post('/api/stashes/sams-locked-123/unlock').send({ password: STASH_PASSWORD }).expect(200);
});

test('a database made before owners gets the new columns, and its stashes have no owner', () => {
    const db = connect(':memory:');
    const columns = db.prepare('PRAGMA table_info(stashes)').all().map(column => column.name);
    assert.ok(columns.includes('owner_id'));
    assert.ok(columns.includes('password_reset_at'));
    db.close();

    // the same step on a schema-7 database that already holds a stash
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    old.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    old.exec('CREATE TABLE stashes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)');
    old.exec("INSERT INTO stashes (slug, created_at) VALUES ('legacy-stash-123', '2026-01-01T00:00:00Z')");
    old.exec('ALTER TABLE stashes ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    old.exec('ALTER TABLE stashes ADD COLUMN password_reset_at TEXT');
    assert.equal(old.prepare('SELECT owner_id, password_reset_at FROM stashes').get().owner_id, null);
    old.close();
});

test('the admin stash list has an Owner column', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const view = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8');
    // a column of its own, right after the name, with "Guest" for a stash nobody owns
    assert.match(view('admin.html'), /<th>Name<\/th><th>Owner<\/th><th>Items<\/th>/);
    const admin = view('admin.js');
    assert.ok(admin.includes("stash.owner || 'Guest'"));
    assert.ok(admin.includes('stash.canResetPassword'));
});

test('the notice about an admin-chosen password offers the way to fix it and can be put away', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const view = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8');
    const html = view('stash.html');
    const notice = html.slice(html.indexOf('id="resetNotice"'), html.indexOf('id="composer"'));
    assert.ok(notice.includes('id="resetNoticeText"'), 'the words');
    assert.ok(notice.includes('id="resetNoticePassword"') && notice.includes('Change password'), 'the way to fix it');
    assert.ok(notice.includes('id="resetNoticeDismiss"') && notice.includes('Dismiss'), 'the way to put it away');
    assert.match(view('styles.css'), /\.notice-row\s*\{[^}]*display:\s*flex/, 'the buttons sit on the notice, not under it');

    // It opens the form itself instead of telling people to look for it, and changing the password clears the mark
    const options = view('stash-options.js');
    assert.ok(options.includes("$('resetNoticePassword').addEventListener('click'"));
    assert.ok(options.includes("openOptions('signin')"));
    assert.ok(options.includes('state.stash.passwordResetAt = null'));

    // Only someone who can change the password is offered the button; a read-only link is told who can
    const load = view('stash-load.js');
    assert.ok(load.includes("$('resetNoticePassword').classList.toggle('hidden', r !== 'full')"));
    assert.match(load, /Whoever knows the password can choose a new one/);
    assert.doesNotMatch(load, /change the password under Options/);
    // Dismissing is this browser's own memory, tied to that reset, so a later reset shows it again
    assert.ok(load.includes("'sl_reset_seen_'"));
    assert.ok(load.includes('resetAt === dismissedResetAt()'));
    assert.ok(load.includes("$('resetNoticeDismiss').addEventListener('click'"));
});
