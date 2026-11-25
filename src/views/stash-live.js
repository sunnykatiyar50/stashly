// The stash page, part 6 of 9: live updates (Server-Sent Events) and what to do with items from other devices.
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var slug = P.slug;
    var base = P.base;
    var $ = P.$;
    var tabId = P.tabId;
    var state = P.state;
    var toast = P.toast;
    var copyText = P.copyText;
    var role = P.role;
    var PEOPLE_ICON = P.PEOPLE_ICON;
    var setChip = P.setChip;
    var oneLine = P.oneLine;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function buildClip() { return P.buildClip.apply(null, arguments); }
    function applyOrders() { return P.applyOrders.apply(null, arguments); }
    function updateCounts() { return P.updateCounts.apply(null, arguments); }
    function markSelected() { return P.markSelected.apply(null, arguments); }
    function renderItems() { return P.renderItems.apply(null, arguments); }
    function renderDetail() { return P.renderDetail.apply(null, arguments); }
    function applyContent() { return P.applyContent.apply(null, arguments); }
    function updateExpiry() { return P.updateExpiry.apply(null, arguments); }
    function load() { return P.load.apply(null, arguments); }
    function gone() { return P.gone.apply(null, arguments); }
    function sortItems() { return P.sortItems.apply(null, arguments); }
    function onItemDeleted() { return P.onItemDeleted.apply(null, arguments); }

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
    // Whether a clip carries every tag the list is filtered by (the tag chips and the #words typed in the search)
    function hasWantedTags(item) {
        var wanted = P.splitSearch(state.filters.search).tags.concat(state.filters.tags || []);
        return wanted.every(function (tag) { return (item.tags || []).indexOf(tag) !== -1; });
    }

    function matchesFilters(item) {
        var f = state.filters;
        // "#work" words in the search are tags, as on the server
        var typed = P.splitSearch(f.search);
        if (typed.text) {
            var hay = ((item.text || '') + ' ' + (item.fileName || '') + ' ' + (item.hasTitle ? item.title : '')).toLowerCase();
            if (hay.indexOf(typed.text.toLowerCase()) === -1) return false;
        }
        if (!hasWantedTags(item)) return false;
        var created = new Date(item.createdAt).getTime();
        if (f.startDate && created < localDayStart(f.startDate)) return false;
        if (f.endDate && created >= localDayStart(f.endDate) + 86400000) return false;
        return true;
    }

    // The same order the list is sorted in (see sortItems)
    function comesBefore(a, b) {
        if (a.pinned !== b.pinned) return a.pinned;
        if (a.order !== b.order) return a.order > b.order;
        return a.id > b.id;
    }

    // A new clip joins the top of the list. What is open on the right is left alone, so a clip
    // arriving from another machine never pulls the page away from what you are reading or typing.
    function onItemAdded(item) {
        if (state.items.some(function (existing) { return existing.id === item.id; })) return;
        if (!matchesFilters(item)) return;
        // One more match on the server (what "Show more (N left)" and the count are worked out from)
        state.total++;
        if (!placeLive(item, true)) updateCounts();
    }

    // Puts a clip arriving live into the loaded part of the list, at the place the list's own order gives it. Returns
    // false when it does not belong there: with more pages still on the server, a clip that sorts after every clip
    // loaded (an item brought back by Undo to a low place) is left out, because inserting it would hide the unloaded
    // clips between; it comes with its own page.
    function placeLive(item, isNew) {
        // Where it goes in the list's own order (pinned first, then by place, then newest). A new item has the highest
        // place, so it lands just below the pinned ones; an item brought back by Undo returns to the place it had.
        var at = 0;
        while (at < state.items.length && comesBefore(state.items[at], item)) at++;
        if (state.hasMore && at === state.items.length && state.items.length) return false;
        state.items.splice(at, 0, item);
        var el = buildClip(item);
        if (isNew) el.classList.add('new');
        var rows = $('items').querySelectorAll('.clip');
        $('items').insertBefore(el, rows[at] || null);
        updateCounts();
        markSelected();
        return true;
    }

    function onItemUpdated(item) {
        var index = state.items.findIndex(function (existing) { return existing.id === item.id; });
        // Not on the page: normally nothing to do. But with more pages on the server, a clip that was further down and
        // now sorts inside what is loaded (it was just pinned) joins the list, as the server's own list now has it there.
        if (index === -1) {
            if (state.hasMore && matchesFilters(item)) placeLive(item, false);
            return;
        }
        var before = state.items[index];
        var wasPinned = before.pinned;
        // A live update never carries who sent it
        delete item.origin;
        state.items[index] = item;
        if (P.syncTagCounts) P.syncTagCounts(before.tags, item.tags);
        // A clip that no longer carries the tags being filtered by leaves the list
        if (!hasWantedTags(item)) { onItemDeleted(item.id); return; }
        // Only its tags changed: the open clip's editor updates itself, redrawing the pane would drop what is being typed
        var onlyTags = before.title === item.title && before.pinned === item.pinned && before.editedAt === item.editedAt &&
            before.thumbUrl === item.thumbUrl && before.expiresAt === item.expiresAt && before.burn === item.burn && before.secret === item.secret &&
            JSON.stringify(before.tags || []) !== JSON.stringify(item.tags || []);
        if (wasPinned !== item.pinned) { sortItems(); renderItems(); } else {
            var el = document.querySelector('.clip[data-id="' + item.id + '"]');
            if (el) el.replaceWith(buildClip(item));
            markSelected();
        }
        // A thumbnail arriving changes nothing in the open clip (it shows the full image already): redrawing it would
        // only make the picture flash
        var onlyThumb = item.kind === 'file' && !before.thumbUrl && Boolean(item.thumbUrl) &&
            before.title === item.title && before.pinned === item.pinned && before.editedAt === item.editedAt;
        // The open clip shows the change, unless it is being edited right now (that would throw the typing away)
        if (onlyTags) { if (P.refreshTagEditor) P.refreshTagEditor(item); return; }
        if (!onlyThumb && state.selectedId === item.id && state.editingId !== item.id && state.revealedId !== item.id) renderDetail(item);
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

    // A notification body is plain text, so a title or a note that names an emoji (:rocket:) shows the emoji itself,
    // as the clip does. What is stored and copied is never changed.
    function emojiNames(text) {
        var markdown = window.StashlyMarkdown;
        return markdown && markdown.shortcodes ? markdown.shortcodes(text) : text;
    }

    // The first 100 characters of a note, never half of an emoji
    function clipText(text, limit) {
        var out = text.slice(0, limit);
        return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
    }

    function notifyItem(item) {
        if (!notificationsReady() || Notification.permission !== 'granted') return;
        // Only when you are not looking at this tab
        if (document.visibilityState === 'visible' && document.hasFocus()) return;
        var body = item.kind === 'file' ? 'New file: ' + emojiNames(item.fileName || '')
            : item.burn ? 'A new burn-after-reading note'
            : item.secret ? 'A new secret note'
            : (item.hasTitle ? emojiNames(item.title) + ': ' : '') + clipText(emojiNames(oneLine(item.text)), 100);
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

    // What the other parts use
    P.closeStream = closeStream;
    P.localDayStart = localDayStart;
    P.matchesFilters = matchesFilters;
    P.comesBefore = comesBefore;
    P.onItemAdded = onItemAdded;
    P.onItemUpdated = onItemUpdated;
    P.connect = connect;
    P.tabFlag = tabFlag;
    P.setTabFlag = setTabFlag;
    P.notificationsReady = notificationsReady;
    P.autoCopyNote = autoCopyNote;
    P.notifyItem = notifyItem;
    P.onIncoming = onIncoming;
    P.showPresence = showPresence;
})();
