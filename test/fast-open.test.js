// Opening a stash quickly: the first page comes inside the stash page for a visitor who may read it, the newest note
// comes in full, and the page's scripts and styles have versioned addresses the browser keeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const PASSWORD = 'correct horse battery';
const BIG = 'y'.repeat(5000);

// The JSON the server put in the page, or null
function initialOf(html) {
    const match = /<script type="application\/json" id="initialPage">([\s\S]*?)<\/script>/.exec(html);
    return match ? JSON.parse(match[1]) : null;
}

test('an unlocked password stash comes inside its page, with the newest note in full', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'fast-open', password: PASSWORD }).expect(201);
    await owner.post('/api/stashes/fast-open/notes').send({ text: 'older' }).expect(201);
    await owner.post('/api/stashes/fast-open/notes').send({ text: BIG, title: 'Newest' }).expect(201);

    const html = (await owner.get('/s/fast-open').expect(200)).text;
    const first = initialOf(html);
    assert.ok(first, 'the first page is in the page');
    assert.equal(first.slug, 'fast-open');
    assert.equal(first.role, 'full');
    assert.equal(first.items.length, 2);
    // The first item is the one the page opens: whole, not a preview
    assert.equal(first.items[0].title, 'Newest');
    assert.equal(first.items[0].text, BIG);
    assert.equal(first.items[0].truncated, undefined);
    // The same as the page's own first request
    const asked = await owner.post('/api/stashes/fast-open/query').send({ preview: true, limit: 100, offset: 0, fullFirst: true }).expect(200);
    assert.deepEqual(first.items, asked.body.items);
});

test('nothing is added for a visitor who only knows the name, is locked out, or names no stash', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'open-by-name-only' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'locked-stash', password: PASSWORD }).expect(201);
    for (const slug of ['open-by-name-only', 'locked-stash', 'no-such-stash-here']) {
        const html = (await request(ctx.app).get(`/s/${slug}`).expect(200)).text;
        assert.equal(initialOf(html), null, slug);
        // The place for it is not left in the page either
        assert.doesNotMatch(html, /initial-page|initialPage/, slug);
    }
});

test('the inline page cannot break out of its element', async () => {
    const ctx = makeApp();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'tricky-stash', password: PASSWORD }).expect(201);
    const text = '</script><script>alert(1)</script><!-- & -->';
    await owner.post('/api/stashes/tricky-stash/notes').send({ text }).expect(201);
    const html = (await owner.get('/s/tricky-stash').expect(200)).text;
    // Exactly one JSON element, and the note's text survives the round trip
    assert.equal(html.match(/<script type="application\/json"/g).length, 1);
    assert.equal(initialOf(html).items[0].text, text);
    assert.doesNotMatch(html, /<script>alert/);
});

test('fullFirst only applies to the first item of the first page', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'full-first-stash' }).expect(201);
    for (let i = 0; i < 3; i++) await request(ctx.app).post('/api/stashes/full-first-stash/notes').send({ text: BIG + i }).expect(201);
    const first = await request(ctx.app).post('/api/stashes/full-first-stash/query').send({ preview: true, fullFirst: true }).expect(200);
    assert.deepEqual(first.body.items.map(item => Boolean(item.truncated)), [false, true, true]);
    const later = await request(ctx.app).post('/api/stashes/full-first-stash/query').send({ preview: true, fullFirst: true, offset: 1 }).expect(200);
    assert.ok(later.body.items.every(item => item.truncated));
    // Without it, a preview cuts every long note as before
    const plain = await request(ctx.app).post('/api/stashes/full-first-stash/query').send({ preview: true }).expect(200);
    assert.ok(plain.body.items.every(item => item.truncated));
});

test('pages give their scripts and styles versioned addresses, which the browser may keep for good', async () => {
    const ctx = makeApp();
    for (const url of ['/', '/s/some-stash-name', '/account', '/admin', '/settings', '/share']) {
        const html = (await request(ctx.app).get(url).expect(200)).text;
        const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))(\?v=[0-9a-f]{12})?"/g)];
        assert.ok(assets.length, url);
        for (const match of assets) assert.ok(match[2], `${url}: ${match[1]} is versioned`);
    }
    const html = (await request(ctx.app).get('/s/some-stash-name').expect(200)).text;
    const css = /href="(\/styles\.css\?v=[0-9a-f]+)"/.exec(html)[1];
    const qr = /src="(\/vendor\/qrcode\.js\?v=[0-9a-f]+)"/.exec(html)[1];
    for (const url of [css, qr]) {
        for (const encoding of ['gzip', 'identity']) {
            const res = await request(ctx.app).get(url).set('Accept-Encoding', encoding).expect(200);
            assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', `${url} ${encoding}`);
        }
    }
    // The plain address is still checked with the server each time
    const plain = await request(ctx.app).get('/styles.css').set('Accept-Encoding', 'gzip').expect(200);
    assert.equal(plain.headers['cache-control'], 'no-cache');
    // The pages themselves are never kept
    assert.equal((await request(ctx.app).get('/s/some-stash-name')).headers['cache-control'], 'no-store');
});
