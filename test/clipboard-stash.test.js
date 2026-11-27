// The Clipboard stash: a private stash made for a signed-in user, where their copied text is saved.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';

async function setup(overrides = {}) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides });
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    for (const username of ['olive', 'sam']) await root.post('/api/admin/users').send({ username, password: PASSWORD, role: 'user' }).expect(201);
    const signIn = async username => {
        const agent = request.agent(ctx.app);
        await agent.post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
        return agent;
    };
    return { ...ctx, olive: await signIn('olive'), sam: await signIn('sam') };
}

test('a user has no Clipboard stash until they ask, and asking makes one private stash they own', async () => {
    const ctx = await setup({ allowNoExpiry: true, ttlOptions: require('../src/config').loadConfig({ ALLOW_NO_EXPIRY: 'true' }).ttlOptions });
    assert.deepEqual((await ctx.olive.get('/api/me/clipboard').expect(200)).body, { slug: null, label: null });

    const made = await ctx.olive.post('/api/me/clipboard').expect(201);
    assert.equal(made.body.created, true);
    // The name is only a random key; the stash is called "Clipboard" wherever it is shown
    assert.match(made.body.slug, /^[a-z2-7]{12}$/);
    assert.doesNotMatch(made.body.slug, /clipboard/);
    assert.equal(made.body.label, 'Clipboard');

    const stash = (await ctx.olive.get(`/api/stashes/${made.body.slug}`).expect(200)).body;
    assert.equal(stash.label, 'Clipboard');
    assert.equal(stash.private, true);
    assert.equal(stash.owned, true);
    assert.equal(stash.hasPassword, false);
    assert.equal(stash.expiresAt, null, 'it does not expire when the server allows that');
    assert.deepEqual((await ctx.olive.get('/api/me/clipboard').expect(200)).body, { slug: made.body.slug, label: 'Clipboard' });

    // The owner can add text to it; nobody else can even see it is there
    await ctx.olive.post(`/api/stashes/${made.body.slug}/notes`).send({ text: 'copied text' }).expect(201);
    await ctx.sam.get(`/api/stashes/${made.body.slug}`).expect(404);
    await request(ctx.app).get(`/api/stashes/${made.body.slug}`).expect(404);
    const listed = (await ctx.olive.get('/api/me/stashes').expect(200)).body.stashes.find(s => s.slug === made.body.slug);
    assert.ok(listed && listed.owned);
    assert.equal(listed.label, 'Clipboard');
    // It cannot be renamed: its name is only a key
    await ctx.olive.post(`/api/stashes/${made.body.slug}/rename`).send({ slug: 'my-own-new-name' }).expect(403);
    // An ordinary stash has no label
    await ctx.olive.post('/api/stashes').send({ slug: 'an-ordinary-stash', password: 'stash password one' }).expect(201);
    assert.equal((await ctx.olive.get('/api/stashes/an-ordinary-stash').expect(200)).body.label, null);
});

test('asking again returns the same stash, and each user gets their own', async () => {
    const ctx = await setup();
    const first = (await ctx.olive.post('/api/me/clipboard').expect(201)).body;
    const again = await ctx.olive.post('/api/me/clipboard').expect(200);
    assert.deepEqual(again.body, { slug: first.slug, label: 'Clipboard', created: false });
    const sams = (await ctx.sam.post('/api/me/clipboard').expect(201)).body;
    assert.notEqual(sams.slug, first.slug);
    await ctx.sam.get(`/api/stashes/${first.slug}`).expect(404);
});

test('only a signed-in user has one', async () => {
    const ctx = await setup();
    await request(ctx.app).get('/api/me/clipboard').expect(401);
    await request(ctx.app).post('/api/me/clipboard').expect(401);
});

test('if the stash is deleted or expires, the next request makes a new one', async () => {
    const ctx = await setup();
    const first = (await ctx.olive.post('/api/me/clipboard').expect(201)).body;
    await ctx.olive.delete(`/api/stashes/${first.slug}`).expect(200);
    assert.deepEqual((await ctx.olive.get('/api/me/clipboard').expect(200)).body, { slug: null, label: null });
    const second = (await ctx.olive.post('/api/me/clipboard').expect(201)).body;
    assert.notEqual(second.slug, first.slug);
});

test('when the server does not allow stashes that never expire it lasts as long as the longest choice', async () => {
    const ctx = await setup();
    const made = (await ctx.olive.post('/api/me/clipboard').expect(201)).body;
    const stash = (await ctx.olive.get(`/api/stashes/${made.slug}`).expect(200)).body;
    assert.ok(stash.expiresAt, 'it has an end');
    const longest = Math.max(...ctx.config.ttlOptions.filter(o => o.ms).map(o => o.ms));
    assert.equal(new Date(stash.expiresAt) - ctx.clock.time, longest);
});

test('it is refused when this user may not create stashes', async () => {
    const ctx = await setup({ requireAdminToCreate: true });
    const refused = await ctx.olive.post('/api/me/clipboard').expect(403);
    assert.match(refused.body.error, /does not let you create/);
});

