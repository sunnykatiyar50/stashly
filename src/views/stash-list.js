// The stash page, part 2 of 9: the list of clips on the left: rows, dragging them into a new order, the counts,
// and the resizable panes.
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var base = P.base;
    var $ = P.$;
    var state = P.state;
    var api = P.api;
    var toast = P.toast;
    var make = P.make;
    var svg = P.svg;
    var NOTE_ICON = P.NOTE_ICON;
    var relativeTime = P.relativeTime;
    var expiryText = P.expiryText;
    var extensionOf = P.extensionOf;
    var findItem = P.findItem;
    var MASK = P.MASK;
    var PIN_ICON = P.PIN_ICON;
    var FLAME_ICON = P.FLAME_ICON;
    var EYE_OFF_ICON = P.EYE_OFF_ICON;
    var GRIP_ICON = P.GRIP_ICON;
    var CHECK_ICON = P.CHECK_ICON;
    var COPY_ICON = P.COPY_ICON;
    var role = P.role;
    var CLOCK_ICON = P.CLOCK_ICON;
    var shortExpiry = P.shortExpiry;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function copyItem() { return P.copyItem.apply(null, arguments); }
    function openItem() { return P.openItem.apply(null, arguments); }
    function load() { return P.load.apply(null, arguments); }
    function locked() { return P.locked.apply(null, arguments); }
    function setPinned() { return P.setPinned.apply(null, arguments); }
    function wantThumb() { return P.wantThumb.apply(null, arguments); }
    function loadMore() { return P.loadMore.apply(null, arguments); }
    function comesBefore() { return P.comesBefore.apply(null, arguments); }

    // An image without a thumbnail is only shown in the list as itself when it is small; a big one would be
    // downloaded in full just to draw 34 pixels
    var SMALL_IMAGE = 1024 * 1024;

    // A title can carry :rocket: names; they are shown as the emoji itself, like the note body (the stored title, the
    // edit box, Copy and search all keep what was typed)
    function titleText(value) {
        var markdown = window.StashlyMarkdown;
        return markdown && markdown.shortcodes ? markdown.shortcodes(value) : value;
    }

    // A note shows its title (the first 40 characters when it was not given one); a file shows its name
    function itemTitle(item) {
        if (item.kind !== 'note') return titleText(item.title || item.fileName);
        return titleText(item.title || '(empty note)');
    }

    // The properties of a clip, shown as small chips on the right of its row so they read as labels, not as content:
    // Pinned, Burns after reading, Secret, and a countdown when the note has its own expiry.
    // Each is shown as an icon, with its name on hover; the expiry also shows the time left in short ("3h 20m").
    function clipFlags(item) {
        var flags = [];
        // With full access the row's own pin button (filled in) already shows it, so the icon is only for the others
        if (item.pinned && role() !== 'full') flags.push({ text: 'Pinned', kind: 'pinned', icon: PIN_ICON });
        if (item.kind === 'note') {
            if (item.burn) flags.push({ text: 'Burns after reading', kind: 'burn', icon: FLAME_ICON });
            if (item.secret) flags.push({ text: 'Secret', kind: 'secret', icon: EYE_OFF_ICON });
            if (item.expiresAt) flags.push({ text: expiryText(item.expiresAt), kind: 'expiry', icon: CLOCK_ICON, expires: item.expiresAt });
        }
        return flags;
    }

    // The line under the title in the list: a few lines of the note, or the size of a file.
    // The note lines can be hidden in Options, under This device.
    function itemSub(item) {
        // A file with a title of its own also shows its real name
        if (item.kind !== 'note') return (item.hasTitle ? item.fileName + ' · ' : '') + window.StashlyUpload.formatSize(item.fileSize);
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
            if (state.selecting) {
                // Select mode: a tick box takes the place of the drag handle, and the whole row ticks it
                var picked = Boolean(state.picked[item.id]);
                el.classList.add('has-pick');
                el.classList.toggle('picked', picked);
                el.setAttribute('role', 'checkbox');
                el.setAttribute('aria-checked', String(picked));
                var tick = make('span', 'clip-pick');
                tick.setAttribute('aria-hidden', 'true');
                tick.appendChild(svg(CHECK_ICON));
                el.appendChild(tick);
            } else {
                var grip = make('span', 'clip-grip');
                grip.title = 'Drag to move. Or press Alt+Up or Alt+Down.';
                grip.setAttribute('aria-hidden', 'true');
                grip.appendChild(svg(GRIP_ICON));
                grip.addEventListener('pointerdown', function (event) { startDrag(event, el); });
                grip.addEventListener('click', function (event) { event.stopPropagation(); });
                el.appendChild(grip);
            }
        }

        var lead;
        if (item.isImage && (item.thumbUrl || item.fileSize <= SMALL_IMAGE)) {
            // The thumbnail when there is one. A small image with none is shown as it is (as before); a big one is not
            // loaded just for a 34 px picture, so it keeps its file icon until a thumbnail exists.
            lead = make('img', 'clip-thumb');
            lead.src = item.thumbUrl || item.url;
            lead.alt = '';
            lead.loading = 'lazy';
            if (item.thumbUrl) {
                // A thumbnail that cannot be loaded (gone from the disk) falls back to the file icon
                lead.addEventListener('error', function () { lead.replaceWith(make('span', 'file-icon', extensionOf(item.fileName))); }, { once: true });
            }
        } else if (item.kind === 'file') {
            lead = make('span', 'file-icon', extensionOf(item.fileName));
        } else {
            lead = make('span', 'clip-icon');
            lead.appendChild(svg(NOTE_ICON));
        }
        el.appendChild(lead);
        // An image that has no thumbnail yet (sent from curl, or made before thumbnails existed) gets one made by this
        // page the first time someone with full access sees it
        if (item.isImage && !item.thumbUrl) wantThumb(item, lead);

        var text = make('span', 'clip-text');
        // A note with no title of its own is titled with its first 40 characters (worked out by the server).
        // Secret and burn notes get a plain title, because their content must not show here.
        text.appendChild(make('span', 'clip-title', itemTitle(item)));
        var sub = itemSub(item);
        if (sub) text.appendChild(make('span', item.kind === 'note' ? 'clip-sub clip-preview' : 'clip-sub', sub));
        var flags = clipFlags(item);
        var flagLine = null;
        if (flags.length) {
            flagLine = make('span', 'clip-flags');
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
            var pinLabel = item.pinned ? 'Pinned. Click to unpin.' : 'Pin to the top';
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
                copyItem(item, copy);
            });
            quick.appendChild(copy);
        }
        // The property icons sit on the same line as the buttons, just before them
        if (flagLine) quick.insertBefore(flagLine, quick.firstChild);
        if (quick.children.length) side.appendChild(quick);
        el.appendChild(side);

        // In select mode a click ticks the row (Shift-click ticks a range) instead of opening the clip
        el.addEventListener('click', function (event) {
            if (state.selecting) P.togglePick(item.id, event.shiftKey); else openItem(item.id);
        });
        el.addEventListener('keydown', function (event) {
            if (event.target !== el) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (state.selecting) P.togglePick(item.id, event.shiftKey); else openItem(item.id);
            }
            // Alt+Up / Alt+Down moves the clip one place, for those not using a mouse
            if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && role() === 'full') {
                event.preventDefault();
                moveByKey(el, event.key === 'ArrowUp' ? -1 : 1);
            }
        });
        return el;
    }

    // Clips may only move among those with the same pinned state, so a drag never seems to pin or unpin one
    function sameGroup(a, b) {
        var x = findItem(Number(a.dataset.id));
        var y = findItem(Number(b.dataset.id));
        return Boolean(x && y && x.pinned === y.pinned);
    }

    // The ids of the rows, top to bottom (the "Show more" button at the end is not a row)
    function rowIds() {
        return Array.prototype.filter.call($('items').children, function (child) { return child.dataset.id; })
            .map(function (child) { return child.dataset.id; }).join(',');
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
        // Rows go before the "Show more" button, which stays at the end
        state.items.forEach(function (item) {
            var row = list.querySelector('.clip[data-id="' + item.id + '"]');
            if (row) list.insertBefore(row, moreButton && moreButton.parentNode === list ? moreButton : null);
        });
    }

    function filtersActive() {
        var f = state.filters;
        return Boolean(f.search || f.startDate || f.endDate);
    }

    // "37 clips", or while more are waiting on the server "100 of 250 clips". The total is what the server counted
    // when the list was last read, kept up to date by the clips added and removed here and by live events since.
    function updateCounts() {
        var n = state.items.length;
        var total = state.hasMore ? Math.max(state.total, n) : n;
        var noun = filtersActive() ? (total === 1 ? ' match' : ' matches') : total === 1 ? ' clip' : ' clips';
        $('itemInfo').textContent = (state.hasMore && total > n ? n + ' of ' + total : String(total)) + noun;
        var empty = $('emptyState');
        empty.classList.toggle('hidden', n > 0);
        empty.textContent = filtersActive()
            ? 'No clips match your search or dates.'
            : 'Nothing here yet. Add a note or drop a file.';
        $('filterToggle').classList.toggle('active', Boolean(state.filters.startDate || state.filters.endDate));
        updateMore();
        // Every change to the list passes here: clips that left it are dropped from the ticked ones
        if (P.updateBulk) P.updateBulk();
    }

    // ---- paging: the "Show more" button at the end of the list ----
    // It sits inside the scrolling list (after the last row) and loads the next page by itself when it scrolls into
    // view, where the browser can tell (IntersectionObserver); clicking it, or pressing Enter on it, always works.
    var moreButton = null;
    var moreObserver = null;

    function moreText() {
        var left = Math.max(0, state.total - state.items.length);
        if (state.loadingMore) return 'Loading...';
        return left > 0 ? 'Show more (' + left + ' left)' : 'Show more';
    }

    function updateMore() {
        var list = $('items');
        if (!state.hasMore) {
            if (moreButton && moreButton.parentNode) {
                if (moreObserver) moreObserver.unobserve(moreButton);
                moreButton.remove();
            }
            return;
        }
        if (!moreButton) {
            moreButton = make('button', 'show-more ghost');
            moreButton.type = 'button';
            moreButton.addEventListener('click', function () { loadMore(); });
            if (window.IntersectionObserver) {
                moreObserver = new IntersectionObserver(function (entries) {
                    if (entries.some(function (entry) { return entry.isIntersecting; })) loadMore();
                }, { root: list, rootMargin: '0px 0px 200px 0px' });
            }
        }
        moreButton.textContent = moreText();
        moreButton.disabled = state.loadingMore;
        if (list.lastElementChild !== moreButton) list.appendChild(moreButton);
        // Observed afresh each time, so a list still too short to scroll after a page arrives loads the next one too
        // (not after a failed request, or a button in view would retry at once, forever: the button still works)
        if (moreObserver && !state.loadingMore && !state.moreFailed) { moreObserver.unobserve(moreButton); moreObserver.observe(moreButton); }
    }

    // Adds a page of clips the server sent after the ones on screen. Only these rows are built; the rows already there are
    // left alone (so nothing is reordered or reloaded under the reader). Clips go where the list's own order puts them,
    // which is the end for a normal page.
    function addPage(items) {
        var list = $('items');
        var hadFocus = moreButton && document.activeElement === moreButton;
        var firstNew = null;
        var tail = document.createDocumentFragment();
        // The rows waiting in `tail` go in just before the "Show more" button
        function flush() { list.insertBefore(tail, moreButton && moreButton.parentNode === list ? moreButton : null); }
        items.forEach(function (item) {
            var last = state.items[state.items.length - 1];
            if (!last || comesBefore(last, item)) {
                state.items.push(item);
                var row = buildClip(item);
                if (!firstNew) firstNew = row;
                tail.appendChild(row);
                return;
            }
            // Out of order (it moved while paging): between the rows it belongs between, without moving any of them
            flush();
            var at = 0;
            while (at < state.items.length && comesBefore(state.items[at], item)) at++;
            state.items.splice(at, 0, item);
            var rows = list.querySelectorAll('.clip');
            list.insertBefore(buildClip(item), rows[at] || null);
        });
        flush();
        updateCounts();
        markSelected();
        // Someone using the keyboard pressed the button: put them on the first new clip, not on a button that moved away
        if (hadFocus && firstNew) firstNew.focus();
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
        var rows = document.createDocumentFragment();
        state.items.forEach(function (item) { rows.appendChild(buildClip(item)); });
        list.appendChild(rows);
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

    // On a phone, Options and Close move up into the top bar (beside the menu button), so the row under the
    // stash name holds only the everyday buttons. On a wider screen they go back to the end of that row.
    (function placeTopButtons() {
        var phone = window.matchMedia('(max-width: 760px)');
        var moved = [$('logoutButton'), $('optionsButton')];
        function place() {
            var target = phone.matches ? document.querySelector('.mobile-bar-actions') : document.querySelector('.header-actions');
            if (phone.matches) moved.slice().reverse().forEach(function (el) { target.insertBefore(el, target.firstChild); });
            else moved.forEach(function (el) { target.appendChild(el); });
            moved.forEach(function (el) { el.classList.toggle('in-topbar', phone.matches); });
        }
        place();
        if (phone.addEventListener) phone.addEventListener('change', place); else phone.addListener(place);
    })();

    // A checkbox in Options (This device) shows or hides the note lines under each title, for a shorter list or a
    // screen others can see. The choice is kept on this device only.
    var CONTENT_KEY = 'stashly.hideContent';

    function setContentHidden(hidden, save) {
        $('items').classList.toggle('hide-content', hidden);
        $('contentLinesInput').checked = !hidden;
        if (save) { try { localStorage.setItem(CONTENT_KEY, hidden ? '1' : '0'); } catch (e) { /* storage may be blocked */ } }
    }

    $('contentLinesInput').addEventListener('change', function (event) {
        setContentHidden(!event.target.checked, true);
    });

    try { setContentHidden(localStorage.getItem(CONTENT_KEY) === '1', false); } catch (e) { setContentHidden(false, false); }

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

    // What the other parts use
    P.itemTitle = itemTitle;
    P.clipFlags = clipFlags;
    P.itemSub = itemSub;
    P.buildClip = buildClip;
    P.sameGroup = sameGroup;
    P.rowIds = rowIds;
    P.startDrag = startDrag;
    P.moveByKey = moveByKey;
    P.saveOrder = saveOrder;
    P.applyOrders = applyOrders;
    P.filtersActive = filtersActive;
    P.updateCounts = updateCounts;
    P.markSelected = markSelected;
    P.renderItems = renderItems;
    P.addPage = addPage;
    P.updateMore = updateMore;
    P.sortItems = sortItems;
    P.setContentHidden = setContentHidden;
    P.listLimits = listLimits;
    P.setListWidth = setListWidth;
    P.resetListWidth = resetListWidth;
    P.endDrag = endDrag;
})();
