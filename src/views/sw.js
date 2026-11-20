// A service worker only so the browser treats Stashly as an installable app (which is what makes it appear in a
// phone's share sheet). It caches nothing: stashes are private and every request goes to the server.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* pass-through: the browser handles the request */ });
