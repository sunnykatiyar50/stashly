// Who is signed in, and Sign out, at the very bottom of the left menu (below Theme) of every page that has one. Nothing is drawn for a visitor
// without an account, or when the server has accounts off. The pages that sign people in or out call
// StashlyAccountNav.refresh() so the block appears or goes away without a reload.
(function () {
    'use strict';

    var footer = document.querySelector('.sidebar-footer');
    if (!footer || typeof fetch !== 'function') return;

    var KEY = 'sl_account_nav';
    var block = null;

    var ICON = '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

    // What to show for a user: the display name (or the username), and under it the username and role
    function describe(user) {
        var name = user.displayName || user.username;
        var role = user.role === 'admin' ? 'Admin' : 'User';
        return { name: name, sub: (user.displayName ? user.username + ' · ' : '') + role };
    }

    // The last person seen is drawn at once, so the block does not pop in after the page; the server's answer confirms
    // it or takes it away
    function remembered() {
        try {
            var value = JSON.parse(localStorage.getItem(KEY) || 'null');
            return value && typeof value.name === 'string' ? value : null;
        } catch (e) {
            return null;
        }
    }
    function remember(info) {
        try {
            if (info) localStorage.setItem(KEY, JSON.stringify(info));
            else localStorage.removeItem(KEY);
        } catch (e) { /* not remembered */ }
    }

    function build() {
        var group = document.createElement('div');
        group.className = 'nav-account';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Account');

        var who = document.createElement('div');
        who.className = 'nav-user';
        var avatar = document.createElement('span');
        avatar.className = 'nav-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        var text = document.createElement('span');
        text.className = 'nav-user-text label';
        var name = document.createElement('span');
        name.className = 'nav-user-name';
        var sub = document.createElement('span');
        sub.className = 'nav-user-sub';
        text.appendChild(name);
        text.appendChild(sub);
        who.appendChild(avatar);
        who.appendChild(text);

        var out = document.createElement('button');
        out.type = 'button';
        out.id = 'signOutButton';
        out.className = 'nav-link';
        out.title = 'Sign out';
        var holder = document.createElement('span');
        holder.innerHTML = ICON; // constant markup from this file only
        out.appendChild(holder.firstChild);
        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = 'Sign out';
        out.appendChild(label);
        out.addEventListener('click', signOut);

        group.appendChild(who);
        group.appendChild(out);
        group._parts = { who: who, avatar: avatar, name: name, sub: sub };
        return group;
    }

    function paint(info) {
        if (!block) {
            block = build();
            // Last in the footer, so Theme sits above the account
            footer.appendChild(block);
            document.body.classList.add('has-account-nav');
        }
        var parts = block._parts;
        parts.name.textContent = info.name;
        parts.sub.textContent = info.sub;
        parts.avatar.textContent = Array.from(info.name)[0] || '?';
        parts.who.title = 'Signed in as ' + info.name + (info.sub ? ' (' + info.sub + ')' : '');
    }

    function clear() {
        if (block) block.remove();
        block = null;
        document.body.classList.remove('has-account-nav');
    }

    function refresh() {
        return fetch('/api/me', { credentials: 'same-origin' })
            .then(function (res) { return res.json().catch(function () { return null; }); })
            .then(function (body) {
                if (body && body.enabled && body.user) {
                    var info = describe(body.user);
                    remember(info);
                    paint(info);
                } else {
                    remember(null);
                    clear();
                }
            })
            .catch(function () { /* keeps what it shows */ });
    }

    // Ends the account session, and also clears the old admin-password cookie (scripts may have set one in this browser),
    // so nothing is left signed in. The page then reloads, so everything on it that depended on who you were (My stashes,
    // the Admin section, Follow) is drawn for a guest.
    function signOut(event) {
        var button = event.currentTarget;
        button.disabled = true;
        function post(path) {
            return fetch(path, { method: 'POST', credentials: 'same-origin' }).catch(function () { return null; });
        }
        Promise.all([post('/api/auth/logout'), post('/api/admin/logout')]).then(function () {
            remember(null);
            try {
                localStorage.setItem('sl_signed_in', '0');
                localStorage.setItem('sl_admin_nav', '0');
            } catch (e) { /* not remembered */ }
            location.reload();
        });
    }

    window.StashlyAccountNav = { refresh: refresh };
    var known = remembered();
    if (known) paint(known);
    refresh();
})();
