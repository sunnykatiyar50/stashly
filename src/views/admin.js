// The admin page: see every stash, delete or extend one, manage users, There is no sign-in here:
// everyone signs in on the account page, and the account's admin role is what opens this page.
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var states = { loading: $('stateLoading'), disabled: $('stateDisabled'), signin: $('stateSignIn'), notAdmin: $('stateNotAdmin'), stashes: $('viewStashes'), users: $('viewUsers') };
    var signedIn = false;

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
        if (user.email) {
            var mail = document.createElement('span');
            mail.className = 'muted';
            mail.textContent = user.email;
            name.appendChild(mail);
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
            { label: 'Edit details', ariaLabel: 'Edit the name, username and email of' + who, onClick: function () { openUserEdit(user); } },
            ].concat(user.email ? [{ label: 'Email a reset link', ariaLabel: 'Email a reset link to' + who, onClick: function () { emailResetLink(user); } }] : [], [
            { label: 'Sign out everywhere', ariaLabel: 'Sign out' + who + ' everywhere', onClick: function () { signOutUser(user); } },
            null,
            { label: 'Delete', danger: true, ariaLabel: 'Delete' + who, onClick: function () { deleteUser(user); } },
        ]), 'More actions for' + who));
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

    // ---- a user's details (name, username, email), and emailing them a reset link ----

    var userEditDialog = $('userEditDialog');
    var userEditTarget = null;
    // Which server field goes with which message line in the dialog
    var userEditErrors = { displayName: $('userEditDisplayNameError'), username: $('userEditUsernameError'), email: $('userEditEmailError') };

    function clearUserEditErrors() {
        Object.keys(userEditErrors).forEach(function (key) { userEditErrors[key].textContent = ''; });
        $('userEditError').textContent = '';
    }

    function openUserEdit(user) {
        userEditTarget = user;
        $('userEditTitle').textContent = 'Edit details of ' + user.username;
        $('userEditDisplayName').value = user.displayName || '';
        $('userEditUsername').value = user.username;
        $('userEditEmail').value = user.email || '';
        clearUserEditErrors();
        if (typeof userEditDialog.showModal === 'function') userEditDialog.showModal(); else userEditDialog.setAttribute('open', '');
        $('userEditDisplayName').focus();
    }

    $('userEditCancel').addEventListener('click', function () { userEditDialog.close(); });
    userEditDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('userEditForm').addEventListener('submit', function (event) {
        event.preventDefault();
        clearUserEditErrors();
        // Only what changed is sent, so saving never touches a field nobody edited
        var body = {};
        var name = $('userEditDisplayName').value.trim();
        var username = $('userEditUsername').value.trim();
        var email = $('userEditEmail').value.trim();
        if (name !== (userEditTarget.displayName || '')) body.displayName = name;
        if (username.toLowerCase() !== userEditTarget.username) body.username = username;
        if (email.toLowerCase() !== (userEditTarget.email || '')) body.email = email;
        if (!Object.keys(body).length) { userEditDialog.close(); return; }
        $('userEditSave').disabled = true;
        api('/api/admin/users/' + encodeURIComponent(userEditTarget.id), { method: 'PATCH', body: body }).then(function (res) {
            $('userEditSave').disabled = false;
            if (userStatus(res)) { userEditDialog.close(); return; }
            if (res.ok) {
                userEditDialog.close();
                toast('Details saved for ' + (res.body && res.body.username ? res.body.username : userEditTarget.username) + '.');
                loadUsers();
                return;
            }
            var message = (res.body && res.body.error) || 'Could not save the details.';
            var line = res.body && userEditErrors[res.body.field];
            if (line) line.textContent = message; else $('userEditError').textContent = message;
        }).catch(function () {
            $('userEditSave').disabled = false;
            $('userEditError').textContent = 'Could not reach the server.';
        });
    });

    function emailResetLink(user) {
        api('/api/admin/users/' + encodeURIComponent(user.id) + '/email-reset', { method: 'POST' }).then(function (res) {
            if (userStatus(res)) return;
            if (res.ok) toast('Reset link sent to ' + user.email + '. It works once, for an hour.');
            else toast(((res.body && res.body.error) || 'Could not send the email.') + (res.body && res.body.detail ? ' The mail server said: ' + res.body.detail : ''), true);
        }).catch(function () { toast('Could not reach the server.', true); });
    }

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

    var userFormErrors = { username: $('newUsernameError'), displayName: $('newDisplayNameError'), email: $('newUserEmailError'), password: $('newUserPasswordError') };

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
            body: { username: username, displayName: displayName || undefined, email: $('newUserEmail').value.trim() || undefined, password: password, role: $('newUserRole').value },
        }).then(function (res) {
            $('createUserButton').disabled = false;
            // Cleared whatever the answer: a password is never left in the form
            $('newUserPassword').value = '';
            if (userStatus(res)) return;
            if (res.ok) {
                $('newUsername').value = '';
                $('newDisplayName').value = '';
                $('newUserEmail').value = '';
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

    // ---- routing ----

    function route() {
        if (!signedIn) return;
        // Settings has one page for everyone now: an admin's server settings are tabs there, next to their own account
        if (location.hash === '#/settings') {
            location.replace('/settings');
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
