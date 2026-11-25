// Tags on clips: set one by one or in bulk, filter by them (the tag parameter and #words in the search), undo keeps them.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { unzip } = require('./helpers/unzip');
const { parseTags, splitSearch } = require('../src/utils/tags');

async function stash(ctx, slug = 'tag-stash', body = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);
    return `/api/stashes/${slug}`;
}
const addNote = (ctx, base, text) => request(ctx.app).post(`${base}/notes`).send({ text }).expect(201);
const putTags = (ctx, base, id, tags) => request(ctx.app).put(`${base}/items/${id}/tags`).send({ tags });
const listed = async (ctx, base, query = '') => (await request(ctx.app).get(base + query).expect(200)).body;

test('tags are lowercased, stripped of #, de-duplicated and limited', () => {
    assert.deepEqual(parseTags(['#Work', 'work', ' Home_1 ']).value, ['work', 'home_1']);
    assert.deepEqual(parseTags([]).value, []);
    assert.ok(parseTags(['a b']).error);
    assert.ok(parseTags(['x'.repeat(25)]).error);
    assert.ok(parseTags(['a"b']).error);
    assert.ok(parseTags(['1', '2', '3', '4', '5', '6', '7', '8', '9']).error);
    assert.ok(parseTags('work').error);
    assert.deepEqual(splitSearch('invoice #Work #2024 # #a!'), { text: 'invoice # #a!', tags: ['work', '2024'] });
});

test('a clip can be tagged and untagged, and the listing says which tags the stash uses', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'first');
    const b = await addNote(ctx, base, 'second');
    assert.deepEqual(a.body.tags, []);

    const set = await putTags(ctx, base, a.body.id, ['Work', '#todo']).expect(200);
    assert.deepEqual(set.body.tags, ['work', 'todo']);
    assert.equal(set.body.editedAt, null, 'tagging is not an edit');
    await putTags(ctx, base, b.body.id, ['work']).expect(200);

    const body = await listed(ctx, base);
    assert.deepEqual(body.tags, [{ name: 'work', count: 2 }, { name: 'todo', count: 1 }]);
    assert.deepEqual(body.items.find(i => i.id === a.body.id).tags, ['work', 'todo']);

    await putTags(ctx, base, a.body.id, []).expect(200);
    assert.deepEqual((await listed(ctx, base)).tags, [{ name: 'work', count: 1 }]);
    await putTags(ctx, base, a.body.id, ['bad tag']).expect(400);
    await putTags(ctx, base, 9999, ['x']).expect(404);
});

test('the list can be filtered by tag, with the tag parameter or #words in the search, all tags required', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'alpha invoice');
    const b = await addNote(ctx, base, 'beta invoice');
    await addNote(ctx, base, 'gamma');
    await putTags(ctx, base, a.body.id, ['work', 'urgent']).expect(200);
    await putTags(ctx, base, b.body.id, ['work']).expect(200);

    const ids = async query => (await listed(ctx, base, query)).items.map(i => i.id).sort();
    assert.deepEqual(await ids('?tag=work'), [a.body.id, b.body.id].sort());
    assert.deepEqual(await ids('?tag=work&tag=urgent'), [a.body.id]);
    assert.deepEqual(await ids('?tag=wor'), [], 'a tag matches whole, not by prefix');
    const typed = (await request(ctx.app).post(`${base}/query`).send({ search: '#work beta' }).expect(200)).body;
    assert.deepEqual(typed.items.map(i => i.id), [b.body.id]);
    assert.equal(typed.total, 1);
    await request(ctx.app).get(`${base}?tag=bad%20tag`).expect(400);
});

test('a bulk tag adds one tag to many clips, a bulk untag removes it, and the limit is reported', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'one');
    const b = await addNote(ctx, base, 'two');
    const bulk = (action, ids, tag) => request(ctx.app).post(`${base}/items/bulk`).send({ action, ids, tag });

    const added = await bulk('tag', [a.body.id, b.body.id, 999], 'Inbox').expect(200);
    assert.deepEqual(added.body.items.map(i => i.tags), [['inbox'], ['inbox']]);
    assert.deepEqual(added.body.missing, [999]);
    // Again: nothing changes, nothing breaks
    await bulk('tag', [a.body.id], 'inbox').expect(200);
    assert.deepEqual((await listed(ctx, base)).tags, [{ name: 'inbox', count: 2 }]);

    await putTags(ctx, base, a.body.id, ['1', '2', '3', '4', '5', '6', '7', '8']).expect(200);
    const full = await bulk('tag', [a.body.id, b.body.id], 'extra').expect(200);
    assert.deepEqual(full.body.full, [a.body.id]);
    assert.deepEqual(full.body.items.map(i => i.id), [b.body.id]);

    const removed = await bulk('untag', [b.body.id], 'inbox').expect(200);
    assert.deepEqual(removed.body.items[0].tags, ['extra']);
    await bulk('tag', [a.body.id], 'bad tag').expect(400);
});

test('tags survive a delete and its undo, and appear in the export', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const a = await addNote(ctx, base, 'keep my tags');
    await putTags(ctx, base, a.body.id, ['work']).expect(200);
    await request(ctx.app).delete(`${base}/items/${a.body.id}`).expect(200);
    const back = await request(ctx.app).post(`${base}/items/${a.body.id}/restore`).expect(200);
    assert.deepEqual(back.body.tags, ['work']);
    const exported = await request(ctx.app).get(`${base}/export`).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    const manifest = JSON.parse(unzip(exported.body).get('stash.json').toString());
    assert.deepEqual(manifest.items[0].tags, ['work']);
});

test('only full access can tag; a read-only link sees the tags', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'tag-locked', { password: 'correct horse battery' });
    const agent = request.agent(ctx.app);
    await agent.post(`${base}/unlock`).send({ password: 'correct horse battery' }).expect(200);
    const note = await agent.post(`${base}/notes`).send({ text: 'secret plans' }).expect(201);
    await agent.put(`${base}/items/${note.body.id}/tags`).send({ tags: ['plan'] }).expect(200);
    await request(ctx.app).put(`${base}/items/${note.body.id}/tags`).send({ tags: ['x'] }).expect(401);
});
