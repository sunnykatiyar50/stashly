// Extending a stash: the owner of a stash (or anyone with full access to a guest's stash) can restart its timer or pick a longer
// length; an owned stash is its owner's to extend, so a person who only knows the password cannot, and the admin can only extend a
// guest's stash.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';
const STASH_PASSWORD = 'a long stash password';
const HOUR = 60 * 60 * 1000;
const advance = (ctx, ms) => { ctx.clock.time = new Date(ctx.clock.time.getTime() + ms); };

async function accountApp(overrides = {}, options = {}) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides }, options);
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    return { ...ctx, root };
}
async function user(ctx, username) {
    await ctx.root.post('/api/admin/users').send({ username, password: PASSWORD, role: 'user' }).expect(201);
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
    return agent;
}
const expiresOf = ctx => slug => ctx.model.findBySlug(slug).expires_at;
const overviewOf = async (ctx, slug) => (await ctx.root.get('/api/admin/overview').expect(200)).body.stashes.find(s => s.slug === slug);

test('a guest stash can be extended by anyone with full access: restart the timer, or pick a longer length', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'guest-extend-one', ttl: '1d' }).expect(201);
    const base = '/api/stashes/guest-extend-one';
    const start = ctx.clock.time.getTime();
    advance(ctx, 12 * HOUR);

    // Without a body: the same length again, from now (as before)
    const restart = await request(ctx.app).post(`${base}/extend`).expect(200);
    assert.equal(restart.body.expiresAt, new Date(ctx.clock.time.getTime() + 24 * HOUR).toISOString());

    // A longer length from the list
    const week = await request(ctx.app).post(`${base}/extend`).send({ ttl: '7d' }).expect(200);
    assert.equal(week.body.expiresAt, new Date(ctx.clock.time.getTime() + 7 * 24 * HOUR).toISOString());
    assert.equal(ctx.model.findBySlug('guest-extend-one').ttl_ms, 7 * 24 * HOUR, 'the stash now lives that long');
    assert.ok(new Date(week.body.expiresAt).getTime() > start + 24 * HOUR);

    // A length that ends sooner than it ends now is refused, and so is one that is not on the list
    const sooner = await request(ctx.app).post(`${base}/extend`).send({ ttl: '1h' }).expect(409);
    assert.equal(sooner.body.field, 'ttl');
    assert.match(sooner.body.error, /sooner/);
    await request(ctx.app).post(`${base}/extend`).send({ ttl: 'a fortnight' }).expect(400);
    assert.equal(expiresOf(ctx)('guest-extend-one'), week.body.expiresAt, 'nothing changed');
});

test('the stash tells the page what it can be extended to: only later lengths, the stash\'s own marked as the restart', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'choices-stash-1', ttl: '1d' }).expect(201);
    const first = (await request(ctx.app).get('/api/stashes/choices-stash-1').expect(200)).body;
    assert.equal(first.canExtend, true);
    // Right after making it, only the lengths longer than 1 day end later (and 1 day itself is the restart, no later than now)
    assert.deepEqual(first.extendChoices.map(c => c.key), ['7d', '30d']);
    assert.ok(first.extendChoices.every(c => c.label && c.restart === false && c.never === false));

    advance(ctx, 2 * HOUR);
    const later = (await request(ctx.app).get('/api/stashes/choices-stash-1').expect(200)).body;
    const one = later.extendChoices.find(c => c.key === '1d');
    assert.ok(one && one.restart === true, 'after a while 1 day ends later again, and it is the stash\'s own length');
    // The answer to an extend carries the new choices
    const done = await request(ctx.app).post('/api/stashes/choices-stash-1/extend').send({ ttl: '30d' }).expect(200);
    assert.equal(done.body.canExtend, true);
    assert.deepEqual(done.body.extendChoices, [], 'nothing is longer than 30 days');
});

