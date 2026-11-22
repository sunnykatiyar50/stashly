// The stash page, an extra part that loads before stash.js: the account's Follow button. When someone is signed in to an account, opening
// a stash adds it to My stashes by itself (with the access this browser has now), and the header shows "Following" (press to
// stop). Someone who stops following is not signed up again by reopening the stash in the same tab. The stash is marked as
// seen so the account page counts only what arrived since. Nothing here runs for a visitor without an account: the button
// stays hidden and no request is made after the first check.
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
    var autoTried = {};     // stashes this page already tried to follow by itself, so a failure is not retried in a loop
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
            if (following) { startSeen(); return; }
            stopSeen();
            // Not on the list (or on it with a grant that no longer works): opening the stash adds it, unless the person
            // just chose to stop following it
            if (!optedOut(state.stash.slug) && !autoTried[state.stash.slug]) {
                autoTried[state.stash.slug] = true;
                followNow(true);
            }
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
            ? 'This stash is on your My stashes page, added when you opened it. Press to remove it (the stash itself is not touched).'
            : 'Add this stash to your My stashes page' + (role() === 'view' ? ' (read-only, as with this link)' : '');
    }

    // A stash someone stopped following stays off the list while this tab is open, even if they open it again.
    // sessionStorage can be blocked, in which case the stash is simply followed again next time.
    function optedOut(slug) {
        try { return sessionStorage.getItem('stashly-unfollowed:' + slug) === '1'; } catch (err) { return false; }
    }

    function setOptedOut(slug, value) {
        try {
            if (value) sessionStorage.setItem('stashly-unfollowed:' + slug, '1');
            else sessionStorage.removeItem('stashly-unfollowed:' + slug);
        } catch (err) { /* nothing to remember it with */ }
    }

    // Adds this stash to the list with the access this browser has. quiet: it was not asked for, so say nothing on failure.
    function followNow(quiet) {
        var button = $('followStashButton');
        button.disabled = true;
        return api('/api/me/stashes', { method: 'POST', body: { slug: state.stash.slug, current: true } }).then(function (res) {
            button.disabled = false;
            if (res.ok) {
                following = true;
                setOptedOut(state.stash.slug, false);
                paint();
                startSeen();
                toast('Added to My stashes');
            } else if (!quiet) {
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        }).catch(function () {
            button.disabled = false;
            if (!quiet) toast('Could not reach the server.', true);
        });
    }

    $('followStashButton').addEventListener('click', function () {
        if (!following) { followNow(false); return; }
        var button = $('followStashButton');
        var slug = state.stash.slug;
        button.disabled = true;
        api('/api/me/stashes/' + encodeURIComponent(slug), { method: 'DELETE' }).then(function (res) {
            button.disabled = false;
            if (res.ok) {
                following = false;
                setOptedOut(slug, true);
                paint();
                stopSeen();
                toast('Removed from My stashes');
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
