// The stash page on a phone: the stash's everyday buttons (copy, QR code, share links, extend, follow, pin) collapse into one
// three-dot menu in the top bar, so the header is a single row. The menu is built when it opens, from the real buttons in
// the header (which stay in the page, hidden on a phone): each entry shows the button's current word ("Follow" or
// "Following", "Pin" or "Pinned") and pressing it presses that button, so nothing here repeats what those buttons do or
// what decides when they show.
(function () {
    'use strict';

    var P = window.StashlyPage;
    var $ = P.$;
    var button = $('moreButton');
    if (!button) return;

    // In the order they appear in the menu: the ones used most first
    var BUTTONS = ['copyLatestButton', 'copyLinkButton', 'qrButton', 'shareButton', 'extendButton', 'followStashButton', 'pinStashButton'];
    var open = null; // { menu }

    function available() {
        return BUTTONS.map($).filter(function (el) { return el && !el.classList.contains('hidden'); });
    }

    function labelOf(el) {
        var label = el.querySelector('.btn-label');
        return (label && label.textContent.trim()) || el.getAttribute('aria-label') || el.title || '';
    }

    function close(returnFocus) {
        if (!open) return;
        open.menu.remove();
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onAway);
        window.removeEventListener('scroll', onAway, true);
        button.setAttribute('aria-expanded', 'false');
        open = null;
        // Not open any more: its history entry (see back.js) goes too
        if (window.StashlyBack) window.StashlyBack.release('more-menu');
        if (returnFocus) button.focus();
    }

    function onOutside(event) {
        if (open && !open.menu.contains(event.target) && !button.contains(event.target)) close(false);
    }

    function onAway() { close(false); }

    function onKey(event) {
        if (!open) return;
        var items = Array.prototype.slice.call(open.menu.querySelectorAll('.row-menu-item:not([disabled])'));
        var at = items.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); close(true); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); (items[at + 1] || items[0]).focus(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); (items[at - 1] || items[items.length - 1]).focus(); }
        else if (event.key === 'Home') { event.preventDefault(); items[0].focus(); }
        else if (event.key === 'End') { event.preventDefault(); items[items.length - 1].focus(); }
        else if (event.key === 'Tab') close(false);
    }

    function show() {
        var buttons = available();
        if (!buttons.length) return;
        var menu = document.createElement('div');
        menu.className = 'row-menu more-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Stash actions');
        buttons.forEach(function (source) {
            var pressed = source.getAttribute('aria-pressed');
            var entry = document.createElement('button');
            entry.type = 'button';
            // Follow and Pin are switches: say which way they are set
            entry.setAttribute('role', pressed === null ? 'menuitem' : 'menuitemcheckbox');
            if (pressed !== null) entry.setAttribute('aria-checked', pressed);
            entry.className = 'row-menu-item' + (pressed === 'true' ? ' on' : '');
            entry.disabled = source.disabled;
            var icon = source.querySelector('svg');
            if (icon) entry.appendChild(icon.cloneNode(true));
            var text = document.createElement('span');
            text.textContent = labelOf(source);
            entry.appendChild(text);
            entry.addEventListener('click', function () {
                close(false);
                source.click();
            });
            menu.appendChild(entry);
        });
        document.body.appendChild(menu);
        // Under the button, kept inside the window
        var at = button.getBoundingClientRect();
        var width = menu.offsetWidth;
        var height = menu.offsetHeight;
        var top = at.bottom + 4;
        if (top + height > window.innerHeight - 8) top = Math.max(8, at.top - height - 4);
        menu.style.top = top + 'px';
        menu.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, at.right - width)) + 'px';
        button.setAttribute('aria-expanded', 'true');
        open = { menu: menu };
        // Back closes the menu (back.js)
        if (window.StashlyBack) window.StashlyBack.push('more-menu', function () { close(false); });
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onAway);
        window.addEventListener('scroll', onAway, true);
        var first = menu.querySelector('.row-menu-item:not([disabled])');
        if (first) first.focus();
    }

    button.addEventListener('click', function (event) {
        event.stopPropagation();
        if (open) close(true); else show();
    });
})();
