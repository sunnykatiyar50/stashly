// The stash page: a list of clips on the left, the picked clip (or a new one) on the right.
// Live updates, search and date range, uploads by picker, drag and drop, and paste.
(function () {
    'use strict';

    var slug = decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase();
    var base = '/api/stashes/' + encodeURIComponent(slug);
    var $ = function (id) { return document.getElementById(id); };
    // Made up fresh for each page load; only used to recognise this page's own items in the live stream
    var tabId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

    var state = {
        stash: null,
        items: [],
        filters: { search: '', startDate: '', endDate: '' },
        es: null,
        connectedOnce: false,
        selectedId: null,  // the clip open on the right, or null
        revealedId: null,  // a burn note whose text is on screen and nowhere else
        editingId: null,   // the note being edited in the pane (live updates must not overwrite the form)
        plainIds: {},      // notes the reader switched to plain text (no code colours)
        autoCopy: false,   // copy notes that arrive from other devices (this tab only, off by default)
        notify: false,     // desktop notifications for new items (this tab only)
        pendingCopy: null, // text waiting for the tab to be in front so it can be copied
        sessionOptions: [], // how long a sign-in can last, from the server
        started: false,    // the first successful load picks what to show
    };
    var sections = { loading: $('stateLoading'), gone: $('stateGone'), locked: $('stateLocked'), main: $('stateMain') };
    var narrow = window.matchMedia('(max-width: 760px)');

    document.title = slug + ' · Stashly';
    // Lets the phone layout tighten the top bar on this page only
    document.body.classList.add('stash-page');
    $('thisStashLink').href = location.pathname;
    $('navStashName').textContent = slug;
    $('stashTitle').textContent = slug;
    $('createThisLink').href = '/';

    // ---- helpers ----

    function api(path, options) {
        options = options || {};
        return fetch(path, {
            method: options.method || 'GET',
            credentials: 'same-origin',
            // X-Tab-Id lets the server's live events say which page added an item, so a page knows its own
            headers: options.body ? { 'Content-Type': 'application/json', 'X-Tab-Id': tabId } : { 'X-Tab-Id': tabId },
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
        Object.keys(sections).forEach(function (key) { sections[key].classList.toggle('hidden', key !== name); });
        // Options and Log out may sit in the top bar on a phone; they only show while the stash itself is open
        document.body.classList.toggle('stash-open', name === 'main');
    }

    function make(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function svg(markup) {
        var span = document.createElement('span');
        span.innerHTML = markup;
        return span.firstChild;
    }

    var NOTE_ICON = '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>';

    // Copy works on plain HTTP too (LAN addresses), where navigator.clipboard is unavailable
    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
        }
        return Promise.resolve(fallbackCopy(text));
    }

    function fallbackCopy(text) {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.className = 'offscreen';
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        area.remove();
        return ok;
    }

    var canCopyImage = Boolean(navigator.clipboard && window.ClipboardItem && window.isSecureContext && window.createImageBitmap);

    // Browsers only accept PNG on the clipboard, so other formats are converted first
    function copyImage(item) {
        return fetch(item.url, { credentials: 'same-origin' })
            .then(function (res) { return res.blob(); })
            .then(function (blob) {
                if (blob.type === 'image/png') return blob;
                return createImageBitmap(blob).then(function (bitmap) {
                    var canvas = document.createElement('canvas');
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    canvas.getContext('2d').drawImage(bitmap, 0, 0);
                    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
                });
            })
            .then(function (png) { return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png })]); });
    }

    function relativeTime(iso) {
        var seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (seconds < 45) return 'just now';
        var minutes = Math.round(seconds / 60);
        if (minutes < 60) return minutes + ' min ago';
        var hours = Math.round(minutes / 60);
        if (hours < 24) return hours + ' h ago';
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function expiryText(expiresAt) {
        if (!expiresAt) return 'Never expires';
        var ms = new Date(expiresAt).getTime() - Date.now();
        if (ms <= 0) return 'Expiring now';
        var minutes = Math.floor(ms / 60000);
        if (minutes < 1) return 'Deletes in under 1 min';
        if (minutes < 60) return 'Deletes in ' + minutes + ' min';
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return 'Deletes in ' + hours + ' h ' + (minutes % 60) + ' min';
        return 'Deletes in ' + Math.floor(hours / 24) + ' d ' + (hours % 24) + ' h';
    }

    function extensionOf(name) {
        var index = name.lastIndexOf('.');
        return index > -1 ? name.slice(index + 1, index + 5) : 'file';
    }

    function findItem(id) {
        for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
        return null;
    }

    function button(label, className, onClick) {
        var el = make('button', className);
        el.type = 'button';
        setLabel(el, label);
        el.addEventListener('click', onClick);
        return el;
    }

    // Icons for the action buttons, picked by the button's words (the words change as a button toggles)
    var ACTION_ICONS = {
        copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        check: '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
        edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
        pin: '<svg viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>',
        unpin: '<svg viewBox="0 0 24 24"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12"/><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89"/></svg>',
        trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
        eye: '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
        eyeOff: '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
        text: '<svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
        code: '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        flame: '<svg viewBox="0 0 24 24"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
        x: '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        download: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        open: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
    };

    function iconFor(label) {
        if (/^Copied/.test(label) || label === 'Done' || label === 'Save') return ACTION_ICONS.check;
        if (/^Copy/.test(label)) return ACTION_ICONS.copy;
        if (label === 'Edit') return ACTION_ICONS.edit;
        if (label === 'Pin') return ACTION_ICONS.pin;
        if (label === 'Unpin') return ACTION_ICONS.unpin;
        if (label === 'Delete') return ACTION_ICONS.trash;
        if (label === 'Show') return ACTION_ICONS.eye;
        if (label === 'Hide') return ACTION_ICONS.eyeOff;
        if (label === 'Plain text') return ACTION_ICONS.text;
        if (/^(Render|Highlight) /.test(label)) return ACTION_ICONS.code;
        if (/^Reveal/.test(label)) return ACTION_ICONS.flame;
        if (label === 'Cancel') return ACTION_ICONS.x;
        if (label === 'Download') return ACTION_ICONS.download;
        if (label === 'Open') return ACTION_ICONS.open;
        return null;
    }

    // Puts an icon (when there is one for these words) and the words on a button or link, replacing what was there
    function setLabel(el, label) {
        el.textContent = '';
        var icon = iconFor(label);
        if (icon) el.appendChild(svg(icon));
        el.appendChild(make('span', 'btn-text', label));
    }

    // ---- the list on the left ----

    // A note shows its title (the first 40 characters when it was not given one); a file shows its name
    function itemTitle(item) {
        if (item.kind !== 'note') return item.fileName;
        return item.title || '(empty note)';
    }

    var MASK = '••••••••';

    // The properties of a clip, shown as small chips on the right of its row so they read as labels, not as content:
    // Pinned, Burns after reading, Secret, and a countdown when the note has its own expiry.
    // Each is shown as an icon, with its name on hover; the expiry also shows the time left in short ("3h 20m").
    function clipFlags(item) {
        var flags = [];
        if (item.pinned) flags.push({ text: 'Pinned', kind: 'pinned', icon: PIN_ICON });
        if (item.kind === 'note') {
            if (item.burn) flags.push({ text: 'Burns after reading', kind: 'burn', icon: FLAME_ICON });
            if (item.secret) flags.push({ text: 'Secret', kind: 'secret', icon: LOCK_ICON });
            if (item.expiresAt) flags.push({ text: expiryText(item.expiresAt), kind: 'expiry', icon: CLOCK_ICON, expires: item.expiresAt });
        }
        return flags;
    }

    // The line under the title in the list: a few lines of the note, or the size of a file.
    // The note lines can be hidden with the eye button above the list.
    function itemSub(item) {
        if (item.kind !== 'note') return window.StashlyUpload.formatSize(item.fileSize);
        if (item.burn) return '';
        if (item.secret) return MASK;
        var text = item.text || '';
        return text.replace(/\s+/g, ' ').trim().slice(0, 240);
    }

    function buildClip(item) {
        // A div, not a button, because the row holds its own copy button
        var el = make('div', 'clip');
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
        el.dataset.id = item.id;

        // A handle to drag the clip to another place (only with full access; pinned and unpinned clips each keep
        // to their own group)
        if (role() === 'full') {
            el.classList.add('has-grip');
            var grip = make('span', 'clip-grip');
            grip.title = 'Drag to move. Or press Alt+Up or Alt+Down.';
            grip.setAttribute('aria-hidden', 'true');
            grip.appendChild(svg(GRIP_ICON));
            grip.addEventListener('pointerdown', function (event) { startDrag(event, el); });
            grip.addEventListener('click', function (event) { event.stopPropagation(); });
            el.appendChild(grip);
        }

        var lead;
        if (item.isImage) {
            lead = make('img', 'clip-thumb');
            lead.src = item.url;
            lead.alt = '';
            lead.loading = 'lazy';
        } else if (item.kind === 'file') {
            lead = make('span', 'file-icon', extensionOf(item.fileName));
        } else {
            lead = make('span', 'clip-icon');
            lead.appendChild(svg(NOTE_ICON));
        }
        el.appendChild(lead);

        var text = make('span', 'clip-text');
        // A note with no title of its own is titled with its first 40 characters (worked out by the server).
        // Secret and burn notes get a plain title, because their content must not show here.
        text.appendChild(make('span', 'clip-title', itemTitle(item)));
        var sub = itemSub(item);
        if (sub) text.appendChild(make('span', item.kind === 'note' ? 'clip-sub clip-preview' : 'clip-sub', sub));
        var flags = clipFlags(item);
        if (flags.length) {
            var flagLine = make('span', 'clip-flags');
            flags.forEach(function (flag) {
                var chip;
                if (flag.icon) {
                    chip = make('span', 'clip-flag-icon clip-flag-' + flag.kind);
                    chip.title = flag.text;
                    chip.setAttribute('role', 'img');
                    chip.setAttribute('aria-label', flag.text);
                    chip.appendChild(svg(flag.icon));
                    if (flag.expires) chip.appendChild(make('span', 'clip-flag-short', shortExpiry(flag.text)));
                } else {
                    chip = make('span', 'clip-flag clip-flag-' + flag.kind, flag.text);
                }
                if (flag.expires) chip.dataset.expires = flag.expires;
                flagLine.appendChild(chip);
            });
            text.appendChild(flagLine);
        }
        el.appendChild(text);

        var time = make('span', 'clip-time item-time', relativeTime(item.createdAt));
        time.dataset.iso = item.createdAt;
        time.title = new Date(item.createdAt).toLocaleString();
        var side = make('span', 'clip-side');
        side.appendChild(time);
        // Quick buttons, always shown (a phone has no hover): pin and copy
        var quick = make('span', 'clip-quick');
        if (role() === 'full') {
            var pinLabel = item.pinned ? 'Unpin' : 'Pin to the top';
            var pin = make('button', 'clip-copy clip-pin ghost' + (item.pinned ? ' on' : ''));
            pin.type = 'button';
            pin.title = pinLabel;
            pin.setAttribute('aria-label', pinLabel);
            pin.setAttribute('aria-pressed', item.pinned ? 'true' : 'false');
            pin.appendChild(svg(PIN_ICON));
            pin.addEventListener('click', function (event) {
                event.stopPropagation();
                setPinned(item, !item.pinned);
            });
            quick.appendChild(pin);
        }
        // A note whose text is on the page can be copied without opening it (a burn note's text is not here)
        if (item.kind === 'note' && !item.burn && item.text) {
            var copy = make('button', 'clip-copy ghost');
            copy.type = 'button';
            copy.title = 'Copy this note';
            copy.setAttribute('aria-label', 'Copy this note');
            copy.appendChild(svg(COPY_ICON));
            copy.addEventListener('click', function (event) {
                event.stopPropagation();
                copyNote(item.text, copy);
            });
            quick.appendChild(copy);
        }
        if (quick.children.length) side.appendChild(quick);
        el.appendChild(side);

        el.addEventListener('click', function () { openItem(item.id); });
        el.addEventListener('keydown', function (event) {
            if (event.target !== el) return;
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openItem(item.id); }
            // Alt+Up / Alt+Down moves the clip one place, for those not using a mouse
            if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && role() === 'full') {
                event.preventDefault();
                moveByKey(el, event.key === 'ArrowUp' ? -1 : 1);
            }
        });
        return el;
    }

    var PIN_ICON = '<svg viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>';
    var FLAME_ICON = '<svg viewBox="0 0 24 24"><path d="M12 22c4 0 7-2.7 7-7 0-3.5-2.2-6.2-4-8-.4 2-1.4 3.4-3 4 .3-3.3-1.2-6.4-4-9 0 4-5 6.7-5 13 0 4.3 4 7 9 7z"/></svg>';
    var LOCK_ICON = '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
    var GRIP_ICON = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';

    // ---- moving clips ----

    // Clips may only move among those with the same pinned state, so a drag never seems to pin or unpin one
    function sameGroup(a, b) {
        var x = findItem(Number(a.dataset.id));
        var y = findItem(Number(b.dataset.id));
        return Boolean(x && y && x.pinned === y.pinned);
    }

    function rowIds() {
        return Array.prototype.map.call($('items').children, function (child) { return child.dataset.id; }).join(',');
    }

    // Drag with a mouse, pen or finger from the handle. The row follows the pointer through the list; letting go
    // saves the new order. Pointer events (not HTML drag and drop) so it works the same on phones.
    function startDrag(event, el) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        var list = $('items');
        var before = rowIds();
        var pointerId = event.pointerId;
        var lastY = event.clientY;
        el.classList.add('dragging');
        list.classList.add('drag-active');

        // Moves the row to wherever the pointer is, among the clips of its own group
        function place(y) {
            var siblings = Array.prototype.filter.call(list.children, function (child) { return child !== el && sameGroup(child, el); });
            if (!siblings.length) return;
            var next = null;
            for (var i = 0; i < siblings.length; i++) {
                var box = siblings[i].getBoundingClientRect();
                if (y < box.top + box.height / 2) { next = siblings[i]; break; }
            }
            var anchor = next || siblings[siblings.length - 1].nextElementSibling;
            if (anchor !== el && el.nextElementSibling !== anchor) list.insertBefore(el, anchor);
        }

        // Near the top or bottom edge the list scrolls by itself, so a clip can travel further than one screen
        function autoScroll() {
            var box = list.getBoundingClientRect();
            var edge = 40;
            var step = lastY < box.top + edge ? -12 : lastY > box.bottom - edge ? 12 : 0;
            if (step && list.scrollHeight > list.clientHeight) { list.scrollTop += step; place(lastY); }
        }
        var scrollTimer = setInterval(autoScroll, 30);

        function move(e) {
            if (e.pointerId !== pointerId) return;
            lastY = e.clientY;
            place(lastY);
        }

        function end(e) {
            if (e.pointerId !== pointerId) return;
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            document.removeEventListener('pointercancel', end);
            clearInterval(scrollTimer);
            el.classList.remove('dragging');
            list.classList.remove('drag-active');
            if (rowIds() !== before) saveOrder(el);
        }

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
        document.addEventListener('pointercancel', end);
    }

    function moveByKey(el, direction) {
        var target = direction < 0 ? el.previousElementSibling : el.nextElementSibling;
        if (!target || !sameGroup(target, el)) return;
        $('items').insertBefore(el, direction < 0 ? target : target.nextElementSibling);
        el.focus();
        saveOrder(el);
    }

    // Sends the order of the moved clip's group as it now stands on the page. The server only swaps places among
    // these clips, so the ones a search left out stay where they were.
    function saveOrder(el) {
        var ids = Array.prototype.filter.call($('items').children, function (child) { return sameGroup(child, el); })
            .map(function (child) { return Number(child.dataset.id); });
        api(base + '/reorder', { method: 'POST', body: { ids: ids } }).then(function (res) {
            if (res.ok) return applyOrders(res.body.orders);
            if (res.status === 401) return locked();
            toast((res.body && res.body.error) || 'Could not save the new order.', true);
            // Put the list back the way the server has it
            load(true);
        }).catch(function () {
            toast('Could not save the new order.', true);
            sortItems();
            renderItems();
        });
    }

    // New places for some clips (from this page or another device): re-sort, then move the rows that are out of
    // place without rebuilding them, so focus and loaded images stay
    function applyOrders(orders) {
        var byId = {};
        orders.forEach(function (entry) { byId[entry.id] = entry.order; });
        state.items.forEach(function (item) { if (byId[item.id] !== undefined) item.order = byId[item.id]; });
        sortItems();
        var wanted = state.items.map(function (item) { return String(item.id); }).join(',');
        if (rowIds() === wanted) return;
        var list = $('items');
        state.items.forEach(function (item) {
            var row = list.querySelector('.clip[data-id="' + item.id + '"]');
            if (row) list.appendChild(row);
        });
    }

    var COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    var CHECK_ICON = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

    // Copies a note's text; the row button shows a tick for a moment
    function copyNote(text, trigger) {
        return Promise.resolve(copyText(text)).then(function (ok) {
            toast(ok ? 'Copied' : 'Could not copy. Open the note and select the text.', !ok);
            if (ok && trigger) {
                trigger.textContent = '';
                trigger.appendChild(svg(CHECK_ICON));
                setTimeout(function () { trigger.textContent = ''; trigger.appendChild(svg(COPY_ICON)); }, 1200);
            }
            return ok;
        });
    }

    // The newest note whose text is on the page. A burn note has none (copying it would mean revealing it).
    function copyLatest() {
        for (var i = 0; i < state.items.length; i++) {
            var item = state.items[i];
            if (item.kind === 'note' && !item.burn && item.text) return copyNote(item.text, null);
        }
        toast(state.items.some(function (item) { return item.burn; }) ? 'Only burn-after-reading notes here. Reveal one to copy it.' : 'No note to copy yet.', true);
        return Promise.resolve(false);
    }

    $('copyLatestButton').addEventListener('click', copyLatest);
    // Alt+C copies the newest note from anywhere on the page
    document.addEventListener('keydown', function (event) {
        if (!(event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c')) return;
        if (sections.main.classList.contains('hidden')) return;
        event.preventDefault();
        copyLatest();
    });

    function filtersActive() {
        var f = state.filters;
        return Boolean(f.search || f.startDate || f.endDate);
    }

    function updateCounts() {
        var n = state.items.length;
        $('itemInfo').textContent = n + (filtersActive() ? (n === 1 ? ' match' : ' matches') : n === 1 ? ' clip' : ' clips');
        var empty = $('emptyState');
        empty.classList.toggle('hidden', n > 0);
        empty.textContent = filtersActive()
            ? 'No clips match your search or dates.'
            : 'Nothing here yet. Add a note or drop a file.';
        $('filterToggle').classList.toggle('active', Boolean(state.filters.startDate || state.filters.endDate));
    }

    function markSelected() {
        Array.prototype.forEach.call($('items').children, function (el) {
            var on = Number(el.dataset.id) === state.selectedId;
            el.classList.toggle('selected', on);
            if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
        });
    }

    function renderItems() {
        var list = $('items');
        list.textContent = '';
        state.items.forEach(function (item) { list.appendChild(buildClip(item)); });
        updateCounts();
        markSelected();
    }

    // ---- the pane on the right ----

    // On a narrow screen only one pane shows at a time; "right" means the detail pane
    function setPane(pane) {
        $('split').classList.toggle('show-detail', pane === 'right');
        // On a phone the composer would crowd out an open clip
        sections.main.classList.toggle('detail-open', pane === 'right');
    }

    // Nothing open: the right pane shows a hint
    function showNothing() {
        state.selectedId = null;
        $('detail').classList.add('hidden');
        $('detailEmpty').classList.remove('hidden');
        markSelected();
        setPane('list');
    }

    function openItem(id) {
        var item = findItem(id);
        if (!item) return;
        state.revealedId = null;
        state.editingId = null;
        state.selectedId = id;
        $('detailEmpty').classList.add('hidden');
        $('detail').classList.remove('hidden');
        renderDetail(item);
        markSelected();
        setPane('right');
    }

    // What to open when the clip on the right has gone: its neighbour (on a phone, back to the list)
    function showSomethingElse(preferIndex) {
        if (!narrow.matches && state.items.length) {
            var item = state.items[Math.min(Math.max(preferIndex, 0), state.items.length - 1)];
            openItem(item.id);
        } else {
            showNothing();
        }
    }

    // Text files are stored as text/* (or JSON), so any of them can be previewed
    function isTextType(type) { return /^text\//.test(type || '') || /^application\/json/.test(type || ''); }
    var TEXT_PREVIEW_MAX = 512 * 1024;

    // The names inside a zip file (the server reads the directory only, nothing is unpacked)
    function showZipContents(item, body) {
        var box = make('div', 'zip-list');
        box.appendChild(make('div', 'muted', 'Reading the zip file...'));
        body.appendChild(box);
        fetch(item.url + '/contents', { credentials: 'same-origin' })
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
                if (state.selectedId !== item.id) return;
                box.textContent = '';
                if (!result.ok) { box.remove(); return; }
                var data = result.data;
                var files = data.entries.filter(function (entry) { return !entry.isDir; }).length;
                box.appendChild(make('div', 'zip-title', data.total + (data.total === 1 ? ' entry' : ' entries') + (files !== data.total ? ' (' + files + ' files)' : '')));
                data.entries.forEach(function (entry) {
                    var row = make('div', 'zip-row');
                    row.appendChild(make('span', 'zip-name', entry.name));
                    row.appendChild(make('span', 'muted', entry.isDir ? '' : window.StashlyUpload.formatSize(entry.size)));
                    box.appendChild(row);
                });
                if (data.truncated) box.appendChild(make('div', 'muted', 'And ' + (data.total - data.entries.length) + ' more.'));
            })
            .catch(function () { box.remove(); });
    }

    function copyButton(label, className, value) {
        return button(label, className, function (event) {
            var target = event.currentTarget;
            Promise.resolve(copyText(value)).then(function (ok) {
                toast(ok ? 'Copied' : 'Could not copy. Select the text and copy it by hand.', !ok);
                if (ok) { setLabel(target, 'Copied'); setTimeout(function () { setLabel(target, label); }, 1500); }
            });
        });
    }

    // Asks the server for a burn note's text. The note is deleted as it is handed over, so what is shown here
    // is the only copy; it stays on screen until another clip is opened.
    function revealBurn(item, trigger) {
        trigger.disabled = true;
        state.revealedId = item.id;
        api(base + '/items/' + item.id + '/reveal', { method: 'POST' }).then(function (res) {
            if (res.status === 401) { locked(); return; }
            if (!res.ok) {
                trigger.disabled = false;
                state.revealedId = null;
                toast((res.body && res.body.error) || 'Could not reveal that note.', true);
                if (res.status === 404) onItemDeleted(item.id);
                return;
            }
            onItemDeleted(item.id);
            if (state.selectedId !== item.id) return;
            var actions = $('detailActions');
            var body = $('detailBody');
            actions.textContent = '';
            body.textContent = '';
            $('detailMeta').textContent = 'Revealed once · now deleted for everyone';
            body.appendChild(make('pre', 'detail-text', res.body.text));
            actions.appendChild(copyButton('Copy', 'primary', res.body.text));
            actions.appendChild(button('Done', 'ghost', function () {
                state.revealedId = null;
                showSomethingElse(0);
            }));
        }).catch(function () {
            trigger.disabled = false;
            state.revealedId = null;
            toast('Could not reach the server.', true);
        });
    }

    // What a note looks like: a code or data language, 'markdown', or null for plain text. A note with a fenced code block
    // is Markdown whatever is inside the fences; otherwise code is checked first, because a shell comment starts with
    // the same # as a Markdown heading.
    function detectFormat(text) {
        var markdown = window.StashlyMarkdown;
        var highlight = window.StashlyHighlight;
        if (markdown && markdown.hasFence(text)) return 'markdown';
        var code = highlight ? highlight.detect(text) : null;
        if (code) return code;
        return markdown && markdown.looks(text) ? 'markdown' : null;
    }

    function renderDetail(item) {
        var actions = $('detailActions');
        var body = $('detailBody');
        actions.textContent = '';
        body.textContent = '';
        $('detailTitle').textContent = itemTitle(item);
        var when = new Date(item.createdAt).toLocaleString();

        if (item.kind === 'note' && item.burn) {
            // The text is not here: it stays on the server until someone reveals it, and then it is deleted
            $('detailMeta').textContent = ['Note', 'Burns after reading', item.expiresAt ? expiryText(item.expiresAt) : '', when].filter(Boolean).join(' · ');
            var warning = make('div', 'burn-card');
            warning.appendChild(make('strong', null, 'This note burns after reading.'));
            warning.appendChild(make('span', 'muted', 'Its text has not been sent to this page. Revealing it shows it once and deletes it for everyone, so be ready to copy it.'));
            body.appendChild(warning);
            // Revealing deletes the note, so a read-only link cannot do it
            if (role() === 'full') actions.appendChild(button('Reveal and delete', 'primary', function (event) { revealBurn(item, event.currentTarget); }));
            else warning.appendChild(make('strong', null, 'Only someone with full access can reveal it.'));
        } else if (item.kind === 'note') {
            var language = detectFormat(item.text);
            $('detailMeta').textContent = ['Note', item.secret ? 'Secret' : '', item.expiresAt ? expiryText(item.expiresAt) : '', (item.text || '').length + ' characters', when, item.editedAt ? 'edited ' + relativeTime(item.editedAt) : ''].filter(Boolean).join(' · ');
            var pre = make('div', 'detail-text');
            body.appendChild(pre);
            // Web addresses are clickable; Markdown is rendered and code is coloured when it is recognised, and
            // "Plain text" turns that off (the text itself is never changed)
            var shown = !item.secret;
            var plain = Boolean(state.plainIds[item.id]);
            var paint = function () {
                pre.textContent = '';
                var asMarkdown = shown && !plain && language === 'markdown' && window.StashlyMarkdown;
                pre.classList.toggle('md', Boolean(asMarkdown));
                if (!shown) { pre.textContent = MASK; return; }
                if (asMarkdown) pre.appendChild(window.StashlyMarkdown.render(item.text, window.StashlyHighlight));
                else if (window.StashlyHighlight) pre.appendChild(window.StashlyHighlight.render(item.text, plain || language === 'markdown' ? null : language));
                else pre.textContent = item.text;
            };
            paint();
            actions.appendChild(copyButton('Copy', 'primary', item.text));
            if (item.secret) {
                actions.appendChild(button('Show', 'ghost', function (event) {
                    shown = !shown;
                    paint();
                    setLabel(event.currentTarget, shown ? 'Hide' : 'Show');
                }));
            }
            if (language) {
                var label = language === 'markdown' ? 'Markdown' : window.StashlyHighlight.label(language);
                var verb = language === 'markdown' ? 'Render ' : 'Highlight ';
                actions.appendChild(button(plain ? verb + label : 'Plain text', 'ghost', function (event) {
                    plain = !plain;
                    state.plainIds[item.id] = plain;
                    setLabel(event.currentTarget, plain ? verb + label : 'Plain text');
                    paint();
                }));
            }
            if (role() === 'full') actions.appendChild(button('Edit', 'ghost', function () { editNote(item); }));
        } else {
            $('detailMeta').textContent = window.StashlyUpload.formatSize(item.fileSize) + ' · ' + when;

            var download = make('a', 'button-link primary-link');
            setLabel(download, 'Download');
            download.href = item.url + '?download=1';
            download.setAttribute('download', item.fileName);
            actions.appendChild(download);

            if (item.isImage) {
                var link = make('a', 'detail-image');
                link.href = item.url;
                link.target = '_blank';
                link.rel = 'noopener';
                link.title = 'Open full size';
                var img = make('img');
                img.src = item.url;
                img.alt = item.fileName;
                link.appendChild(img);
                body.appendChild(link);
                if (canCopyImage) {
                    actions.appendChild(button('Copy image', 'ghost', function () {
                        copyImage(item).then(
                            function () { toast('Image copied'); },
                            function () { toast('Could not copy the image. Use Download instead.', true); }
                        );
                    }));
                }
            } else {
                var card = make('div', 'file-card');
                card.appendChild(make('span', 'file-icon large', extensionOf(item.fileName)));
                var info = make('div');
                info.appendChild(make('div', 'file-name', item.fileName));
                info.appendChild(make('div', 'muted', window.StashlyUpload.formatSize(item.fileSize) + (item.fileType ? ' · ' + item.fileType : '')));
                card.appendChild(info);
                body.appendChild(card);

                // Audio and video play in the page, a PDF opens in its own tab, a zip shows what is inside
                var mediaType = (item.fileType || '').split(';')[0];
                if (/^(video|audio)\//.test(mediaType)) {
                    var player = make(mediaType.indexOf('video') === 0 ? 'video' : 'audio', 'detail-media');
                    player.controls = true;
                    player.preload = 'metadata';
                    player.src = item.url;
                    body.insertBefore(player, card);
                } else if (mediaType === 'application/pdf') {
                    var open = make('a', 'button-link');
                    setLabel(open, 'Open');
                    open.href = item.url + '?view=1';
                    open.target = '_blank';
                    open.rel = 'noopener';
                    actions.appendChild(open);
                } else if (mediaType === 'application/zip' && /\.zip$/i.test(item.fileName)) {
                    showZipContents(item, body);
                }

                if (isTextType(item.fileType) && item.fileSize <= TEXT_PREVIEW_MAX) {
                    var pre = make('pre', 'detail-text', 'Loading preview...');
                    body.appendChild(pre);
                    fetch(item.url, { credentials: 'same-origin' })
                        .then(function (res) { if (!res.ok) throw new Error('preview'); return res.text(); })
                        .then(function (text) {
                            if (state.selectedId !== item.id) return;
                            pre.textContent = text;
                            actions.insertBefore(button('Copy text', 'ghost', function () {
                                Promise.resolve(copyText(text)).then(function (ok) { toast(ok ? 'Copied' : 'Could not copy.', !ok); });
                            }), actions.children[1] || null);
                        })
                        .catch(function () { pre.remove(); });
                }
            }
        }

        if (role() === 'full') {
            actions.appendChild(button(item.pinned ? 'Unpin' : 'Pin', 'ghost', function () { setPinned(item, !item.pinned); }));
            actions.appendChild(button('Delete', 'danger-ghost', function () { removeItem(item); }));
        }
        body.scrollTop = 0;
    }

    document.querySelectorAll('[data-back]').forEach(function (el) {
        el.addEventListener('click', function () { setPane('list'); });
    });

    // 'full' can do everything. 'view' (a read-only link) cannot change anything. 'drop' (a drop-box link) can only add.
    function role() { return (state.stash && state.stash.role) || 'full'; }

    // What the stash takes: 'all', 'notes' or 'files'. The composer hides what cannot be added.
    function stashContent() { return (state.stash && state.stash.content) || 'all'; }

    function applyContent() {
        var content = stashContent();
        sections.main.classList.toggle('content-notes', content === 'notes');
        sections.main.classList.toggle('content-files', content === 'files');
    }

    function applyRole() {
        var r = role();
        sections.main.classList.toggle('role-view', r === 'view');
        sections.main.classList.toggle('role-drop', r === 'drop');
        // Options has nothing for a drop-box link (it may be in the top bar, outside the section above)
        $('optionsButton').classList.toggle('hidden', r === 'drop');
        var banner = $('roleBanner');
        banner.classList.toggle('hidden', r === 'full');
        banner.textContent = r === 'view'
            ? 'You opened a read-only link. You can read and copy, but not add or delete anything.'
            : r === 'drop' ? 'You opened a drop-box link. You can add notes and files here, but you cannot see what is in the stash.' : '';
        // Log out of a password-protected stash, or just leave an open one
        var leaveWord = state.stash.hasPassword ? 'Log out' : 'Exit';
        $('logoutButton').querySelector('.btn-label').textContent = leaveWord;
        $('logoutButton').setAttribute('aria-label', leaveWord);
        updateSessionInfo();
        // Share links only make sense on a password-protected stash, and only for someone with full access
        $('shareButton').classList.toggle('hidden', !(r === 'full' && state.stash.hasPassword));
    }

    function updateHeader() {
        var stash = state.stash;
        $('lockChip').classList.toggle('hidden', !stash.hasPassword);
        $('extendButton').classList.toggle('hidden', !stash.canExtend);
        updateExpiry();
        var f = state.filters;
        var chip = $('rangeChip');
        if (f.startDate || f.endDate) {
            $('rangeChipText').textContent = (f.startDate || 'start') + ' → ' + (f.endDate || 'now');
            chip.classList.remove('hidden');
        } else {
            chip.classList.add('hidden');
        }
    }

    // A chip with its full words for wide screens and a short form (icon and number) for phones; the full words
    // stay as the tooltip
    var CLOCK_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';
    var PEOPLE_ICON = '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    function setChip(chip, long, short, icon) {
        // The chip's own explanation (from the page) is kept after the words
        if (chip.dataset.tip === undefined) chip.dataset.tip = chip.title || '';
        chip.textContent = '';
        chip.title = long + (chip.dataset.tip ? '. ' + chip.dataset.tip : '');
        chip.appendChild(make('span', 'chip-long', long));
        var compact = make('span', 'chip-short');
        compact.appendChild(svg(icon));
        compact.appendChild(document.createTextNode(short));
        chip.appendChild(compact);
    }

    // "Deletes in 23 h 59 min" becomes "23h 59m"
    function shortExpiry(text) {
        return text.replace(/^Deletes in /, '').replace(/under 1 min/, '<1m').replace(/ d /, 'd ').replace(/ h( |$)/, 'h$1').replace(/ min$/, 'm');
    }

    function updateExpiry() {
        if (!state.stash) return;
        var chip = $('expiryInfo');
        var words = expiryText(state.stash.expiresAt);
        setChip(chip, words, shortExpiry(words), CLOCK_ICON);
        var soon = state.stash.expiresAt && new Date(state.stash.expiresAt).getTime() - Date.now() < 60 * 60 * 1000;
        chip.classList.toggle('warn', Boolean(soon));
        if (state.stash.expiresAt && new Date(state.stash.expiresAt).getTime() <= Date.now()) load(true);
    }

    function updateTimes() {
        Array.prototype.forEach.call(document.querySelectorAll('.item-time'), function (el) {
            el.textContent = relativeTime(el.dataset.iso);
        });
        // Notes with their own expiry: count down, and drop them from the page when the time is up
        state.items.filter(function (item) { return item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now(); })
            .forEach(function (item) { onItemDeleted(item.id); });
        Array.prototype.forEach.call(document.querySelectorAll('.clip-flags [data-expires]'), function (el) {
            var words = expiryText(el.dataset.expires);
            el.title = words;
            el.setAttribute('aria-label', words);
            var short = el.querySelector('.clip-flag-short');
            if (short) short.textContent = shortExpiry(words);
        });
        updateExpiry();
        updateSessionInfo();
    }

    // ---- loading ----

    function load(quiet) {
        var f = state.filters;
        // Sent in the body, not the address, so search words never end up in a proxy's access log
        var query = { tz: String(new Date().getTimezoneOffset()) };
        if (f.search) query.search = f.search;
        if (f.startDate) query.startDate = f.startDate;
        if (f.endDate) query.endDate = f.endDate;
        return api(base + '/query', { method: 'POST', body: query }).then(function (res) {
            if (res.status === 404) return gone();
            if (res.status === 401) return locked();
            if (res.status === 400) {
                toast(res.body && res.body.error ? res.body.error : 'Check the search and dates.', true);
                return;
            }
            if (!res.ok) {
                if (!quiet) toast('Could not load the stash.', true);
                return;
            }
            var previousIndex = state.items.findIndex(function (item) { return item.id === state.selectedId; });
            state.stash = res.body;
            state.items = res.body.items;
            // Only a stash opened with full access is worth suggesting on the share page
            if (window.StashlyRemember && res.body.role === 'full') window.StashlyRemember(slug);
            // The installed app reopens this stash next time it is launched (whatever the role: a link visitor too)
            if (window.StashlyLast) window.StashlyLast.set(slug);
            applyRole();
            applyContent();
            sections.main.classList.contains('hidden') && show('main');
            updateHeader();
            renderItems();
            connect();

            if (!state.started) {
                state.started = true;
                // Desktop opens the newest clip (the usual reason to visit); a phone starts on the list
                if (!narrow.matches && state.items.length) openItem(state.items[0].id);
            } else if (state.selectedId !== null && state.revealedId !== state.selectedId) {
                if (findItem(state.selectedId)) { if (state.editingId !== state.selectedId) renderDetail(findItem(state.selectedId)); }
                else showSomethingElse(previousIndex);
            }
        }).catch(function () {
            if (!quiet) toast('Could not reach the server.', true);
        });
    }

    function gone() {
        closeStream();
        state.stash = null;
        // It no longer exists, so the installed app should not keep trying to open it
        if (window.StashlyLast) window.StashlyLast.clear(slug);
        show('gone');
    }

    function locked() {
        closeStream();
        state.stash = null;
        show('locked');
        $('unlockInput').focus();
    }

    // ---- live updates ----

    function closeStream() {
        if (state.es) { state.es.close(); state.es = null; }
        $('liveStatus').classList.add('hidden');
        $('presenceChip').classList.add('hidden');
        state.connectedOnce = false;
    }

    function localDayStart(ymd) {
        var parts = ymd.split('-').map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
    }

    // Live items only join the list when they fit the active search and dates
    function matchesFilters(item) {
        var f = state.filters;
        if (f.search) {
            var hay = ((item.text || '') + ' ' + (item.fileName || '') + ' ' + (item.hasTitle ? item.title : '')).toLowerCase();
            if (hay.indexOf(f.search.toLowerCase()) === -1) return false;
        }
        var created = new Date(item.createdAt).getTime();
        if (f.startDate && created < localDayStart(f.startDate)) return false;
        if (f.endDate && created >= localDayStart(f.endDate) + 86400000) return false;
        return true;
    }

    // A new clip joins the top of the list. What is open on the right is left alone, so a clip
    // arriving from another machine never pulls the page away from what you are reading or typing.
    function onItemAdded(item) {
        if (state.items.some(function (existing) { return existing.id === item.id; })) return;
        if (!matchesFilters(item)) return;
        // Pinned items stay above everything, so a new item goes in just below them
        var at = 0;
        while (at < state.items.length && state.items[at].pinned) at++;
        state.items.splice(at, 0, item);
        var el = buildClip(item);
        el.classList.add('new');
        $('items').insertBefore(el, $('items').children[at] || null);
        updateCounts();
        markSelected();
    }

    // The same order as the server: pinned first, then by place (higher on top)
    function sortItems() {
        state.items.sort(function (a, b) {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            if (a.order !== b.order) return b.order - a.order;
            return b.id - a.id;
        });
    }

    function onItemUpdated(item) {
        var index = state.items.findIndex(function (existing) { return existing.id === item.id; });
        if (index === -1) return;
        var wasPinned = state.items[index].pinned;
        // A live update never carries who sent it
        delete item.origin;
        state.items[index] = item;
        if (wasPinned !== item.pinned) { sortItems(); renderItems(); } else {
            var el = document.querySelector('.clip[data-id="' + item.id + '"]');
            if (el) el.replaceWith(buildClip(item));
            markSelected();
        }
        // The open clip shows the change, unless it is being edited right now (that would throw the typing away)
        if (state.selectedId === item.id && state.editingId !== item.id && state.revealedId !== item.id) renderDetail(item);
    }

    function setPinned(item, pinned) {
        api(base + '/items/' + item.id + '/pin', { method: 'POST', body: { pinned: pinned } }).then(function (res) {
            if (res.ok) { onItemUpdated(res.body); toast(pinned ? 'Pinned' : 'Unpinned'); }
            else if (res.status === 401) locked();
            else toast((res.body && res.body.error) || 'Could not do that.', true);
        });
    }

    // Edit a note in place: the title and text become fields, Save sends them, Cancel goes back
    function editNote(item) {
        state.editingId = item.id;
        var actions = $('detailActions');
        var body = $('detailBody');
        actions.textContent = '';
        body.textContent = '';
        var form = make('form', 'edit-form');
        var title = make('input');
        title.type = 'text';
        title.maxLength = 150;
        title.placeholder = 'Title (Optional)';
        title.value = item.hasTitle ? item.title : '';
        title.setAttribute('aria-label', 'Title (optional)');
        var text = make('textarea');
        text.value = item.text;
        text.setAttribute('aria-label', 'Note');
        var error = make('small', 'field-error');
        error.setAttribute('role', 'alert');
        form.appendChild(title);
        form.appendChild(text);
        form.appendChild(error);
        body.appendChild(form);

        function leave() {
            state.editingId = null;
            var current = findItem(item.id);
            if (current && state.selectedId === item.id) renderDetail(current); else showSomethingElse(0);
        }
        var save = button('Save', 'primary', function () { form.requestSubmit(); });
        actions.appendChild(save);
        actions.appendChild(button('Cancel', 'ghost', leave));
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            error.textContent = '';
            if (!text.value.trim()) { error.textContent = 'A note cannot be empty.'; text.focus(); return; }
            save.disabled = true;
            api(base + '/items/' + item.id, { method: 'PUT', body: { title: title.value, text: text.value } }).then(function (res) {
                save.disabled = false;
                if (res.ok) {
                    state.editingId = null;
                    onItemUpdated(res.body); // also shows the saved note in the pane
                    toast('Saved');
                } else if (res.status === 401) {
                    locked();
                } else if (res.status === 404) {
                    error.textContent = 'That note is gone.';
                } else {
                    error.textContent = (res.body && res.body.error) || 'Could not save.';
                }
            }).catch(function () { save.disabled = false; error.textContent = 'Could not reach the server.'; });
        });
        form.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); }
            else if (event.key === 'Escape') { event.preventDefault(); leave(); }
        });
        text.focus();
    }

    function onItemDeleted(id) {
        if (state.editingId === id) state.editingId = null;
        var index = state.items.findIndex(function (item) { return item.id === id; });
        state.items = state.items.filter(function (item) { return item.id !== id; });
        var el = document.querySelector('.clip[data-id="' + id + '"]');
        if (el) el.remove();
        updateCounts();
        // A note that was just revealed stays on screen (its text is no longer anywhere else) until another clip is opened
        if (state.selectedId === id && state.revealedId !== id) showSomethingElse(index);
    }

    function connect() {
        // A drop-box visitor cannot read, so there is nothing to follow live
        if (state.es || !window.EventSource || role() === 'drop') return;
        var es = new EventSource(base + '/events');
        state.es = es;
        es.onopen = function () {
            $('liveStatus').classList.remove('hidden');
            // After a dropped connection, catch up on anything missed
            if (state.connectedOnce) load(true);
            state.connectedOnce = true;
        };
        es.onerror = function () {
            $('liveStatus').classList.add('hidden');
            $('presenceChip').classList.add('hidden');
            // A refused stream (locked or gone) is not retried by the browser: find out which
            if (es.readyState === EventSource.CLOSED) {
                state.es = null;
                state.connectedOnce = false;
                load(true);
            }
        };
        es.addEventListener('item-added', function (event) {
            var item = JSON.parse(event.data);
            var known = state.items.some(function (existing) { return existing.id === item.id; });
            var origin = item.origin;
            delete item.origin;
            onItemAdded(item);
            // From another device (not this page's own add): the opt-in extras
            if (!known && origin !== tabId) onIncoming(item);
        });
        es.addEventListener('item-updated', function (event) { onItemUpdated(JSON.parse(event.data)); });
        es.addEventListener('items-reordered', function (event) { applyOrders(JSON.parse(event.data).orders); });
        es.addEventListener('presence', function (event) { showPresence(JSON.parse(event.data).count); });
        es.addEventListener('item-deleted', function (event) { onItemDeleted(JSON.parse(event.data).id); });
        es.addEventListener('stash-extended', function (event) {
            if (state.stash) { state.stash.expiresAt = JSON.parse(event.data).expiresAt; updateExpiry(); }
        });
        es.addEventListener('stash-gone', gone);
        // Someone changed what the stash takes
        es.addEventListener('content-changed', function (event) {
            if (!state.stash) return;
            state.stash.content = JSON.parse(event.data).content;
            applyContent();
        });
        // The stash was renamed (by someone else, or by this page, which moves itself): follow it to the new address
        es.addEventListener('stash-renamed', function (event) {
            var data = {};
            try { data = JSON.parse(event.data); } catch (e) { /* no details */ }
            if (!data.slug || (data.origin && data.origin === tabId)) return;
            if (window.StashlyRenamed) window.StashlyRenamed(slug, data.slug);
            location.replace('/s/' + encodeURIComponent(data.slug));
        });
        // The stash's password was changed: this page's sign-in is no longer good, so ask again. (Not when this very
        // page changed it: it was given a new sign-in with the answer.)
        es.addEventListener('access-changed', function (event) {
            var data = {};
            try { data = JSON.parse(event.data); } catch (e) { /* no details */ }
            if (data.origin && data.origin === tabId) return;
            closeStream();
            load(true);
        });
    }

    // ---- actions ----

    function removeItem(item) {
        api(base + '/items/' + item.id, { method: 'DELETE' }).then(function (res) {
            if (res.ok || res.status === 404) onItemDeleted(item.id);
            else if (res.status === 401) locked();
            else toast('Could not delete that.', true);
        });
    }

    $('composer').addEventListener('submit', function (event) {
        event.preventDefault();
        if (stashContent() === 'files') return;
        var input = $('noteInput');
        var error = $('noteError');
        error.textContent = '';
        var text = input.value;
        if (!text.trim()) { error.textContent = 'Write something first.'; input.focus(); return; }
        var submit = $('addNoteButton');
        submit.disabled = true;
        var note = {
            title: $('titleInput').value,
            text: text,
            burn: $('burnInput').checked,
            secret: $('secretInput').checked,
            expires: $('itemTtlSelect').value,
        };
        api(base + '/notes', { method: 'POST', body: note }).then(function (res) {
            submit.disabled = false;
            if (res.ok) {
                input.value = '';
                $('titleInput').value = '';
                // The options are for one note: the next one starts plain
                $('burnInput').checked = false;
                $('secretInput').checked = false;
                $('itemTtlSelect').value = '';
                onItemAdded(res.body);
                toast('Note added');
                input.focus();
            } else if (res.status === 401) {
                locked();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not add the note.';
            }
        }).catch(function () {
            submit.disabled = false;
            error.textContent = 'Could not reach the server.';
        });
    });

    $('noteInput').addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            $('composer').requestSubmit();
        }
    });
    $('titleInput').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); $('noteInput').focus(); }
    });

    // The composer is always there but small. The expand button opens a bigger note box with the title and a drop zone.
    function setExpanded(expanded) {
        $('composer').classList.toggle('expanded', expanded);
        var button = $('expandButton');
        button.setAttribute('aria-expanded', String(expanded));
        button.title = expanded ? 'Make smaller' : 'Expand';
        button.setAttribute('aria-label', button.title);
        // A size dragged by hand applies to the size it was dragged in; switching starts from the default again
        $('noteInput').style.height = '';
        if (expanded) $('titleInput').focus();
    }
    $('expandButton').addEventListener('click', function () {
        setExpanded(!$('composer').classList.contains('expanded'));
    });

    $('unlockForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('unlockError');
        error.textContent = '';
        var password = $('unlockInput').value;
        if (!password) { error.textContent = 'Enter the password.'; return; }
        $('unlockButton').disabled = true;
        api(base + '/unlock', { method: 'POST', body: { password: password, session: $('sessionSelect').value } }).then(function (res) {
            $('unlockButton').disabled = false;
            if (res.ok) {
                $('unlockInput').value = '';
                load();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not unlock.';
                $('unlockInput').select();
            }
        }).catch(function () {
            $('unlockButton').disabled = false;
            error.textContent = 'Could not reach the server.';
        });
    });

    $('copyLinkButton').addEventListener('click', function () {
        Promise.resolve(copyText(location.href)).then(function (ok) {
            toast(ok ? 'Link copied' : 'Could not copy the link.', !ok);
        });
    });

    // ---- QR code: open this stash on a phone or another device ----

    function isLocalHost(host) {
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /\.localhost$/.test(host);
    }

    function showQr() {
        var url = location.origin + location.pathname;
        var qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        $('qrImage').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
        $('qrLink').textContent = url;
        // A phone can't reach "localhost": that is the computer showing this page
        var warn = $('qrWarn');
        var local = isLocalHost(location.hostname);
        warn.classList.toggle('hidden', !local);
        warn.textContent = local
            ? "This address only works on this computer. Open Stashly with the computer's network address or its domain name (not localhost), then show the code again."
            : '';
        $('qrLockNote').classList.toggle('hidden', !(state.stash && state.stash.hasPassword));
        var dialog = $('qrDialog');
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    $('qrButton').addEventListener('click', showQr);
    $('qrClose').addEventListener('click', function () { $('qrDialog').close(); });
    $('qrCopy').addEventListener('click', function () {
        Promise.resolve(copyText($('qrLink').textContent)).then(function (ok) {
            toast(ok ? 'Link copied' : 'Could not copy the link.', !ok);
        });
    });
    // A click on the dimmed backdrop closes it
    $('qrDialog').addEventListener('click', function (event) {
        if (event.target === event.currentTarget) event.currentTarget.close();
    });

    $('extendButton').addEventListener('click', function () {
        api(base + '/extend', { method: 'POST' }).then(function (res) {
            if (res.ok) {
                state.stash.expiresAt = res.body.expiresAt;
                updateExpiry();
                toast('Extended. ' + expiryText(res.body.expiresAt));
            } else {
                toast((res.body && res.body.error) || 'Could not extend.', true);
            }
        });
    });

    // Renaming the stash (full access only). The address changes, so this page moves to the new one when it is done.
    var renameForm = $('renameForm');
    function closeRenameForm() {
        renameForm.classList.add('hidden');
        renameForm.reset();
        $('renameError').textContent = '';
        $('renameToggle').classList.remove('hidden');
    }
    $('renameCurrent').textContent = slug;
    $('renameToggle').addEventListener('click', function (event) {
        renameForm.classList.remove('hidden');
        event.currentTarget.classList.add('hidden');
        $('renameInput').value = slug;
        $('renameInput').focus();
        $('renameInput').select();
    });
    $('renameCancel').addEventListener('click', closeRenameForm);
    renameForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('renameError');
        error.textContent = '';
        var next = $('renameInput').value.trim().toLowerCase();
        if (!next) { error.textContent = 'A stash name is required.'; return; }
        if (next === slug) { error.textContent = 'That is already the name of this stash.'; return; }
        if (!/^[a-z0-9_-]+$/.test(next)) { error.textContent = 'Use only letters, numbers, dashes and underscores.'; return; }
        $('renameSave').disabled = true;
        api(base + '/rename', { method: 'POST', body: { slug: next } }).then(function (res) {
            $('renameSave').disabled = false;
            if (res.ok) {
                if (window.StashlyRenamed) window.StashlyRenamed(slug, res.body.slug);
                // Move to the new address: the old one no longer exists
                location.replace(res.body.url);
            } else if (res.status === 401) {
                $('optionsDialog').close();
                locked();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not rename the stash.';
            }
        }).catch(function () { $('renameSave').disabled = false; error.textContent = 'Could not reach the server.'; });
    });

    // Deleting the stash lives in Options, and needs the stash's name typed in, so it cannot happen by accident
    var deleteForm = $('deleteStashForm');
    function closeDeleteForm() {
        deleteForm.classList.add('hidden');
        deleteForm.reset();
        $('deleteStashConfirm').disabled = true;
        $('deleteStashButton').classList.remove('hidden');
    }
    $('deleteStashSlug').textContent = slug;
    $('deleteStashButton').addEventListener('click', function (event) {
        deleteForm.classList.remove('hidden');
        event.currentTarget.classList.add('hidden');
        $('deleteStashName').focus();
    });
    $('deleteStashCancel').addEventListener('click', closeDeleteForm);
    $('deleteStashName').addEventListener('input', function (event) {
        $('deleteStashConfirm').disabled = event.target.value.trim().toLowerCase() !== slug;
    });
    deleteForm.addEventListener('submit', function (event) {
        event.preventDefault();
        if ($('deleteStashName').value.trim().toLowerCase() !== slug) return;
        $('deleteStashConfirm').disabled = true;
        api(base, { method: 'DELETE' }).then(function (res) {
            if (res.ok) {
                closeDeleteForm();
                $('optionsDialog').close();
                gone();
            } else if (res.status === 401) {
                $('optionsDialog').close();
                locked();
            } else {
                $('deleteStashConfirm').disabled = false;
                toast((res.body && res.body.error) || 'Could not delete the stash.', true);
            }
        }).catch(function () { $('deleteStashConfirm').disabled = false; toast('Could not reach the server.', true); });
    });

    // ---- signing out ----

    function untilText(iso) {
        var ms = new Date(iso).getTime() - Date.now();
        if (ms <= 0) return 'now';
        var minutes = Math.ceil(ms / 60000);
        if (minutes < 60) return 'in ' + minutes + ' min';
        var hours = Math.floor(minutes / 60);
        // Days for the long sessions, so it reads "in 6 d 23 h" and not "in 167 h"
        if (hours >= 24) return 'in ' + Math.floor(hours / 24) + ' d ' + (hours % 24) + ' h';
        return 'in ' + hours + ' h ' + (minutes % 60) + ' min';
    }

    // The button's hint and the Options text say when this browser is signed out
    function updateSessionInfo() {
        var stash = state.stash;
        if (!stash) return;
        var end = stash.hasPassword && stash.sessionEndsAt;
        $('logoutButton').title = end ? 'Log out of this stash. You are signed out ' + untilText(end) + ' anyway.' : 'Leave this stash';
        $('sessionInfo').textContent = end ? 'Signed in until ' + new Date(end).toLocaleString() + ' (' + untilText(end) + ').' : '';
        // The sign-in ran out while the page was open: ask for the password again
        if (end && new Date(end).getTime() <= Date.now()) load(true);
    }

    // "Log out" clears this browser's sign-in for the stash and goes home. An open stash has nothing to clear: Exit just goes home.
    function leaveStash() {
        // Logging out or exiting is leaving on purpose: the installed app should start at home next time
        if (window.StashlyLast) window.StashlyLast.clear(slug);
        if (!state.stash || !state.stash.hasPassword) { location.href = '/'; return; }
        api(base + '/logout', { method: 'POST' }).then(function () { location.href = '/'; }).catch(function () { location.href = '/'; });
    }
    $('logoutButton').addEventListener('click', leaveStash);
    $('logoutNow').addEventListener('click', leaveStash);

    // Change the stash's password. Whoever knows the current one is the owner, so it is asked for again here.
    var passwordForm = $('changePasswordForm');
    function closePasswordForm() {
        passwordForm.classList.add('hidden');
        passwordForm.reset();
        $('changePasswordError').textContent = '';
        $('changePasswordToggle').classList.remove('hidden');
    }
    $('changePasswordToggle').addEventListener('click', function (event) {
        passwordForm.classList.remove('hidden');
        event.currentTarget.classList.add('hidden');
        $('currentPasswordInput').focus();
    });
    $('changePasswordCancel').addEventListener('click', closePasswordForm);
    passwordForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('changePasswordError');
        error.textContent = '';
        var current = $('currentPasswordInput').value;
        var next = $('newPasswordInput').value;
        if (!current) { error.textContent = 'Enter the current password.'; $('currentPasswordInput').focus(); return; }
        var minPassword = state.minPassword || 10;
        if (next.length < minPassword) { error.textContent = 'The new password must be at least ' + minPassword + ' characters.'; $('newPasswordInput').focus(); return; }
        if (next !== $('repeatPasswordInput').value) { error.textContent = 'The two new passwords do not match.'; $('repeatPasswordInput').focus(); return; }
        $('changePasswordSave').disabled = true;
        api(base + '/password', { method: 'POST', body: { currentPassword: current, newPassword: next } }).then(function (res) {
            $('changePasswordSave').disabled = false;
            if (res.ok) {
                state.stash.sessionEndsAt = res.body.sessionEndsAt;
                // The stash had share links; they were cancelled with the old password
                if (state.stash.shareLinks) state.stash.shareLinks = { view: false, drop: false };
                closePasswordForm();
                updateSessionInfo();
                toast('Password changed. Everyone else was signed out.');
            } else if (res.status === 401 && res.body && res.body.field !== 'currentPassword') {
                locked();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not change the password.';
                if (res.status === 401) { $('currentPasswordInput').select(); }
            }
        }).catch(function () { $('changePasswordSave').disabled = false; error.textContent = 'Could not reach the server.'; });
    });

    // ---- options: what to do with items that arrive from other devices, and how many to keep ----
    // Auto-copy and notifications are per tab (kept for this tab only, and off until you turn them on).

    function tabFlag(name) {
        try { return sessionStorage.getItem('sl_' + name + ':' + slug) === '1'; } catch (e) { return false; }
    }
    function setTabFlag(name, on) {
        try { sessionStorage.setItem('sl_' + name + ':' + slug, on ? '1' : '0'); } catch (e) { /* only lasts until reload then */ }
    }
    // Notifications need a secure page (https or localhost)
    function notificationsReady() { return 'Notification' in window && window.isSecureContext; }

    state.autoCopy = tabFlag('autocopy');
    state.notify = tabFlag('notify') && notificationsReady() && Notification.permission === 'granted';

    function oneLine(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

    // The browser only lets a page write to the clipboard while it is in front, so a note that arrives while the tab
    // is in the background waits and is copied the moment you come back.
    function autoCopyNote(text) {
        Promise.resolve(copyText(text)).then(function (ok) {
            if (ok) { state.pendingCopy = null; toast('Copied the new note'); } else { state.pendingCopy = text; }
        });
    }
    window.addEventListener('focus', function () {
        if (!state.pendingCopy) return;
        var text = state.pendingCopy;
        state.pendingCopy = null;
        autoCopyNote(text);
    });

    function notifyItem(item) {
        if (!notificationsReady() || Notification.permission !== 'granted') return;
        // Only when you are not looking at this tab
        if (document.visibilityState === 'visible' && document.hasFocus()) return;
        var body = item.kind === 'file' ? 'New file: ' + item.fileName
            : item.burn ? 'A new burn-after-reading note'
            : item.secret ? 'A new secret note'
            : (item.hasTitle ? item.title + ': ' : '') + oneLine(item.text).slice(0, 100);
        try {
            var note = new Notification('Stashly · ' + slug, { body: body, tag: 'stashly-' + slug, icon: '/icons/icon-192.png' });
            note.onclick = function () { window.focus(); note.close(); };
        } catch (e) { /* some phone browsers only allow notifications through a service worker */ }
    }

    // A note or file that came from another device
    function onIncoming(item) {
        // Secret notes are left alone: auto-copying would put them in the system's clipboard history (and its cloud sync)
        if (state.autoCopy && item.kind === 'note' && !item.burn && !item.secret && item.text) autoCopyNote(item.text);
        if (state.notify) notifyItem(item);
    }

    function showPresence(count) {
        var chip = $('presenceChip');
        setChip(chip, count + ' connected', String(count), PEOPLE_ICON);
        chip.classList.remove('hidden');
    }

    var optionsDialog = $('optionsDialog');
    var NOTIFY_HINT = $('notifyHint').textContent;
    var KEEP_CHOICES = [5, 10, 20, 50, 100, 200, 500];

    function renderOptions() {
        // Start with the delete confirmation closed, so it always has to be asked for again
        closeDeleteForm();
        var protectedStash = Boolean(state.stash && state.stash.hasPassword);
        document.querySelector('[data-option="session"]').classList.toggle('hidden', !protectedStash);
        // The dialog sits outside the page section that carries the role classes, so the rows are hidden here. Only
        // someone with full access can keep-last, delete the stash or change the password.
        var full = role() === 'full';
        document.querySelector('[data-option="keep"]').classList.toggle('hidden', !full);
        document.querySelector('[data-option="danger"]').classList.toggle('hidden', !full);
        document.querySelector('[data-option="rename"]').classList.toggle('hidden', !full);
        document.querySelector('[data-option="content"]').classList.toggle('hidden', !full);
        Array.prototype.forEach.call(document.querySelectorAll('input[name="stashContent"]'), function (input) {
            input.checked = input.value === stashContent();
        });
        closeRenameForm();
        closePasswordForm();
        $('changePasswordToggle').classList.toggle('hidden', role() !== 'full');
        if (protectedStash) {
            updateSessionInfo();
            var change = $('sessionChange');
            change.textContent = '';
            var keep = make('option', null, 'choose...');
            keep.value = '';
            change.appendChild(keep);
            state.sessionOptions.forEach(function (option) { var el = make('option', null, option.label); el.value = option.key; change.appendChild(el); });
        }
        $('autoCopyInput').checked = state.autoCopy;
        var ready = notificationsReady();
        var denied = ready && Notification.permission === 'denied';
        $('notifyInput').checked = state.notify;
        $('notifyInput').disabled = !ready || denied;
        $('notifyHint').textContent = !ready ? 'Notifications need a secure address (https or localhost), so they are off here.'
            : denied ? 'Notifications are blocked for this site in the browser settings.' : NOTIFY_HINT;
        var current = state.stash && state.stash.keepLast;
        var choices = KEEP_CHOICES.slice();
        if (current && choices.indexOf(current) === -1) { choices.push(current); choices.sort(function (a, b) { return a - b; }); }
        var select = $('keepSelect');
        select.textContent = '';
        var all = make('option', null, 'everything (no limit)');
        all.value = '';
        select.appendChild(all);
        choices.forEach(function (n) { var el = make('option', null, n + ' items'); el.value = String(n); select.appendChild(el); });
        select.value = current ? String(current) : '';
        updateOptionTabs();
    }

    // ---- the tabs in Options ----

    var optionTabs = Array.prototype.slice.call(document.querySelectorAll('.opt-tab'));
    var optionTab = null;

    function panelOf(tab) { return $('optPanel-' + tab.dataset.tab); }

    // A tab is shown only when its panel has something for this visitor; the last one picked stays picked
    function updateOptionTabs() {
        optionTabs.forEach(function (tab) {
            var rows = panelOf(tab).querySelectorAll('.share-row');
            var any = Array.prototype.some.call(rows, function (row) { return !row.classList.contains('hidden'); });
            tab.classList.toggle('hidden', !any);
        });
        var visible = optionTabs.filter(function (tab) { return !tab.classList.contains('hidden'); });
        var pick = visible.filter(function (tab) { return tab.dataset.tab === optionTab; })[0] || visible[0];
        if (pick) selectOptionTab(pick, false);
    }

    function selectOptionTab(tab, focus) {
        optionTab = tab.dataset.tab;
        optionTabs.forEach(function (other) {
            var on = other === tab;
            other.setAttribute('aria-selected', on ? 'true' : 'false');
            other.tabIndex = on ? 0 : -1;
            panelOf(other).classList.toggle('hidden', !on);
        });
        if (focus) tab.focus();
    }

    optionTabs.forEach(function (tab) {
        tab.addEventListener('click', function () { selectOptionTab(tab, false); });
        // Arrow keys move between the tabs, Home and End go to the first and last
        tab.addEventListener('keydown', function (event) {
            var visible = optionTabs.filter(function (other) { return !other.classList.contains('hidden'); });
            var index = visible.indexOf(tab);
            var next = null;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = visible[(index + 1) % visible.length];
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = visible[(index - 1 + visible.length) % visible.length];
            else if (event.key === 'Home') next = visible[0];
            else if (event.key === 'End') next = visible[visible.length - 1];
            if (!next) return;
            event.preventDefault();
            selectOptionTab(next, true);
        });
    });

    // What the stash can hold
    var CONTENT_WORDS = { all: 'This stash takes notes and files', notes: 'This stash now takes notes only', files: 'This stash now takes files only' };
    Array.prototype.forEach.call(document.querySelectorAll('input[name="stashContent"]'), function (input) {
        input.addEventListener('change', function () {
            if (!input.checked) return;
            var previous = stashContent();
            api(base + '/content', { method: 'PUT', body: { content: input.value } }).then(function (res) {
                if (res.ok) {
                    state.stash.content = res.body.content;
                    applyContent();
                    toast(CONTENT_WORDS[res.body.content]);
                } else {
                    restoreContentChoice(previous);
                    toast((res.body && res.body.error) || 'Could not change that.', true);
                }
            }, function () {
                restoreContentChoice(previous);
                toast('Could not reach the server.', true);
            });
        });
    });

    function restoreContentChoice(value) {
        Array.prototype.forEach.call(document.querySelectorAll('input[name="stashContent"]'), function (input) {
            input.checked = input.value === value;
        });
    }

    $('optionsButton').addEventListener('click', function () {
        renderOptions();
        if (typeof optionsDialog.showModal === 'function') optionsDialog.showModal(); else optionsDialog.setAttribute('open', '');
    });
    $('optionsClose').addEventListener('click', function () { optionsDialog.close(); });
    optionsDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });

    $('autoCopyInput').addEventListener('change', function (event) {
        state.autoCopy = event.target.checked;
        setTabFlag('autocopy', state.autoCopy);
        if (!state.autoCopy) state.pendingCopy = null;
        toast(state.autoCopy ? 'New notes from other devices will be copied' : 'Auto-copy is off');
    });

    $('notifyInput').addEventListener('change', function (event) {
        var box = event.target;
        if (!box.checked) { state.notify = false; setTabFlag('notify', false); return; }
        // Asking for permission has to come from a click, which this is
        Promise.resolve(Notification.requestPermission()).then(function (permission) {
            state.notify = permission === 'granted';
            box.checked = state.notify;
            setTabFlag('notify', state.notify);
            if (!state.notify) { toast('Notifications were not allowed', true); renderOptions(); }
        });
    });

    $('sessionChange').addEventListener('change', function (event) {
        var select = event.target;
        if (!select.value) return;
        api(base + '/session', { method: 'POST', body: { session: select.value } }).then(function (res) {
            select.value = '';
            if (res.ok) {
                state.stash.sessionEndsAt = res.body.sessionEndsAt;
                updateSessionInfo();
                toast(res.body.capped
                    ? 'A sign-in lasts at most 30 days, so you will be signed out ' + untilText(res.body.sessionEndsAt) + '. Unlock again to start a new one.'
                    : 'You will be signed out ' + untilText(res.body.sessionEndsAt));
            } else if (res.status === 401) {
                locked();
            } else {
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        });
    });

    // Ends every other sign-in to this stash (and sessions opened from share links); this browser stays signed in
    $('signOutOthers').addEventListener('click', function () {
        if (!window.confirm('Sign out every other browser and device from this stash? They will need the password again. Read-only and drop-box links keep working; cancel them under Share links if you need to.')) return;
        var button = $('signOutOthers');
        button.disabled = true;
        api(base + '/sign-out-others', { method: 'POST' }).then(function (res) {
            button.disabled = false;
            if (res.ok) {
                state.stash.sessionEndsAt = res.body.sessionEndsAt;
                updateSessionInfo();
                toast('Every other device was signed out');
            } else if (res.status === 401) {
                locked();
            } else {
                toast((res.body && res.body.error) || 'Could not sign the others out.', true);
            }
        }).catch(function () {
            button.disabled = false;
            toast('Could not reach the server.', true);
        });
    });

    $('keepSelect').addEventListener('change', function (event) {
        var select = event.target;
        var keep = select.value ? Number(select.value) : null;
        var previous = state.stash.keepLast || null;
        var unpinned = state.items.filter(function (item) { return !item.pinned; }).length;
        if (keep && unpinned > keep && !window.confirm('This deletes the oldest unpinned items now, keeping the newest ' + keep + '. Continue?')) {
            select.value = previous ? String(previous) : '';
            return;
        }
        api(base + '/keep-last', { method: 'PUT', body: { keepLast: keep } }).then(function (res) {
            if (res.ok) {
                state.stash.keepLast = keep;
                toast(keep ? 'Keeping the last ' + keep + (res.body.removed ? '. Removed ' + res.body.removed + '.' : '') : 'Keeping everything');
            } else {
                select.value = previous ? String(previous) : '';
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        });
    });

    // ---- share links: a read-only link and a drop-box link, for a password-protected stash ----

    var shareDialog = $('shareDialog');
    var shareUrls = { view: '', drop: '' }; // a link is only known right after it is made

    function renderShare() {
        var links = (state.stash && state.stash.shareLinks) || { view: false, drop: false };
        Array.prototype.forEach.call(shareDialog.querySelectorAll('.share-row'), function (row) {
            var kind = row.dataset.kind;
            var exists = Boolean(links[kind]);
            var url = shareUrls[kind];
            row.querySelector('[data-state]').textContent = !exists
                ? 'No link yet.'
                : url ? 'Link is on. Copy it now: it is not shown again.' : 'A link exists. It is only shown when it is made; make a new one to get a fresh link (the old one stops working).';
            var code = row.querySelector('[data-url]');
            code.textContent = url;
            code.classList.toggle('hidden', !url);
            row.querySelector('[data-make]').textContent = exists ? 'Make a new link' : 'Make link';
            row.querySelector('[data-copy]').classList.toggle('hidden', !url);
            row.querySelector('[data-revoke]').classList.toggle('hidden', !exists);
        });
    }

    Array.prototype.forEach.call(shareDialog.querySelectorAll('.share-row'), function (row) {
        var kind = row.dataset.kind;
        row.querySelector('[data-make]').addEventListener('click', function () {
            var links = state.stash.shareLinks || {};
            if (links[kind] && !window.confirm('Make a new link? The old one stops working.')) return;
            api(base + '/share-links', { method: 'POST', body: { kind: kind } }).then(function (res) {
                if (!res.ok) { toast((res.body && res.body.error) || 'Could not make the link.', true); return; }
                shareUrls[kind] = location.origin + res.body.path;
                state.stash.shareLinks = state.stash.shareLinks || { view: false, drop: false };
                state.stash.shareLinks[kind] = true;
                renderShare();
            });
        });
        row.querySelector('[data-copy]').addEventListener('click', function () {
            Promise.resolve(copyText(shareUrls[kind])).then(function (ok) { toast(ok ? 'Link copied' : 'Could not copy the link.', !ok); });
        });
        row.querySelector('[data-revoke]').addEventListener('click', function () {
            api(base + '/share-links/' + kind, { method: 'DELETE' }).then(function (res) {
                if (!res.ok) { toast((res.body && res.body.error) || 'Could not cancel the link.', true); return; }
                shareUrls[kind] = '';
                state.stash.shareLinks[kind] = false;
                renderShare();
                toast('Link cancelled');
            });
        });
    });

    $('shareButton').addEventListener('click', function () {
        renderShare();
        if (typeof shareDialog.showModal === 'function') shareDialog.showModal(); else shareDialog.setAttribute('open', '');
    });
    $('shareClose').addEventListener('click', function () { shareDialog.close(); });
    shareDialog.addEventListener('close', function () { shareUrls = { view: '', drop: '' }; });
    shareDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });

    // A share link is /s/name#view=KEY or #drop=KEY. The key is traded for a cookie, then taken out of the address
    // bar, so it is not left in the history or on screen.
    function redeemFromHash() {
        var match = /^#(view|drop)=([A-Za-z0-9_-]{16,})$/.exec(location.hash);
        if (!match) return Promise.resolve();
        return api(base + '/redeem', { method: 'POST', body: { token: match[2] } }).then(function (res) {
            history.replaceState(null, '', location.pathname + location.search);
            if (!res.ok) toast((res.body && res.body.error) || 'That link is not valid any more.', true);
        }).catch(function () { /* the stash page below shows what is wrong */ });
    }

    // ---- search and date range ----

    function applyFilters() {
        var next = {
            search: $('searchInput').value.trim(),
            startDate: $('startDate').value,
            endDate: $('endDate').value,
        };
        if (next.startDate && next.endDate && next.startDate > next.endDate) {
            toast('The From date is after the To date.', true);
            return;
        }
        state.filters = next;
        load();
    }

    var searchTimer;
    $('searchInput').addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyFilters, 300);
    });
    $('searchInput').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { clearTimeout(searchTimer); applyFilters(); }
    });
    $('filterToggle').addEventListener('click', function () {
        var panel = $('filterPanel');
        panel.classList.toggle('hidden');
        $('filterToggle').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
    });
    $('startDate').addEventListener('change', applyFilters);
    $('endDate').addEventListener('change', applyFilters);
    $('resetButton').addEventListener('click', function () {
        $('searchInput').value = '';
        $('startDate').value = '';
        $('endDate').value = '';
        applyFilters();
    });
    $('rangeChip').addEventListener('click', function () {
        $('startDate').value = '';
        $('endDate').value = '';
        applyFilters();
    });
    $('refreshButton').addEventListener('click', function () { load(); });

    // On a phone, Options and Log out move up into the top bar (next to Admin and Theme), so the row under the
    // stash name holds only the everyday buttons. On a wider screen they go back to the end of that row.
    (function placeTopButtons() {
        var phone = window.matchMedia('(max-width: 760px)');
        var moved = [$('logoutButton'), $('optionsButton')];
        function place() {
            var target = phone.matches ? document.querySelector('.sidebar-footer') : document.querySelector('.header-actions');
            if (phone.matches) moved.slice().reverse().forEach(function (el) { target.insertBefore(el, target.firstChild); });
            else moved.forEach(function (el) { target.appendChild(el); });
            moved.forEach(function (el) { el.classList.toggle('in-topbar', phone.matches); });
        }
        place();
        if (phone.addEventListener) phone.addEventListener('change', place); else phone.addListener(place);
    })();

    // The eye button shows or hides the note lines under each title, for a shorter list or a screen others can
    // see. The choice is kept on this device only.
    var CONTENT_KEY = 'stashly.hideContent';
    function setContentHidden(hidden, save) {
        $('items').classList.toggle('hide-content', hidden);
        var toggle = $('contentToggle');
        toggle.setAttribute('aria-pressed', hidden ? 'false' : 'true');
        toggle.classList.toggle('active', hidden);
        toggle.title = hidden ? 'Show note content in the list' : 'Hide note content in the list';
        if (save) { try { localStorage.setItem(CONTENT_KEY, hidden ? '1' : '0'); } catch (e) { /* storage may be blocked */ } }
    }
    $('contentToggle').addEventListener('click', function () {
        var hidden = !$('items').classList.contains('hide-content');
        setContentHidden(hidden, true);
        toast(hidden ? 'Note content hidden in the list' : 'Note content shown in the list');
    });
    try { setContentHidden(localStorage.getItem(CONTENT_KEY) === '1', false); } catch (e) { setContentHidden(false, false); }

    // ---- uploads: picker, drop zone, drag and drop anywhere, paste ----

    var uploader = window.StashlyUpload.create({
        container: $('uploads'),
        url: base + '/files',
        maxBytes: 0,
        tabId: tabId,
        onDone: function (item) { if (item) onItemAdded(item); },
        onLocked: locked,
    });

    // Upload progress shows under the composer, which is always on the page
    function addFiles(files) {
        if (stashContent() === 'notes') { toast('This stash only takes notes, not files.', true); return; }
        uploader.add(files);
    }

    var dropZone = $('dropZone');
    function chooseFiles() { $('fileInput').click(); }
    $('attachButton').addEventListener('click', chooseFiles);
    dropZone.addEventListener('click', chooseFiles);
    dropZone.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseFiles(); }
    });
    $('fileInput').addEventListener('change', function (event) {
        addFiles(event.target.files);
        event.target.value = '';
    });

    function hasFiles(event) {
        return event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types || [], 'Files') !== -1;
    }

    var dragDepth = 0;
    var overlay = $('dropOverlay');
    function mainVisible() { return !sections.main.classList.contains('hidden'); }
    document.addEventListener('dragenter', function (event) {
        if (!mainVisible() || !hasFiles(event)) return;
        dragDepth++;
        overlay.classList.remove('hidden');
    });
    document.addEventListener('dragleave', function (event) {
        if (!hasFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) overlay.classList.add('hidden');
    });
    document.addEventListener('dragover', function (event) { if (hasFiles(event)) event.preventDefault(); });
    document.addEventListener('drop', function (event) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        overlay.classList.add('hidden');
        if (mainVisible()) addFiles(event.dataTransfer.files);
    });

    document.addEventListener('paste', function (event) {
        var files = event.clipboardData && event.clipboardData.files;
        if (!files || !files.length || !mainVisible()) return;
        event.preventDefault();
        addFiles(files);
    });

    // ---- resizable list and clip panes ----

    var LIST_MIN = 200;
    var LIST_KEY = 'stashly.listWidth';
    var split = $('split');
    var splitter = $('splitter');

    // The clip pane keeps at least 320px, and the list at least LIST_MIN
    function listLimits() {
        var total = split.clientWidth - 12;
        return { min: LIST_MIN, max: total > 0 ? Math.max(LIST_MIN, total - 320) : Infinity };
    }

    function setListWidth(px, save) {
        var limits = listLimits();
        var width = Math.round(Math.min(limits.max, Math.max(limits.min, px)));
        split.style.setProperty('--list-width', width + 'px');
        splitter.setAttribute('aria-valuemin', String(limits.min));
        splitter.setAttribute('aria-valuemax', String(limits.max));
        splitter.setAttribute('aria-valuenow', String(width));
        if (save) { try { localStorage.setItem(LIST_KEY, String(width)); } catch (e) { /* storage may be blocked */ } }
        return width;
    }

    function resetListWidth() {
        split.style.removeProperty('--list-width');
        try { localStorage.removeItem(LIST_KEY); } catch (e) { /* storage may be blocked */ }
        splitter.setAttribute('aria-valuenow', String(Math.round($('items').closest('.pane').getBoundingClientRect().width)));
    }

    splitter.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        split.classList.add('resizing');
    });
    splitter.addEventListener('pointermove', function (event) {
        if (!split.classList.contains('resizing')) return;
        setListWidth(event.clientX - split.getBoundingClientRect().left - 6, false);
    });
    function endDrag(event) {
        if (!split.classList.contains('resizing')) return;
        split.classList.remove('resizing');
        if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
        setListWidth($('items').closest('.pane').getBoundingClientRect().width, true);
    }
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
    splitter.addEventListener('dblclick', resetListWidth);
    splitter.addEventListener('keydown', function (event) {
        var current = $('items').closest('.pane').getBoundingClientRect().width;
        if (event.key === 'ArrowLeft') { event.preventDefault(); setListWidth(current - 24, true); }
        else if (event.key === 'ArrowRight') { event.preventDefault(); setListWidth(current + 24, true); }
        else if (event.key === 'Home' || event.key === 'Escape') { event.preventDefault(); resetListWidth(); }
    });
    window.addEventListener('resize', function () {
        var saved = split.style.getPropertyValue('--list-width');
        if (saved) setListWidth(parseInt(saved, 10), false);
    });
    try {
        var savedWidth = Number(localStorage.getItem(LIST_KEY));
        if (savedWidth) setListWidth(savedWidth, false);
    } catch (e) { /* storage may be blocked */ }

    // ---- start ----

    api('/api/config').then(function (res) {
        if (!res.ok) return;
        state.minPassword = Number(res.body.minPasswordLength) || 10;
        // How long to stay signed in: on the unlock form, and in Options to change it later
        var sessionOptions = res.body.sessionOptions || [];
        if (sessionOptions.length) {
            $('sessionSelect').textContent = '';
            sessionOptions.forEach(function (option) {
                var el = make('option', null, option.label);
                el.value = option.key;
                if (option.key === res.body.defaultSession) el.selected = true;
                $('sessionSelect').appendChild(el);
            });
            state.sessionOptions = sessionOptions;
        }
        (res.body.itemTtlOptions || []).forEach(function (option) {
            var el = make('option', null, option.label);
            el.value = option.key;
            $('itemTtlSelect').appendChild(el);
        });
        var max = res.body.limits.maxFileBytes;
        $('limitHint').textContent = 'Up to ' + window.StashlyUpload.formatSize(max) + ' per file. Images, PDF, Office files, zip, certificates and any text file.';
        uploader = window.StashlyUpload.create({
            container: $('uploads'),
            url: base + '/files',
            maxBytes: max,
            tabId: tabId,
            onDone: function (item) { if (item) onItemAdded(item); },
            onLocked: locked,
        });
    });

    setInterval(updateTimes, 15000);
    redeemFromHash().then(function () { load(); });
})();
