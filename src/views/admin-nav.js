// Adds the admin section (Stashes, Users, Settings) to the left menu of every page for someone who is signed in as an
// admin, so an admin sees the same menu as everyone else plus their own section, and does not have to open the admin
// page first. Guests and ordinary users get nothing. The admin page has its own copy of this menu and does not load
// this script. The pages that sign people in or out call StashlyAdminNav.refresh() so the section appears or goes away
// without a reload.
(function () {
    'use strict';

    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;

    var section = null;
    var HINT_KEY = 'sl_admin_nav';

    // Whether this browser was an admin last time. Only used to draw the section without waiting; the server's answer
    // below confirms it or takes it away, and the links lead to pages that check for themselves.
    function remembered() {
        try { return localStorage.getItem(HINT_KEY) === '1'; } catch (e) { return false; }
    }
    function remember(value) {
        try { localStorage.setItem(HINT_KEY, value ? '1' : '0'); } catch (e) { /* not remembered */ }
    }

    var LINKS = [
        { href: '/admin#/stashes', label: 'Stashes', icon: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>' },
        { href: '/admin#/users', label: 'Users', icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
        { href: '/admin#/settings', label: 'Settings', icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>' },
    ];

    function build() {
        var group = document.createElement('div');
        group.className = 'nav-section';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Admin');
        var label = document.createElement('span');
        label.className = 'nav-section-label label';
        label.textContent = 'Admin';
        group.appendChild(label);
        LINKS.forEach(function (item) {
            var link = document.createElement('a');
            link.href = item.href;
            link.className = 'nav-link';
            link.title = item.label;
            var holder = document.createElement('span');
            // Constant markup from this file only
            holder.innerHTML = '<svg viewBox="0 0 24 24">' + item.icon + '</svg>';
            link.appendChild(holder.firstChild);
            var text = document.createElement('span');
            text.className = 'label';
            text.textContent = item.label;
            link.appendChild(text);
            group.appendChild(link);
        });
        return group;
    }

    function refresh() {
        return fetch('/api/admin/status', { credentials: 'same-origin' })
            .then(function (res) { return res.json().catch(function () { return null; }); })
            .then(function (body) {
                var admin = Boolean(body && body.enabled && body.signedIn);
                remember(admin);
                if (admin && !section) {
                    section = build();
                    nav.appendChild(section);
                } else if (!admin && section) {
                    section.remove();
                    section = null;
                }
            })
            .catch(function () { /* keeps the menu it has */ });
    }

    window.StashlyAdminNav = { refresh: refresh };
    if (remembered()) {
        section = build();
        nav.appendChild(section);
    }
    refresh();
})();
