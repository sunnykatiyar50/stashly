// The stash page, part 1 of 9: what the other parts share. It sets up window.StashlyPage (the slug, the
// state, the API call, small helpers and icons); each later script adds its own functions to it.
(function () {
    'use strict';

    var P = window.StashlyPage = {};

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

    // A short file type for the details line: the extension in capitals ("CSV", "PDF"), or the kind from the
    // file type when the name has none ("Text file", "Image")
    function fileKind(item) {
        var name = item.fileName || '';
        var dot = name.lastIndexOf('.');
        var ext = dot > 0 ? name.slice(dot + 1) : '';
        if (ext && ext.length <= 8 && /^[a-z0-9]+$/i.test(ext)) return ext.toUpperCase();
        var main = String(item.fileType || '').split('/')[0];
        return { text: 'Text file', image: 'Image', audio: 'Audio', video: 'Video' }[main] || 'File';
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
        el.classList.toggle('has-icon', Boolean(icon));
        if (icon) {
            el.appendChild(svg(icon));
            // On a phone only the icon shows, so the name is kept for hover and screen readers
            el.title = label;
            el.setAttribute('aria-label', label);
        }
        el.appendChild(make('span', 'btn-text', label));
    }

    var MASK = '••••••••';

    var PIN_ICON = '<svg viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>';

    var FLAME_ICON = '<svg viewBox="0 0 24 24"><path d="M12 22c4 0 7-2.7 7-7 0-3.5-2.2-6.2-4-8-.4 2-1.4 3.4-3 4 .3-3.3-1.2-6.4-4-9 0 4-5 6.7-5 13 0 4.3 4 7 9 7z"/></svg>';

    var EYE_OFF_ICON = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

    var GRIP_ICON = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';

    var COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

    var CHECK_ICON = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

    // 'full' can do everything. 'view' (a read-only link) cannot change anything. 'drop' (a drop-box link) can only add.
    function role() { return (state.stash && state.stash.role) || 'full'; }

    // What the stash takes: 'all', 'notes' or 'files'. The composer hides what cannot be added.
    function stashContent() { return (state.stash && state.stash.content) || 'all'; }

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

    function oneLine(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

    // What the other parts use
    P.slug = slug;
    P.base = base;
    P.$ = $;
    P.tabId = tabId;
    P.state = state;
    P.sections = sections;
    P.narrow = narrow;
    P.api = api;
    P.toast = toast;
    P.show = show;
    P.make = make;
    P.svg = svg;
    P.NOTE_ICON = NOTE_ICON;
    P.copyText = copyText;
    P.fallbackCopy = fallbackCopy;
    P.canCopyImage = canCopyImage;
    P.copyImage = copyImage;
    P.relativeTime = relativeTime;
    P.expiryText = expiryText;
    P.extensionOf = extensionOf;
    P.fileKind = fileKind;
    P.findItem = findItem;
    P.button = button;
    P.iconFor = iconFor;
    P.setLabel = setLabel;
    P.MASK = MASK;
    P.PIN_ICON = PIN_ICON;
    P.FLAME_ICON = FLAME_ICON;
    P.EYE_OFF_ICON = EYE_OFF_ICON;
    P.GRIP_ICON = GRIP_ICON;
    P.COPY_ICON = COPY_ICON;
    P.CHECK_ICON = CHECK_ICON;
    P.role = role;
    P.stashContent = stashContent;
    P.CLOCK_ICON = CLOCK_ICON;
    P.PEOPLE_ICON = PEOPLE_ICON;
    P.setChip = setChip;
    P.shortExpiry = shortExpiry;
    P.untilText = untilText;
    P.oneLine = oneLine;
})();
