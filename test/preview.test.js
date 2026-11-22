const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const BIG = 'x'.repeat(5000);

async function setup() {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'preview-stash' }).expect(201);
    const base = '/api/stashes/preview-stash';
    await request(ctx.app).post(`${base}/notes`).send({ text: 'short note' }).expect(201);
    const big = await request(ctx.app).post(`${base}/notes`).send({ text: BIG, title: 'Big' }).expect(201);
    return { ctx, base, bigId: big.body.id };
}

test('a listing carries full text unless a preview is asked for', async () => {
    const { ctx, base } = await setup();
    const res = await request(ctx.app).get(base).expect(200);
    assert.ok(res.body.items.every(item => !item.truncated));
    assert.equal(res.body.items.find(item => item.title === 'Big').text.length, 5000);
});

test('a preview listing cuts long notes and says so, and leaves short ones alone', async () => {
    const { ctx, base } = await setup();
    for (const res of [
        await request(ctx.app).post(`${base}/query`).send({ preview: true }).expect(200),
        await request(ctx.app).get(`${base}?preview=1`).expect(200),
    ]) {
        const big = res.body.items.find(item => item.title === 'Big');
        assert.equal(big.text.length, 2000);
        assert.equal(big.truncated, true);
        assert.equal(big.textLength, 5000);
        const short = res.body.items.find(item => item.text === 'short note');
        assert.equal(short.truncated, undefined);
    }
});

test('a preview never cuts a character in half', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'emoji-stash' }).expect(201);
    // The emoji is two UTF-16 units, and the 2000-unit cut would land in the middle of the last one
    await request(ctx.app).post('/api/stashes/emoji-stash/notes').send({ text: 'a'.repeat(1999) + '😀' + 'b'.repeat(50) }).expect(201);
    const res = await request(ctx.app).post('/api/stashes/emoji-stash/query').send({ preview: true }).expect(200);
    const text = res.body.items[0].text;
    assert.equal(text, 'a'.repeat(1999));
    assert.doesNotMatch(text, /[\ud800-\udbff]$/);
});

test('search still looks through the whole note, not just its preview', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'search-stash' }).expect(201);
    await request(ctx.app).post('/api/stashes/search-stash/notes').send({ text: 'a'.repeat(3000) + ' needle' }).expect(201);
    const res = await request(ctx.app).post('/api/stashes/search-stash/query').send({ preview: true, search: 'needle' }).expect(200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].truncated, true);
});

test('one item can be fetched in full', async () => {
    const { ctx, base, bigId } = await setup();
    const res = await request(ctx.app).get(`${base}/items/${bigId}`).expect(200);
    assert.equal(res.body.text, BIG);
    assert.equal(res.body.truncated, undefined);
    await request(ctx.app).get(`${base}/items/99999`).expect(404);
});

test('fetching one item follows the same access rules, and never returns a burn note', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'guarded', password: 'correct horse' }).expect(201);
    const note = await owner.post('/api/stashes/guarded/notes').send({ text: 'hi' }).expect(201);
    const burn = await owner.post('/api/stashes/guarded/notes').send({ text: 'secret text', burn: true }).expect(201);
    await request(ctx.app).get(`/api/stashes/guarded/items/${note.body.id}`).expect(401);
    const fetched = await owner.get(`/api/stashes/guarded/items/${burn.body.id}`).expect(200);
    assert.equal(fetched.body.text, null);
    assert.equal(fetched.body.burn, true);
    // A drop-box link can add but not read
    const link = await owner.post('/api/stashes/guarded/share-links').send({ kind: 'drop' }).expect(201);
    const dropper = request.agent(ctx.app);
    await dropper.post('/api/stashes/guarded/redeem').send({ token: link.body.token }).expect(200);
    await dropper.get(`/api/stashes/guarded/items/${note.body.id}`).expect(403);
});
