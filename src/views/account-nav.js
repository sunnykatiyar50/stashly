// Who is signed in, and Sign out, at the very bottom of the left menu (below Theme) of every page that has one. Nothing is drawn for a visitor
// without an account, or when the server has accounts off. The pages that sign people in or out call
// StashlyAccountNav.refresh() so the block appears or goes away without a reload.
(function () {
    'use strict';

    var footer = document.querySelector('.sidebar-footer');
    if (!footer || typeof fetch !== 'function') return;

    var KEY = 'sl_account_nav';
    var block = null;

    // The Settings gear, drawn with DOM calls (no markup parsing)
    function gearIcon() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        var circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '3');
        svg.appendChild(circle);
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z');
        svg.appendChild(path);
        return svg;
    }

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

        // Your own details and settings, on every page
        var settings = document.createElement('a');
        settings.className = 'nav-link' + (location.pathname === '/settings' ? ' active' : '');
        settings.href = '/settings';
        settings.title = 'Settings';
        if (location.pathname === '/settings') settings.setAttribute('aria-current', 'page');
        settings.appendChild(gearIcon());
        var settingsLabel = document.createElement('span');
        settingsLabel.className = 'label';
        settingsLabel.textContent = 'Settings';
        settings.appendChild(settingsLabel);

        group.appendChild(who);
        group.appendChild(settings);
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

    // ---- pinned stashes: quick links under the main menu, on every page ----
    // Drawn with DOM calls (no markup parsing)
    function pinIcon() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        ['M12 17v5', 'M9 3h6l-1 7 4 3v2H6v-2l4-3z'].forEach(function (d) {
            var path = document.createElementNS(ns, 'path');
            path.setAttribute('d', d);
            svg.appendChild(path);
        });
        return svg;
    }
    var pinBox = null;
    var PINS_KEY = 'sl_pinned_slugs';
    var here = location.pathname.split('/')[1] === 's' ? decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase() : '';

    // The stash page lists the open stash in the menu too. When it is one of the pinned ones, the Pinned list already
    // shows it (as the current one), so this second entry is hidden instead of showing the same stash twice.
    function setOpenStashVisible(visible) {
        var open = document.getElementById('thisStashLink');
        if (open) open.classList.toggle('hidden', !visible);
    }
    // The pinned names seen last time, so the open stash's entry is right on first paint (the server's answer confirms)
    function rememberedPins() {
        try {
            var list = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }
    function rememberPins(slugs) {
        try { localStorage.setItem(PINS_KEY, JSON.stringify(slugs)); } catch (e) { /* not remembered */ }
    }
    if (here && rememberedPins().indexOf(here) !== -1) setOpenStashVisible(false);

    function drawPins(stashes) {
        var nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        var pinned = stashes.filter(function (s) { return s.pinned && !s.needsPassword; });
        rememberPins(pinned.map(function (s) { return s.slug; }));
        // On a phone the menu is closed, so a dot on its button says a pinned stash has something new
        document.body.classList.toggle('pins-new', pinned.some(function (s) { return s.newItems > 0; }));
        setOpenStashVisible(!(here && pinned.some(function (s) { return s.slug === here; })));
        if (!pinned.length) { if (pinBox) { pinBox.remove(); pinBox = null; } return; }
        if (!pinBox) {
            pinBox = document.createElement('div');
            pinBox.className = 'nav-pins';
            pinBox.setAttribute('role', 'group');
            pinBox.setAttribute('aria-label', 'Pinned stashes');
            // Menu order: Home, My stashes, Pinned, the open stash (stash page only), then Admin (admin-nav.js appends its
            // section last, so this is right whichever script finishes first)
            nav.insertBefore(pinBox, nav.querySelector('#thisStashLink, .nav-section, .nav-section-label'));
        }
        pinBox.textContent = '';
        var heading = document.createElement('div');
        heading.className = 'nav-pins-title label';
        heading.textContent = 'Pinned';
        pinBox.appendChild(heading);
        pinned.forEach(function (stash) {
            var link = document.createElement('a');
            link.className = 'nav-link nav-pin' + (stash.slug === here ? ' active' : '');
            link.href = '/s/' + encodeURIComponent(stash.slug);
            link.title = stash.slug + (stash.newItems ? ' (' + stash.newItems + ' new)' : '');
            link.appendChild(pinIcon());
            var label = document.createElement('span');
            label.className = 'label';
            label.textContent = stash.slug;
            link.appendChild(label);
            if (stash.newItems > 0) {
                var badge = document.createElement('span');
                badge.className = 'nav-badge label';
                badge.textContent = String(stash.newItems);
                link.appendChild(badge);
            }
            pinBox.appendChild(link);
        });
    }

    function refreshPins() {
        return fetch('/api/me/stashes', { credentials: 'same-origin' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (body) { if (body && body.stashes) drawPins(body.stashes); else drawPins([]); })
            .catch(function () { /* keeps what it shows */ });
    }

    function clear() {
        if (pinBox) { pinBox.remove(); pinBox = null; }
        rememberPins([]);
        setOpenStashVisible(true);
        document.body.classList.remove('pins-new');
        if (block) block.remove();
        block = null;
        document.body.classList.remove('has-account-nav');
    }

    // Who is signed in: { ok, status, body }. The first answer is shared with the stash page's own script
    // (StashlyAccountNav.firstMe), so the page does not ask the server the same thing twice while it starts.
    function getMe() {
        return fetch('/api/me', { credentials: 'same-origin' }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        });
    }
    var firstMe = null;

    function refresh() {
        var request = firstMe;
        firstMe = null; // only the very first call reuses the page-start request; later ones (after sign in or out) ask again
        return (request || getMe())
            .then(function (res) { return res.body; })
            .then(function (body) {
                if (body && body.enabled && body.user) {
                    var info = describe(body.user);
                    remember(info);
                    paint(info);
                    refreshPins();
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

    // Started now, and used by the first refresh() below
    firstMe = getMe();
    var shared = firstMe;
    window.StashlyAccountNav = { refresh: refresh, refreshPins: refreshPins, firstMe: function () { return shared; } };
    var known = remembered();
    if (known) {
        paint(known);
        // The pinned stashes seen last time are drawn at once too, so the menu does not grow after the page appears;
        // the server's answer (with the new-item counts) replaces them a moment later
        var pins = rememberedPins();
        if (pins.length) drawPins(pins.map(function (slug) { return { slug: slug, pinned: true }; }));
    }
    refresh();
})();
