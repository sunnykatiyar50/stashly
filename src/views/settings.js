// The settings page: your own details (name, username, email) and your password. More sections can be added as cards in
// settings.html, each with its own form and a handler here.
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var states = { loading: $('stateLoading'), disabled: $('stateDisabled'), login: $('stateLogin'), settings: $('viewSettings') };
    var me = null;

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

    function sessionEnded() {
        me = null;
        show('login');
        toast('Your session ended. Sign in again.', true);
    }

    // ---- your details ----

    var profileErrors = { displayName: $('profileNameError'), username: $('profileUsernameError'), email: $('profileEmailError'), currentPassword: $('profilePasswordError') };

    function clearProfileErrors() {
        Object.keys(profileErrors).forEach(function (key) { profileErrors[key].textContent = ''; });
    }

    function fillProfile() {
        $('profileName').value = me.displayName || '';
        $('profileUsername').value = me.username;
        $('profileEmail').value = me.email || '';
        $('profilePassword').value = '';
        syncPasswordField();
        $('whoInfo').textContent = me.displayName ? me.displayName + ' (' + me.username + ')' : me.username;
        $('roleChip').textContent = me.role === 'admin' ? 'Admin' : 'User';
    }

    // The current password is only asked for when the username or the email is being changed
    function sensitiveChange() {
        return $('profileUsername').value.trim().toLowerCase() !== me.username || $('profileEmail').value.trim().toLowerCase() !== (me.email || '');
    }
    function syncPasswordField() {
        $('profilePasswordField').classList.toggle('hidden', !sensitiveChange());
    }
    $('profileUsername').addEventListener('input', syncPasswordField);
    $('profileEmail').addEventListener('input', syncPasswordField);

    $('profileForm').addEventListener('submit', function (event) {
        event.preventDefault();
        clearProfileErrors();
        // Only what changed is sent, so saving never touches a field nobody edited
        var body = {};
        var name = $('profileName').value.trim();
        var username = $('profileUsername').value.trim();
        var email = $('profileEmail').value.trim();
        if (name !== (me.displayName || '')) body.displayName = name;
        if (username.toLowerCase() !== me.username) body.username = username;
        if (email.toLowerCase() !== (me.email || '')) body.email = email;
        if (!Object.keys(body).length) { toast('Nothing to save.'); return; }
        if (body.username !== undefined || body.email !== undefined) {
            if (!$('profilePassword').value) { profileErrors.currentPassword.textContent = 'Enter your current password.'; return; }
            body.currentPassword = $('profilePassword').value;
        }
        $('profileSave').disabled = true;
        api('/api/me', { method: 'PATCH', body: body }).then(function (res) {
            $('profileSave').disabled = false;
            $('profilePassword').value = '';
            if (res.status === 401 && res.body && res.body.signedIn === false) return sessionEnded();
            if (res.ok) {
                me = res.body.user;
                fillProfile();
                // The left menu shows the name, so it follows the change without a reload
                if (window.StashlyAccountNav) window.StashlyAccountNav.refresh();
                toast('Details saved.');
            } else {
                var line = res.body && profileErrors[res.body.field];
                (line || profileErrors.currentPassword).textContent = (res.body && res.body.error) || 'Could not save the details.';
            }
            return null;
        }).catch(function () {
            $('profileSave').disabled = false;
            profileErrors.currentPassword.textContent = 'Could not reach the server.';
        });
    });

    // ---- password ----

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
            if (res.status === 401 && res.body && res.body.signedIn === false) return sessionEnded();
            if (res.ok) {
                // Nothing stays in the form
                $('currentPassword').value = '';
                $('newPassword').value = '';
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

    // ---- start ----

    api('/api/me').then(function (res) {
        if (!res.ok) return toast('Could not reach the server.', true);
        if (!res.body.enabled) return show('disabled');
        if (!res.body.user) return show('login');
        me = res.body.user;
        fillProfile();
        // The environment's admin account cannot change its details here
        var managed = Boolean(me.managed);
        $('managedNote').classList.toggle('hidden', !managed);
        $('profileSection').classList.toggle('hidden', managed);
        $('passwordSection').classList.toggle('hidden', managed);
        show('settings');
        return null;
    }).catch(function () { toast('Could not reach the server.', true); });
})();
