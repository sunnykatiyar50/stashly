// The admin page: sign in, see every stash, delete or extend one, change the limits
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var states = { loading: $('stateLoading'), disabled: $('stateDisabled'), login: $('stateLogin'), stashes: $('viewStashes'), settings: $('viewSettings') };
    var signedIn = false;
    var fields = [];

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
        Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (link) {
            link.classList.toggle('active', link.dataset.view === name);
        });
    }

    function setSignedIn(value) {
        signedIn = value;
        Array.prototype.forEach.call(document.querySelectorAll('.admin-only'), function (el) {
            el.classList.toggle('hidden', !value);
        });
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function formatDate(iso) {
        return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function expiryText(iso) {
        if (!iso) return 'Never';
        var ms = new Date(iso).getTime() - Date.now();
        if (ms <= 0) return 'Expired';
        var minutes = Math.floor(ms / 60000);
        if (minutes < 60) return 'in ' + Math.max(1, minutes) + ' min';
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return 'in ' + hours + ' h';
        return 'in ' + Math.floor(hours / 24) + ' d';
    }

    function cell(content, className) {
        var td = document.createElement('td');
        if (className) td.className = className;
        if (content instanceof Node) td.appendChild(content);
        else td.textContent = content;
        return td;
    }

    // ---- sign in ----

    $('loginForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('loginError');
        error.textContent = '';
        var password = $('loginInput').value;
        if (!password) { error.textContent = 'Enter the admin password.'; return; }
        $('loginButton').disabled = true;
        api('/api/admin/login', { method: 'POST', body: { password: password } }).then(function (res) {
            $('loginButton').disabled = false;
            if (res.ok) {
                $('loginInput').value = '';
                start();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not sign in.';
                $('loginInput').select();
            }
        }).catch(function () {
            $('loginButton').disabled = false;
            error.textContent = 'Could not reach the server.';
        });
    });

    $('logoutButton').addEventListener('click', function () {
        api('/api/admin/logout', { method: 'POST' }).then(function () {
            setSignedIn(false);
            show('login');
            $('loginInput').focus();
        });
    });

    function expired() {
        setSignedIn(false);
        show('login');
        toast('Your admin session ended. Sign in again.', true);
    }

    // ---- stashes ----

    function loadStashes() {
        var query = new URLSearchParams();
        var search = $('searchInput').value.trim();
        if (search) query.set('search', search);
        return api('/api/admin/overview?' + query.toString()).then(function (res) {
            if (res.status === 401) return expired();
            if (!res.ok) return toast('Could not load the stashes.', true);
            renderOverview(res.body, Boolean(search));
        });
    }

    function renderOverview(data, searched) {
        var t = data.totals;
        $('statStashes').textContent = t.stashes;
        $('statStashesSub').textContent = 'of ' + data.maxStashes + ' allowed';
        $('statItems').textContent = t.items;
        $('statItemsSub').textContent = t.files + (t.files === 1 ? ' file' : ' files');
        $('statBytes').textContent = formatSize(t.bytes);
        $('statBytesSub').textContent = 'of ' + formatSize(data.maxTotalBytes) + ' allowed';
        var pct = data.maxTotalBytes ? Math.min(100, (t.bytes / data.maxTotalBytes) * 100) : 0;
        $('statMeter').style.width = pct + '%';
        $('statMeter').className = pct > 90 ? 'full' : '';

        $('stashInfo').textContent = data.stashes.length + (searched ? ' shown' : ' stashes');
        var body = $('stashBody');
        body.textContent = '';
        data.stashes.forEach(function (stash) { body.appendChild(buildRow(stash)); });
        var empty = $('stashEmpty');
        empty.classList.toggle('hidden', data.stashes.length > 0);
        empty.textContent = searched ? 'No stash matches that name.' : 'No stashes yet.';
    }

    function buildRow(stash) {
        var tr = document.createElement('tr');
        var link = document.createElement('a');
        link.href = '/s/' + encodeURIComponent(stash.slug);
        link.textContent = stash.slug;
        link.className = 'mono';
        var name = document.createElement('span');
        name.className = 'name-cell';
        name.appendChild(link);
        if (stash.hasPassword) {
            // A padlock instead of the word "Password"; the hint says what it means
            var lock = document.createElement('span');
            lock.className = 'chip lock-chip';
            lock.title = 'Password protected';
            lock.setAttribute('role', 'img');
            lock.setAttribute('aria-label', 'Password protected');
            lock.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
            name.appendChild(lock);
        }
        tr.appendChild(cell(name));
        tr.appendChild(cell(String(stash.items), 'num'));
        tr.appendChild(cell(String(stash.files), 'num'));
        tr.appendChild(cell(formatSize(stash.bytes), 'num'));
        tr.appendChild(cell(formatDate(stash.createdAt)));
        var expires = cell(expiryText(stash.expiresAt));
        if (stash.expiresAt) expires.title = new Date(stash.expiresAt).toLocaleString();
        tr.appendChild(expires);

        var actions = document.createElement('div');
        actions.className = 'row-actions';
        if (stash.canExtend) {
            var extend = document.createElement('button');
            extend.type = 'button';
            extend.className = 'ghost small';
            extend.textContent = 'Extend';
            extend.addEventListener('click', function () { extendStash(stash); });
            actions.appendChild(extend);
        }
        var pw = document.createElement('button');
        pw.type = 'button';
        pw.className = 'ghost small';
        pw.textContent = stash.hasPassword ? 'Change password' : 'Set password';
        pw.addEventListener('click', function () { openPasswordDialog(stash); });
        actions.appendChild(pw);
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger-ghost small';
        del.textContent = 'Delete';
        del.addEventListener('click', function () { deleteStash(stash); });
        actions.appendChild(del);
        tr.appendChild(cell(actions, 'actions'));
        return tr;
    }

    function extendStash(stash) {
        api('/api/admin/stashes/' + encodeURIComponent(stash.slug) + '/extend', { method: 'POST' }).then(function (res) {
            if (res.status === 401) return expired();
            if (res.ok) { toast('Extended "' + stash.slug + '"'); loadStashes(); }
            else toast((res.body && res.body.error) || 'Could not extend.', true);
        });
    }

    // ---- set or change a stash's password ----

    var passwordDialog = $('passwordDialog');
    var passwordTarget = null;

    function openPasswordDialog(stash) {
        passwordTarget = stash;
        $('passwordTitle').textContent = (stash.hasPassword ? 'Change the password of ' : 'Set a password on ') + stash.slug;
        $('passwordIntro').textContent = stash.hasPassword
            ? 'Use this when the owner has forgotten the password.'
            : 'This stash has no password yet, so anyone with its name can open it. Setting one locks it.';
        $('passwordInput').value = '';
        $('passwordError').textContent = '';
        if (typeof passwordDialog.showModal === 'function') passwordDialog.showModal(); else passwordDialog.setAttribute('open', '');
        $('passwordInput').focus();
    }

    $('passwordCancel').addEventListener('click', function () { passwordDialog.close(); });
    passwordDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('passwordForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var password = $('passwordInput').value;
        $('passwordError').textContent = '';
        if (password.length < 4) { $('passwordError').textContent = 'The password must be at least 4 characters.'; $('passwordInput').focus(); return; }
        $('passwordSave').disabled = true;
        api('/api/admin/stashes/' + encodeURIComponent(passwordTarget.slug) + '/password', { method: 'PUT', body: { password: password } }).then(function (res) {
            $('passwordSave').disabled = false;
            if (res.status === 401) { passwordDialog.close(); return expired(); }
            if (res.ok) {
                passwordDialog.close();
                $('passwordInput').value = '';
                toast('Password set for "' + passwordTarget.slug + '". Everyone was signed out.');
                loadStashes();
            } else {
                $('passwordError').textContent = (res.body && res.body.error) || 'Could not set the password.';
            }
        }).catch(function () {
            $('passwordSave').disabled = false;
            $('passwordError').textContent = 'Could not reach the server.';
        });
    });

    function deleteStash(stash) {
        var message = 'Delete "' + stash.slug + '" with its ' + stash.items + (stash.items === 1 ? ' item' : ' items') + '? This cannot be undone.';
        if (!window.confirm(message)) return;
        api('/api/admin/stashes/' + encodeURIComponent(stash.slug), { method: 'DELETE' }).then(function (res) {
            if (res.status === 401) return expired();
            if (res.ok || res.status === 404) { toast('Deleted "' + stash.slug + '"'); loadStashes(); }
            else toast((res.body && res.body.error) || 'Could not delete.', true);
        });
    }

    $('searchButton').addEventListener('click', loadStashes);
    $('searchInput').addEventListener('keydown', function (event) { if (event.key === 'Enter') loadStashes(); });
    $('resetButton').addEventListener('click', function () { $('searchInput').value = ''; loadStashes(); });
    $('refreshButton').addEventListener('click', loadStashes);

    // ---- settings ----

    function loadSettings() {
        return api('/api/admin/settings').then(function (res) {
            if (res.status === 401) return expired();
            if (!res.ok) return toast('Could not load the settings.', true);
            fields = res.body.fields;
            renderSettings();
        });
    }

    function renderSettings() {
        var host = $('settingsFields');
        host.textContent = '';
        fields.forEach(function (field) {
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
            control.appendChild(note);

            var error = document.createElement('small');
            error.className = 'field-error';
            error.id = 'error-' + field.key;
            error.setAttribute('role', 'alert');
            control.appendChild(error);

            row.appendChild(text);
            row.appendChild(control);
            host.appendChild(row);
        });
    }

    function collectSettings() {
        var values = {};
        fields.forEach(function (field) {
            var input = $('setting-' + field.key);
            if (field.type === 'choice') values[field.key] = input.value;
            else values[field.key] = field.type === 'bool' ? input.checked : (input.value === '' ? NaN : Number(input.value));
        });
        return values;
    }

    $('settingsForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var status = $('settingsStatus');
        status.textContent = '';
        status.classList.remove('error');
        fields.forEach(function (field) { $('error-' + field.key).textContent = ''; });
        var values = collectSettings();
        for (var key in values) {
            if (typeof values[key] === 'number' && !isFinite(values[key])) {
                $('error-' + key).textContent = 'Enter a whole number.';
                return;
            }
        }
        $('saveSettingsButton').disabled = true;
        api('/api/admin/settings', { method: 'PUT', body: { values: values } }).then(function (res) {
            $('saveSettingsButton').disabled = false;
            if (res.status === 401) return expired();
            if (res.ok) {
                fields = res.body.fields;
                renderSettings();
                toast('Settings saved');
            } else if (res.body && res.body.errors) {
                Object.keys(res.body.errors).forEach(function (key) {
                    var el = $('error-' + key);
                    if (el) el.textContent = res.body.errors[key];
                    else { status.textContent = res.body.errors[key]; status.classList.add('error'); }
                });
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
        if (!window.confirm('Put every limit back to the server\'s default values?')) return;
        api('/api/admin/settings/reset', { method: 'POST' }).then(function (res) {
            if (res.status === 401) return expired();
            if (res.ok) {
                fields = res.body.fields;
                renderSettings();
                toast('Settings reset to defaults');
            } else {
                toast('Could not reset.', true);
            }
        });
    });

    // ---- routing ----

    function route() {
        if (!signedIn) return;
        if (location.hash === '#/settings') {
            show('settings');
            loadSettings();
        } else {
            show('stashes');
            loadStashes();
        }
    }

    function start() {
        api('/api/admin/status').then(function (res) {
            if (!res.ok) return toast('Could not reach the server.', true);
            if (!res.body.enabled) { setSignedIn(false); return show('disabled'); }
            if (!res.body.signedIn) { setSignedIn(false); show('login'); $('loginInput').focus(); return; }
            setSignedIn(true);
            route();
        }).catch(function () { toast('Could not reach the server.', true); });
    }

    window.addEventListener('hashchange', route);
    start();
})();
