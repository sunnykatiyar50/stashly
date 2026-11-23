// The account page: the one sign-in for everyone (users and the server's admin), where followed stashes are watched in one place
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var states = { loading: $('stateLoading'), disabled: $('stateDisabled'), login: $('stateLogin'), account: $('viewAccount') };
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

    // ---- change password ----

    var passwordDialog = $('passwordDialog');

    $('passwordButton').addEventListener('click', function () {
        $('currentPassword').value = '';
        $('newPassword').value = '';
        $('currentPasswordError').textContent = '';
        $('newPasswordError').textContent = '';
        openDialog(passwordDialog);
        $('currentPassword').focus();
    });
    $('passwordCancel').addEventListener('click', function () { passwordDialog.close(); });
    passwordDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('passwordForm').addEventListener('submit', function (event) {
        event.preventDefault();
        $('currentPasswordError').textContent = '';
        $('newPasswordError').textContent = '';
        var current = $('currentPassword').value;
        var next = $('newPassword').value;
        if (!current) { $('currentPasswordError').textContent = 'Enter your current password.'; return; }
        if (!next) { $('newPasswordError').textContent = 'Enter a new password.'; return; }
        $('passwordSave').disabled = true;
        api('/api/me/password', { method: 'POST', body: { currentPassword: current, newPassword: next } }).then(function (res) {
            $('passwordSave').disabled = false;
            if (res.status === 401 && res.body && res.body.signedIn === false) { passwordDialog.close(); return sessionEnded(); }
            if (res.ok) {
                // Nothing stays in the form
                $('currentPassword').value = '';
                $('newPassword').value = '';
                passwordDialog.close();
                toast('Password changed. Your other browsers were signed out.');
            } else {
                var target = res.body && res.body.field === 'newPassword' ? 'newPasswordError' : 'currentPasswordError';
                $(target).textContent = (res.body && res.body.error) || 'Could not change the password.';
            }
            return null;
        }).catch(function () {
            $('passwordSave').disabled = false;
            $('currentPasswordError').textContent = 'Could not reach the server.';
        });
    });

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

    function renderList(stashes) {
        var list = $('followList');
        list.textContent = '';
        stashes.forEach(function (stash) { list.appendChild(buildCard(stash)); });
        $('followEmpty').classList.toggle('hidden', stashes.length > 0);
    }

    function buildCard(stash) {
        var li = make('li', 'follow-item card' + (stash.needsPassword ? ' stale' : ''));
        var main = make('div', 'follow-main');

        var title = make('div', 'follow-title');
        title.appendChild(make('span', 'mono follow-name', stash.slug));
        if (stash.needsPassword) {
            title.appendChild(make('span', 'chip warn', 'Needs the password again'));
        } else {
            if (stash.hasPassword) {
                var lock = make('span', 'chip lock-chip');
                lock.title = 'Password protected';
                lock.setAttribute('role', 'img');
                lock.setAttribute('aria-label', 'Password protected');
                lock.innerHTML = LOCK_ICON;
                title.appendChild(lock);
            }
            title.appendChild(make('span', 'chip' + (stash.role === 'view' ? ' role-view' : ''), stash.role === 'view' ? 'Read-only' : 'Full access'));
            if (stash.newItems > 0) title.appendChild(make('span', 'chip new-chip', stash.newItems + ' new'));
        }
        main.appendChild(title);

        var sub = make('div', 'follow-sub muted');
        if (stash.needsPassword) {
            sub.textContent = 'Its password or read-only link changed, so this account can no longer open it. Enter the password to follow it again.';
        } else {
            sub.textContent = stash.items + (stash.items === 1 ? ' item' : ' items') + (stash.files ? ' (' + stash.files + (stash.files === 1 ? ' file' : ' files') + ')' : '') +
                ' · ' + (stash.latestAt ? 'last activity ' + relativeTime(stash.latestAt) : 'no activity yet') + ' · ' + expiryText(stash.expiresAt);
        }
        main.appendChild(sub);
        li.appendChild(main);

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
        }
        var unfollow = make('button', 'ghost small', 'Unfollow');
        unfollow.type = 'button';
        unfollow.setAttribute('aria-label', 'Unfollow ' + stash.slug);
        unfollow.addEventListener('click', function () { unfollowStash(stash); });
        actions.appendChild(unfollow);
        li.appendChild(actions);
        return li;
    }

    function unfollowStash(stash) {
        api('/api/me/stashes/' + encodeURIComponent(stash.slug), { method: 'DELETE' }).then(function (res) {
            if (res.status === 401) return sessionEnded();
            if (res.ok) { toast('Stopped following "' + stash.slug + '". The stash itself is untouched.'); loadList(); }
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

    function start(justSignedIn) {
        api('/api/me').then(function (res) {
            if (!res.ok) return toast('Could not reach the server.', true);
            if (!res.body.enabled) return show('disabled');
            if (!res.body.user) { me = null; refreshAdminNav(); show('login'); $('loginUsername').focus(); return null; }
            me = res.body.user;
            if (justSignedIn && me.role === 'admin' && nextTarget(location.search)) { location.href = nextTarget(location.search); return null; }
            $('passwordButton').classList.toggle('hidden', Boolean(me.managed));
            $('whoInfo').textContent = me.displayName ? me.displayName + ' (' + me.username + ')' : me.username;
            $('roleChip').textContent = me.role === 'admin' ? 'Admin' : 'User';
            refreshAdminNav();
            show('account');
            loadList();
            startRefresh();
            return null;
        }).catch(function () { toast('Could not reach the server.', true); });
    }

    start();
})();
