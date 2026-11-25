// A stash's own settings and organizing: they belong to its owner (anyone with full access on a guest's stash); tags can be renamed
// or deleted across the whole stash; clips can be moved or copied to another stash of yours.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';
const STASH_PASSWORD = 'a long stash password';

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
const note = (agent, slug, text, extra = {}) => agent.post(`/api/stashes/${slug}/notes`).send({ text, ...extra }).expect(201);
const file = (agent, slug, name = 'pic.png') => agent.post(`/api/stashes/${slug}/files`).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
const listing = async (agent, slug) => (await agent.get(`/api/stashes/${slug}`).expect(200)).body;
const tagsOf = async (agent, slug) => (await listing(agent, slug)).tags;

// ---- who manages ----

test('an owned stash\'s settings are its owner\'s: someone who only knows the password cannot rename, delete, organize or change what it holds', async () => {
    const ctx = await accountApp();
    const sam = await user(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-managed-one', password: STASH_PASSWORD }).expect(201);
    const base = '/api/stashes/sams-managed-one';
    const knower = request.agent(ctx.app);
    await knower.post(`${base}/unlock`).send({ password: STASH_PASSWORD }).expect(200);
    const n = (await note(knower, 'sams-managed-one', 'a note', {})).body;

    // Reading and adding are for everyone with full access; the settings are not
    assert.equal((await listing(knower, 'sams-managed-one')).canManage, false);
    assert.equal((await listing(sam, 'sams-managed-one')).canManage, true);
    for (const [method, path, body] of [
        ['post', `${base}/rename`, { slug: 'renamed-by-knower' }],
        ['put', `${base}/content`, { content: 'notes' }],
        ['put', `${base}/keep-last`, { keepLast: 5 }],
        ['post', `${base}/tags/rename`, { from: 'a', to: 'b' }],
        ['delete', `${base}/tags/a`, undefined],
        ['post', `${base}/items/move`, { ids: [n.id], to: 'whatever-stash' }],
        ['delete', base, undefined],
    ]) {
        const res = await knower[method](path).send(body);
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.match(res.body.error, /Only the owner/);
    }
    assert.ok(ctx.model.findBySlug('sams-managed-one'), 'nothing happened to the stash');

    // The owner can
    await sam.put(`${base}/content`).send({ content: 'notes' }).expect(200);
    await sam.post(`${base}/rename`).send({ slug: 'sams-renamed-one' }).expect(200);
    await sam.delete('/api/stashes/sams-renamed-one').expect(200);
});

test('a guest\'s stash: anyone with full access manages it, as before', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'guest-managed-one' }).expect(201);
    assert.equal((await request(ctx.app).get('/api/stashes/guest-managed-one').expect(200)).body.canManage, true);
    await request(ctx.app).put('/api/stashes/guest-managed-one/content').send({ content: 'files' }).expect(200);
    await request(ctx.app).post('/api/stashes/guest-managed-one/rename').send({ slug: 'guest-managed-two' }).expect(200);
    await request(ctx.app).delete('/api/stashes/guest-managed-two').expect(200);
});

// ---- tags across the stash ----

