// The service worker's share handling (src/views/sw.js), run in Node against a fake worker scope and a small fake IndexedDB, with
// real Request and FormData objects: it must keep a shared title, text, link and files for the share page, send the page on to
// /share?received=1, leave every other request alone, and fall back to the server when the browser cannot store the share.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'sw.js'), 'utf8');

// Just enough IndexedDB for the worker: open (with upgrade), a transaction, and put / get / delete on one store
function fakeIndexedDB({ failOpen = false } = {}) {
    const stores = new Map(); // store name -> Map(key -> value)
    const later = fn => setImmediate(fn);
    return {
        stores,
        open(name, version) {
            const request = { result: null, error: null };
            later(() => {
                if (failOpen) { request.error = new Error('storage is not available'); return request.onerror && request.onerror(); }
                const db = {
                    createObjectStore(store) { stores.set(store, new Map()); },
                    transaction(store) {
                        const tx = {};
                        const data = stores.get(store);
                        const done = () => later(() => tx.oncomplete && tx.oncomplete());
                        tx.objectStore = () => ({
                            put(value, key) { data.set(key, value); done(); return {}; },
                            get(key) { const r = {}; later(() => { r.result = data.get(key); r.onsuccess && r.onsuccess(); }); return r; },
                            delete(key) { data.delete(key); done(); return {}; },
                        });
                        return tx;
                    },
                    close() {},
                };
                request.result = db;
                if (!stores.size) request.onupgradeneeded && request.onupgradeneeded();
                request.onsuccess && request.onsuccess();
            });
            return request;
        },
    };
}

// Runs sw.js in a context with a fake worker scope. Returns the scope, the handlers it registered and what it did.
function load({ failOpen = false } = {}) {
    const handlers = {};
    const calls = { fetch: [], redirects: [] };
    const indexedDB = fakeIndexedDB({ failOpen });
    const scope = {
        location: { origin: 'https://stash.example.com' },
        addEventListener: (type, fn) => { handlers[type] = fn; },
        skipWaiting: () => {},
        clients: { claim: () => Promise.resolve() },
    };
    const sandbox = {
        self: scope, indexedDB, URL, Promise, setTimeout,
        // Browsers resolve a relative address here against the worker's own; Node needs it spelled out, so the call is recorded
        Response: { redirect: (url, status) => { calls.redirects.push([url, status]); return { redirected: true, url, status }; } },
        fetch: request => { calls.fetch.push(request); return Promise.resolve({ fromServer: true }); },
    };
    vm.runInNewContext(SOURCE, sandbox);
    // Sends one fetch event through the worker; resolves to what it answered, or undefined when it let the request pass
    const send = request => new Promise(resolve => {
        let answered = false;
        handlers.fetch({ request, respondWith: promise => { answered = true; Promise.resolve(promise).then(resolve); } });
        if (!answered) resolve(undefined);
    });
    return { handlers, calls, indexedDB, send };
}

const post = (url, form) => new Request(url, { method: 'POST', body: form });
const formOf = (fields, files = []) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    for (const file of files) form.append('files', file);
    return form;
};

test('a share with files is kept for the share page and the browser is sent there', async () => {
    const sw = load();
    const png = new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'IMG_0001.png', { type: 'image/png' });
    const note = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const answer = await sw.send(post('https://stash.example.com/share', formOf({ title: 'Holiday', text: 'look', url: 'https://example.com' }, [png, note])));

    assert.deepEqual(sw.calls.redirects, [['/share?received=1', 303]]);
    assert.equal(answer.redirected, true);
    assert.equal(sw.calls.fetch.length, 0, 'nothing is sent on to the server');

    const kept = sw.indexedDB.stores.get('pending').get('latest');
    assert.equal(kept.title, 'Holiday');
    assert.equal(kept.text, 'look');
    assert.equal(kept.url, 'https://example.com');
    assert.deepEqual(kept.files.map(file => [file.name, file.size, file.type]), [['IMG_0001.png', 7, 'image/png'], ['notes.txt', 5, 'text/plain']]);
    assert.ok(Math.abs(Date.now() - kept.time) < 5000);
    assert.equal(Buffer.from(await kept.files[1].arrayBuffer()).toString(), 'hello', 'the bytes are kept, not just the names');
});

test('a text-only share is kept the same way, and a later share replaces one nobody picked up', async () => {
    const sw = load();
    await sw.send(post('https://stash.example.com/share', formOf({ title: 'First', text: 'one', url: '' })));
    await sw.send(post('https://stash.example.com/share', formOf({ title: 'Second', text: 'two', url: '' })));
    const stored = sw.indexedDB.stores.get('pending');
    assert.equal(stored.size, 1);
    const kept = stored.get('latest');
    assert.equal(kept.title, 'Second');
    assert.deepEqual(kept.files, []);
});

test('only a POST to /share on this origin is taken; every other request passes through untouched', async () => {
    const sw = load();
    assert.equal(await sw.send(new Request('https://stash.example.com/share')), undefined, 'a GET of the page');
    assert.equal(await sw.send(post('https://stash.example.com/api/stashes/x/notes', formOf({ text: 'a' }))), undefined, 'another path');
    assert.equal(await sw.send(post('https://elsewhere.example.org/share', formOf({ text: 'a' }))), undefined, 'another origin');
    assert.equal(sw.calls.redirects.length, 0);
    assert.equal(sw.indexedDB.stores.size, 0, 'nothing was stored');
});

test('when the browser cannot store the share, the request goes to the server as before', async () => {
    const sw = load({ failOpen: true });
    const answer = await sw.send(post('https://stash.example.com/share', formOf({ title: 'T', text: 'x', url: '' })));
    assert.deepEqual(answer, { fromServer: true });
    assert.equal(sw.calls.fetch.length, 1);
    assert.equal(sw.calls.fetch[0].method, 'POST');
    assert.equal(sw.calls.redirects.length, 0);
});

test('the worker still installs at once and takes over open pages, and keeps no cache', () => {
    const sw = load();
    assert.equal(typeof sw.handlers.install, 'function');
    assert.equal(typeof sw.handlers.activate, 'function');
    assert.doesNotMatch(SOURCE, /caches\.|cache\.put|addAll/);
});
