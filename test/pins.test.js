// Pinned stashes: pinned ones sit first in the user's list (and in the left menu), are limited, and go with the follow.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { connect, SCHEMA_VERSION } = require('../src/database/sqlite');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';

async function setup() {
    const ctx = makeApp({ adminPassword: ADMIN });
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    for (const name of ['sam', 'kim']) await root.post('/api/admin/users').send({ username: name, password: PASSWORD, role: 'user' }).expect(201);
    const sign = async name => { const a = request.agent(ctx.app); await a.post('/api/auth/login').send({ username: name, password: PASSWORD }).expect(200); return a; };
    return { ...ctx, root, sam: await sign('sam'), kim: await sign('kim') };
}

const list = async agent => (await agent.get('/api/me/stashes').expect(200)).body.stashes;
const make = (ctx, slug) => request(ctx.app).post('/api/stashes').send({ slug }).expect(201);

test('a followed stash can be pinned and unpinned, and pinned ones come first, in the order they were pinned', async () => {
    const ctx = await setup();
    for (const slug of ['stash-aaaaaaaa', 'stash-bbbbbbbb', 'stash-cccccccc']) { await make(ctx, slug); await ctx.sam.post('/api/me/stashes').send({ slug }).expect(200); }
    assert.ok((await list(ctx.sam)).every(s => s.pinned === false));

    await ctx.sam.put('/api/me/stashes/stash-cccccccc/pin').expect(200);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 1000);
    await ctx.sam.put('/api/me/stashes/stash-aaaaaaaa/pin').expect(200);
    assert.deepEqual((await list(ctx.sam)).map(s => [s.slug, s.pinned]), [['stash-cccccccc', true], ['stash-aaaaaaaa', true], ['stash-bbbbbbbb', false]]);

    await ctx.sam.delete('/api/me/stashes/stash-cccccccc/pin').expect(200);
    assert.equal((await list(ctx.sam)).find(s => s.slug === 'stash-cccccccc').pinned, false);
    assert.equal((await list(ctx.sam))[0].slug, 'stash-aaaaaaaa');
});

test('your own stash can be pinned, and pins belong to one user', async () => {
    const ctx = await setup();
    await ctx.sam.post('/api/stashes').send({ slug: 'sams-own-stash' }).expect(201);
    await ctx.sam.put('/api/me/stashes/sams-own-stash/pin').expect(200);
    assert.equal((await list(ctx.sam))[0].pinned, true);
    await make(ctx, 'shared-stash-1');
    await ctx.sam.post('/api/me/stashes').send({ slug: 'shared-stash-1' }).expect(200);
    await ctx.kim.post('/api/me/stashes').send({ slug: 'shared-stash-1' }).expect(200);
    await ctx.sam.put('/api/me/stashes/shared-stash-1/pin').expect(200);
    assert.equal((await list(ctx.kim))[0].pinned, false, "kim's list is not affected");
});

test('only stashes in your list can be pinned; there is no pin without signing in', async () => {
    const ctx = await setup();
    await make(ctx, 'not-followed-1');
    await ctx.sam.put('/api/me/stashes/not-followed-1/pin').expect(404);
    await ctx.sam.put('/api/me/stashes/does-not-exist/pin').expect(404);
    await request(ctx.app).put('/api/me/stashes/not-followed-1/pin').expect(401);
    await request(ctx.app).delete('/api/me/stashes/not-followed-1/pin').expect(401);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM user_stashes WHERE pinned_at IS NOT NULL').get().n, 0);
});

test('at most 20 pins; pinning again is fine; unpinning makes room', async () => {
    const ctx = await setup();
    for (let i = 0; i < 21; i++) {
        const slug = `bulk-stash-${String(i).padStart(2, '0')}`;
        await make(ctx, slug);
        await ctx.sam.post('/api/me/stashes').send({ slug }).expect(200);
        if (i < 20) await ctx.sam.put(`/api/me/stashes/${slug}/pin`).expect(200);
    }
    await ctx.sam.put('/api/me/stashes/bulk-stash-20/pin').expect(409);
    await ctx.sam.put('/api/me/stashes/bulk-stash-00/pin').expect(200);
    await ctx.sam.delete('/api/me/stashes/bulk-stash-00/pin').expect(200);
    await ctx.sam.put('/api/me/stashes/bulk-stash-20/pin').expect(200);
});

test('unfollowing drops the pin, and following again starts unpinned', async () => {
    const ctx = await setup();
    await make(ctx, 'pinned-then-gone');
    await ctx.sam.post('/api/me/stashes').send({ slug: 'pinned-then-gone' }).expect(200);
    await ctx.sam.put('/api/me/stashes/pinned-then-gone/pin').expect(200);
    await ctx.sam.delete('/api/me/stashes/pinned-then-gone').expect(200);
    await ctx.sam.post('/api/me/stashes').send({ slug: 'pinned-then-gone' }).expect(200);
    assert.equal((await list(ctx.sam))[0].pinned, false);
});

test('the pin column is added to an existing database', () => {
    assert.ok(SCHEMA_VERSION >= 9);
    const db = connect(':memory:');
    assert.ok(db.prepare('PRAGMA table_info(user_stashes)').all().some(c => c.name === 'pinned_at'));
});
