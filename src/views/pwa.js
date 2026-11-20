// Registers the service worker, which is what lets a phone install Stashly and offer it in the share sheet.
// Also remembers the stashes you open, so the share page can suggest them.
(function () {
    'use strict';

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('/sw.js').catch(function () { /* the site works without it */ });
    }

    // The stash the installed app should reopen when it is launched (see launch.js). Only the name is kept.
    window.StashlyLast = {
        set: function (slug) { try { localStorage.setItem('sl_last_stash', slug); } catch (e) { /* not remembered */ } },
        // Forget it, but only if it is this stash (another tab may have moved on to a different one)
        clear: function (slug) {
            try { if (localStorage.getItem('sl_last_stash') === slug) localStorage.removeItem('sl_last_stash'); } catch (e) { /* nothing to forget */ }
        },
    };

    // A stash was renamed: carry the old name over in the suggestions and in the "reopen last stash" memory
    window.StashlyRenamed = function (oldSlug, newSlug) {
        try {
            var list = JSON.parse(localStorage.getItem('sl_recent_stashes') || '[]');
            if (!Array.isArray(list)) list = [];
            list = list.filter(function (name) { return name !== oldSlug && name !== newSlug; });
            list.unshift(newSlug);
            localStorage.setItem('sl_recent_stashes', JSON.stringify(list.slice(0, 8)));
            if (localStorage.getItem('sl_last_stash') === oldSlug) localStorage.setItem('sl_last_stash', newSlug);
        } catch (e) { /* not remembered */ }
    };

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