test('a tag can be renamed everywhere in the stash, and renaming onto an existing tag merges them', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'tags-everywhere' }).expect(201);
    const agent = request(ctx.app);
    const base = '/api/stashes/tags-everywhere';
    const a = (await note(agent, 'tags-everywhere', 'one')).body;
    const b = (await note(agent, 'tags-everywhere', 'two')).body;
    const c = (await note(agent, 'tags-everywhere', 'three')).body;
    await agent.put(`${base}/items/${a.id}/tags`).send({ tags: ['work', 'todo'] }).expect(200);
    await agent.put(`${base}/items/${b.id}/tags`).send({ tags: ['work'] }).expect(200);
    await agent.put(`${base}/items/${c.id}/tags`).send({ tags: ['todo', 'tasks'] }).expect(200);

    const renamed = await agent.post(`${base}/tags/rename`).send({ from: 'Work', to: '#Job' }).expect(200);
    assert.equal(renamed.body.changed, 2);
    assert.deepEqual(renamed.body.tags.map(t => [t.name, t.count]), [['job', 2], ['todo', 2], ['tasks', 1]]);
    const item = async id => (await agent.get(`${base}/items/${id}`).expect(200)).body.tags;
    assert.deepEqual(await item(a.id), ['job', 'todo']);

    // Onto a tag the clip already has: they merge, keeping one
    const merged = await agent.post(`${base}/tags/rename`).send({ from: 'tasks', to: 'todo' }).expect(200);
    assert.equal(merged.body.changed, 1);
    assert.deepEqual(await item(c.id), ['todo']);
    assert.deepEqual(merged.body.tags.map(t => [t.name, t.count]), [['job', 2], ['todo', 2]]);

    // Nothing has it / bad names / the same name
    await agent.post(`${base}/tags/rename`).send({ from: 'nothing', to: 'else' }).expect(404);
    assert.equal((await agent.post(`${base}/tags/rename`).send({ from: 'job', to: 'bad name' }).expect(400)).body.field, 'to');
    assert.equal((await agent.post(`${base}/tags/rename`).send({ from: 'job', to: 'JOB' }).expect(400)).body.field, 'to');
    await agent.post(`${base}/tags/rename`).send({ to: 'x' }).expect(400);
});

test('a tag can be deleted from every clip, the clips stay, and a deleted clip brought back by undo does not get it back', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'tags-deleted' }).expect(201);
    const agent = request(ctx.app);
    const base = '/api/stashes/tags-deleted';
    const a = (await note(agent, 'tags-deleted', 'one')).body;
    const b = (await note(agent, 'tags-deleted', 'two')).body;
    await agent.put(`${base}/items/${a.id}/tags`).send({ tags: ['old', 'keep'] }).expect(200);
    await agent.put(`${base}/items/${b.id}/tags`).send({ tags: ['old'] }).expect(200);
    // b is in the trash (deleted, undoable) while the tag goes
    await agent.delete(`${base}/items/${b.id}`).expect(200);
    const gone = await agent.delete(`${base}/tags/Old`).expect(200);
    assert.equal(gone.body.changed, 1);
    assert.deepEqual(gone.body.tags.map(t => t.name), ['keep']);
    assert.equal((await listing(agent, 'tags-deleted')).items.length, 1, 'the clip stays');
    const back = await agent.post(`${base}/items/${b.id}/restore`).expect(200);
    assert.deepEqual(back.body.tags, [], 'the undone clip does not bring the tag back');
    await agent.delete(`${base}/tags/old`).expect(404);
    await agent.delete(`${base}/tags/bad%20name`).expect(400);
});

// ---- move and copy ----

