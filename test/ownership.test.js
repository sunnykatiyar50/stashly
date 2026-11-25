// Changing who owns a stash: an admin can give a stash that has no owner to a user, and an owner can pass it on to another user.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';
const STASH_PASSWORD = 'a long stash password';

async function accountApp(overrides = {}, options = {}) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides }, options);
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    return { ...ctx, root };
}
const addUser = async (ctx, username) => (await ctx.root.post('/api/admin/users').send({ username, password: PASSWORD, role: 'user' }).expect(201)).body;
async function signIn(ctx, username) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
    return agent;
}
const overviewOf = async (ctx, slug) => (await ctx.root.get('/api/admin/overview').expect(200)).body.stashes.find(s => s.slug === slug);
const mine = async agent => (await agent.get('/api/me/stashes').expect(200)).body.stashes;
const guestStash = (ctx, slug, body = {}) => request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);

// ---- an admin gives a guest's stash an owner ----

test('an admin can give a stash with no owner to a user, who then owns it: in their list, first, marked Owner, opened with no password', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const sam = await signIn(ctx, 'sam');
    await guestStash(ctx, 'guests-open-stash');
    await guestStash(ctx, 'guests-locked-stash', { password: STASH_PASSWORD });
    assert.equal((await overviewOf(ctx, 'guests-open-stash')).canSetOwner, true);

    const set = await ctx.root.post('/api/admin/stashes/guests-open-stash/owner').send({ username: 'Sam' }).expect(200);
    assert.deepEqual(set.body, { ok: true, owner: 'sam' });
    const row = await overviewOf(ctx, 'guests-open-stash');
    assert.equal(row.owner, 'sam');
    assert.equal(row.canSetOwner, false, 'it has an owner now');
    assert.equal(row.canResetPassword, false, 'and so the admin cannot reset its password');

    const list = await mine(sam);
    assert.deepEqual(list.map(s => [s.slug, s.owned, s.role]), [['guests-open-stash', true, 'full']]);

    // A password-protected one is opened by its owner with no password and no cookie
    await ctx.root.post('/api/admin/stashes/guests-locked-stash/owner').send({ username: 'sam' }).expect(200);
    await sam.post('/api/stashes/guests-locked-stash/notes').send({ text: 'in without the password' }).expect(201);
    await request(ctx.app).post('/api/stashes/guests-locked-stash/notes').send({ text: 'a stranger' }).expect(401);
});

test('an admin cannot change who owns a stash that already has an owner, and cannot name an unknown or disabled user', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');
    await addUser(ctx, 'kim');
    const samAgent = await signIn(ctx, 'sam');
    await samAgent.post('/api/stashes').send({ slug: 'sams-owned-stash' }).expect(201);
    const owned = await ctx.root.post('/api/admin/stashes/sams-owned-stash/owner').send({ username: 'kim' }).expect(409);
    assert.match(owned.body.error, /already has an owner/);
    assert.equal((await overviewOf(ctx, 'sams-owned-stash')).owner, 'sam');

    await guestStash(ctx, 'guests-stash-123');
    const unknown = await ctx.root.post('/api/admin/stashes/guests-stash-123/owner').send({ username: 'nobody' }).expect(404);
    assert.equal(unknown.body.field, 'username');
    await ctx.root.post('/api/admin/stashes/guests-stash-123/owner').send({}).expect(404);
    await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ disabled: true }).expect(200);
    // A disabled account is refused with the same answer as one that does not exist
    const kimGone = await ctx.root.post('/api/admin/stashes/guests-stash-123/owner').send({ username: 'sam' }).expect(404);
    assert.deepEqual(kimGone.body, unknown.body);
    assert.equal((await overviewOf(ctx, 'guests-stash-123')).owner, null);
    await ctx.root.post('/api/admin/stashes/no-such-stash-here/owner').send({ username: 'kim' }).expect(404);
});

