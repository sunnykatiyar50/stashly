// The stash page: a list of clips on the left, the picked clip (or a new one) on the right.
// Live updates, search and date range, uploads by picker, drag and drop, and paste.
(function () {
    'use strict';

    var slug = decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase();
    var base = '/api/stashes/' + encodeURIComponent(slug);
    var $ = function (id) { return document.getElementById(id); };

    var state = {
        stash: null,
        items: [],
        filters: { search: '', startDate: '', endDate: '' },
        es: null,
        connectedOnce: false,
        selectedId: null,  // the clip open on the right, or null
        started: false,    // the first successful load picks what to show
    };
    var sections = { loading: $('stateLoading'), gone: $('stateGone'), locked: $('stateLocked'), main: $('stateMain') };
    var narrow = window.matchMedia('(max-width: 760px)');

    document.title = slug + ' · Stashly';
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
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
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
        var el = make('button', className, label);
        el.type = 'button';
        el.addEventListener('click', onClick);
        return el;
    }

    // ---- the list on the left ----

    // A note shows its title (the first five words when it was not given one); a file shows its name
    function itemTitle(item) {
        if (item.kind !== 'note') return item.fileName;
        return item.title || '(empty note)';
    }

    // The line under the title in the list: a few lines of the note, or the size of a file.
    // A note without a title already shows its first five words as the title, so those are left out here.
    function itemSub(item) {
        if (item.kind !== 'note') return window.StashlyUpload.formatSize(item.fileSize);
        var text = item.text || '';
        if (!item.hasTitle) text = text.replace(/^\s*(?:\S+\s*){1,5}/, '');
        return text.replace(/\s+/g, ' ').trim().slice(0, 240);
    }

    function buildClip(item) {
        var el = make('button', 'clip');
        el.type = 'button';
        el.dataset.id = item.id;

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
        text.appendChild(make('span', 'clip-title', itemTitle(item)));
        var sub = itemSub(item);
        if (sub) text.appendChild(make('span', item.kind === 'note' ? 'clip-sub clip-preview' : 'clip-sub', sub));
        el.appendChild(text);

        var time = make('span', 'clip-time item-time', relativeTime(item.createdAt));
        time.dataset.iso = item.createdAt;
        time.title = new Date(item.createdAt).toLocaleString();
        el.appendChild(time);

        el.addEventListener('click', function () { openItem(item.id); });
        return el;
    }

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

    function renderDetail(item) {
        var actions = $('detailActions');
        var body = $('detailBody');
        actions.textContent = '';
        body.textContent = '';
        $('detailTitle').textContent = itemTitle(item);
        var when = new Date(item.createdAt).toLocaleString();

        if (item.kind === 'note') {
            $('detailMeta').textContent = 'Note · ' + (item.text || '').length + ' characters · ' + when;
            body.appendChild(make('pre', 'detail-text', item.text));
            actions.appendChild(button('Copy', 'primary', function (event) {
                var target = event.currentTarget;
                Promise.resolve(copyText(item.text)).then(function (ok) {
                    toast(ok ? 'Copied' : 'Could not copy. Select the text and copy it by hand.', !ok);
                    if (ok) { target.textContent = 'Copied'; setTimeout(function () { target.textContent = 'Copy'; }, 1500); }
                });
            }));
        } else {
            $('detailMeta').textContent = window.StashlyUpload.formatSize(item.fileSize) + ' · ' + when;

            var download = make('a', 'button-link primary-link', 'Download');
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

        actions.appendChild(button('Delete', 'danger-ghost', function () { removeItem(item); }));
        body.scrollTop = 0;
    }

    document.querySelectorAll('[data-back]').forEach(function (el) {
        el.addEventListener('click', function () { setPane('list'); });
    });

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

    function updateExpiry() {
        if (!state.stash) return;
        var chip = $('expiryInfo');
        chip.textContent = expiryText(state.stash.expiresAt);
        var soon = state.stash.expiresAt && new Date(state.stash.expiresAt).getTime() - Date.now() < 60 * 60 * 1000;
        chip.classList.toggle('warn', Boolean(soon));
        if (state.stash.expiresAt && new Date(state.stash.expiresAt).getTime() <= Date.now()) load(true);
    }

    function updateTimes() {
        Array.prototype.forEach.call(document.querySelectorAll('.item-time'), function (el) {
            el.textContent = relativeTime(el.dataset.iso);
        });
        updateExpiry();
    }

    // ---- loading ----

    function load(quiet) {
        var f = state.filters;
        var query = new URLSearchParams();
        if (f.search) query.set('search', f.search);
        if (f.startDate) query.set('startDate', f.startDate);
        if (f.endDate) query.set('endDate', f.endDate);
        query.set('tz', String(new Date().getTimezoneOffset()));
        return api(base + '?' + query.toString()).then(function (res) {
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
            sections.main.classList.contains('hidden') && show('main');
            updateHeader();
            renderItems();
            connect();

            if (!state.started) {
                state.started = true;
                // Desktop opens the newest clip (the usual reason to visit); a phone starts on the list
                if (!narrow.matches && state.items.length) openItem(state.items[0].id);
            } else if (state.selectedId !== null) {
                if (findItem(state.selectedId)) renderDetail(findItem(state.selectedId));
                else showSomethingElse(previousIndex);
            }
        }).catch(function () {
            if (!quiet) toast('Could not reach the server.', true);
        });
    }

    function gone() {
        closeStream();
        state.stash = null;
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
        state.items.unshift(item);
        var el = buildClip(item);
        el.classList.add('new');
        $('items').insertBefore(el, $('items').firstChild);
        updateCounts();
        markSelected();
    }

    function onItemDeleted(id) {
        var index = state.items.findIndex(function (item) { return item.id === id; });
        state.items = state.items.filter(function (item) { return item.id !== id; });
        var el = document.querySelector('.clip[data-id="' + id + '"]');
        if (el) el.remove();
        updateCounts();
        if (state.selectedId === id) showSomethingElse(index);
    }

    function connect() {
        if (state.es || !window.EventSource) return;
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
            // A refused stream (locked or gone) is not retried by the browser: find out which
            if (es.readyState === EventSource.CLOSED) {
                state.es = null;
                state.connectedOnce = false;
                load(true);
            }
        };
        es.addEventListener('item-added', function (event) { onItemAdded(JSON.parse(event.data)); });
        es.addEventListener('item-deleted', function (event) { onItemDeleted(JSON.parse(event.data).id); });
        es.addEventListener('stash-extended', function (event) {
            if (state.stash) { state.stash.expiresAt = JSON.parse(event.data).expiresAt; updateExpiry(); }
        });
        es.addEventListener('stash-gone', gone);
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
        var input = $('noteInput');
        var error = $('noteError');
        error.textContent = '';
        var text = input.value;
        if (!text.trim()) { error.textContent = 'Write something first.'; input.focus(); return; }
        var submit = $('addNoteButton');
        submit.disabled = true;
        api(base + '/notes', { method: 'POST', body: { title: $('titleInput').value, text: text } }).then(function (res) {
            submit.disabled = false;
            if (res.ok) {
                input.value = '';
                $('titleInput').value = '';
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
        api(base + '/unlock', { method: 'POST', body: { password: password } }).then(function (res) {
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

    $('deleteStashButton').addEventListener('click', function () {
        if (!window.confirm('Delete "' + slug + '" and everything in it? This cannot be undone.')) return;
        api(base, { method: 'DELETE' }).then(function (res) {
            if (res.ok) gone();
            else toast((res.body && res.body.error) || 'Could not delete the stash.', true);
        });
    });

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

    // ---- uploads: picker, drop zone, drag and drop anywhere, paste ----

    var uploader = window.StashlyUpload.create({
        container: $('uploads'),
        url: base + '/files',
        maxBytes: 0,
        onDone: function (item) { if (item) onItemAdded(item); },
        onLocked: locked,
    });

    // Upload progress shows under the composer, which is always on the page
    function addFiles(files) {
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

    // ---- start ----

    api('/api/config').then(function (res) {
        if (!res.ok) return;
        var max = res.body.limits.maxFileBytes;
        $('limitHint').textContent = 'Up to ' + window.StashlyUpload.formatSize(max) + ' per file. Images, PDF, Office files, zip, certificates and any text file.';
        uploader = window.StashlyUpload.create({
            container: $('uploads'),
            url: base + '/files',
            maxBytes: max,
            onDone: function (item) { if (item) onItemAdded(item); },
            onLocked: locked,
        });
    });

    setInterval(updateTimes, 30000);
    load();
})();
