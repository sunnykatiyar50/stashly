// Runs first on the home page (it is in the <head>). When the installed app is launched from its icon, the manifest's
// start address carries ?source=pwa, and this sends the person straight to the stash they had open last time, before
// the home page has drawn anything. An ordinary visit to the home page is never redirected.
(function () {
    'use strict';

    var KEY = 'sl_last_stash';
    var LAUNCH = /(?:^|[?&])source=pwa(?:&|$)/;

    // The stash to open for this address, or null. storage is a localStorage-like object.
    function target(search, storage) {
        if (!LAUNCH.test(String(search || ''))) return null;
        var last;
        try { last = storage.getItem(KEY); } catch (e) { return null; }
        // Only a well-formed stash name is ever followed
        return typeof last === 'string' && /^[a-z0-9_-]{4,64}$/.test(last) ? last : null;
    }

    var api = { target: target, KEY: KEY };

    if (typeof window !== 'undefined' && window.location) {
        var slug = null;
        try { slug = target(window.location.search, window.localStorage); } catch (e) { slug = null; }
        if (slug) {
            window.location.replace('/s/' + slug);
        } else if (LAUNCH.test(window.location.search) && window.history && window.history.replaceState) {
            // Nothing to go back to: stay on the home page, with a clean address
            window.history.replaceState(null, '', window.location.pathname);
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
