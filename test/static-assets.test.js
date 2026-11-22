const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const views = path.join(__dirname, '..', 'src', 'views');

// The raw response: supertest and fetch both unzip for you, and the point is to see what goes over the wire
function rawGet(server, url, headers) {
    return new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: url, headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('scripts and styles are compressed for browsers that accept gzip, byte for byte the same file', async () => {
    const ctx = makeApp();
    const server = ctx.app.listen(0);
    try {
        for (const asset of ['styles.css', 'stash-list.js', 'shell.js']) {
            const res = await rawGet(server, '/' + asset, { 'Accept-Encoding': 'gzip' });
            assert.equal(res.status, 200, asset);
            assert.equal(res.headers['content-encoding'], 'gzip', asset);
            assert.match(res.headers.vary, /Accept-Encoding/);
            assert.ok(res.body.length < fs.statSync(path.join(views, asset)).size, asset + ' is smaller compressed');
            assert.deepEqual(zlib.gunzipSync(res.body), fs.readFileSync(path.join(views, asset)));
        }
        // A browser that does not accept gzip gets the plain file
        const plain = await rawGet(server, '/shell.js', { 'Accept-Encoding': 'identity' });
        assert.equal(plain.headers['content-encoding'], undefined);
        assert.deepEqual(plain.body, fs.readFileSync(path.join(views, 'shell.js')));
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test('assets are revalidated, not re-downloaded: no-cache with an ETag, and 304 when nothing changed', async () => {
    const ctx = makeApp();
    const first = await request(ctx.app).get('/styles.css').set('Accept-Encoding', 'gzip').expect(200);
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.ok(first.headers.etag);
    await request(ctx.app).get('/styles.css').set('Accept-Encoding', 'gzip').set('If-None-Match', first.headers.etag).expect(304);

    // The same without compression (express.static): also no-cache, and 304 on a repeat
    const plain = await request(ctx.app).get('/styles.css').set('Accept-Encoding', 'identity').expect(200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.headers['cache-control'], 'no-cache');
    assert.equal(plain.text, fs.readFileSync(path.join(views, 'styles.css'), 'utf8'));
    await request(ctx.app).get('/styles.css').set('Accept-Encoding', 'identity').set('If-None-Match', plain.headers.etag).expect(304);
});

test('only the public page assets are relaxed: pages, the API and files stay no-store', async () => {
    const ctx = makeApp();
    for (const url of ['/account', '/admin', '/api/config', '/s/some-stash-name']) {
        const res = await request(ctx.app).get(url).set('Accept-Encoding', 'gzip');
        assert.equal(res.headers['cache-control'], 'no-store', url);
    }
});

test('the gzip route never serves anything outside the views folder', async () => {
    const ctx = makeApp();
    for (const url of ['/..%2fpackage.json', '/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/%2e%2e%2fpackage.json', '/nope.js']) {
        const res = await request(ctx.app).get(url).set('Accept-Encoding', 'gzip');
        assert.notEqual(res.headers['content-encoding'], 'gzip', url);
        assert.ok(!/"name":\s*"stashly"/.test(res.text || ''), `${url} did not serve package.json`);
    }
});