test('clips move to another stash of yours: same ids, on top in the same order, files keep their bytes, links end', async () => {
    const ctx = await accountApp();
    const sam = await user(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-from-stash' }).expect(201);
    await sam.post('/api/stashes').send({ slug: 'sams-to-stash' }).expect(201);
    const first = (await note(sam, 'sams-from-stash', 'first', { title: 'First' })).body;
    const second = (await note(sam, 'sams-from-stash', 'second')).body;
    const pic = (await file(sam, 'sams-from-stash')).body;
    const stays = (await note(sam, 'sams-from-stash', 'stays here')).body;
    await note(sam, 'sams-to-stash', 'already there');
    await sam.put(`/api/stashes/sams-from-stash/items/${first.id}/tags`).send({ tags: ['kept'] }).expect(200);
    await sam.post(`/api/stashes/sams-from-stash/items/${second.id}/share`).send({}).expect(201);
    const link = (await sam.post(`/api/stashes/sams-from-stash/items/${first.id}/share`).send({}).expect(201)).body.token;
    await request(ctx.app).get(`/api/clips/${link}`).expect(200);

    const done = await sam.post('/api/stashes/sams-from-stash/items/move').send({ ids: [first.id, second.id, pic.id], to: 'Sams-To-Stash' }).expect(200);
    assert.deepEqual(done.body.moved.slice().sort(), [first.id, second.id, pic.id].sort());
    assert.deepEqual(done.body.skipped, []);
    assert.equal(done.body.target, 'sams-to-stash');

    const source = await listing(sam, 'sams-from-stash');
    assert.deepEqual(source.items.map(i => i.id), [stays.id], 'gone from the source');
    const target = await listing(sam, 'sams-to-stash');
    // On top of what was there, in the order they had (the newest of them first, as in the source)
    assert.deepEqual(target.items.slice(0, 3).map(i => i.id), [pic.id, second.id, first.id]);
    assert.equal(target.items.length, 4);
    assert.deepEqual(target.items.find(i => i.id === first.id).tags, ['kept']);
    assert.equal(target.items.find(i => i.id === first.id).title, 'First');

    // The file is served from its new stash, not the old one
    const bytes = await sam.get(`/api/stashes/sams-to-stash/files/${pic.id}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.deepEqual(bytes.body, PNG);
    await sam.get(`/api/stashes/sams-from-stash/files/${pic.id}`).expect(404);
    // A link made for the old stash ends
    await request(ctx.app).get(`/api/clips/${link}`).expect(404);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM item_shares').get().n, 0);
});

test('clips can be copied: new items, the original stays, a file\'s bytes are copied, a burn note is skipped', async () => {
    const ctx = await accountApp();
    const sam = await user(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'sams-copy-from' }).expect(201);
    await sam.post('/api/stashes').send({ slug: 'sams-copy-to' }).expect(201);
    const text = (await note(sam, 'sams-copy-from', 'copy me', { title: 'Copy' })).body;
    const pic = (await file(sam, 'sams-copy-from')).body;
    const burn = (await note(sam, 'sams-copy-from', 'read once', { burn: true })).body;
    await sam.post(`/api/stashes/sams-copy-from/items/${pic.id}/pin`).send({ pinned: true }).expect(200);

    const done = await sam.post('/api/stashes/sams-copy-from/items/move').send({ ids: [text.id, pic.id, burn.id], to: 'sams-copy-to', copy: true }).expect(200);
    assert.deepEqual(done.body.moved, []);
    assert.equal(done.body.copied.length, 2);
    assert.deepEqual(done.body.skipped, [{ id: burn.id, reason: 'burn' }]);

    const from = await listing(sam, 'sams-copy-from');
    assert.equal(from.items.length, 3, 'the original stays');
    const to = await listing(sam, 'sams-copy-to');
    assert.equal(to.items.length, 2);
    const copiedFile = to.items.find(i => i.kind === 'file');
    assert.notEqual(copiedFile.id, pic.id);
    assert.equal(copiedFile.pinned, false, 'the pin belongs to the original');
    assert.equal(to.items.find(i => i.kind === 'note').title, 'Copy');
    const bytes = await sam.get(`/api/stashes/sams-copy-to/files/${copiedFile.id}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.deepEqual(bytes.body, PNG);
    // Deleting the original does not touch the copy's bytes
    await sam.delete(`/api/stashes/sams-copy-from/items/${pic.id}`).expect(200);
    await sam.get(`/api/stashes/sams-copy-to/files/${copiedFile.id}`).expect(200);
});

test('where clips may go: only a stash you own, signed in, not the same one, one that exists, one that takes that kind, within its limits', async () => {
    const ctx = await accountApp({ maxItemsPerStash: 4 });
    const sam = await user(ctx, 'sam');
    const kim = await user(ctx, 'kim');
    await sam.post('/api/stashes').send({ slug: 'sams-source-two' }).expect(201);
    await sam.post('/api/stashes').send({ slug: 'sams-target-two' }).expect(201);
    await kim.post('/api/stashes').send({ slug: 'kims-stash-two' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'guests-stash-two' }).expect(201);
    const one = (await note(sam, 'sams-source-two', 'one')).body;
    const pic = (await file(sam, 'sams-source-two')).body;
    const move = (agent, body) => agent.post('/api/stashes/sams-source-two/items/move').send(body);

    assert.equal((await move(sam, { ids: [one.id], to: 'kims-stash-two' }).expect(403)).body.field, 'to');
    assert.equal((await move(sam, { ids: [one.id], to: 'guests-stash-two' }).expect(403)).body.field, 'to');
    assert.equal((await move(sam, { ids: [one.id], to: 'sams-source-two' }).expect(400)).body.field, 'to');
    assert.equal((await move(sam, { ids: [one.id], to: 'no-such-stash' }).expect(404)).body.field, 'to');
    await move(sam, { ids: [], to: 'sams-target-two' }).expect(400);
    await move(sam, { ids: ['x'], to: 'sams-target-two' }).expect(400);
    // Not signed in, or somebody else's stash to move out of
    await request(ctx.app).post('/api/stashes/sams-source-two/items/move').send({ ids: [one.id], to: 'sams-target-two' }).expect(res => assert.ok([401, 403].includes(res.status)));
    await move(kim, { ids: [one.id], to: 'kims-stash-two' }).expect(res => assert.ok([401, 403].includes(res.status)));

    // A target that takes notes only skips a file, and says why
    await sam.put('/api/stashes/sams-target-two/content').send({ content: 'notes' }).expect(200);
    const skipped = await move(sam, { ids: [one.id, pic.id, 999], to: 'sams-target-two' }).expect(200);
    assert.deepEqual(skipped.body.moved, [one.id]);
    assert.deepEqual(skipped.body.skipped, [{ id: pic.id, reason: 'kind' }, { id: 999, reason: 'gone' }]);

    // A limit refuses the whole move: nothing is moved
    await sam.put('/api/stashes/sams-target-two/content').send({ content: 'all' }).expect(200);
    for (const text of ['a', 'b', 'c']) await note(sam, 'sams-target-two', text);
    const before = (await listing(sam, 'sams-source-two')).items.length;
    const full = await move(sam, { ids: [pic.id], to: 'sams-target-two' }).expect(413);
    assert.match(full.body.error, /Nothing was moved/);
    assert.equal((await listing(sam, 'sams-source-two')).items.length, before);
});

test('tag changes, moves and copies are audited by kind and count, with no stash names or tags', async () => {
    const audit = [];
    const ctx = await accountApp({ auditLog: 'stdout' }, { auditOut: line => audit.push(line) });
    const sam = await user(ctx, 'sam');
    await sam.post('/api/stashes').send({ slug: 'audit-set-from' }).expect(201);
    await sam.post('/api/stashes').send({ slug: 'audit-set-to' }).expect(201);
    const a = (await note(sam, 'audit-set-from', 'one')).body;
    await sam.put(`/api/stashes/audit-set-from/items/${a.id}/tags`).send({ tags: ['secret-tag'] }).expect(200);
    await sam.post('/api/stashes/audit-set-from/tags/rename').send({ from: 'secret-tag', to: 'other-tag' }).expect(200);
    await sam.post('/api/stashes/audit-set-from/items/move').send({ ids: [a.id], to: 'audit-set-to', copy: true }).expect(200);
    await sam.post('/api/stashes/audit-set-from/items/move').send({ ids: [a.id], to: 'audit-set-to' }).expect(200);
    const events = audit.map(line => JSON.parse(line)).filter(e => /tags_changed|items\.(moved|copied)/.test(e.event));
    assert.deepEqual(events.map(e => [e.event, e.detail]), [
        ['stash.tags_changed', { action: 'rename', clips: 1 }],
        ['items.copied', { count: 1 }],
        ['items.moved', { count: 1 }],
    ]);
    const all = audit.join('\n');
    assert.ok(!all.includes('audit-set') && !all.includes('secret-tag') && !all.includes('other-tag'));
});
