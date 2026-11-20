const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
// launch.js also works as a CommonJS module, so its decision can be tested here
const { target, KEY } = require('../src/views/launch.js');

const storageWith = value => ({ getItem: key => (key === KEY ? value : null) });

test('a launch from the installed app opens the last stash', () => {
    assert.equal(target('?source=pwa', storageWith('my-stash-name')), 'my-stash-name');
    assert.equal(target('?source=pwa&x=1', storageWith('abcd')), 'abcd');
    assert.equal(target('?x=1&source=pwa', storageWith('abcd')), 'abcd');
});

test('an ordinary visit to the home page is never redirected', () => {
    for (const search of ['', '?', '?source=web', '?source=pwa2', '?resource=pwa', '?x=source=pwa']) {
        assert.equal(target(search, storageWith('my-stash-name')), null, search);
    }
});

test('nothing is opened when there is no last stash, or storage cannot be read', () => {
    assert.equal(target('?source=pwa', storageWith(null)), null);
    assert.equal(target('?source=pwa', { getItem() { throw new Error('blocked'); } }), null);
    assert.equal(target('?source=pwa', undefined), null);
});

test('only a well-formed stash name is ever followed', () => {
    for (const bad of ['', 'abc', 'has space', 'UPPER', '../admin', 'a/b', 'javascript:alert(1)', 'x'.repeat(65), '//evil.com', '<script>']) {
        assert.equal(target('?source=pwa', storageWith(bad)), null, bad);
    }
    assert.equal(target('?source=pwa', storageWith('ok_name-1')), 'ok_name-1');
    assert.equal(target('?source=pwa', storageWith('x'.repeat(64))), 'x'.repeat(64));
});

test('the installed app starts through the launch address, and the home page loads the redirect first', async () => {
    const { app } = makeApp();
    const manifest = JSON.parse((await request(app).get('/manifest.webmanifest').expect(200)).text);
    assert.equal(manifest.start_url, '/?source=pwa');
    assert.ok(manifest.start_url.startsWith(manifest.scope));

    // The launch address is the home page, and launch.js comes before the page's own scripts (in the head)
    const page = (await request(app).get('/?source=pwa').expect(200)).text;
    const head = page.slice(0, page.indexOf('</head>'));
    assert.match(head, /<script src="\/launch\.js"><\/script>/);
    const js = await request(app).get('/launch.js').expect(200);
    assert.match(js.headers['content-type'], /javascript/);
});

test('the stash page remembers the last stash, and forgets it on logout, exit or when it is gone', async () => {
    const { app } = makeApp();
    const html = (await request(app).get('/s/anything').expect(200)).text;
    assert.match(html, /<script src="\/pwa\.js"><\/script>/);
    const pwa = (await request(app).get('/pwa.js').expect(200)).text;
    assert.match(pwa, /sl_last_stash/);
    const stash = (await request(app).get('/stash.js').expect(200)).text;
    assert.match(stash, /StashlyLast\.set\(slug\)/);
    assert.match(stash, /StashlyLast\.clear\(slug\)/);
});
