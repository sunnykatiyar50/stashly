// The stash page: notes, images and files, live updates, search and date range
(function () {
    'use strict';

    var slug = decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase();
    var base = '/api/stashes/' + encodeURIComponent(slug);
    var $ = function (id) { return document.getElementById(id); };

    var state = { stash: null, items: [], filters: { search: '', startDate: '', endDate: '' }, es: null, connectedOnce: false };
    var sections = { loading: $('stateLoading'), gone: $('stateGone'), locked: $('stateLocked'), main: $('stateMain') };

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

    function icon(markup) {
        var span = document.createElement('span');
        span.innerHTML = markup;
        return span.firstChild;
    }

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

    // ---- items ----

    function button(label, className, onClick) {
        var el = document.createElement('button');
        el.type = 'button';
        el.className = className;
        el.textContent = label;
        el.addEventListener('click', onClick);
        return el;
    }

    function buildItem(item) {
        var el = document.createElement('article');
        el.className = 'item';
        el.dataset.id = item.id;

        var main = document.createElement('div');
        main.className = 'item-main';
        var actions = document.createElement('div');
        actions.className = 'item-actions';

        if (item.kind === 'note') {
            var text = document.createElement('pre');
            text.className = 'item-text';
            text.textContent = item.text;
            main.appendChild(text);
            actions.appendChild(button('Copy', 'ghost small', function (event) {
                var target = event.currentTarget;
                Promise.resolve(copyText(item.text)).then(function (ok) {
                    toast(ok ? 'Copied' : 'Could not copy. Select the text and copy it by hand.', !ok);
                    if (ok) { target.textContent = 'Copied'; setTimeout(function () { target.textContent = 'Copy'; }, 1500); }
                });
            }));
        } else {
            if (item.isImage) {
                var link = document.createElement('a');
                link.className = 'thumb';
                link.href = item.url;
                link.target = '_blank';
                link.rel = 'noopener';
                var img = document.createElement('img');
                img.src = item.url;
                img.alt = item.fileName;
                img.loading = 'lazy';
                link.appendChild(img);
                main.appendChild(link);
            }
            var line = document.createElement('div');
            line.className = 'file-line';
            if (!item.isImage) {
                var badge = document.createElement('span');
                badge.className = 'file-icon';
                badge.textContent = extensionOf(item.fileName);
                line.appendChild(badge);
            }
            var name = document.createElement('div');
            var nameText = document.createElement('div');
            nameText.className = 'file-name';
            nameText.textContent = item.fileName;
            var size = document.createElement('div');
            size.className = 'item-meta';
            size.textContent = window.StashlyUpload.formatSize(item.fileSize);
            name.appendChild(nameText);
            name.appendChild(size);
            line.appendChild(name);
            main.appendChild(line);

            var download = document.createElement('a');
            download.className = 'button-link small';
            download.href = item.url + '?download=1';
            download.setAttribute('download', item.fileName);
            download.textContent = 'Download';
            actions.appendChild(download);
            if (item.isImage && canCopyImage) {
                actions.appendChild(button('Copy image', 'ghost small', function () {
                    copyImage(item).then(
                        function () { toast('Image copied'); },
                        function () { toast('Could not copy the image. Use Download instead.', true); }
                    );
                }));
            }
        }

        var meta = document.createElement('div');
        meta.className = 'item-meta item-time';
        meta.dataset.iso = item.createdAt;
        meta.title = new Date(item.createdAt).toLocaleString();
        meta.textContent = relativeTime(item.createdAt);
        main.appendChild(meta);

        actions.appendChild(button('Delete', 'danger-ghost small', function () { removeItem(item); }));
        el.appendChild(main);
        el.appendChild(actions);
        return el;
    }

    function filtersActive() {
        var f = state.filters;
        return Boolean(f.search || f.startDate || f.endDate);
    }

    function updateCounts() {
        var n = state.items.length;
        $('itemInfo').textContent = n + (filtersActive() ? (n === 1 ? ' match' : ' matches') : n === 1 ? ' item' : ' items');
        var empty = $('emptyState');
        empty.classList.toggle('hidden', n > 0);
        empty.textContent = filtersActive()
            ? 'No items match your search or dates.'
            : 'Nothing here yet. Add a note, drop a file, or paste a screenshot.';
    }

    function renderItems() {
        var list = $('items');
        list.textContent = '';
        state.items.forEach(function (item) { list.appendChild(buildItem(item)); });
        updateCounts();
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
            state.stash = res.body;
            state.items = res.body.items;
            sections.main.classList.contains('hidden') && show('main');
            updateHeader();
            renderItems();
            connect();
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
            var hay = ((item.text || '') + ' ' + (item.fileName || '')).toLowerCase();
            if (hay.indexOf(f.search.toLowerCase()) === -1) return false;
        }
        var created = new Date(item.createdAt).getTime();
        if (f.startDate && created < localDayStart(f.startDate)) return false;
        if (f.endDate && created >= localDayStart(f.endDate) + 86400000) return false;
        return true;
    }

    function onItemAdded(item) {
        if (state.items.some(function (existing) { return existing.id === item.id; })) return;
        if (!matchesFilters(item)) return;
        state.items.unshift(item);
        var el = buildItem(item);
        el.classList.add('new');
        $('items').insertBefore(el, $('items').firstChild);
        updateCounts();
    }

    function onItemDeleted(id) {
        state.items = state.items.filter(function (item) { return item.id !== id; });
        var el = document.querySelector('.item[data-id="' + id + '"]');
        if (el) el.remove();
        updateCounts();
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
        api(base + '/notes', { method: 'POST', body: { text: text } }).then(function (res) {
            submit.disabled = false;
            if (res.ok) {
                input.value = '';
                onItemAdded(res.body);
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
        state.filters = {
            search: $('searchInput').value.trim(),
            startDate: $('startDate').value,
            endDate: $('endDate').value,
        };
        if (state.filters.startDate && state.filters.endDate && state.filters.startDate > state.filters.endDate) {
            toast('The From date is after the To date.', true);
            return;
        }
        load();
    }

    $('searchButton').addEventListener('click', applyFilters);
    $('searchInput').addEventListener('keydown', function (event) { if (event.key === 'Enter') applyFilters(); });
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

    // ---- uploads: picker, drag and drop, paste ----

    var uploader = window.StashlyUpload.create({
        container: $('uploads'),
        url: base + '/files',
        maxBytes: 0,
        onDone: function (item) { if (item) onItemAdded(item); },
        onLocked: locked,
    });

    $('attachButton').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (event) {
        uploader.add(event.target.files);
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
        if (mainVisible()) uploader.add(event.dataTransfer.files);
    });

    document.addEventListener('paste', function (event) {
        var files = event.clipboardData && event.clipboardData.files;
        if (!files || !files.length || !mainVisible()) return;
        event.preventDefault();
        uploader.add(files);
    });

    // ---- start ----

    api('/api/config').then(function (res) {
        if (res.ok) uploader = window.StashlyUpload.create({
            container: $('uploads'),
            url: base + '/files',
            maxBytes: res.body.limits.maxFileBytes,
            onDone: function (item) { if (item) onItemAdded(item); },
            onLocked: locked,
        });
    });

    setInterval(updateTimes, 30000);
    load();
})();
