// The sidebar: collapse to icons and remember it, and show which release is running at the bottom of it
(function () {
    'use strict';

    var KEY = 'sl_sidebar_collapsed';
    var VERSION_KEY = 'sl_version';

    // One request for the server's public config, shared with the page script that needs it (home.js), started as soon
    // as this script runs instead of after the page has drawn. Resolves to { ok, status, body }.
    var configRequest = null;
    function getConfig() {
        if (!configRequest) {
            configRequest = fetch('/api/config', { credentials: 'same-origin' }).then(function (res) {
                return res.json().catch(function () { return null; }).then(function (body) {
                    return { ok: res.ok, status: res.status, body: body };
                });
            });
        }
        return configRequest;
    }
    window.StashlyConfig = getConfig;
    if (typeof fetch === 'function') getConfig().catch(function () { /* each user of it handles failure */ });

    function read() {
        try {
            return localStorage.getItem(KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    // On a phone the sidebar is a slide-over menu, always shown in full, so "collapsed" only applies on a wide screen
    var phone = window.matchMedia('(max-width: 760px)');

    function apply(collapsed) {
        document.body.classList.toggle('sidebar-collapsed', collapsed && !phone.matches);
        var button = document.getElementById('collapseButton');
        if (button) {
            button.setAttribute('aria-expanded', String(!collapsed));
            button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
            button.setAttribute('aria-label', button.title);
        }
    }

    // Which release is running (the server says so in /api/config), in the footer of the menu below the account card, with a
    // "What's new" link to the release notes. The last version seen is drawn at once, so it does not pop in after the
    // page; the server's answer replaces it (a new release shows up on the next load).
    function showVersion() {
        var footer = document.querySelector('.sidebar-footer');
        if (!footer || typeof fetch !== 'function') return;
        var link = document.createElement('a');
        link.className = 'version-btn label';
        link.href = 'https://github.com/sunnykatiyar50/stashly/releases';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        var text = document.createElement('span');
        text.className = 'app-version';
        var hint = document.createElement('span');
        hint.className = 'version-hint';
        hint.textContent = "What's new";
        link.appendChild(text);
        link.appendChild(hint);
        function paint(version) {
            text.textContent = 'v' + version;
            link.title = 'Stashly ' + version + ': see what is new in this release';
            if (!link.parentNode) footer.appendChild(link);
        }
        try {
            var remembered = localStorage.getItem(VERSION_KEY);
            if (remembered) paint(remembered);
        } catch (e) { /* nothing remembered */ }
        getConfig().then(function (res) {
            if (!res.ok || !res.body || !res.body.version) return;
            paint(res.body.version);
            try { localStorage.setItem(VERSION_KEY, res.body.version); } catch (e) { /* not remembered */ }
        }).catch(function () { /* no version label this time */ });
    }

    // The phone's slide-over menu: the menu button opens it; the dimmed page, Esc, or choosing a link closes it
    function setupDrawer() {
        var button = document.querySelector('.drawer-button');
        var sidebar = document.getElementById('sidebar');
        if (!button || !sidebar) return;
        function set(open) {
            // Back closes the menu (back.js)
            if (window.StashlyBack) { if (open) window.StashlyBack.push('drawer', function () { set(false); }); else window.StashlyBack.release('drawer'); }
            document.body.classList.toggle('drawer-open', open);
            button.setAttribute('aria-expanded', String(open));
            button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
            if (open) {
                var first = sidebar.querySelector('a, button');
                if (first) first.focus();
            } else if (document.activeElement && sidebar.contains(document.activeElement)) {
                button.focus();
            }
        }
        button.addEventListener('click', function () { set(!document.body.classList.contains('drawer-open')); });
        var backdrop = document.querySelector('.drawer-backdrop');
        if (backdrop) backdrop.addEventListener('click', function () { set(false); });
        sidebar.addEventListener('click', function (event) {
            if (event.target.closest && event.target.closest('a[href]')) set(false);
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) set(false);
        });
        // Back to a wide screen, or back to the page from the browser's cache: never leave the menu open
        function closeIfWide() { if (!phone.matches) set(false); }
        if (phone.addEventListener) phone.addEventListener('change', closeIfWide); else phone.addListener(closeIfWide);
        window.addEventListener('pageshow', function () { set(false); });
    }

    document.addEventListener('DOMContentLoaded', function () {
        apply(read());
        var onPhoneChange = function () { apply(read()); };
        if (phone.addEventListener) phone.addEventListener('change', onPhoneChange); else phone.addListener(onPhoneChange);
        setupDrawer();
        showVersion();
        var button = document.getElementById('collapseButton');
        if (!button) return;
        button.addEventListener('click', function () {
            var collapsed = !document.body.classList.contains('sidebar-collapsed');
            try {
                localStorage.setItem(KEY, collapsed ? '1' : '0');
            } catch (e) {
                // not remembered
            }
            apply(collapsed);
        });
    });
})();
