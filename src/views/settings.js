// The settings page, the same one for everyone. My account (your name, username, email and password) is the first tab;
// an admin also gets the server settings as more tabs (Limits, Security, Email, ...), saved with their own buttons.
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
        fields = [];
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

    // ---- server settings (admins only): one tab per group the server gives each field ----

    var fields = [];

    function loadSettings() {
        return api('/api/admin/settings').then(function (res) {
            if (res.status === 401 || res.status === 403) { fields = []; return renderSettings(); }
            if (!res.ok) { toast('Could not load the server settings.', true); return renderSettings(); }
            fields = res.body.fields;
            renderSettings();
        });
    }

    // The settings are shown in tabs, one per group the server gives each field. The open tab is remembered.
    var TAB_KEY = 'sl_admin_settings_tab';
    var activeGroup = null;
    var ACCOUNT_TAB = 'My account';
    var narrow = window.matchMedia('(max-width: 760px)');

    function savedGroup() {
        try { return localStorage.getItem(TAB_KEY); } catch (e) { return null; }
    }

    function rememberGroup(name) {
        try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* not remembered */ }
    }

    function settingGroups() {
        var groups = [];
        var byName = {};
        fields.forEach(function (field) {
            var name = field.group || 'Other';
            if (!byName[name]) {
                byName[name] = { name: name, id: 'settings-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), fields: [] };
                groups.push(byName[name]);
            }
            byName[name].fields.push(field);
        });
        return groups;
    }

    function groupOf(key) {
        var field = fields.filter(function (f) { return f.key === key; })[0];
        return field ? (field.group || 'Other') : null;
    }

    function settingTabs() {
        return Array.prototype.slice.call($('settingsFields').querySelectorAll('[role="tab"]'));
    }

    function selectGroup(name, focus) {
        settingTabs().forEach(function (tab) {
            var selected = tab.dataset.group === name;
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            tab.tabIndex = selected ? 0 : -1;
            $(tab.getAttribute('aria-controls')).hidden = !selected;
            if (selected && focus) tab.focus();
        });
        activeGroup = name;
        rememberGroup(name);
        // Save and Reset belong to the server settings; My account has its own buttons
        $('settingsActions').classList.toggle('hidden', name === ACCOUNT_TAB);
    }

    function setTabOrientation() {
        var list = $('settingsFields').querySelector('[role="tablist"]');
        if (list) list.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
    }
    if (narrow.addEventListener) narrow.addEventListener('change', setTabOrientation);

    // Arrow keys move between tabs (either direction, so it works for side and top tabs), Home and End jump
    function onTabKey(event) {
        var tabs = settingTabs();
        var index = tabs.indexOf(event.target);
        if (index === -1) return;
        var next = null;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        selectGroup(tabs[next].dataset.group, true);
    }

    // Icons for the settings tabs, by group name
    var GROUP_ICONS = {
        'My account': '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        Limits: '<svg viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
        Security: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
        Files: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/></svg>',
        Stashes: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>',
        'Rate limits': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
        Email: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>',
        other: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/></svg>'
    };

    function renderSettings() {
        var host = $('settingsFields');
        // My account waits outside the tabs while they are rebuilt, so what was typed in it is kept
        $('accountStash').appendChild($('accountContent'));
        host.textContent = '';
        var groups = settingGroups();
        groups.unshift({ name: ACCOUNT_TAB, id: 'settings-my-account', fields: [] });
        var names = groups.map(function (group) { return group.name; });
        if (names.indexOf(activeGroup) === -1) activeGroup = savedGroup();
        if (names.indexOf(activeGroup) === -1) activeGroup = names[0];

        var layout = document.createElement('div');
        // With only My account there is nothing to switch between, so no tab list is shown
        layout.className = 'settings-layout' + (groups.length === 1 ? ' single' : '');
        var list = document.createElement('div');
        list.className = 'settings-tabs';
        list.setAttribute('role', 'tablist');
        list.setAttribute('aria-label', 'Settings categories');
        list.addEventListener('keydown', onTabKey);
        layout.appendChild(list);
        host.appendChild(layout);

        groups.forEach(function (group) {
            var tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'settings-tab';
            tab.id = group.id + '-tab';
            tab.dataset.group = group.name;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', group.id + '-panel');
            // An icon for the group (static markup from this file, never from the server)
            var icon = document.createElement('span');
            icon.className = 'settings-tab-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = GROUP_ICONS[group.name] || GROUP_ICONS.other;
            tab.appendChild(icon);
            var name = document.createElement('span');
            name.className = 'settings-tab-name';
            name.textContent = group.name;
            var flag = document.createElement('span');
            flag.className = 'settings-tab-flag';
            flag.title = 'Has a problem to fix';
            var flagText = document.createElement('span');
            flagText.className = 'offscreen';
            flagText.textContent = ', has a problem to fix';
            flag.appendChild(flagText);
            tab.appendChild(name);
            tab.appendChild(flag);
            tab.addEventListener('click', function () { selectGroup(group.name, false); });
            list.appendChild(tab);

            var panel = document.createElement('div');
            panel.className = 'settings-panel';
            panel.id = group.id + '-panel';
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', tab.id);
            panel.tabIndex = 0;
            layout.appendChild(panel);
            if (group.name === ACCOUNT_TAB) panel.appendChild($('accountContent'));
            group.fields.forEach(function (field) { panel.appendChild(settingRow(field)); });
            if (group.name === 'Email') panel.appendChild(emailTestBox());
        });
        setTabOrientation();
        selectGroup(activeGroup, false);
    }

    // "Send a test email": uses the settings as they are saved, and shows what the mail server said when it fails
    function emailTestBox() {
        var box = document.createElement('div');
        box.className = 'email-test';
        var title = document.createElement('h3');
        title.textContent = 'Send a test email';
        var hint = document.createElement('small');
        hint.className = 'field-hint';
        hint.textContent = 'Save your changes first: the test uses what is saved.';
        var row = document.createElement('div');
        row.className = 'input-row';
        var input = document.createElement('input');
        input.type = 'email';
        input.id = 'testEmailTo';
        input.autocomplete = 'email';
        input.placeholder = 'you@example.com';
        input.setAttribute('aria-label', 'Send the test email to');
        var button = document.createElement('button');
        button.type = 'button';
        button.id = 'testEmailButton';
        button.className = 'ghost';
        button.textContent = 'Send test';
        var result = document.createElement('p');
        result.id = 'testEmailResult';
        result.className = 'form-status';
        result.setAttribute('role', 'status');
        row.appendChild(input);
        row.appendChild(button);
        box.appendChild(title);
        box.appendChild(hint);
        box.appendChild(row);
        box.appendChild(result);
        button.addEventListener('click', function () {
            result.classList.remove('error');
            var to = input.value.trim();
            if (!to) { result.textContent = 'Enter the address to send the test to.'; result.classList.add('error'); input.focus(); return; }
            button.disabled = true;
            result.textContent = 'Sending...';
            api('/api/admin/email/test', { method: 'POST', body: { to: to } }).then(function (res) {
                button.disabled = false;
                if (res.status === 401 || res.status === 403) return adminEnded();
                if (res.ok) {
                    result.textContent = 'Sent to ' + to + '. Check that inbox (and the spam folder).';
                } else {
                    var body = res.body || {};
                    result.textContent = (body.error || 'The test email could not be sent.') + (body.detail ? ' The mail server said: ' + body.detail : '');
                    result.classList.add('error');
                }
                return null;
            }).catch(function () {
                button.disabled = false;
                result.textContent = 'Could not reach the server.';
                result.classList.add('error');
            });
        });
        return box;
    }

    function settingRow(field) {
        var row = document.createElement('div');
        row.className = 'settings-row';

        var text = document.createElement('div');
        text.className = 'settings-text';
        var label = document.createElement('label');
        label.htmlFor = 'setting-' + field.key;
        label.textContent = field.label;
        var help = document.createElement('small');
        help.className = 'field-hint';
        help.textContent = field.help;
        text.appendChild(label);
        text.appendChild(help);

        var control = document.createElement('div');
        control.className = 'settings-control';
        var input = document.createElement(field.type === 'choice' ? 'select' : 'input');
        input.id = 'setting-' + field.key;
        input.dataset.key = field.key;
        // The inputs sit in tabs next to My account's own forms, so they join the server form by its id
        input.setAttribute('form', 'settingsForm');
        if (field.type === 'choice') {
            field.options.forEach(function (option) {
                var el = document.createElement('option');
                el.value = option.value;
                el.textContent = option.label;
                if (option.value === field.value) el.selected = true;
                input.appendChild(el);
            });
        } else if (field.type === 'bool') {
            input.type = 'checkbox';
            input.checked = Boolean(field.value);
        } else if (field.type === 'text' || field.type === 'email' || field.type === 'url' || field.type === 'secret') {
            input.type = field.type === 'secret' ? 'password' : field.type === 'text' ? 'text' : field.type;
            input.maxLength = field.maxLength || 255;
            input.autocomplete = field.type === 'secret' ? 'new-password' : 'off';
            input.spellcheck = false;
            input.className = 'wide-input';
            if (field.type === 'secret') {
                // Never filled in: the server does not send it back
                input.placeholder = field.isSet ? 'A password is saved. Type to replace it.' : 'Not set';
            } else {
                input.value = field.value || '';
                if (field.placeholder) input.placeholder = field.placeholder;
            }
        } else {
            input.type = 'number';
            input.min = field.min;
            input.max = field.max;
            input.step = 1;
            input.value = field.value;
        }
        control.appendChild(input);
        if (field.unit) {
            var unit = document.createElement('span');
            unit.className = 'muted';
            unit.textContent = field.unit;
            control.appendChild(unit);
        }
        var note = document.createElement('small');
        note.className = 'field-hint';
        var defaultText = field.default;
        if (field.type === 'bool') defaultText = field.default ? 'on' : 'off';
        if (field.type === 'choice') {
            defaultText = field.options.filter(function (option) { return option.value === field.default; })[0].label;
        }
        note.textContent = 'Default: ' + defaultText;
        if (field.type === 'secret') {
            // A secret has no default to show; say whether one is saved, and let it be removed
            note.textContent = field.isSet ? 'A password is saved.' : 'No password is saved.';
            control.appendChild(note);
            if (field.isSet) {
                var clear = document.createElement('label');
                clear.className = 'inline-check';
                var box = document.createElement('input');
                box.type = 'checkbox';
                box.id = 'clear-' + field.key;
                box.setAttribute('form', 'settingsForm');
                clear.appendChild(box);
                clear.appendChild(document.createTextNode(' Remove the saved password when I save'));
                control.appendChild(clear);
            }
        } else {
            if (field.type === 'text' || field.type === 'email' || field.type === 'url') note.textContent = field.default ? 'Default: ' + field.default : 'Default: empty';
            control.appendChild(note);
        }

        var error = document.createElement('small');
        error.className = 'field-error';
        error.id = 'error-' + field.key;
        error.setAttribute('role', 'alert');
        control.appendChild(error);

        row.appendChild(text);
        row.appendChild(control);
        return row;
    }

    function collectSettings() {
        var values = {};
        fields.forEach(function (field) {
            var input = $('setting-' + field.key);
            if (field.type === 'choice') values[field.key] = input.value;
            else if (field.type === 'text' || field.type === 'email' || field.type === 'url') values[field.key] = input.value;
            else if (field.type === 'secret') {
                var removing = $('clear-' + field.key);
                if (input.value) values[field.key] = input.value;
                else if (removing && removing.checked) values[field.key] = null;
                // empty and not removing: leave the saved one alone (the key is not sent)
            } else values[field.key] = field.type === 'bool' ? input.checked : (input.value === '' ? NaN : Number(input.value));
        });
        return values;
    }

    // Puts each error next to its field and flags the tabs that have one. When the open tab has none,
    // the first tab with a problem is opened, so an error is never left out of sight.
    function showSettingErrors(errors) {
        var status = $('settingsStatus');
        var flagged = {};
        fields.forEach(function (field) {
            var message = errors[field.key] || '';
            $('error-' + field.key).textContent = message;
            var input = $('setting-' + field.key);
            if (message) input.setAttribute('aria-invalid', 'true');
            else input.removeAttribute('aria-invalid');
            if (message) flagged[field.group || 'Other'] = true;
        });
        Object.keys(errors).forEach(function (key) {
            if (!groupOf(key)) { status.textContent = errors[key]; status.classList.add('error'); }
        });
        var tabs = settingTabs();
        tabs.forEach(function (tab) { tab.classList.toggle('has-error', Boolean(flagged[tab.dataset.group])); });
        if (!flagged[activeGroup]) {
            var first = tabs.filter(function (tab) { return flagged[tab.dataset.group]; })[0];
            if (first) selectGroup(first.dataset.group, false);
        }
        var firstInvalid = $('settingsFields').querySelector('.settings-panel:not([hidden]) [aria-invalid="true"]');
        if (firstInvalid) firstInvalid.focus();
    }

    $('settingsForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var status = $('settingsStatus');
        status.textContent = '';
        status.classList.remove('error');
        showSettingErrors({});
        var values = collectSettings();
        for (var key in values) {
            if (typeof values[key] === 'number' && !isFinite(values[key])) {
                var invalid = {};
                invalid[key] = 'Enter a whole number.';
                showSettingErrors(invalid);
                return;
            }
        }
        $('saveSettingsButton').disabled = true;
        api('/api/admin/settings', { method: 'PUT', body: { values: values } }).then(function (res) {
            $('saveSettingsButton').disabled = false;
            if (res.status === 401 || res.status === 403) return adminEnded();
            if (res.ok) {
                fields = res.body.fields;
                renderSettings();
                toast('Settings saved');
            } else if (res.body && res.body.errors) {
                showSettingErrors(res.body.errors);
            } else {
                status.textContent = (res.body && res.body.error) || 'Could not save.';
                status.classList.add('error');
            }
        }).catch(function () {
            $('saveSettingsButton').disabled = false;
            toast('Could not reach the server.', true);
        });
    });

    $('resetSettingsButton').addEventListener('click', function () {
        if (!window.confirm('Put every server setting back to the server\'s default values?')) return;
        api('/api/admin/settings/reset', { method: 'POST' }).then(function (res) {
            if (res.status === 401 || res.status === 403) return adminEnded();
            if (res.ok) {
                fields = res.body.fields;
                renderSettings();
                toast('Settings reset to defaults');
            } else {
                toast('Could not reset.', true);
            }
        });
    });

    // An admin session that ended while the page was open: the server tabs go, My account stays
    function adminEnded() {
        fields = [];
        renderSettings();
        toast('Your admin session ended. Sign in again to change the server settings.', true);
    }

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
        // Everyone has My account; an admin also gets the server's settings as tabs
        if (me.role === 'admin') return loadSettings();
        renderSettings();
        return null;
    }).catch(function () { toast('Could not reach the server.', true); });
})();