test('an older database gets the pointer column, empty for every user', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { connect, SCHEMA_VERSION } = require('../src/database/sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-clip-'));
    try {
        const file = path.join(dir, 'old.sqlite');
        connect(file).close();
        const raw = new DatabaseSync(file);
        raw.exec('ALTER TABLE users DROP COLUMN clipboard_stash_id');
        raw.exec('PRAGMA user_version = 14');
        raw.close();
        const db = connect(file);
        assert.ok(db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'clipboard_stash_id'));
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an older database gets the label column, and a Clipboard stash made before it is labelled', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { connect } = require('../src/database/sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-label-'));
    try {
        const file = path.join(dir, 'old.sqlite');
        connect(file).close();
        const raw = new DatabaseSync(file);
        raw.exec('ALTER TABLE stashes DROP COLUMN label');
        raw.exec('PRAGMA user_version = 15');
        raw.exec("INSERT INTO stashes (slug, created_at) VALUES ('keyonly', '2025-01-01T00:00:00Z'), ('plain-one', '2025-01-01T00:00:00Z')");
        raw.exec("INSERT INTO users (username, password_hash, password_salt, role, created_at, clipboard_stash_id) VALUES ('olive', 'h', 's', 'user', '2025-01-01T00:00:00Z', 1)");
        raw.close();
        const db = connect(file);
        const labels = Object.fromEntries(db.prepare('SELECT slug, label FROM stashes').all().map(r => [r.slug, r.label]));
        assert.deepEqual(labels, { keyonly: 'Clipboard', 'plain-one': null });
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---- the display name of any stash an owner has ----

test('the owner can give a stash a display name that need not be unique; the stash is still opened by its name', async () => {
    const ctx = await setup();
    await ctx.olive.post('/api/stashes').send({ slug: 'olives-stash-one', password: 'stash password one' }).expect(201);
    await ctx.sam.post('/api/stashes').send({ slug: 'sams-stash-one', password: 'stash password one' }).expect(201);
    const set = (agent, slug, name) => agent.put(`/api/stashes/${slug}/display-name`).send({ name });

    // Two users can both call their stash the same thing; the names (keys) stay unique
    assert.deepEqual((await set(ctx.olive, 'olives-stash-one', 'Work notes').expect(200)).body, { label: 'Work notes' });
    assert.deepEqual((await set(ctx.sam, 'sams-stash-one', 'Work notes').expect(200)).body, { label: 'Work notes' });
    const view = (await ctx.olive.get('/api/stashes/olives-stash-one').expect(200)).body;
    assert.equal(view.label, 'Work notes');
    assert.equal(view.slug, 'olives-stash-one');
    assert.equal(view.clipboard, false);
    const listed = (await ctx.olive.get('/api/me/stashes').expect(200)).body.stashes.find(s => s.slug === 'olives-stash-one');
    assert.equal(listed.label, 'Work notes');

    // It is not a way to find or open a stash: typing it where a name goes finds nothing
    await request(ctx.app).get('/api/stashes/work%20notes/exists').expect(404);
    await request(ctx.app).get('/api/stashes/olives-stash-one/exists').expect(200);

    // Spaces are tidied, control characters go, empty clears it
    assert.equal((await set(ctx.olive, 'olives-stash-one', '  My   big\tlist\n ').expect(200)).body.label, 'My big list');
    assert.equal((await set(ctx.olive, 'olives-stash-one', '').expect(200)).body.label, null);
    assert.equal((await set(ctx.olive, 'olives-stash-one', 'Work notes').expect(200)).body.label, 'Work notes');
    assert.equal((await set(ctx.olive, 'olives-stash-one', null).expect(200)).body.label, null);
    await set(ctx.olive, 'olives-stash-one', 'x'.repeat(61)).expect(400);
    await set(ctx.olive, 'olives-stash-one', 42).expect(400);
});

test('only the owner can set a display name; a guest stash and the Clipboard stash cannot have one', async () => {
    const ctx = await setup();
    await ctx.olive.post('/api/stashes').send({ slug: 'olives-stash-two' }).expect(201);
    // Someone who is not the owner, signed in or not
    await ctx.sam.put('/api/stashes/olives-stash-two/display-name').send({ name: 'Mine now' }).expect(403);
    await request(ctx.app).put('/api/stashes/olives-stash-two/display-name').send({ name: 'Mine now' }).expect(403);
    // A guest stash has no owner: it is shown by its name
    await request(ctx.app).post('/api/stashes').send({ slug: 'a-guest-stash-one' }).expect(201);
    const guest = await request(ctx.app).put('/api/stashes/a-guest-stash-one/display-name').send({ name: 'Nope' }).expect(403);
    assert.match(guest.body.error, /no owner/);
    // The Clipboard stash is always Clipboard
    const clip = (await ctx.olive.post('/api/me/clipboard').expect(201)).body;
    await ctx.olive.put(`/api/stashes/${clip.slug}/display-name`).send({ name: 'Secrets' }).expect(403);
    assert.equal((await ctx.olive.get(`/api/stashes/${clip.slug}`).expect(200)).body.clipboard, true);
    assert.equal((await ctx.olive.get('/api/me/stashes').expect(200)).body.stashes.find(s => s.slug === clip.slug).clipboard, true);
});

test('a stash with a display name can still be renamed (its name, the key), and keeps the display name', async () => {
    const ctx = await setup();
    await ctx.olive.post('/api/stashes').send({ slug: 'olives-stash-three' }).expect(201);
    await ctx.olive.put('/api/stashes/olives-stash-three/display-name').send({ name: 'Keep me' }).expect(200);
    await ctx.olive.post('/api/stashes/olives-stash-three/rename').send({ slug: 'olives-renamed-three' }).expect(200);
    assert.equal((await ctx.olive.get('/api/stashes/olives-renamed-three').expect(200)).body.label, 'Keep me');
});

// ---- saving copied text ----

const save = (agent, text, device) => agent.post('/api/me/clipboard/notes').send({ text, device });
const noteList = async (agent, slug) => (await agent.get(`/api/stashes/${slug}`).expect(200)).body.items;

test('saving copied text makes the Clipboard stash when there is none, and tags the note with the device', async () => {
    const ctx = await setup();
    const first = await save(ctx.olive, 'first copy', 'Chrome Windows').expect(201);
    assert.equal(first.body.saved, true);
    // The stash was made by saving, and it is the same one the account then has
    assert.deepEqual((await ctx.olive.get('/api/me/clipboard').expect(200)).body, { slug: first.body.slug, label: 'Clipboard' });
    const items = await noteList(ctx.olive, first.body.slug);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'first copy');
    assert.deepEqual(items[0].tags, ['chrome-windows']);
    // It can be filtered by that device like any tag
    const filtered = (await ctx.olive.get(`/api/stashes/${first.body.slug}?tag=chrome-windows`).expect(200)).body;
    assert.equal(filtered.total, 1);
});

