// The account page: the one sign-in for everyone (users and the server's admin), where followed stashes are watched in one place
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var states = { loading: $('stateLoading'), disabled: $('stateDisabled'), login: $('stateLogin'), reset: $('stateReset'), account: $('viewAccount') };
    var me = null;
    var refreshTimer = null;
    var REFRESH_MS = 20000;

    // ---- helpers ----

    function api(path, options) {
        options = options || {};
        return fetch(path, {
            method: options.method || 'GET',
            credentials: 'same-origin',
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
            body: options.body ? JSON.stringify(options.body) : undefined,
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        });
    }

    var toastTimer;
    function toast(message, isError) {
        var el = $('toast');
        el.textContent = message;
        el.classList.toggle('error', Boolean(isError));
        el.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.classList.add('hidden'); }, isError ? 4000 : 2200);
    }

    function show(name) {
        Object.keys(states).forEach(function (key) { states[key].classList.toggle('hidden', key !== name); });
    }

    function make(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined && text !== null) el.textContent = text;
        return el;
    }

    function relativeTime(iso) {
        if (!iso) return 'no activity yet';
        var seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
        if (seconds < 45) return 'just now';
        var minutes = Math.round(seconds / 60);
        if (minutes < 60) return minutes + ' min ago';
        var hours = Math.round(minutes / 60);
        if (hours < 24) return hours + ' h ago';
        var days = Math.round(hours / 24);
        return days + (days === 1 ? ' day ago' : ' days ago');
    }

    function expiryText(iso) {
        if (!iso) return 'Never expires';
        var ms = new Date(iso).getTime() - Date.now();
        if (ms <= 0) return 'Expired';
        var minutes = Math.floor(ms / 60000);
        if (minutes < 60) return 'Expires in ' + Math.max(1, minutes) + ' min';
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return 'Expires in ' + hours + ' h';
        return 'Expires in ' + Math.floor(hours / 24) + ' d';
    }

    // Static markup from this file (never from the server)
    var LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

    function openDialog(dialog) {
        if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }

    // ---- sign in and out ----

    // Where to go after signing in: only the admin area, and only when the address says exactly next=/admin. Anything else
    // (another path, a full address, "//evil.example", a look-alike such as /admin/x) is ignored, so the page can never
    // be used to send someone to another site.
    function nextTarget(search) {
        var match = /[?&]next=([^&#]*)/.exec(search || '');
        var value = '';
        try { value = match ? decodeURIComponent(match[1]) : ''; } catch (err) { value = ''; }
        return value === '/admin' ? '/admin' : '';
    }

    $('loginForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('loginError');
        error.textContent = '';
        var username = $('loginUsername').value.trim();
        var password = $('loginPassword').value;
        if (!username || !password) { error.textContent = 'Enter your username and password.'; return; }
        $('loginButton').disabled = true;
        api('/api/auth/login', { method: 'POST', body: { username: username, password: password } }).then(function (res) {
            $('loginButton').disabled = false;
            if (res.ok) {
                $('loginPassword').value = '';
                start(true);
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not sign in.';
                $('loginPassword').select();
            }
        }).catch(function () {
            $('loginButton').disabled = false;
            error.textContent = 'Could not reach the server.';
        });
    });

    $('logoutButton').addEventListener('click', function () {
        api('/api/auth/logout', { method: 'POST' }).then(function () {
            me = null;
            stopRefresh();
            show('login');
            $('loginUsername').focus();
        });
    });

    function sessionEnded() {
        me = null;
        stopRefresh();
        show('login');
        toast('Your session ended. Sign in again.', true);
    }

    // ---- the list of followed stashes ----

    function loadList() {
        return api('/api/me/stashes').then(function (res) {
            if (res.status === 401) return sessionEnded();
            if (!res.ok) return null;
            renderList(res.body.stashes);
            $('refreshInfo').textContent = 'Updated ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '. Refreshes by itself while this page is open.';
            return null;
        }).catch(function () { /* the next refresh tries again */ });
    }

    // The stashes you own, then the ones you follow: two lists (each hidden when empty), pinned first in each
    function renderList(stashes) {
        var owned = stashes.filter(function (stash) { return stash.owned; });
        var followed = stashes.filter(function (stash) { return !stash.owned; });
        fillGroup('owned', owned);
        fillGroup('follow', followed);
        $('followEmpty').classList.toggle('hidden', stashes.length > 0);
    }

    function fillGroup(name, stashes) {
        var list = $(name + 'List');
        list.textContent = '';
        stashes.forEach(function (stash) { list.appendChild(buildRow(stash)); });
        $(name + 'Group').classList.toggle('hidden', stashes.length === 0);
        $(name + 'Count').textContent = stashes.length ? String(stashes.length) : '';
    }

    // Constant markup from this file only
    var PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l-1 7 4 3v2H6v-2l4-3z"/></svg>';
    var GEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

    // One compact row: the name with its tags, a line of facts, and the buttons
    function buildRow(stash) {
        var li = make('li', 'stash-row card' + (stash.needsPassword ? ' stale' : ''));

        // A stash with a label (your Clipboard stash) is shown by it: its own name is only a random key
        var shown = stash.label || stash.slug;
        var id = make('div', 'stash-id');
        id.appendChild(make('span', stash.label ? 'follow-name' : 'mono follow-name', shown));
        // A display name covers the name people open the stash by, so that is shown small beside it (never for the Clipboard stash)
        if (stash.label && !stash.clipboard) id.appendChild(make('span', 'mono muted follow-key', stash.slug));
        if (stash.needsPassword) {
            id.appendChild(make('span', 'chip warn', 'Needs the password'));
        } else {
            if (stash.owned) id.appendChild(make('span', 'chip owner-chip', 'Owner'));
            if (stash.hasPassword) {
                var lock = make('span', 'chip lock-chip');
                lock.title = 'Password protected';
                lock.setAttribute('role', 'img');
                lock.setAttribute('aria-label', 'Password protected');
                lock.innerHTML = LOCK_ICON;
                id.appendChild(lock);
            }
            if (!stash.owned) id.appendChild(make('span', 'chip' + (stash.role === 'view' ? ' role-view' : ''), stash.role === 'view' ? 'Read-only' : 'Full access'));
            if (stash.newItems > 0) id.appendChild(make('span', 'chip new-chip', stash.newItems + ' new'));
        }
        li.appendChild(id);

        var sub = make('div', 'stash-meta muted');
        if (stash.needsPassword) {
            sub.textContent = 'Its password or link changed. Enter the password to follow it again.';
        } else {
            sub.textContent = stash.items + (stash.items === 1 ? ' item' : ' items') + (stash.files ? ' (' + stash.files + (stash.files === 1 ? ' file' : ' files') + ')' : '') +
                ' · ' + (stash.latestAt ? 'last ' + relativeTime(stash.latestAt) : 'no activity yet') + ' · ' + expiryText(stash.expiresAt);
        }
        li.appendChild(sub);

        var actions = make('div', 'row-actions');
        if (stash.needsPassword) {
            var again = make('button', 'primary small', 'Enter password');
            again.type = 'button';
            again.addEventListener('click', function () { openRefollow(stash); });
            actions.appendChild(again);
        } else {
            var open = make('a', 'button-link primary-link small', 'Open');
            open.href = '/s/' + encodeURIComponent(stash.slug);
            actions.appendChild(open);
            var pin = make('button', 'ghost small icon-action pin-button' + (stash.pinned ? ' pinned' : ''));
            pin.type = 'button';
            pin.innerHTML = PIN_ICON;
            pin.setAttribute('aria-pressed', String(Boolean(stash.pinned)));
            pin.setAttribute('aria-label', (stash.pinned ? 'Unpin ' : 'Pin ') + shown);
            pin.title = stash.pinned ? 'Pinned: press to remove it from the left menu' : 'Pin it to the left menu for quick switching';
            pin.addEventListener('click', function () { pinStash(stash, !stash.pinned); });
            actions.appendChild(pin);
            // Your own stash: its settings, without opening it first (the stash opens on its Options)
            if (stash.owned) {
                var settings = make('a', 'button-link ghost small icon-action');
                settings.href = '/s/' + encodeURIComponent(stash.slug) + '#options';
                settings.innerHTML = GEAR_ICON;
                settings.setAttribute('aria-label', 'Settings for ' + shown);
                settings.title = 'Settings: name, expiry, tags, owner...';
                actions.appendChild(settings);
            }
        }
        // Only stashes someone else made can be unfollowed: your own stay in your list
        if (!stash.owned) {
            var unfollow = make('button', 'ghost small danger-ghost', 'Unfollow');
            unfollow.type = 'button';
            unfollow.setAttribute('aria-label', 'Unfollow ' + stash.slug);
            unfollow.addEventListener('click', function () { unfollowStash(stash); });
            actions.appendChild(unfollow);
        }
        li.appendChild(actions);
        return li;
    }

    function pinStash(stash, pinned) {
        api('/api/me/stashes/' + encodeURIComponent(stash.slug) + '/pin', { method: pinned ? 'PUT' : 'DELETE' }).then(function (res) {
            if (res.status === 401) return sessionEnded();
            if (!res.ok) { toast((res.body && res.body.error) || 'Could not change that.', true); return null; }
            loadList();
            if (window.StashlyAccountNav) window.StashlyAccountNav.refreshPins();
            return null;
        });
    }

    function unfollowStash(stash) {
        api('/api/me/stashes/' + encodeURIComponent(stash.slug), { method: 'DELETE' }).then(function (res) {
            if (res.status === 401) return sessionEnded();
            if (res.ok) { toast('Stopped following "' + stash.slug + '". The stash itself is untouched.'); loadList(); if (window.StashlyAccountNav) window.StashlyAccountNav.refreshPins(); }
            else toast('Could not unfollow.', true);
            return null;
        });
    }

    // Following again after the password (or the link) changed
    var refollowDialog = $('refollowDialog');
    var refollowTarget = null;

    function openRefollow(stash) {
        refollowTarget = stash;
        $('refollowIntro').textContent = 'Enter the current password of "' + stash.slug + '" to follow it again. It is checked once and not stored.';
        $('refollowPassword').value = '';
        $('refollowError').textContent = '';
        openDialog(refollowDialog);
        $('refollowPassword').focus();
    }

    $('refollowCancel').addEventListener('click', function () { refollowDialog.close(); });
    refollowDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('refollowForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var password = $('refollowPassword').value;
        if (!password) { $('refollowError').textContent = 'Enter the password.'; return; }
        $('refollowSave').disabled = true;
        api('/api/me/stashes', { method: 'POST', body: { slug: refollowTarget.slug, password: password } }).then(function (res) {
            $('refollowSave').disabled = false;
            if (res.status === 401 && res.body && res.body.signedIn === false) { refollowDialog.close(); return sessionEnded(); }
            if (res.ok) {
                $('refollowPassword').value = '';
                refollowDialog.close();
                toast('Following "' + refollowTarget.slug + '" again');
                loadList();
            } else {
                $('refollowError').textContent = (res.body && res.body.error) || 'Could not follow the stash.';
            }
            return null;
        }).catch(function () {
            $('refollowSave').disabled = false;
            $('refollowError').textContent = 'Could not reach the server.';
        });
    });

    // ---- forgot password, and the link from the email ----

    // The link from a reset email is /account#reset=TOKEN. The token stays in the fragment (never sent to a server), and is
    // taken out of the address bar and the history at once.
    var resetToken = (/^#reset=([\w.-]{1,300})$/.exec(location.hash) || [])[1] || '';
    if (resetToken) history.replaceState(null, '', location.pathname + location.search);

    var forgotDialog = $('forgotDialog');
    $('forgotLink').addEventListener('click', function () {
        $('forgotIdentifier').value = $('loginUsername').value;
        $('forgotError').textContent = '';
        $('forgotDone').textContent = '';
        openDialog(forgotDialog);
        $('forgotIdentifier').focus();
    });
    $('forgotCancel').addEventListener('click', function () { forgotDialog.close(); });
    forgotDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('forgotForm').addEventListener('submit', function (event) {
        event.preventDefault();
        $('forgotError').textContent = '';
        $('forgotDone').textContent = '';
        var identifier = $('forgotIdentifier').value.trim();
        if (!identifier) { $('forgotError').textContent = 'Enter your username or email address.'; return; }
        $('forgotSend').disabled = true;
        api('/api/auth/forgot', { method: 'POST', body: { identifier: identifier } }).then(function (res) {
            $('forgotSend').disabled = false;
            // The same words whether or not an account matched
            if (res.ok) $('forgotDone').textContent = 'If an account matches, a link is on its way. It works for an hour. Check your spam folder too.';
            else $('forgotError').textContent = (res.body && res.body.error) || 'Could not send the link.';
        }).catch(function () {
            $('forgotSend').disabled = false;
            $('forgotError').textContent = 'Could not reach the server.';
        });
    });

    $('resetBack').addEventListener('click', function () { resetToken = ''; show('login'); $('loginUsername').focus(); });
    $('resetForm').addEventListener('submit', function (event) {
        event.preventDefault();
        $('resetError').textContent = '';
        var password = $('resetPassword').value;
        if (!password) { $('resetError').textContent = 'Enter a new password.'; return; }
        $('resetButton').disabled = true;
        api('/api/auth/reset', { method: 'POST', body: { token: resetToken, password: password } }).then(function (res) {
            $('resetButton').disabled = false;
            $('resetPassword').value = '';
            if (res.ok) {
                resetToken = '';
                show('login');
                $('loginPassword').focus();
                toast('Password changed. Sign in with the new one.');
            } else {
                $('resetError').textContent = (res.body && res.body.error) || 'Could not set the password.';
            }
        }).catch(function () {
            $('resetButton').disabled = false;
            $('resetError').textContent = 'Could not reach the server.';
        });
    });

    // ---- keeping the list fresh ----

    // Every 20 seconds while this tab is in front, once more when it comes back, and not at all while it is hidden
    function startRefresh() {
        stopRefresh();
        if (document.hidden) return;
        refreshTimer = setInterval(loadList, REFRESH_MS);
    }

    function stopRefresh() {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }

    document.addEventListener('visibilitychange', function () {
        if (!me) return;
        if (document.hidden) stopRefresh();
        else { loadList(); startRefresh(); }
    });
    window.addEventListener('focus', function () { if (me && !document.hidden) loadList(); });

    // ---- start ----

    // justSignedIn: this call follows the sign-in form, so a next=/admin in the address is followed (an admin only; a
    // plain user stays here, and the admin page tells them it is not for them)
    // The left menu adds (or drops) the Admin section for whoever is signed in now, without a reload
    function refreshAdminNav() {
        if (window.StashlyAdminNav) window.StashlyAdminNav.refresh();
        if (window.StashlyAccountNav) window.StashlyAccountNav.refresh();
    }

    // The Clipboard stash card: save what you copy to a private stash of your own, on this device (see clipboard.js)
    function paintClipboard() {
        var C = window.StashlyClipboard;
        if (!C) return;
        var button = $('clipboardToggle');
        var error = $('clipboardError');
        error.textContent = '';
        $('clipboardCard').classList.remove('hidden');
        if (!C.supported()) {
            button.disabled = true;
            button.textContent = 'Not available in this browser';
            error.textContent = 'This browser does not let Stashly read the clipboard. Chrome, Edge and Safari do, on a secure (https) page.';
            return;
        }
        var on = C.enabled();
        button.disabled = false;
        button.textContent = on ? 'Turn off for this device' : 'Turn on for this device';
        button.className = on ? 'ghost small' : 'primary small';
        // The link to the stash itself shows whenever the account has one, on or off
        api('/api/me/clipboard').then(function (res) {
            var link = $('clipboardOpen');
            var slug = res.ok && res.body && res.body.slug;
            link.classList.toggle('hidden', !slug);
            if (slug) link.href = '/s/' + encodeURIComponent(slug);
        });
    }

    $('clipboardToggle').addEventListener('click', function () {
        var C = window.StashlyClipboard;
        if (!C) return;
        if (C.enabled()) {
            C.disable();
            toast('Saving your clipboard is off on this device');
            paintClipboard();
            return;
        }
        $('clipboardToggle').disabled = true;
        C.enable().then(function (result) {
            paintClipboard();
            if (result.error) { $('clipboardError').textContent = result.error; return; }
            toast('Saving your clipboard to your Clipboard stash');
            loadList();
        });
    });

    function start(justSignedIn) {
        api('/api/me').then(function (res) {
            if (!res.ok) return toast('Could not reach the server.', true);
            if (!res.body.enabled) return show('disabled');
            $('forgotLink').classList.toggle('hidden', !res.body.resetByEmail);
            if (resetToken && !res.body.user) { show('reset'); $('resetPassword').focus(); return null; }
            if (!res.body.user) { me = null; refreshAdminNav(); show('login'); $('loginUsername').focus(); return null; }
            me = res.body.user;
            if (justSignedIn && me.role === 'admin' && nextTarget(location.search)) { location.href = nextTarget(location.search); return null; }
            $('whoInfo').textContent = me.displayName ? me.displayName + ' (' + me.username + ')' : me.username;
            $('roleChip').textContent = me.role === 'admin' ? 'Admin' : 'User';
            refreshAdminNav();
            show('account');
            paintClipboard();
            loadList();
            startRefresh();
            return null;
        }).catch(function () { toast('Could not reach the server.', true); });
    }

    start();
})();
