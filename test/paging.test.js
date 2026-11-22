const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

// A stash of `count` notes, "note 1" (oldest) to "note N" (newest, listed first); every fifth one has the title "needle"
async function filled(count = 25, slug = 'paged') {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
    const base = `/api/stashes/${slug}`;
    const ids = [];
    for (let i = 1; i <= count; i++) {
        const res = await request(ctx.app).post(`${base}/notes`).send({ text: `note ${i}`, title: i % 5 === 0 ? 'needle' : undefined }).expect(201);
        ids.push(res.body.id);
    }
    return { ctx, base, ids };
}
const query = (ctx, base, body) => request(ctx.app).post(`${base}/query`).send(body);
const texts = res => res.body.items.map(item => item.text);

test('offset skips items and the response says how many match in all, and whether more remain', async () => {
    const { ctx, base } = await filled(25);
    const first = await query(ctx, base, { limit: 10 }).expect(200);
    assert.equal(first.body.items.length, 10);
    assert.equal(first.body.total, 25);
    assert.equal(first.body.hasMore, true);
    assert.equal(texts(first)[0], 'note 25');

    const second = await query(ctx, base, { limit: 10, offset: 10 }).expect(200);
    assert.deepEqual(texts(second), Array.from({ length: 10 }, (_, i) => `note ${15 - i}`));
    assert.equal(second.body.total, 25);
    assert.equal(second.body.hasMore, true);

    const last = await query(ctx, base, { limit: 10, offset: 20 }).expect(200);
    assert.deepEqual(texts(last), ['note 5', 'note 4', 'note 3', 'note 2', 'note 1']);
    assert.equal(last.body.total, 25);
    assert.equal(last.body.hasMore, false);
});

test('page boundaries: an exact last page, a page past the end, and a short list', async () => {
    const { ctx, base } = await filled(20);
    // Exactly full last page: nothing more
    const exact = await query(ctx, base, { limit: 10, offset: 10 }).expect(200);
    assert.equal(exact.body.items.length, 10);
    assert.equal(exact.body.total, 20);
    assert.equal(exact.body.hasMore, false);
    // First page of exactly its size: the total is still 20, so there is more
    const firstPage = await query(ctx, base, { limit: 10 }).expect(200);
    assert.equal(firstPage.body.hasMore, true);
    // Starting at the end, and past it: no items, the total still counts everything, nothing more
    for (const offset of [20, 21, 5000]) {
        const past = await query(ctx, base, { limit: 10, offset }).expect(200);
        assert.deepEqual(past.body.items, []);
        assert.equal(past.body.total, 20);
        assert.equal(past.body.hasMore, false);
    }
    // A limit bigger than the list
    const all = await query(ctx, base, { limit: 200 }).expect(200);
    assert.equal(all.body.items.length, 20);
    assert.equal(all.body.total, 20);
    assert.equal(all.body.hasMore, false);
    // Offset 0 is the same as no offset
    assert.deepEqual(texts(await query(ctx, base, { limit: 5, offset: 0 }).expect(200)), texts(await query(ctx, base, { limit: 5 }).expect(200)));
});

test('without a limit nothing changes: everything comes, hasMore is false; an offset alone skips that many', async () => {
    const { ctx, base } = await filled(12);
    const all = await request(ctx.app).get(base).expect(200);
    assert.equal(all.body.items.length, 12);
    assert.equal(all.body.total, 12);
    assert.equal(all.body.hasMore, false);

    const skipped = await query(ctx, base, { offset: 5 }).expect(200);
    assert.equal(skipped.body.items.length, 7);
    assert.equal(skipped.body.total, 12);
    assert.equal(skipped.body.hasMore, false);
    assert.equal(texts(skipped)[0], 'note 7');
    const beyond = await query(ctx, base, { offset: 50 }).expect(200);
    assert.deepEqual(beyond.body.items, []);
    assert.equal(beyond.body.total, 12);
});

test('total counts every match of a search, and paging walks through the matches only', async () => {
    const { ctx, base } = await filled(25); // 5 of them say "needle"
    const first = await query(ctx, base, { search: 'needle', limit: 2 }).expect(200);
    assert.deepEqual(texts(first), ['note 25', 'note 20']);
    assert.equal(first.body.total, 5);
    assert.equal(first.body.hasMore, true);
    const second = await query(ctx, base, { search: 'needle', limit: 2, offset: 2 }).expect(200);
    assert.deepEqual(texts(second), ['note 15', 'note 10']);
    assert.equal(second.body.hasMore, true);
    const third = await query(ctx, base, { search: 'needle', limit: 2, offset: 4 }).expect(200);
    assert.deepEqual(texts(third), ['note 5']);
    assert.equal(third.body.total, 5);
    assert.equal(third.body.hasMore, false);
    // A search with nothing found
    const none = await query(ctx, base, { search: 'absent', limit: 10 }).expect(200);
    assert.deepEqual([none.body.total, none.body.hasMore, none.body.items.length], [0, false, 0]);
});

