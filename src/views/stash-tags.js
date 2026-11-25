// The stash page: tags. A clip's tags show as small chips under its row, a strip above the list filters by them, the open
// clip has the editor (adding and removing happens only there, so the list stays compact), and select mode can add one
// tag to many clips (stash-select.js calls P.tagMany).
(function () {
    'use strict';

    var P = window.StashlyPage;
    var base = P.base;
    var $ = P.$;
    var state = P.state;
    var api = P.api;
    var toast = P.toast;
    var make = P.make;
    var role = P.role;

    function load() { return P.load.apply(null, arguments); }
    function locked() { return P.locked.apply(null, arguments); }
    function onItemUpdated() { return P.onItemUpdated.apply(null, arguments); }

    // The same rules as the server (src/utils/tags.js): lowercase letters, numbers, - and _, up to 24 characters
    var MAX_TAGS = 8;
    var MAX_TAG = 24;
    var VALID = /^[\p{L}\p{N}_-]+$/u;

    // A typed tag in its stored form, or '' when it is not one
    function cleanTag(raw) {
        var value = String(raw || '').trim().replace(/^#+/, '').toLowerCase();
        return value && Array.from(value).length <= MAX_TAG && VALID.test(value) ? value : '';
    }

    // Splits a search into its #tag words and the rest, like the server does
    function splitSearch(search) {
        var tags = [];
        var rest = [];
        String(search || '').split(/\s+/).filter(Boolean).forEach(function (word) {
            var tag = word.length > 1 && word.charAt(0) === '#' ? cleanTag(word) : '';
            if (tag) { if (tags.indexOf(tag) === -1) tags.push(tag); } else rest.push(word);
        });
        return { text: rest.join(' '), tags: tags };
    }

    // ---- chips in the list ----

    // How many chips a row shows; the rest are counted ("+2"). Fewer on a phone.
    function visibleChips() { return P.narrow && P.narrow.matches ? 2 : 3; }

    // The tags of a row, or null when the clip has none (so an untagged row gets no extra line)
    function rowTags(item) {
        var tags = item.tags || [];
        if (!tags.length) return null;
        var line = make('span', 'clip-tags');
        var shown = visibleChips();
        tags.slice(0, shown).forEach(function (tag) {
            var chip = make('button', 'tag-chip' + (activeTags().indexOf(tag) !== -1 ? ' on' : ''), tag);
            chip.type = 'button';
            chip.title = 'Show clips tagged ' + tag;
            chip.addEventListener('click', function (event) {
                event.stopPropagation();
                toggleFilter(tag);
            });
            line.appendChild(chip);
        });
        if (tags.length > shown) {
            var more = make('span', 'tag-more', '+' + (tags.length - shown));
            more.title = tags.slice(shown).join(', ');
            line.appendChild(more);
        }
        return line;
    }

    // ---- the filter strip above the list ----

    function activeTags() { return state.filters.tags || []; }

    function toggleFilter(tag) {
        var current = activeTags();
        var next = current.indexOf(tag) === -1 ? current.concat(tag) : current.filter(function (name) { return name !== tag; });
        state.filters = { search: state.filters.search, startDate: state.filters.startDate, endDate: state.filters.endDate, tags: next };
        load();
    }

    // The tags the stash uses, as a single scrolling line of chips; the ones filtered by are filled in. It is hidden
    // while the stash has no tags and no tag is being filtered by.
    function renderTagBar() {
        var bar = $('tagBar');
        var list = state.tagList || [];
        var active = activeTags();
        // A tag filtered by stays on the strip even when no clip has it any more, so it can be switched off
        var names = list.map(function (entry) { return entry.name; });
        active.forEach(function (tag) { if (names.indexOf(tag) === -1) list = list.concat({ name: tag, count: 0 }); });
        bar.textContent = '';
        bar.classList.toggle('hidden', !list.length);
        list.forEach(function (entry) {
            var on = active.indexOf(entry.name) !== -1;
            var chip = make('button', 'tag-chip' + (on ? ' on' : ''));
            chip.type = 'button';
            chip.setAttribute('aria-pressed', String(on));
            chip.title = entry.count + (entry.count === 1 ? ' clip' : ' clips');
            chip.appendChild(make('span', null, entry.name));
            chip.appendChild(make('span', 'tag-count', String(entry.count)));
            chip.addEventListener('click', function () { toggleFilter(entry.name); });
            bar.appendChild(chip);
        });
    }

    // Keeps the strip and the editor's suggestions in line with a clip's tags changing, here or on another device
    function syncCounts(before, after) {
        var list = state.tagList || (state.tagList = []);
        function bump(name, by) {
            var entry = list.filter(function (e) { return e.name === name; })[0];
            if (entry) entry.count = Math.max(0, entry.count + by);
            else if (by > 0) list.push({ name: name, count: by });
        }
        (before || []).forEach(function (name) { if ((after || []).indexOf(name) === -1) bump(name, -1); });
        (after || []).forEach(function (name) { if ((before || []).indexOf(name) === -1) bump(name, 1); });
        state.tagList = list.filter(function (entry) { return entry.count > 0; }).sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });
        renderTagBar();
    }

    // ---- the editor in the open clip ----

    // Chips with a remove button, and a box to add one (Enter, comma or space adds it; Backspace on an empty box removes
    // the last). Without full access the tags are shown and cannot be changed. Returns null for a clip with no tags
    // that cannot be tagged.
    function tagEditor(item) {
        var editable = role() === 'full';
        if (!editable && !(item.tags || []).length) return null;
        var box = make('div', 'tag-editor');
        box.dataset.id = item.id;
        var chips = make('span', 'tag-editor-chips');
        box.appendChild(make('span', 'tag-editor-label', 'Tags'));
        box.appendChild(chips);
        var tags = (item.tags || []).slice();
        var input = null;
        // Changes show at once and are sent one after another, so tags typed quickly are never lost. If a save fails,
        // the chips go back to what the server last had.
        var queue = Promise.resolve();
        var pending = 0;
        var saved = tags.slice();

        function save(next) {
            tags = next.slice();
            paint();
            pending++;
            queue = queue.then(function () {
                return api(base + '/items/' + item.id + '/tags', { method: 'PUT', body: { tags: next } });
            }).then(function (res) {
                pending--;
                if (res.ok) {
                    saved = res.body.tags.slice();
                    // A later change is still on its way: keep showing it
                    if (!pending) { tags = saved.slice(); paint(); }
                    onItemUpdated(res.body);
                } else {
                    if (res.status === 401) locked();
                    else toast((res.body && res.body.error) || 'Could not save the tags.', true);
                    if (!pending) { tags = saved.slice(); paint(); }
                }
            }).catch(function () {
                pending--;
                toast('Could not reach the server.', true);
                if (!pending) { tags = saved.slice(); paint(); }
            });
        }

        function add(raw) {
            var words = String(raw).split(/[\s,]+/).filter(Boolean);
            if (!words.length) return;
            var next = tags.slice();
            for (var i = 0; i < words.length; i++) {
                var tag = cleanTag(words[i]);
                if (!tag) { toast('A tag can only have letters, numbers, - and _ (up to ' + MAX_TAG + ' characters).', true); return; }
                if (next.indexOf(tag) === -1) next.push(tag);
            }
            if (next.length > MAX_TAGS) { toast('A clip can have at most ' + MAX_TAGS + ' tags.', true); return; }
            input.value = '';
            if (next.length !== tags.length) save(next);
        }

        function paint() {
            chips.textContent = '';
            tags.forEach(function (tag) {
                var chip = make('span', 'tag-chip static');
                chip.appendChild(make('span', null, tag));
                if (editable) {
                    var remove = make('button', 'tag-remove', '×');
                    remove.type = 'button';
                    remove.title = 'Remove ' + tag;
                    remove.setAttribute('aria-label', 'Remove tag ' + tag);
                    remove.addEventListener('click', function () { save(tags.filter(function (name) { return name !== tag; })); });
                    chip.appendChild(remove);
                }
                chips.appendChild(chip);
            });
            if (input) {
                input.classList.toggle('hidden', tags.length >= MAX_TAGS);
                // Suggestions: the stash's tags this clip does not have yet
                var options = $('tagSuggestions');
                options.textContent = '';
                (state.tagList || []).forEach(function (entry) {
                    if (tags.indexOf(entry.name) === -1) options.appendChild(make('option', null, entry.name));
                });
            }
        }

        if (editable) {
            input = make('input', 'tag-input');
            input.type = 'text';
            input.placeholder = tags.length ? 'Add a tag' : 'Add a tag to organise this clip';
            input.maxLength = 60;
            input.setAttribute('list', 'tagSuggestions');
            input.setAttribute('aria-label', 'Add a tag');
            input.autocomplete = 'off';
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
                    if (!input.value.trim()) { if (event.key !== 'Enter') event.preventDefault(); return; }
                    event.preventDefault();
                    add(input.value);
                } else if (event.key === 'Backspace' && !input.value && tags.length) {
                    save(tags.slice(0, -1));
                }
            });
            // A tag never has a comma or space, so a box that holds one (pasted "a, b", or a phone keyboard that sends no
            // key names) has finished tags in it
            input.addEventListener('input', function () { if (/[\s,]/.test(input.value) && input.value.trim()) add(input.value); });
            // Picking a suggestion from the list, or leaving the box with a tag typed, adds it too
            input.addEventListener('change', function () { add(input.value); });
            box.appendChild(input);
        }
        // A change that came from elsewhere; ignored while this editor has saves of its own on the way
        box._paint = function (next) { if (pending) return; tags = next.slice(); saved = next.slice(); paint(); };
        paint();
        return box;
    }

    // The open clip's editor shows a change that came from somewhere else (another device, select mode)
    function refreshEditor(item) {
        var box = $('detailBody').querySelector('.tag-editor');
        if (box && Number(box.dataset.id) === item.id && box._paint) box._paint(item.tags || []);
    }

    // ---- select mode ----

    // Adds (or removes) one tag on the ticked clips in one request. Resolves to the answer's body, or null.
    function tagMany(action, ids, tag) {
        return api(base + '/items/bulk', { method: 'POST', body: { action: action, ids: ids, tag: tag } }).then(function (res) {
            if (res.ok) return res.body;
            if (res.status === 401) locked();
            else toast((res.body && res.body.error) || 'Could not change the tags.', true);
            return null;
        }).catch(function () {
            toast('Could not reach the server.', true);
            return null;
        });
    }

    P.cleanTag = cleanTag;
    P.splitSearch = splitSearch;
    P.rowTags = rowTags;
    P.renderTagBar = renderTagBar;
    P.syncTagCounts = syncCounts;
    P.tagEditor = tagEditor;
    P.refreshTagEditor = refreshEditor;
    P.tagMany = tagMany;
    P.toggleTagFilter = toggleFilter;
})();
