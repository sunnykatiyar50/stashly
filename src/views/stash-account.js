// The stash page, an extra part that loads before stash.js: the account's Follow button. When someone is signed in to an account, the header offers
// "Follow" (add this stash to My stashes, with the access this browser has now) or "Following" (press to stop), and the
// stash is marked as seen so the account page counts only what arrived since. Nothing here runs for a visitor without
// an account: the button stays hidden and no request is made after the first check.
(function () {
    'use strict';

    var P = window.StashlyPage;
    var $ = P.$;
    var state = P.state;
    var api = P.api;
    var toast = P.toast;
    var role = P.role;

    var accounts = false;   // accounts are on and someone is signed in
    var probed = false;     // /api/me has been asked
    var following = false;  // this stash is on the signed-in user's list with a grant that works
    var seenTimer = null;
    var SEEN_EVERY_MS = 30000;

    // Called by the rest of the page every time the stash is (re)loaded
    function refresh() {
        if (!probed) {
            probed = true;
            api('/api/me').then(function (res) {
                accounts = Boolean(res.ok && res.body && res.body.enabled && res.body.user);
                $('accountLink').classList.toggle('hidden', !accounts);
                if (accounts) refresh();
            }).catch(function () { /* no account features this time */ });
            return;
        }
        var button = $('followStashButton');
        var r = state.stash ? role() : null;
        // A drop-box link has nothing to read, so there is nothing to follow
        if (!accounts || !state.stash || (r !== 'full' && r !== 'view')) {
            button.classList.add('hidden');
            stopSeen();
            return;
        }
        api('/api/me/stashes').then(function (res) {
            if (!res.ok || !res.body) return;
            following = res.body.stashes.some(function (s) { return s.slug === state.stash.slug && !s.needsPassword; });
            paint();
            if (following) startSeen(); else stopSeen();
        }).catch(function () { /* the button keeps its last look */ });
    }

    function paint() {
        var button = $('followStashButton');
        button.classList.remove('hidden');
        button.classList.toggle('following', following);
        button.setAttribute('aria-pressed', String(following));
        var word = following ? 'Following' : 'Follow';
        button.querySelector('.btn-label').textContent = word;
        button.setAttribute('aria-label', following ? 'Following this stash. Press to stop following.' : 'Follow this stash in My stashes');
        button.title = following
            ? 'This stash is on your My stashes page. Press to remove it (the stash itself is not touched).'
            : 'Add this stash to your My stashes page' + (role() === 'view' ? ' (read-only, as with this link)' : '');
    }

    $('followStashButton').addEventListener('click', function () {
        var button = $('followStashButton');
        button.disabled = true;
        var slug = state.stash.slug;
        var request = following
            ? api('/api/me/stashes/' + encodeURIComponent(slug), { method: 'DELETE' })
            : api('/api/me/stashes', { method: 'POST', body: { slug: slug, current: true } });
        request.then(function (res) {
            button.disabled = false;
            if (res.ok) {
                following = !following;
                paint();
                if (following) { startSeen(); toast('Added to My stashes'); } else { stopSeen(); toast('Removed from My stashes'); }
            } else {
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        }).catch(function () {
            button.disabled = false;
            toast('Could not reach the server.', true);
        });
    });

    // ---- marking the stash as seen ----

    function markSeen() {
        if (!following || document.hidden || !state.stash) return;
        api('/api/me/stashes/' + encodeURIComponent(state.stash.slug) + '/seen', { method: 'POST' }).catch(function () { /* next time */ });
    }

    function startSeen() {
        markSeen();
        if (!seenTimer) seenTimer = setInterval(markSeen, SEEN_EVERY_MS);
    }

    function stopSeen() {
        clearInterval(seenTimer);
        seenTimer = null;
    }

    document.addEventListener('visibilitychange', function () { if (!document.hidden) markSeen(); });

    P.afterRole = refresh;
})();
