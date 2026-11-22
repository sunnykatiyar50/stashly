// The sidebar: collapse to icons and remember it, and show which release is running at the bottom of it
(function () {
    'use strict';

    var KEY = 'sl_sidebar_collapsed';

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

    // Which release is running, as a small label at the bottom of the menu (the server says so in /api/config)
    function showVersion() {
        var footer = document.querySelector('.sidebar-footer');
        if (!footer || typeof fetch !== 'function') return;
        fetch('/api/config', { credentials: 'same-origin' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (config) {
                if (!config || !config.version) return;
                var label = document.createElement('div');
                label.className = 'app-version label';
                label.textContent = 'v' + config.version;
                label.title = 'Stashly ' + config.version;
                footer.appendChild(label);
            })
            .catch(function () { /* no version label this time */ });
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