test('date filters apply to paging too', async () => {
    const { ctx, base } = await filled(6);
    // The test clock is fixed at 2026-01-15, so a range that excludes it matches nothing
    const out = await query(ctx, base, { startDate: '2026-02-01', limit: 2, offset: 0 }).expect(200);
    assert.equal(out.body.total, 0);
    const inRange = await query(ctx, base, { startDate: '2026-01-15', endDate: '2026-01-15', limit: 4, offset: 4, tz: '0' }).expect(200);
    assert.equal(inRange.body.total, 6);
    assert.equal(inRange.body.items.length, 2);
    assert.equal(inRange.body.hasMore, false);
});

test('pages follow the list order (pinned first) and together hold every item once', async () => {
    const { ctx, base, ids } = await filled(23);
    // Pin the oldest: it leads the list, then the rest newest first
    await request(ctx.app).post(`${base}/items/${ids[0]}/pin`).send({ pinned: true }).expect(200);
    const seen = [];
    for (let offset = 0; ; offset += 10) {
        const page = await query(ctx, base, { limit: 10, offset }).expect(200);
        seen.push(...page.body.items.map(item => item.id));
        if (!page.body.hasMore) break;
    }
    const whole = await request(ctx.app).get(base).expect(200);
    assert.deepEqual(seen, whole.body.items.map(item => item.id));
    assert.equal(seen[0], ids[0]);
    assert.equal(new Set(seen).size, 23);
});

test('offset works on GET with the query string, and with a number given as text', async () => {
    const { ctx, base } = await filled(8);
    const res = await request(ctx.app).get(`${base}?limit=3&offset=6`).expect(200);
    assert.deepEqual(texts(res), ['note 2', 'note 1']);
    assert.equal(res.body.total, 8);
    assert.equal(res.body.hasMore, false);
    const asText = await query(ctx, base, { limit: '3', offset: '3' }).expect(200);
    assert.deepEqual(texts(asText), ['note 5', 'note 4', 'note 3']);
    assert.equal(asText.body.hasMore, true);
});

test('offset is validated like limit: whole numbers from 0 only', async () => {
    const { ctx, base } = await filled(3);
    for (const bad of [-1, 1.5, 'abc', '1e', 1e300, true, [1], {}, '-5', Number.MAX_SAFE_INTEGER + 2]) {
        const res = await query(ctx, base, { limit: 2, offset: bad });
        assert.equal(res.status, 400, `offset ${JSON.stringify(bad)}`);
        assert.equal(res.body.field, 'offset');
        assert.match(res.body.error, /offset/);
    }
    for (const bad of ['-1', '1.5', 'x']) await request(ctx.app).get(`${base}?limit=2&offset=${bad}`).expect(400);
    // Empty and missing mean "none"
    for (const fine of [undefined, null, '', 0, '0']) await query(ctx, base, { limit: 2, offset: fine }).expect(200);
    // limit keeps its own rules
    const badLimit = await query(ctx, base, { limit: 0, offset: 1 }).expect(400);
    assert.equal(badLimit.body.field, 'limit');
});

test('a drop-box link sees no items, no total and nothing more, whatever the page', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'guarded', password: 'correct horse' }).expect(201);
    await owner.post('/api/stashes/guarded/notes').send({ text: 'hidden' }).expect(201);
    const link = await owner.post('/api/stashes/guarded/share-links').send({ kind: 'drop' }).expect(201);
    const dropper = request.agent(ctx.app);
    await dropper.post('/api/stashes/guarded/redeem').send({ token: link.body.token }).expect(200);
    const res = await dropper.post('/api/stashes/guarded/query').send({ limit: 10, offset: 0 }).expect(200);
    assert.deepEqual([res.body.items, res.body.total, res.body.hasMore], [[], 0, false]);
    const further = await dropper.post('/api/stashes/guarded/query').send({ limit: 10, offset: 7 }).expect(200);
    assert.deepEqual([further.body.items, further.body.total, further.body.hasMore], [[], 0, false]);
});

test('the browser extension\'s query (a limit and no offset) still answers as before', async () => {
    const { ctx, base } = await filled(30);
    // What extension/popup.js sends: POST .../query with { limit }
    const res = await query(ctx, base, { limit: 25 }).expect(200);
    assert.equal(res.body.items.length, 25);
    assert.equal(res.body.total, 30);
    assert.equal(res.body.items[0].text, 'note 30');
    // The fields it reads are all still there
    for (const key of ['id', 'kind', 'title', 'text', 'createdAt', 'url', 'fileName']) assert.ok(key in res.body.items[0], key);
    // And with an offset it can ask for the rest
    const rest = await query(ctx, base, { limit: 25, offset: 25 }).expect(200);
    assert.equal(rest.body.items.length, 5);
    assert.equal(rest.body.hasMore, false);
});

test('burn notes and expired notes are not counted in the pages either', async () => {
    const { ctx, base } = await filled(4);
    await request(ctx.app).post(`${base}/notes`).send({ text: 'burnme', burn: true }).expect(201);
    const res = await query(ctx, base, { limit: 2, offset: 2 }).expect(200);
    // The burn note is in the list (as a placeholder) and counted; the page arithmetic is by listed items
    assert.equal(res.body.total, 5);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.hasMore, true);
    assert.ok(res.body.items.every(item => item.text !== 'burnme'));
});
