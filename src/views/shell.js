// The sidebar: collapse to icons and remember it
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

    document.addEventListener('DOMContentLoaded', function () {
        apply(read());
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
