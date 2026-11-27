// A private stash: only its owner (a signed-in account) can open it. Passwords, share links and follows stop working
// while it is on, and come back when it is turned off. Links to single clips keep working.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';
const STASH_PASSWORD = 'stash password one';

async function setup() {
    const ctx = makeApp({ adminPassword: ADMIN });
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

// A stash olive made while signed in (with a password), plus a visitor who knows the password
async function privateSetup(slug = 'olives-private-stash') {
    const ctx = await setup();
    await ctx.olive.post('/api/stashes').send({ slug, password: STASH_PASSWORD }).expect(201);
    const base = `/api/stashes/${slug}`;
    await ctx.olive.post(`${base}/notes`).send({ text: 'secret note' }).expect(201);
    const visitor = request.agent(ctx.app);
    await visitor.post(`${base}/unlock`).send({ password: STASH_PASSWORD }).expect(200);
    await visitor.get(base).expect(200);
    return { ...ctx, base, slug, visitor };
}

test('only the owner can make a stash private, and a guest stash cannot be', async () => {
    const ctx = await privateSetup();
    assert.equal((await ctx.olive.get(ctx.base).expect(200)).body.private, false);
    // Not the owner: even with the password
    await ctx.visitor.put(`${ctx.base}/private`).send({ private: true }).expect(403);
    await ctx.olive.put(`${ctx.base}/private`).send({ private: 'yes' }).expect(400);
    await ctx.olive.put(`${ctx.base}/private`).send({ private: true }).expect(200, { private: true });
    assert.equal((await ctx.olive.get(ctx.base).expect(200)).body.private, true);

    // A stash made without an account has no owner to keep it for
    await request(ctx.app).post('/api/stashes').send({ slug: 'a-guest-stash-name' }).expect(201);
    const refused = await request(ctx.app).put('/api/stashes/a-guest-stash-name/private').send({ private: true }).expect(403);
    assert.match(refused.body.error, /no owner/);
});

test('while it is private only the owner gets in: the password, an unlocked cookie and other users are all refused as "not found"', async () => {
    const ctx = await privateSetup();
    await ctx.olive.put(`${ctx.base}/private`).send({ private: true }).expect(200);

    // The visitor was already unlocked: now it looks like the stash does not exist
    await ctx.visitor.get(ctx.base).expect(404);
    await ctx.visitor.get(`${ctx.base}/notes`).expect(404);
    await ctx.visitor.post(`${ctx.base}/notes`).send({ text: 'sneaky' }).expect(404);
    // The password no longer opens it, and the answer is the same as for a name that is not there
    const fresh = request.agent(ctx.app);
    const unlock = await fresh.post(`${ctx.base}/unlock`).send({ password: STASH_PASSWORD }).expect(404);
    const missing = await fresh.post('/api/stashes/no-such-stash-here/unlock').send({ password: STASH_PASSWORD }).expect(404);
    assert.deepEqual(unlock.body, missing.body);
    const known = await request(ctx.app).get(`${ctx.base}/exists`);
    const unknown = await request(ctx.app).get('/api/stashes/no-such-stash-here/exists');
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
    // Another signed-in user cannot open it either
    await ctx.sam.get(ctx.base).expect(404);

    // The owner is in, with no password and no cookie
    const owner = await ctx.olive.get(ctx.base).expect(200);
    assert.equal(owner.body.items.length, 1);
    assert.equal(owner.body.items[0].text, 'secret note');
    await ctx.olive.post(`${ctx.base}/notes`).send({ text: 'mine' }).expect(201);
});

test('turning it off brings the password back, and a follower comes back too', async () => {
    const ctx = await privateSetup();
    await ctx.sam.post('/api/me/stashes').send({ slug: ctx.slug, password: STASH_PASSWORD }).expect(200);
    assert.equal((await ctx.sam.get('/api/me/stashes').expect(200)).body.stashes.length, 1);
    await ctx.sam.get(ctx.base).expect(200);

    await ctx.olive.put(`${ctx.base}/private`).send({ private: true }).expect(200);
    // Sam's follow is suspended, not shown, and cannot be made again
    await ctx.sam.get(ctx.base).expect(404);
    assert.deepEqual((await ctx.sam.get('/api/me/stashes').expect(200)).body.stashes, []);
    await ctx.sam.post('/api/me/stashes').send({ slug: ctx.slug, password: STASH_PASSWORD }).expect(404);
    // The owner still sees it in the list
    assert.equal((await ctx.olive.get('/api/me/stashes').expect(200)).body.stashes.length, 1);

    await ctx.olive.put(`${ctx.base}/private`).send({ private: false }).expect(200, { private: false });
    await ctx.sam.get(ctx.base).expect(200);
    assert.equal((await ctx.sam.get('/api/me/stashes').expect(200)).body.stashes.length, 1);
    // The unlock cookie of the visitor works again too
    await ctx.visitor.get(ctx.base).expect(200);
});

test('a link to one clip keeps working on a private stash', async () => {
    const ctx = await privateSetup();
    const note = (await ctx.olive.get(ctx.base).expect(200)).body.items[0];
    const link = (await ctx.olive.post(`${ctx.base}/items/${note.id}/share`).send({ expires: '7d' }).expect(201)).body;
    await ctx.olive.put(`${ctx.base}/private`).send({ private: true }).expect(200);
    const opened = await request(ctx.app).get(`/api/clips/${link.token}`).expect(200);
    assert.equal(opened.body.text, 'secret note');
});

test('if the owner account is gone the stash goes back to its password instead of being lost for good', async () => {
    const ctx = await privateSetup();
    await ctx.olive.put(`${ctx.base}/private`).send({ private: true }).expect(200);
    await ctx.visitor.get(ctx.base).expect(404);
    ctx.db.prepare('UPDATE stashes SET owner_id = NULL WHERE slug = ?').run(ctx.slug);
    await ctx.visitor.get(ctx.base).expect(200);
});

test('an older database gets the private column, off for every stash', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { connect, SCHEMA_VERSION } = require('../src/database/sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-private-'));
    try {
        const file = path.join(dir, 'old.sqlite');
        connect(file).close();
        const raw = new DatabaseSync(file);
        raw.exec('ALTER TABLE stashes DROP COLUMN is_private');
        raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
        raw.exec("INSERT INTO stashes (slug, created_at) VALUES ('older-stash', '2025-01-01T00:00:00Z')");
        raw.close();
        const db = connect(file);
        assert.equal(db.prepare("SELECT is_private FROM stashes WHERE slug = 'older-stash'").get().is_private, 0);
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
