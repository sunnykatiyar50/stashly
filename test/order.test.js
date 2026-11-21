const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { connect } = require('../src/database/sqlite');

async function stashWith(ctx, texts, slug = 'order') {
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    const ids = [];
    for (const text of texts) {
        const res = await request(ctx.app).post(`/api/stashes/${slug}/notes`).send({ text }).expect(201);
        ids.push(res.body.id);
    }
    return { base: `/api/stashes/${slug}`, ids };
}

const listed = async (ctx, base) => (await request(ctx.app).get(base).expect(200)).body.items.map(item => item.text);

test('new clips go on top, and each one carries its place in the list', async () => {
    const ctx = makeApp();
    const { base } = await stashWith(ctx, ['a', 'b', 'c']);
    const items = (await request(ctx.app).get(base).expect(200)).body.items;
    assert.deepEqual(items.map(item => item.text), ['c', 'b', 'a']);
    assert.ok(items[0].order > items[1].order && items[1].order > items[2].order);
});

test('clips can be put in a new order, which is kept and sent to other pages', async () => {
    const ctx = makeApp();
    const { base, ids } = await stashWith(ctx, ['a', 'b', 'c']);
    const [a, b, c] = ids;
    const seen = [];
    const original = ctx.events.publish.bind(ctx.events);
    ctx.events.publish = (slug, name, data) => { seen.push({ name, data }); return original(slug, name, data); };

    const res = await request(ctx.app).post(`${base}/reorder`).send({ ids: [a, c, b] }).expect(200);
    assert.deepEqual(res.body.orders.map(entry => entry.id), [a, c, b]);
    assert.deepEqual(await listed(ctx, base), ['a', 'c', 'b']);
    const event = seen.find(entry => entry.name === 'items-reordered');
    assert.deepEqual(event.data.orders, res.body.orders);

    // A clip added afterwards still goes on top
    await request(ctx.app).post(`${base}/notes`).send({ text: 'd' }).expect(201);
    assert.deepEqual(await listed(ctx, base), ['d', 'a', 'c', 'b']);
});

test('moving only some clips leaves the others where they were', async () => {
    const ctx = makeApp();
    const { base, ids } = await stashWith(ctx, ['a', 'b', 'c', 'd', 'e']);
    // The list reads e d c b a; swap d and b (as a search showing only those two would)
    await request(ctx.app).post(`${base}/reorder`).send({ ids: [ids[1], ids[3]] }).expect(200);
    assert.deepEqual(await listed(ctx, base), ['e', 'b', 'c', 'd', 'a']);
});

test('pinned clips stay above the rest whatever the order', async () => {
    const ctx = makeApp();
    const { base, ids } = await stashWith(ctx, ['a', 'b', 'c']);
    await request(ctx.app).post(`${base}/items/${ids[0]}/pin`).send({ pinned: true }).expect(200);
    await request(ctx.app).post(`${base}/reorder`).send({ ids: [ids[1], ids[2]] }).expect(200);
    assert.deepEqual(await listed(ctx, base), ['a', 'b', 'c']);
});

test('a bad reorder is refused and changes nothing', async () => {
    const ctx = makeApp();
    const { base, ids } = await stashWith(ctx, ['a', 'b']);
    const other = await stashWith(ctx, ['theirs'], 'other');
    for (const body of [{}, { ids: [] }, { ids: 'x' }, { ids: [ids[0], 'b'] }, { ids: [ids[0], 1.5] }, { ids: [ids[0], ids[0]] }]) {
        await request(ctx.app).post(`${base}/reorder`).send(body).expect(400);
    }
    // A clip from another stash, or one that is gone
    await request(ctx.app).post(`${base}/reorder`).send({ ids: [ids[0], other.ids[0]] }).expect(404);
    await request(ctx.app).post(`${base}/reorder`).send({ ids: [ids[0], 99999] }).expect(404);
    assert.deepEqual(await listed(ctx, base), ['b', 'a']);
    assert.deepEqual(await listed(ctx, other.base), ['theirs']);
});

test('only full access may reorder: a locked stash and a read-only link are refused', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked', password: 'secret-pw' }).expect(201);
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes/locked/unlock').send({ password: 'secret-pw' }).expect(200);
    const a = (await owner.post('/api/stashes/locked/notes').send({ text: 'a' }).expect(201)).body.id;
    const b = (await owner.post('/api/stashes/locked/notes').send({ text: 'b' }).expect(201)).body.id;

    await request(ctx.app).post('/api/stashes/locked/reorder').send({ ids: [a, b] }).expect(401);

    const link = (await owner.post('/api/stashes/locked/share-links').send({ kind: 'view' }).expect(201)).body;
    const viewer = request.agent(ctx.app);
    await viewer.post('/api/stashes/locked/redeem').send({ token: link.token }).expect(200);
    await viewer.get('/api/stashes/locked').expect(200);
    await viewer.post('/api/stashes/locked/reorder').send({ ids: [a, b] }).expect(403);

    await owner.post('/api/stashes/locked/reorder').send({ ids: [a, b] }).expect(200);
});

test('a database from before clip order exists keeps its clips in the order they were added', () => {
    const db = connect(':memory:');
    // Pretend the column is new: clear it and run the migration's backfill again
    db.exec('INSERT INTO stashes (slug, created_at) VALUES (\'old\', \'2026-01-01T00:00:00Z\')');
    db.exec("INSERT INTO items (stash_id, kind, text, created_at) VALUES (1, 'note', 'first', '2026-01-01T00:00:00Z')");
    db.exec("INSERT INTO items (stash_id, kind, text, created_at) VALUES (1, 'note', 'second', '2026-01-02T00:00:00Z')");
    const rows = db.prepare('SELECT text, sort_order FROM items ORDER BY id').all();
    // Rows written without a place sort last until the backfill gives them one; the migration uses the id
    assert.deepEqual(rows.map(row => row.sort_order), [null, null]);
    db.exec('UPDATE items SET sort_order = id WHERE sort_order IS NULL');
    const { StashModel } = require('../src/models/stashModel');
    const model = new StashModel(db);
    assert.deepEqual(model.listItems(1, { now: new Date('2026-01-03T00:00:00Z') }).map(row => row.text), ['second', 'first']);
});
