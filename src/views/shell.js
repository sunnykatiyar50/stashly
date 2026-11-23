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

    function apply(collapsed) {
        document.body.classList.toggle('sidebar-collapsed', collapsed);
        var button = document.getElementById('collapseButton');
        if (button) {
            button.setAttribute('aria-expanded', String(!collapsed));
            button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
            button.setAttribute('aria-label', button.title);
        }
    }

    // Which release is running, as a small centred label right under the logo and name (the server says so in /api/config)
    // The last version seen is drawn at once, so the label does not pop in after the page; the server's answer
    // replaces it (a new release shows up on the next load).
    function showVersion() {
        var brand = document.querySelector('.sidebar-brand');
        if (!brand || typeof fetch !== 'function') return;
        var label = document.createElement('div');
        label.className = 'app-version label';
        function paint(version) {
            label.textContent = 'v' + version;
            label.title = 'Stashly ' + version;
            if (!label.parentNode) brand.insertAdjacentElement('afterend', label);
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

    document.addEventListener('DOMContentLoaded', function () {
        apply(read());
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
