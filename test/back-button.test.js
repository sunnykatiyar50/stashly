// The Back button support (src/views/back.js), run in Node against a fake history that behaves like a browser's: pushState adds
// an entry, back() is asynchronous and then fires popstate, and a person pressing Back is the same traversal from outside.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'back.js'), 'utf8');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

// Loads back.js with a fake window and history. `entries` is what the history holds (the first is the page itself).
function load() {
    const listeners = [];
    const entries = [null];
    let index = 0;
    const fire = () => listeners.forEach(fn => fn({ state: entries[index] }));
    const history = {
        pushState(state) { entries.splice(index + 1); entries.push(state); index++; },
        // Like a browser: the move happens later, and then popstate fires. At the first entry there is nowhere to go.
        back() { if (index > 0) setImmediate(() => { index--; fire(); }); },
    };
    const window = { addEventListener: (type, fn) => { if (type === 'popstate') listeners.push(fn); } };
    const document = { readyState: 'complete', querySelectorAll: () => [] };
    vm.runInNewContext(SOURCE, { window, history, document, setTimeout, clearTimeout, MutationObserver: class { observe() {} } });
    return {
        back: window.StashlyBack,
        entries, history,
        index: () => index,
        // A person pressing the Back button
        press: () => new Promise(resolve => { history.back(); setTimeout(resolve, 15); }),
    };
}

test('Back closes what was opened, and only that: it does not leave the page', async () => {
    const page = load();
    const closed = [];
    page.back.push('clip', () => closed.push('clip'));
    await tick();
    assert.equal(page.index(), 1, 'opening it added one history entry');
    await page.press();
    assert.deepEqual(closed, ['clip']);
    assert.equal(page.index(), 0, 'and Back used that entry, nothing more');
    assert.equal(page.back.open(), 0);
});

test('closing it another way takes its history entry away again, without calling close', async () => {
    const page = load();
    const closed = [];
    page.back.push('dialog:options', () => closed.push('x'));
    await tick();
    page.back.release('dialog:options');
    await tick(20);
    assert.equal(page.index(), 0);
    assert.deepEqual(closed, []);
    assert.equal(page.back.open(), 0);
    // Releasing what is not open is harmless
    page.back.release('dialog:options');
    await tick(20);
    assert.equal(page.index(), 0);
});

test('layers close one at a time, the newest first', async () => {
    const page = load();
    const closed = [];
    page.back.push('clip', () => closed.push('clip'));
    page.back.push('dialog:share', () => closed.push('dialog'));
    await tick();
    assert.equal(page.index(), 2);
    await page.press();
    assert.deepEqual(closed, ['dialog']);
    await page.press();
    assert.deepEqual(closed, ['dialog', 'clip']);
    assert.equal(page.index(), 0);
});

test('a menu that closes as a dialog opens: the dialog keeps its entry, so Back closes the dialog', async () => {
    const page = load();
    const closed = [];
    page.back.push('more-menu', () => closed.push('menu'));
    await tick();
    // Pressing an entry in the menu: the menu closes and, in the same moment, the dialog it opens registers itself
    page.back.release('more-menu');
    page.back.push('dialog:qr', () => closed.push('dialog'));
    await tick(30);
    assert.equal(page.index(), 1, 'one entry, for the dialog');
    assert.deepEqual(page.entries.map(e => e && e.stashlyBack), [null, 'dialog:qr']);
    await page.press();
    assert.deepEqual(closed, ['dialog']);
    assert.equal(page.index(), 0);
});

test('closing a layer that has something above it leaves a spare entry that Back steps over in one press', async () => {
    const page = load();
    const closed = [];
    page.back.push('clip', () => closed.push('clip'));
    page.back.push('dialog:options', () => closed.push('dialog'));
    await tick();
    // The clip goes away (deleted elsewhere) while the dialog is still open
    page.back.release('clip');
    await tick(20);
    assert.equal(page.index(), 2, 'its entry is still there, under the dialog');
    // The dialog is closed with its own button
    page.back.release('dialog:options');
    await tick(20);
    assert.equal(page.index(), 1, 'one step back, onto the spare entry');
    // One press of Back now goes past it, to the page before
    await page.press();
    await tick(20);
    assert.equal(page.index(), 0);
    assert.deepEqual(closed, []);
});

test('the same thing opened twice has one entry; and a Back with nothing open is left to the browser', async () => {
    const page = load();
    let calls = 0;
    page.back.push('drawer', () => calls++);
    page.back.push('drawer', () => calls++);
    await tick();
    assert.equal(page.index(), 1);
    await page.press();
    assert.equal(calls, 1);
    // Nothing open and nothing spare: a press moves nowhere in this page (the first entry), no error
    await page.press();
    assert.equal(page.index(), 0);
});

test('a back() the browser never answers does not stop later layers from working', async () => {
    const page = load();
    // Closing something that was never given an entry (the history was already at its first entry) queues a back with no answer
    page.back.push('menu', () => {});
    await tick();
    page.entries.length = 1; // the history was reset behind its back (a page restored from cache)
    page.back.release('menu');
    await tick(500);
    page.back.push('dialog:late', () => {});
    await tick(10);
    assert.equal(page.back.open(), 1);
    assert.ok(page.entries.some(entry => entry && entry.stashlyBack === 'dialog:late'), 'the later layer got its entry');
});

test('the pages load it before the shell, and the things that open on top use it', async () => {
    const ctx = makeApp({ adminPassword: 'admin-pass-123' });
    for (const url of ['/', '/account', '/admin', '/settings', '/s/any-stash-name']) {
        const html = (await request(ctx.app).get(url).expect(200)).text.replace(/\?v=[0-9a-f]+"/g, '"');
        assert.ok(html.indexOf('src="/back.js"') > 0, `${url} loads back.js`);
        assert.ok(html.indexOf('src="/back.js"') < html.indexOf('src="/shell.js"'), `${url}: back.js comes before shell.js`);
    }
    const text = async file => (await request(ctx.app).get(file).expect(200)).text;
    assert.match(await text('/shell.js'), /StashlyBack\.push\('drawer'/);
    assert.match(await text('/stash-detail.js'), /StashlyBack\.push\('clip'/);
    assert.match(await text('/stash-detail.js'), /narrow\.matches\) \{\s*if \(pane === 'right'\)/);
    assert.match(await text('/stash-more.js'), /StashlyBack\.push\('more-menu'/);
    assert.match(await text('/back.js'), /querySelectorAll\('dialog'\)/);
});