test('only the admin can set an owner', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    await guestStash(ctx, 'guests-stash-456');
    const sam = await signIn(ctx, 'sam');
    for (const who of [request(ctx.app), sam]) {
        const res = await who.post('/api/admin/stashes/guests-stash-456/owner').send({ username: 'sam' });
        assert.ok([401, 403, 404].includes(res.status), `status ${res.status}`);
    }
    assert.equal((await overviewOf(ctx, 'guests-stash-456')).owner, null);
});

test('on a password-protected stash an admin can only set an owner while the admin may reset stash passwords: both give a way in', async () => {
    const ctx = await accountApp({ adminCanResetStashPasswords: false });
    await addUser(ctx, 'sam');
    await guestStash(ctx, 'guests-locked-one', { password: STASH_PASSWORD });
    await guestStash(ctx, 'guests-open-one');
    assert.equal((await overviewOf(ctx, 'guests-locked-one')).canSetOwner, false);
    assert.equal((await overviewOf(ctx, 'guests-open-one')).canSetOwner, true, 'an open stash gives nothing extra, so it is fine');
    const refused = await ctx.root.post('/api/admin/stashes/guests-locked-one/owner').send({ username: 'sam' }).expect(403);
    assert.match(refused.body.error, /switched off/);
    await ctx.root.post('/api/admin/stashes/guests-open-one/owner').send({ username: 'sam' }).expect(200);
});

// ---- the owner passes it on ----

test('an owner can transfer a stash to another user: the new owner owns it, the previous owner stays on as a follower with the access they had', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    await addUser(ctx, 'kim');
    const sam = await signIn(ctx, 'sam');
    const kim = await signIn(ctx, 'kim');
    await sam.post('/api/stashes').send({ slug: 'sams-to-give-away', password: STASH_PASSWORD }).expect(201);
    await sam.post('/api/stashes/sams-to-give-away/notes').send({ text: 'a note' }).expect(201);
    assert.deepEqual(await mine(kim), []);

    const moved = await sam.post('/api/stashes/sams-to-give-away/owner').send({ username: ' KIM ' }).expect(200);
    assert.deepEqual(moved.body, { ok: true, owner: 'kim' });
    assert.equal((await overviewOf(ctx, 'sams-to-give-away')).owner, 'kim');

    // Kim owns it: in her list, first, with full access and no password
    const kimList = await mine(kim);
    assert.deepEqual(kimList.map(s => [s.slug, s.owned, s.role, s.items]), [['sams-to-give-away', true, 'full', 1]]);
    await kim.post('/api/stashes/sams-to-give-away/notes').send({ text: 'from the new owner' }).expect(201);
    assert.equal((await kim.get('/api/stashes/sams-to-give-away').expect(200)).body.owned, true);

    // Sam is not the owner any more, but is not locked out: he follows it with full access until the password changes
    const samList = await mine(sam);
    assert.deepEqual(samList.map(s => [s.slug, s.owned, s.role]), [['sams-to-give-away', false, 'full']]);
    const asSam = (await sam.get('/api/stashes/sams-to-give-away').expect(200)).body;
    assert.equal(asSam.owned, false);
    assert.equal(asSam.role, 'full');
    await sam.post('/api/stashes/sams-to-give-away/owner').send({ username: 'sam' }).expect(403);

    // The new owner can end that by choosing a new password, without the old one, and Sam is then asked for it
    await kim.post('/api/stashes/sams-to-give-away/password').send({ newPassword: 'a brand new password' }).expect(200);
    await sam.get('/api/stashes/sams-to-give-away').expect(401);
    assert.equal((await mine(sam))[0].needsPassword, true);
    assert.equal((await mine(kim))[0].owned, true);
});

