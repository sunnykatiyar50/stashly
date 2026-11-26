// Theme: System (follows the browser/OS), Light or Dark.
//
// Loaded in <head>, so the saved theme is in place on first paint. Sets on <html>:
//   data-theme="light" | "dark"   only for an explicit choice (styles.css keys the palettes off this)
//   data-theme-choice="system" | "light" | "dark"   always
// The switch in the sidebar has one [data-theme-set="system|light|dark"] button per choice; the chosen one is marked.
(function () {
    'use strict';

    var KEY = 'sl_theme';
    var ORDER = ['system', 'light', 'dark'];
    var root = document.documentElement;

    function read() {
        try {
            var value = localStorage.getItem(KEY);
            return ORDER.indexOf(value) === -1 ? 'system' : value;
        } catch (e) {
            return 'system';
        }
    }

    function apply(choice) {
        if (choice === 'system') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', choice);
        root.setAttribute('data-theme-choice', choice);
        var buttons = document.querySelectorAll('[data-theme-set]');
        for (var i = 0; i < buttons.length; i++) {
            var on = buttons[i].getAttribute('data-theme-set') === choice;
            buttons[i].classList.toggle('active', on);
            buttons[i].setAttribute('aria-pressed', String(on));
        }
    }

    function save(choice) {
        try {
            if (choice === 'system') localStorage.removeItem(KEY);
            else localStorage.setItem(KEY, choice);
        } catch (e) {
            // storage unavailable: the choice lasts until the page is reloaded
        }
    }

    apply(read());

    document.addEventListener('DOMContentLoaded', function () {
        apply(read());
        document.addEventListener('click', function (event) {
            var button = event.target.closest && event.target.closest('[data-theme-set]');
            if (!button) return;
            var choice = button.getAttribute('data-theme-set');
            if (ORDER.indexOf(choice) === -1) return;
            save(choice);
            apply(choice);
        });
    });

    // Another tab changed the theme
    window.addEventListener('storage', function (event) {
        if (event.key === KEY) apply(read());
    });
})();
