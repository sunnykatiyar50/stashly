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
    var pinned = false;
    var autoTried = {};     // stashes this page already tried to follow by itself, so a failure is not retried in a loop
    var SEEN_EVERY_MS = 30000;

    // The menu is the same in every state of the page (loading, locked, open, gone) and for everyone who can see it, as on the
    // home page: "My stashes" in the main menu for someone signed in, "Sign in" above Theme for a visitor, and neither when the
    // server has no accounts. What was seen last time is drawn at once, and the server's answer (asked as the page starts, not
    // when the stash has loaded, so a locked stash gets it too) confirms it. Otherwise the entry would be missing exactly
    // when someone has just signed out and is asked for the stash's password.
    function paintAccountLinks(enabled, signedIn) {
        $('accountLink').classList.toggle('hidden', !signedIn);
        $('signInLink').classList.toggle('hidden', !(enabled && !signedIn));
    }
    try {
        var seen = localStorage.getItem('sl_signed_in');
        var seenAccounts = localStorage.getItem('sl_accounts_on');
        if (seen === '1') paintAccountLinks(true, true);
        else if (seenAccounts === '1') paintAccountLinks(true, false);
    } catch (e) { /* stays hidden until known */ }

    // Who is signed in, asked once; the rest of the page waits on this promise
    var meReady = null;
    function probeMe() {
        if (!meReady) {
            // account-nav.js asked at page start already; reuse that answer
            var nav = window.StashlyAccountNav;
            meReady = (nav && nav.firstMe ? nav.firstMe() : api('/api/me')).then(function (res) {
                var enabled = Boolean(res.ok && res.body && res.body.enabled);
                accounts = Boolean(enabled && res.body.user);
                paintAccountLinks(enabled, accounts);
                try {
                    localStorage.setItem('sl_signed_in', accounts ? '1' : '0');
                    localStorage.setItem('sl_accounts_on', enabled ? '1' : '0');
                } catch (e) { /* not remembered */ }
            });
        }
        return meReady;
    }
    probeMe().catch(function () { /* the menu keeps what it shows */ });

    // Called by the rest of the page every time the stash is (re)loaded
    function refresh() {
        if (!probed) {
            probed = true;
            probeMe().then(function () { if (accounts) refresh(); }).catch(function () { /* no account features this time */ });
            return;
        }
        var button = $('followStashButton');
        var r = state.stash ? role() : null;
        // A drop-box link has nothing to read, so there is nothing to follow
        if (!accounts || !state.stash || (r !== 'full' && r !== 'view')) {
            button.classList.add('hidden');
            $('pinStashButton').classList.add('hidden');
            stopSeen();
            return;
        }
        api('/api/me/stashes').then(function (res) {
            if (!res.ok || !res.body) return;
            var mine = res.body.stashes.filter(function (s) { return s.slug === state.stash.slug && !s.needsPassword; })[0];
            following = Boolean(mine);
            pinned = Boolean(mine && mine.pinned);
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

    // The pin button: only for a stash that is in the list. Pinned stashes show in the left menu on every page.
    function paintPin() {
        var pin = $('pinStashButton');
        pin.classList.toggle('hidden', !following);
        pin.classList.toggle('pinned', pinned);
        pin.setAttribute('aria-pressed', String(pinned));
        pin.querySelector('.btn-label').textContent = pinned ? 'Pinned' : 'Pin';
        pin.title = pinned ? 'Pinned in the left menu. Press to unpin.' : 'Show this stash in the left menu for quick switching';
    }

    $('pinStashButton').addEventListener('click', function () {
        var pin = $('pinStashButton');
        var want = !pinned;
        pin.disabled = true;
        api('/api/me/stashes/' + encodeURIComponent(state.stash.slug) + '/pin', { method: want ? 'PUT' : 'DELETE' }).then(function (res) {
            pin.disabled = false;
            if (res.ok) {
                pinned = want;
                paintPin();
                if (window.StashlyAccountNav) window.StashlyAccountNav.refreshPins();
            } else {
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        }).catch(function () {
            pin.disabled = false;
            toast('Could not reach the server.', true);
        });
    });

    function paint() {
        paintPin();
        var button = $('followStashButton');
        button.classList.remove('hidden');
        button.classList.toggle('following', following);
        button.setAttribute('aria-pressed', String(following));
        // A stash you made is always in your list: nothing to press
        var owned = Boolean(state.stash && state.stash.owned);
        button.disabled = owned;
        var word = owned ? 'Owner' : following ? 'Following' : 'Follow';
        button.classList.toggle('is-owner', owned);
        button.querySelector('.btn-label').textContent = word;
        button.setAttribute('aria-label', owned ? 'You made this stash, so it is always in My stashes.' : following ? 'Following this stash. Press to stop following.' : 'Follow this stash in My stashes');
        if (owned) { button.title = 'You made this stash, so it is always in your My stashes list.'; return; }
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
                pinned = false;
                setOptedOut(slug, true);
                if (window.StashlyAccountNav) window.StashlyAccountNav.refreshPins();
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