test('text that repeats the newest note is skipped, however many devices send it; older text is saved again', async () => {
    const ctx = await setup();
    const a = await save(ctx.olive, 'same text', 'Chrome Windows').expect(201);
    const dup = await save(ctx.olive, 'same text', 'Safari iOS').expect(200);
    assert.deepEqual(dup.body, { saved: false, duplicate: true, slug: a.body.slug });
    await save(ctx.olive, 'something else', 'Safari iOS').expect(201);
    await save(ctx.olive, 'same text', 'Chrome Windows').expect(201);
    const texts = (await noteList(ctx.olive, a.body.slug)).map(i => i.text);
    assert.deepEqual(texts.sort(), ['same text', 'same text', 'something else']);
});

test('the device name is tidied into a tag, and a name with nothing usable just leaves the note untagged', async () => {
    const ctx = await setup();
    const one = await save(ctx.olive, 'one', '  Chrome / Windows 11!! ').expect(201);
    await save(ctx.olive, 'two', '???').expect(201);
    await save(ctx.olive, 'three').expect(201);
    await save(ctx.olive, 'four', 'x'.repeat(60)).expect(201);
    const byText = Object.fromEntries((await noteList(ctx.olive, one.body.slug)).map(i => [i.text, i.tags]));
    assert.deepEqual(byText.one, ['chrome-windows-11']);
    assert.deepEqual(byText.two, []);
    assert.deepEqual(byText.three, []);
    assert.equal(byText.four.length, 1);
    assert.ok(byText.four[0].length <= 24);
});

test('saving needs a sign-in, some text, and text within the note size', async () => {
    const ctx = await setup({ maxNoteBytes: 100 });
    await request(ctx.app).post('/api/me/clipboard/notes').send({ text: 'hi' }).expect(401);
    await save(ctx.olive, '   ').expect(400);
    await save(ctx.olive, 42).expect(400);
    await save(ctx.olive, 'x'.repeat(101)).expect(413);
    await save(ctx.olive, 'x'.repeat(100)).expect(201);
});

test('each user saves to their own Clipboard stash, which nobody else can open', async () => {
    const ctx = await setup();
    const olive = await save(ctx.olive, 'olive secret', 'Chrome Windows').expect(201);
    const sam = await save(ctx.sam, 'olive secret', 'Chrome Windows').expect(201);
    assert.notEqual(olive.body.slug, sam.body.slug);
    await ctx.sam.get(`/api/stashes/${olive.body.slug}`).expect(404);
});

test('a new Clipboard stash is made again if the old one is gone', async () => {
    const ctx = await setup();
    const first = await save(ctx.olive, 'before').expect(201);
    await ctx.olive.delete(`/api/stashes/${first.body.slug}`).expect(200);
    const second = await save(ctx.olive, 'before').expect(201);
    assert.notEqual(second.body.slug, first.body.slug);
});
