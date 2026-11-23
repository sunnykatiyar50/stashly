const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

test('the web app manifest is served with a share target that reaches the share page', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/manifest.webmanifest').expect(200);
    assert.match(res.headers['content-type'], /manifest\+json|json/);
    const manifest = JSON.parse(res.text);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.share_target.action, '/share');
    // POST, so what is shared never appears in an address (proxy logs, browser history)
    assert.equal(manifest.share_target.method, 'POST');
    assert.equal(manifest.share_target.enctype, 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.keys(manifest.share_target.params).sort(), ['text', 'title', 'url']);
    // The share target must be inside the app's scope
    assert.ok(manifest.share_target.action.startsWith(manifest.scope));
});

test('every icon the manifest lists is served as a PNG', async () => {
    const { app } = makeApp();
    const manifest = JSON.parse((await request(app).get('/manifest.webmanifest')).text);
    const sizes = new Set(manifest.icons.map(icon => icon.sizes));
    assert.ok(sizes.has('192x192') && sizes.has('512x512'));
    for (const icon of manifest.icons) {
        const res = await request(app).get(icon.src).expect(200);
        assert.equal(res.headers['content-type'], 'image/png', icon.src);
        assert.ok(res.body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), `${icon.src} is a PNG`);
    }
    await request(app).get('/icons/icon-180.png').expect(200);
});

test('the service worker is served from the root as JavaScript and caches nothing', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/sw.js').expect(200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.doesNotMatch(res.text, /caches\.|cache\.put|addAll/);
});

test('the share page is served, with or without shared content in the address', async () => {
    const { app } = makeApp();
    for (const url of ['/share', '/share?title=Hi&text=hello%20world&url=https%3A%2F%2Fexample.com']) {
        const res = await request(app).get(url).expect(200);
        assert.match(res.headers['content-type'], /html/);
        assert.match(res.text, /id="shareForm"/);
    }
});

test('the pages link the manifest and load the app script', async () => {
    const { app } = makeApp();
    for (const url of ['/', '/s/any-name', '/share']) {
        // (the asset addresses carry ?v=<hash>; dropped here, the check is about the address)
        const text = (await request(app).get(url).expect(200)).text.replace(/\?v=[0-9a-f]+"/g, '"');
        assert.match(text, /rel="manifest" href="\/manifest\.webmanifest"/, url);
        assert.match(text, /src="\/pwa\.js"/, url);
    }
});

test('the content policy still allows what the share page needs and nothing from outside', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/share').expect(200);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline.*script|script-src[^;]*unsafe-inline/);
});

test('a note shared from the share page is added like any other', async () => {
    // The share page posts to the ordinary notes endpoint; check that path with a title and a link
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'phone' }).expect(201);
    const res = await request(ctx.app)
        .post('/api/stashes/phone/notes')
        .send({ title: 'An article', text: 'Worth reading\nhttps://example.com/a' })
        .expect(201);
    assert.equal(res.body.title, 'An article');
    assert.match(res.body.text, /https:\/\/example\.com\/a$/);
});
