// A service worker so the browser treats Stashly as an installable app (which is what makes it appear in a phone's share
// sheet), and so it can receive what is shared to it. It caches nothing: stashes are private and every request goes to the
// server.
//
// Sharing: the manifest's share target POSTs to /share as a form with files. A server cannot read that without a multipart
// parser, and the files would have to travel twice, so this worker takes the POST itself: it keeps the title, text, link and
// files in the browser's own IndexedDB (nothing is sent to the server) and sends the page on to /share?received=1, which
// reads them back (share.js), lets the person pick the stash, and uploads them. Only that page can send them anywhere.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

var DB_NAME = 'stashly-share';
var STORE = 'pending';

function save(record) {
    return new Promise(function (resolve, reject) {
        var open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = function () { open.result.createObjectStore(STORE); };
        open.onerror = function () { reject(open.error); };
        open.onsuccess = function () {
            var db = open.result;
            var tx = db.transaction(STORE, 'readwrite');
            // One share is kept at a time: a new one replaces any that was never picked up
            tx.objectStore(STORE).put(record, 'latest');
            tx.oncomplete = function () { db.close(); resolve(); };
            tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
        };
    });
}

var text = function (value) { return typeof value === 'string' ? value : ''; };
var isFile = function (value) { return value && typeof value === 'object' && typeof value.size === 'number' && typeof value.name === 'string'; };

function receiveShare(request) {
    // Kept so that, if the browser cannot store it, the server still gets the request as it used to (text shares work that way)
    var copy = request.clone();
    return request.formData().then(function (form) {
        return save({
            time: Date.now(),
            title: text(form.get('title')),
            text: text(form.get('text')),
            url: text(form.get('url')),
            files: form.getAll('files').filter(isFile),
        });
    }).then(function () {
        return Response.redirect('/share?received=1', 303);
    }, function () {
        return fetch(copy);
    });
}

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'POST') return;
    var url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname !== '/share') return;
    event.respondWith(receiveShare(request));
});
