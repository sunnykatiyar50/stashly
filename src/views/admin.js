// The admin page: see every stash, delete or extend one, manage users, change the limits. There is no sign-in here:
// everyone signs in on the account page, and the account's admin role is what opens this page.
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var states = { loading: $('stateLoading'), disabled: $('stateDisabled'), signin: $('stateSignIn'), notAdmin: $('stateNotAdmin'), stashes: $('viewStashes'), users: $('viewUsers'), settings: $('viewSettings') };
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
        if (value) showAccountState();
        if (window.StashlyAccountNav) window.StashlyAccountNav.refresh();
    }

    // The sidebar link to the user account page says "My stashes" when an account is already signed in, "Sign in" otherwise
    function showAccountState() {
        api('/api/me').then(function (res) {
            if (res.ok && res.body && res.body.user) {
                $('accountLinkLabel').textContent = 'My stashes';
                $('accountLink').title = 'My stashes, signed in as ' + res.body.user.username;
            } else {
                $('accountLinkLabel').textContent = 'Sign in';
                $('accountLink').title = 'Sign in to follow your stashes';
            }
        }).catch(function () { /* keeps the label it had */ });
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

    // ---- sign out ----

    // Signs out of the account, and also clears the old admin-password cookie (scripts may have set one in this browser).
    // Both are asked for whatever the other answers, so nothing is left signed in.
    $('logoutButton').addEventListener('click', function () {
        var quiet = function () { return null; };
        var account = api('/api/auth/logout', { method: 'POST' }).catch(quiet);
        var legacy = api('/api/admin/logout', { method: 'POST' }).catch(quiet);
        Promise.all([account, legacy]).then(function () {
            setSignedIn(false);
            show('signin');
        });
    });

    function expired() {
        setSignedIn(false);
        show('signin');
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
        $('statUsers').textContent = data.userCount;
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
        // Who made it: a signed-in user (an admin cannot reset the password of their stash), or a guest
        var ownerCell = cell(stash.owner || 'Guest', stash.owner ? 'owner-cell' : 'owner-cell muted');
        ownerCell.title = stash.owner
            ? 'Made by ' + stash.owner + '. The owner can change its password; an admin cannot reset it.'
            : 'Made by a guest, so it has no owner.';
        tr.appendChild(ownerCell);
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
        // Anything that changes or removes the stash is in the menu. The password is not offered for a stash with an
        // owner, nor when the server has switched resetting off.
        var items = [];
        if (stash.canResetPassword) {
            items.push({ label: stash.hasPassword ? 'Change password' : 'Set password', onClick: function () { openPasswordDialog(stash); }, ariaLabel: (stash.hasPassword ? 'Change password of ' : 'Set a password on ') + stash.slug });
            items.push(null);
        }
        items.push({ label: 'Delete', danger: true, onClick: function () { deleteStash(stash); }, ariaLabel: 'Delete ' + stash.slug });
        actions.appendChild(menuButton(items, 'More actions for ' + stash.slug));
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
        // The server checks the length against the live "Shortest stash password" setting and says what it needs
        if (!password) { $('passwordError').textContent = 'Enter a password.'; $('passwordInput').focus(); return; }
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

    // ---- users ----

    function userStatus(res) {
        // 401 or 403: the admin session ended, or an admin account lost its role
        if (res.status === 401 || res.status === 403) { expired(); return true; }
        return false;
    }

    function loadUsers() {
        return api('/api/admin/users').then(function (res) {
            if (userStatus(res)) return;
            if (!res.ok) return toast('Could not load the users.', true);
            renderUsers(res.body.users);
        });
    }

    function chip(text, className) {
        var el = document.createElement('span');
        el.className = 'chip' + (className ? ' ' + className : '');
        el.textContent = text;
        return el;
    }

    function renderUsers(users) {
        $('userInfo').textContent = users.length + (users.length === 1 ? ' user' : ' users');
        var body = $('userBody');
        body.textContent = '';
        users.forEach(function (user) { body.appendChild(buildUserRow(user)); });
        $('userEmpty').classList.toggle('hidden', users.length > 0);
    }

    // ---- the "..." menu on a row: the actions that change or remove something live here, one click away but not in the way ----

    var openMenu = null; // { button, menu }

    function closeMenu(returnFocus) {
        if (!openMenu) return;
        openMenu.menu.remove();
        openMenu.button.setAttribute('aria-expanded', 'false');
        if (returnFocus) openMenu.button.focus();
        openMenu = null;
    }

    // items: [{ label, onClick, danger, ariaLabel }]. A null entry draws a divider.
    function menuButton(items, label) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost small menu-button';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', label);
        button.title = label;
        // Three dots, drawn as shapes (no text, no markup built from data)
        var dots = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        dots.setAttribute('viewBox', '0 0 24 24');
        [5, 12, 19].forEach(function (cy) {
            var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', '12');
            dot.setAttribute('cy', String(cy));
            dot.setAttribute('r', '1.8');
            dots.appendChild(dot);
        });
        button.appendChild(dots);

        button.addEventListener('click', function (event) {
            event.stopPropagation();
            if (openMenu && openMenu.button === button) { closeMenu(true); return; }
            closeMenu(false);
            var menu = document.createElement('div');
            menu.className = 'row-menu';
            menu.setAttribute('role', 'menu');
            items.forEach(function (item) {
                if (!item) {
                    var rule = document.createElement('div');
                    rule.className = 'row-menu-rule';
                    rule.setAttribute('role', 'separator');
                    menu.appendChild(rule);
                    return;
                }
                var entry = document.createElement('button');
                entry.type = 'button';
                entry.setAttribute('role', 'menuitem');
                entry.className = 'row-menu-item' + (item.danger ? ' danger' : '');
                entry.textContent = item.label;
                if (item.ariaLabel) entry.setAttribute('aria-label', item.ariaLabel);
                entry.addEventListener('click', function () { closeMenu(false); item.onClick(); });
                menu.appendChild(entry);
            });
            document.body.appendChild(menu);
            // Under the button, or above it near the bottom of the window. Fixed, so a scrolling table never clips it.
            var at = button.getBoundingClientRect();
            var height = menu.offsetHeight;
            var width = menu.offsetWidth;
            var top = at.bottom + 4;
            if (top + height > window.innerHeight - 8) top = Math.max(8, at.top - height - 4);
            menu.style.top = top + 'px';
            menu.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, at.right - width)) + 'px';
            button.setAttribute('aria-expanded', 'true');
            openMenu = { button: button, menu: menu };
            var first = menu.querySelector('.row-menu-item');
            if (first) first.focus();
        });
        return button;
    }

    document.addEventListener('click', function () { closeMenu(false); });
    window.addEventListener('resize', function () { closeMenu(false); });
    window.addEventListener('scroll', function () { closeMenu(false); }, true);
    document.addEventListener('keydown', function (event) {
        if (!openMenu) return;
        var entries = Array.prototype.slice.call(openMenu.menu.querySelectorAll('.row-menu-item'));
        var at = entries.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(at + 1) % entries.length].focus(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(at - 1 + entries.length) % entries.length].focus(); }
        else if (event.key === 'Home') { event.preventDefault(); entries[0].focus(); }
        else if (event.key === 'End') { event.preventDefault(); entries[entries.length - 1].focus(); }
        else if (event.key === 'Tab') closeMenu(false);
    });

    function actionButton(label, className, onClick, ariaLabel) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = className + ' small';
        button.textContent = label;
        if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
        button.addEventListener('click', onClick);
        return button;
    }

    function buildUserRow(user) {
        var tr = document.createElement('tr');
        var name = document.createElement('span');
        name.className = 'name-cell';
        var login = document.createElement('span');
        login.className = 'mono';
        login.textContent = user.username;
        name.appendChild(login);
        if (user.displayName) {
            var shown = document.createElement('span');
            shown.className = 'muted';
            shown.textContent = user.displayName;
            name.appendChild(shown);
        }
        tr.appendChild(cell(name));
        tr.appendChild(cell(chip(user.role === 'admin' ? 'Admin' : 'User', user.role === 'admin' ? 'role-admin' : '')));
        tr.appendChild(cell(chip(user.disabled ? 'Disabled' : 'Active', user.disabled ? 'status-off' : '')));
        tr.appendChild(cell(user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'));
        tr.appendChild(cell(String(user.stashCount), 'num'));

        // The server's admin account is set by ADMIN_USERNAME and ADMIN_PASSWORD: nothing to press here
        if (user.managed) {
            var note = document.createElement('span');
            note.className = 'muted';
            note.textContent = 'Set in the server environment';
            tr.appendChild(cell(note, 'actions'));
            return tr;
        }
        var actions = document.createElement('div');
        actions.className = 'row-actions';
        var who = ' ' + user.username;
        // Each of these changes what the person can do or removes them, so they all live in the menu
        actions.appendChild(menuButton([
            {
                label: user.role === 'admin' ? 'Make user' : 'Make admin',
                ariaLabel: (user.role === 'admin' ? 'Make user' : 'Make admin') + who,
                onClick: function () {
                    changeUser(user, { role: user.role === 'admin' ? 'user' : 'admin' }, user.username + ' is now ' + (user.role === 'admin' ? 'a user' : 'an admin') + '. Their sessions ended.');
                },
            },
            {
                label: user.disabled ? 'Enable' : 'Disable',
                ariaLabel: (user.disabled ? 'Enable' : 'Disable') + who,
                onClick: function () {
                    changeUser(user, { disabled: !user.disabled }, user.username + (user.disabled ? ' can sign in again.' : ' is disabled and signed out.'));
                },
            },
            { label: 'Reset password', ariaLabel: 'Reset password of' + who, onClick: function () { openUserPassword(user); } },
            { label: 'Sign out everywhere', ariaLabel: 'Sign out' + who + ' everywhere', onClick: function () { signOutUser(user); } },
            null,
            { label: 'Delete', danger: true, ariaLabel: 'Delete' + who, onClick: function () { deleteUser(user); } },
        ], 'More actions for' + who));
        tr.appendChild(cell(actions, 'actions'));
        return tr;
    }

    function changeUser(user, changes, message) {
        api('/api/admin/users/' + encodeURIComponent(user.id), { method: 'PATCH', body: changes }).then(function (res) {
            if (userStatus(res)) return;
            if (res.ok) { toast(message); loadUsers(); }
            else toast((res.body && res.body.error) || 'Could not change the user.', true);
        });
    }

    function signOutUser(user) {
        api('/api/admin/users/' + encodeURIComponent(user.id) + '/sign-out', { method: 'POST' }).then(function (res) {
            if (userStatus(res)) return;
            if (res.ok) toast(user.username + ' was signed out everywhere.');
            else toast((res.body && res.body.error) || 'Could not sign the user out.', true);
        });
    }

    function deleteUser(user) {
        var message = 'Delete the user "' + user.username + '"? Their list of followed stashes goes with them. The stashes themselves are not touched. This cannot be undone.';
        if (!window.confirm(message)) return;
        api('/api/admin/users/' + encodeURIComponent(user.id), { method: 'DELETE' }).then(function (res) {
            if (userStatus(res)) return;
            if (res.ok || res.status === 404) { toast('Deleted ' + user.username); loadUsers(); }
            else toast((res.body && res.body.error) || 'Could not delete the user.', true);
        });
    }

    var userPasswordDialog = $('userPasswordDialog');
    var userPasswordTarget = null;

    function openUserPassword(user) {
        userPasswordTarget = user;
        $('userPasswordTitle').textContent = 'Reset the password of ' + user.username;
        $('userPasswordInput').value = '';
        $('userPasswordError').textContent = '';
        if (typeof userPasswordDialog.showModal === 'function') userPasswordDialog.showModal(); else userPasswordDialog.setAttribute('open', '');
        $('userPasswordInput').focus();
    }

    $('userPasswordCancel').addEventListener('click', function () { userPasswordDialog.close(); });
    userPasswordDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('userPasswordForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var password = $('userPasswordInput').value;
        $('userPasswordError').textContent = '';
        if (!password) { $('userPasswordError').textContent = 'Enter a password.'; $('userPasswordInput').focus(); return; }
        $('userPasswordSave').disabled = true;
        api('/api/admin/users/' + encodeURIComponent(userPasswordTarget.id) + '/password', { method: 'POST', body: { password: password } }).then(function (res) {
            $('userPasswordSave').disabled = false;
            if (userStatus(res)) { userPasswordDialog.close(); return; }
            if (res.ok) {
                // The password is not kept anywhere on the page
                $('userPasswordInput').value = '';
                userPasswordDialog.close();
                toast('Password reset for ' + userPasswordTarget.username + '. They were signed out everywhere.');
            } else {
                $('userPasswordError').textContent = (res.body && res.body.error) || 'Could not reset the password.';
            }
        }).catch(function () {
            $('userPasswordSave').disabled = false;
            $('userPasswordError').textContent = 'Could not reach the server.';
        });
    });

    // Create user and Backup stay out of the way until asked for: a button opens or closes each panel
    function setPanel(toggle, panel, open, focusId) {
        panel.classList.toggle('hidden', !open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open && focusId) $(focusId).focus();
    }

    $('backupToggle').addEventListener('click', function () {
        setPanel($('backupToggle'), $('backupCard'), $('backupCard').classList.contains('hidden'), 'backupLink');
    });

    function closeUserForm() {
        // A password is never left in the form, and neither are old messages
        $('newUserPassword').value = '';
        Object.keys(userFormErrors).forEach(function (key) { userFormErrors[key].textContent = ''; });
        $('userFormStatus').textContent = '';
        setPanel($('createUserToggle'), $('userForm'), false);
    }

    $('createUserToggle').addEventListener('click', function () {
        if ($('userForm').classList.contains('hidden')) setPanel($('createUserToggle'), $('userForm'), true, 'newUsername');
        else closeUserForm();
    });
    $('cancelUserButton').addEventListener('click', function () {
        $('newUsername').value = '';
        $('newDisplayName').value = '';
        $('newUserRole').value = 'user';
        closeUserForm();
        $('createUserToggle').focus();
    });

    var userFormErrors = { username: $('newUsernameError'), displayName: $('newDisplayNameError'), password: $('newUserPasswordError') };

    $('userForm').addEventListener('submit', function (event) {
        event.preventDefault();
        Object.keys(userFormErrors).forEach(function (key) { userFormErrors[key].textContent = ''; });
        var status = $('userFormStatus');
        status.textContent = '';
        status.classList.remove('error');
        var username = $('newUsername').value.trim();
        var password = $('newUserPassword').value;
        if (!username) { userFormErrors.username.textContent = 'Enter a username.'; $('newUsername').focus(); return; }
        // The server checks the length against the live "Shortest stash password" setting and says what it needs
        if (!password) { userFormErrors.password.textContent = 'Enter an initial password.'; $('newUserPassword').focus(); return; }
        $('createUserButton').disabled = true;
        var displayName = $('newDisplayName').value.trim();
        api('/api/admin/users', {
            method: 'POST',
            body: { username: username, displayName: displayName || undefined, password: password, role: $('newUserRole').value },
        }).then(function (res) {
            $('createUserButton').disabled = false;
            // Cleared whatever the answer: a password is never left in the form
            $('newUserPassword').value = '';
            if (userStatus(res)) return;
            if (res.ok) {
                $('newUsername').value = '';
                $('newDisplayName').value = '';
                $('newUserRole').value = 'user';
                toast('Added ' + res.body.username + '. Tell them their password.');
                closeUserForm();
                loadUsers();
            } else {
                var message = (res.body && res.body.error) || 'Could not add the user.';
                var field = res.body && res.body.field;
                if (field && userFormErrors[field]) userFormErrors[field].textContent = message;
                else { status.textContent = message; status.classList.add('error'); }
            }
        }).catch(function () {
            $('createUserButton').disabled = false;
            status.textContent = 'Could not reach the server.';
            status.classList.add('error');
        });
    });

    $('refreshUsersButton').addEventListener('click', loadUsers);

    // ---- settings ----

    function loadSettings() {
        return api('/api/admin/settings').then(function (res) {
            if (res.status === 401) return expired();
            if (!res.ok) return toast('Could not load the settings.', true);
            fields = res.body.fields;
            renderSettings();
        });
    }

    // The settings are shown in tabs, one per group the server gives each field. The open tab is remembered.
    var TAB_KEY = 'sl_admin_settings_tab';
    var activeGroup = null;
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
        host.textContent = '';
        var groups = settingGroups();
        var names = groups.map(function (group) { return group.name; });
        if (names.indexOf(activeGroup) === -1) activeGroup = savedGroup();
        if (names.indexOf(activeGroup) === -1) activeGroup = names[0];

        var layout = document.createElement('div');
        layout.className = 'settings-layout';
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
                if (res.status === 401) return expired();
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
            if (res.status === 401) return expired();
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
        } else if (location.hash === '#/users') {
            show('users');
            loadUsers();
        } else {
            show('stashes');
            loadStashes();
        }
    }

    function start() {
        api('/api/admin/status').then(function (res) {
            if (!res.ok) return toast('Could not reach the server.', true);
            if (!res.body.enabled) { setSignedIn(false); return show('disabled'); }
            if (!res.body.signedIn) {
                setSignedIn(false);
                // Signed in to an account that is not an admin, or not signed in at all: say which
                return api('/api/me').then(function (me) {
                    show(me.ok && me.body && me.body.user ? 'notAdmin' : 'signin');
                });
            }
            setSignedIn(true);
            route();
            return null;
        }).catch(function () { toast('Could not reach the server.', true); });
    }

    window.addEventListener('hashchange', route);
    start();
})();
