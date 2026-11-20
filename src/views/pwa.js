// Registers the service worker, which is what lets a phone install Stashly and offer it in the share sheet.
// Also remembers the stashes you open, so the share page can suggest them.
(function () {
    'use strict';

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('/sw.js').catch(function () { /* the site works without it */ });
    }

    // Called by the stash page once a stash has opened. Only the name is kept, never a password or content.
    window.StashlyRemember = function (slug) {
        try {
            var list = JSON.parse(localStorage.getItem('sl_recent_stashes') || '[]');
            if (!Array.isArray(list)) list = [];
            list = list.filter(function (name) { return name !== slug; });
            list.unshift(slug);
            localStorage.setItem('sl_recent_stashes', JSON.stringify(list.slice(0, 8)));
        } catch (e) { /* not remembered */ }
    };
})();