test('only the owner can transfer; a password-knowing visitor, a follower, a link holder and an admin cannot', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    await addUser(ctx, 'kim');
    const sam = await signIn(ctx, 'sam');
    const kim = await signIn(ctx, 'kim');
    await sam.post('/api/stashes').send({ slug: 'sams-guarded-stash', password: STASH_PASSWORD }).expect(201);
    const base = '/api/stashes/sams-guarded-stash';

    // Someone who knows the password has full access, but is not the owner
    const knower = request.agent(ctx.app);
    await knower.post(`${base}/unlock`).send({ password: STASH_PASSWORD }).expect(200);
    assert.match((await knower.post(`${base}/owner`).send({ username: 'kim' }).expect(403)).body.error, /Only the owner/);
    // A signed-in user who unlocked it with the password is a follower, not the owner
    await kim.post(`${base}/unlock`).send({ password: STASH_PASSWORD }).expect(200);
    await kim.post(`${base}/owner`).send({ username: 'kim' }).expect(403);
    // Nobody signed in, and a read-only link
    await request(ctx.app).post(`${base}/owner`).send({ username: 'kim' }).expect(401);
    const link = (await sam.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body.token;
    const reader = request.agent(ctx.app);
    await reader.post(`${base}/redeem`).send({ token: link }).expect(200);
    await reader.post(`${base}/owner`).send({ username: 'kim' }).expect(403);
    // The admin has no route for an owned stash
    const admin = await ctx.root.post('/api/admin/stashes/sams-guarded-stash/owner').send({ username: 'kim' }).expect(409);
    assert.match(admin.body.error, /already has an owner/);
    assert.equal((await overviewOf(ctx, 'sams-guarded-stash')).owner, 'sam');
});