test('"Never" is offered when the server allows it, and a stash that never expires has nothing to extend', async () => {
    const ctx = makeApp();
    ctx.settings.update({ allowNoExpiry: true });
    await request(ctx.app).post('/api/stashes').send({ slug: 'forever-stash-1', ttl: '7d' }).expect(201);
    const body = (await request(ctx.app).get('/api/stashes/forever-stash-1').expect(200)).body;
    assert.ok(body.extendChoices.some(c => c.key === 'never' && c.never === true));

    const never = await request(ctx.app).post('/api/stashes/forever-stash-1/extend').send({ ttl: 'never' }).expect(200);
    assert.equal(never.body.expiresAt, null);
    assert.equal(never.body.canExtend, false);
    assert.deepEqual(never.body.extendChoices, []);
    const row = ctx.model.findBySlug('forever-stash-1');
    assert.equal(row.expires_at, null);
    assert.equal(row.ttl_ms, null);
    assert.equal((await request(ctx.app).get('/api/stashes/forever-stash-1').expect(200)).body.canExtend, false);
    await request(ctx.app).post('/api/stashes/forever-stash-1/extend').send({ ttl: '30d' }).expect(400);
    await request(ctx.app).post('/api/stashes/forever-stash-1/extend').expect(400);
});

test('an owned stash is its owner\'s to extend: a person who only knows the password cannot', async () => {
    const ctx = await accountApp();
    const sam = await user(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-owned-extend', password: STASH_PASSWORD, ttl: '1d' }).expect(201);
    const base = '/api/stashes/sams-owned-extend';

    const owner = (await sam.get(base).expect(200)).body;
    assert.equal(owner.canExtend, true);
    assert.deepEqual(owner.extendChoices.map(c => c.key), ['7d', '30d']);
    const moved = await sam.post(`${base}/extend`).send({ ttl: '7d' }).expect(200);
    assert.equal(moved.body.expiresAt, new Date(ctx.clock.time.getTime() + 7 * 24 * HOUR).toISOString());

    // Full access by password: can read and add, but cannot change when it expires
    const knower = request.agent(ctx.app);
    await knower.post(`${base}/unlock`).send({ password: STASH_PASSWORD }).expect(200);
    await knower.post(`${base}/notes`).send({ text: 'welcome' }).expect(201);
    const view = (await knower.get(base).expect(200)).body;
    assert.equal(view.canExtend, false);
    assert.deepEqual(view.extendChoices, []);
    const refused = await knower.post(`${base}/extend`).send({ ttl: '30d' }).expect(403);
    assert.match(refused.body.error, /Only the owner/);
    await knower.post(`${base}/extend`).expect(403);
    // Nor can someone with a read-only link, or nobody signed in
    await request(ctx.app).post(`${base}/extend`).expect(401);
    assert.equal(expiresOf(ctx)('sams-owned-extend'), moved.body.expiresAt);
});

test('the admin can extend a guest stash but not one that has an owner, and the list says which', async () => {
    const ctx = await accountApp();
    const sam = await user(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-admin-extend', ttl: '1d' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'guests-admin-extend', ttl: '1d' }).expect(201);

    assert.equal((await overviewOf(ctx, 'sams-admin-extend')).canExtend, false);
    const guest = await overviewOf(ctx, 'guests-admin-extend');
    assert.equal(guest.canExtend, true);

    advance(ctx, 6 * HOUR);
    const before = ctx.model.findBySlug('sams-admin-extend').expires_at;
    const owned = await ctx.root.post('/api/admin/stashes/sams-admin-extend/extend').expect(409);
    assert.match(owned.body.error, /only the owner/);
    assert.equal(ctx.model.findBySlug('sams-admin-extend').expires_at, before, 'untouched');

    const done = await ctx.root.post('/api/admin/stashes/guests-admin-extend/extend').expect(200);
    // The answer says which stash and until when, so the page can say so
    assert.equal(done.body.slug, 'guests-admin-extend');
    assert.equal(done.body.expiresAt, new Date(ctx.clock.time.getTime() + 24 * HOUR).toISOString());

    // A stash that never expires has nothing to extend, owner or not
    ctx.settings.update({ allowNoExpiry: true });
    await request(ctx.app).post('/api/stashes').send({ slug: 'guests-never-admin', ttl: 'never' }).expect(201);
    assert.equal((await overviewOf(ctx, 'guests-never-admin')).canExtend, false);
    await ctx.root.post('/api/admin/stashes/guests-never-admin/extend').expect(400);
});

test('extending is audited by who did it, without the stash name', async () => {
    const audit = [];
    const ctx = await accountApp({ auditLog: 'stdout' }, { auditOut: line => audit.push(line) });
    const sam = await user(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'audited-extend-own', ttl: '1d' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'audited-extend-guest', ttl: '1d' }).expect(201);
    await sam.post('/api/stashes/audited-extend-own/extend').send({ ttl: '7d' }).expect(200);
    await ctx.root.post('/api/admin/stashes/audited-extend-guest/extend').expect(200);
    const events = audit.map(line => JSON.parse(line)).filter(e => /extended/.test(e.event));
    assert.deepEqual(events.map(e => [e.event, e.actor, e.detail]), [
        ['stash.extended', 'visitor', { by: 'owner', ttl: '7d' }],
        ['stash.extended_by_admin', 'admin', {}],
    ]);
    assert.ok(!audit.join('\n').includes('audited-extend'), 'no stash name in the log');
});

test('the pages carry the controls: the extend dialog, the clock chip as a button, Options > Expires, and the admin message', async () => {
    const ctx = makeApp({ adminPassword: ADMIN });
    const html = (await request(ctx.app).get('/s/any-stash-name').expect(200)).text;
    assert.match(html, /<dialog id="extendDialog"[^>]*aria-labelledby="extendTitle"/);
    assert.match(html, /id="extendChoices"/);
    assert.match(html, /data-option="expiry"[\s\S]*id="optExtendButton"/);
    const options = (await request(ctx.app).get('/stash-options.js').expect(200)).text;
    // One dialog for the Extend button, the clock chip and Options; it sends the chosen length
    assert.match(options, /\$\('extendButton'\)\.addEventListener\('click', openExtend\)/);
    assert.match(options, /expiryChip\.addEventListener\('click'/);
    assert.match(options, /\{ ttl: choice\.key \}/);
    // Only lengths that still end later are offered, and the message names the stash and when it ends
    assert.match(options, /Date\.now\(\) \+ choice\.ms > ends/);
    assert.match(options, /'Extended "' \+ slug \+ '"\. '/);
    const load = (await request(ctx.app).get('/stash-load.js').expect(200)).text;
    assert.match(load, /P\.paintExpiryAction\(\)/);
    const admin = (await request(ctx.app).get('/admin.js').expect(200)).text;
    assert.match(admin, /toast\('Extended "' \+ stash\.slug \+ '"\. It now ends '/);
    assert.match(admin, /just-extended/);
    const css = (await request(ctx.app).get('/styles.css').expect(200)).text;
    assert.match(css, /\.chip\.extendable \{ cursor: pointer; \}/);
    assert.match(css, /\.table tr\.just-extended td \{ animation: extended-flash/);
});

test('Extend in Options opens the dialog on top of Options, so Cancel returns to Options instead of closing it', async () => {
    const ctx = makeApp();
    const options = (await request(ctx.app).get('/stash-options.js').expect(200)).text;
    assert.match(options, /\$\('optExtendButton'\)\.addEventListener\('click', openExtend\);/);
    assert.doesNotMatch(options, /\$\('optionsDialog'\)\.close\(\);\s*openExtend\(\)/);
    // Selecting clips is different: it needs the page, so that one does close Options
    assert.match(options, /\$\('optSelectClips'\)\.addEventListener\('click', function \(\) \{\s*\$\('optionsDialog'\)\.close\(\);/);
});

test('the listing says whether Never is allowed, and the Extend dialog explains when it is not', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'never-hint-stash', ttl: '1d' }).expect(201);
    const off = (await request(ctx.app).get('/api/stashes/never-hint-stash').expect(200)).body;
    assert.equal(off.neverAllowed, false);
    assert.ok(!off.extendChoices.some(c => c.never), 'no Never choice');
    ctx.settings.update({ allowNoExpiry: true });
    const on = (await request(ctx.app).get('/api/stashes/never-hint-stash').expect(200)).body;
    assert.equal(on.neverAllowed, true);
    assert.ok(on.extendChoices.some(c => c.never), 'a Never choice');

    const options = (await request(ctx.app).get('/stash-options.js').expect(200)).text;
    assert.match(options, /state\.stash\.expiresAt && !state\.stash\.neverAllowed/);
    assert.match(options, /Never is not offered: this server does not allow stashes that never expire\. An admin can turn it on in Admin > Settings > Stashes\./);
});