test('a transfer needs an active user other than yourself, and says the same for a missing name and a disabled account', async () => {
    const ctx = await accountApp();
    await addUser(ctx, 'sam');
    const kim = await addUser(ctx, 'kim');
    const sam = await signIn(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-picky-stash' }).expect(201);
    const base = '/api/stashes/sams-picky-stash';
    const missing = await sam.post(`${base}/owner`).send({ username: 'nobody' }).expect(404);
    await sam.post(`${base}/owner`).send({}).expect(404);
    await sam.post(`${base}/owner`).send({ username: 12 }).expect(404);
    assert.equal(missing.body.field, 'username');
    assert.equal((await sam.post(`${base}/owner`).send({ username: 'sam' }).expect(400)).body.field, 'username');
    await ctx.root.patch(`/api/admin/users/${kim.id}`).send({ disabled: true }).expect(200);
    assert.deepEqual((await sam.post(`${base}/owner`).send({ username: 'kim' }).expect(404)).body, missing.body);
    assert.equal((await overviewOf(ctx, 'sams-picky-stash')).owner, 'sam');
});

test('ownership can be passed on again, and the stash goes to guests when its latest owner is deleted', async () => {
    const ctx = await accountApp();
    const sam = await addUser(ctx, 'sam');
    await addUser(ctx, 'kim');
    const samAgent = await signIn(ctx, 'sam');
    const kimAgent = await signIn(ctx, 'kim');
    await samAgent.post('/api/stashes').send({ slug: 'a-travelling-stash' }).expect(201);
    await samAgent.post('/api/stashes/a-travelling-stash/owner').send({ username: 'kim' }).expect(200);
    await kimAgent.post('/api/stashes/a-travelling-stash/owner').send({ username: 'sam' }).expect(200);
    assert.equal((await overviewOf(ctx, 'a-travelling-stash')).owner, 'sam');
    assert.equal((await mine(samAgent))[0].owned, true);
    assert.equal((await mine(kimAgent))[0].owned, false);

    // Deleting the owner's account hands it back to the guests, and the admin can give it an owner again
    await ctx.root.delete(`/api/admin/users/${sam.id}`).expect(200);
    const orphan = await overviewOf(ctx, 'a-travelling-stash');
    assert.equal(orphan.owner, null);
    assert.equal(orphan.canSetOwner, true);
    await ctx.root.post('/api/admin/stashes/a-travelling-stash/owner').send({ username: 'kim' }).expect(200);
    assert.equal((await overviewOf(ctx, 'a-travelling-stash')).owner, 'kim');
});

test('both changes are audited by who and to whom (a number), never by name, and nothing else changes in the stash', async () => {
    const audit = [];
    const ctx = await accountApp({ auditLog: 'stdout' }, { auditOut: line => audit.push(line) });
    const sam = await addUser(ctx, 'sam');
    const kim = await addUser(ctx, 'kim');
    const samAgent = await signIn(ctx, 'sam');
    await request(ctx.app).post('/api/stashes').send({ slug: 'audited-guest-stash' }).expect(201);
    await samAgent.post('/api/stashes').send({ slug: 'audited-owned-stash' }).expect(201);
    await samAgent.post('/api/stashes/audited-owned-stash/notes').send({ text: 'unchanged' }).expect(201);
    await ctx.root.post('/api/admin/stashes/audited-guest-stash/owner').send({ username: 'sam' }).expect(200);
    await samAgent.post('/api/stashes/audited-owned-stash/owner').send({ username: 'kim' }).expect(200);

    const events = audit.map(line => JSON.parse(line)).filter(e => /owner/.test(e.event));
    assert.deepEqual(events.map(e => [e.event, e.actor, e.detail]), [
        ['stash.owner_set_by_admin', 'admin', { user: sam.id }],
        ['stash.ownership_transferred', 'visitor', { to: kim.id }],
    ]);
    assert.ok(!audit.join('\n').includes('audited-guest-stash'), 'no stash name in the log');
    assert.equal((await kimItems(ctx, 'audited-owned-stash')).length, 1, 'the notes stay where they are');
});

async function kimItems(ctx, slug) {
    const kim = await signIn(ctx, 'kim');
    return (await kim.get(`/api/stashes/${slug}`).expect(200)).body.items;
}

test('the pages carry the controls: Set owner in the admin stash menu, and Owner in the stash options', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const admin = (await request(ctx.app).get('/admin').expect(200)).text;
    assert.match(admin, /id="ownerDialog"/);
    assert.match(admin, /id="ownerSelect"/);
    const adminJs = (await request(ctx.app).get('/admin.js').expect(200)).text;
    assert.match(adminJs, /stash\.canSetOwner/);
    assert.match(adminJs, /\/owner', \{ method: 'POST'/);

    const stash = (await request(ctx.app).get('/s/any-stash-name').expect(200)).text;
    assert.match(stash, /data-option="owner"/);
    assert.match(stash, /id="ownerToggle"/);
    const optionsJs = (await request(ctx.app).get('/stash-options.js').expect(200)).text;
    // shown to the owner only
    assert.match(optionsJs, /data-option="owner"\]'\)\.classList\.toggle\('hidden', !\(manage && state\.stash\.owned\)\)/);
    assert.match(optionsJs, /api\(base \+ '\/owner', \{ method: 'POST'/);
});

test('the Owner tag is green, Unfollow is red, and the stash page calls an owned stash Owner', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const account = (await request(ctx.app).get('/account.js').expect(200)).text;
    assert.match(account, /make\('span', 'chip owner-chip', 'Owner'\)/);
    assert.doesNotMatch(account, /'Yours'/);
    assert.match(account, /make\('button', 'ghost small danger-ghost', 'Unfollow'\)/);
    const stashPage = (await request(ctx.app).get('/stash-account.js').expect(200)).text;
    assert.match(stashPage, /owned \? 'Owner' : following \? 'Following' : 'Follow'/);
    const css = (await request(ctx.app).get('/styles.css').expect(200)).text;
    assert.match(css, /\.chip\.owner-chip \{ background: var\(--success-soft\); color: var\(--success\); \}/);
    assert.match(css, /#followStashButton\.is-owner[^{]*\{ color: var\(--success\)/);
    assert.match(css, /button\.danger-ghost \{ color: var\(--danger\)/);
});
