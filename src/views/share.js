// The page the phone's share sheet opens: what was shared fills a note (and lists any files), you pick the stash, Send adds it.
(function () {
    'use strict';

    var RECENT_KEY = 'sl_recent_stashes';
    var $ = function (id) { return document.getElementById(id); };

    function readRecent() {
        try {
            var list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
            return Array.isArray(list) ? list.filter(function (name) { return typeof name === 'string'; }) : [];
        } catch (e) {
            return [];
        }
    }

    // What the share sheet handed over reaches this page in one of two ways. Installed, the service worker (sw.js) keeps the
    // title, text, link and files in IndexedDB and sends the page here with ?received=1. Otherwise (the plain form POST, or
    // an older install) the server hands the text over in the fragment (#); very old installs used the query string. Either
    // way the address is cleaned at once, so it is not kept in the browser's history.
    var received = new URLSearchParams(location.search).get('received') === '1';
    var params = new URLSearchParams(location.hash.length > 1 ? location.hash.slice(1) : received ? '' : location.search);
    if (location.hash || location.search) {
        try { history.replaceState(null, '', '/share'); } catch (e) { /* the address keeps it; nothing else changes */ }
    }

    // Android usually puts the link in "text" and sometimes repeats it in "url"; share only one copy of it
    function compose(title, text, url) {
        title = (title || '').trim();
        text = (text || '').trim();
        url = (url || '').trim();
        var body = text;
        if (url && text.indexOf(url) === -1) body = body ? body + '\n' + url : url;
        // A title that only repeats the start of the text adds nothing
        if (title && body.indexOf(title) === 0) title = '';
        return { title: title.slice(0, 150), body: body };
    }

    // ---- shared files, kept by the service worker ----

    // A share older than this is not offered any more (it was never picked up)
    var FRESH_MS = 60 * 60 * 1000;
    var files = []; // the File objects still to be sent

    // Reads the pending share and removes it, so it is offered once. Resolves to the record, or null.
    function takePending() {
        return new Promise(function (resolve) {
            if (!window.indexedDB) return resolve(null);
            var open = indexedDB.open('stashly-share', 1);
            open.onupgradeneeded = function () { open.result.createObjectStore('pending'); };
            open.onerror = function () { resolve(null); };
            open.onsuccess = function () {
                var db = open.result;
                var record = null;
                var tx;
                try { tx = db.transaction('pending', 'readwrite'); } catch (e) { db.close(); return resolve(null); }
                var store = tx.objectStore('pending');
                var get = store.get('latest');
                get.onsuccess = function () { record = get.result || null; store.delete('latest'); };
                tx.oncomplete = function () { db.close(); resolve(record && Date.now() - record.time < FRESH_MS ? record : null); };
                tx.onerror = tx.onabort = function () { db.close(); resolve(null); };
            };
        });
    }

    function size(bytes) {
        return window.StashlyUpload ? window.StashlyUpload.formatSize(bytes) : bytes + ' B';
    }

    function drawFiles() {
        var list = $('shareFiles');
        list.textContent = '';
        $('shareFilesField').classList.toggle('hidden', !files.length);
        files.forEach(function (file, index) {
            var item = document.createElement('li');
            item.className = 'share-file';
            var name = document.createElement('span');
            name.className = 'share-file-name';
            name.textContent = file.name || 'file';
            name.title = file.name || 'file';
            var sizeLabel = document.createElement('span');
            sizeLabel.className = 'muted';
            sizeLabel.textContent = size(file.size);
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ghost small';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', 'Remove ' + (file.name || 'file'));
            remove.addEventListener('click', function () { files.splice(index, 1); drawFiles(); });
            item.appendChild(name);
            item.appendChild(sizeLabel);
            item.appendChild(remove);
            list.appendChild(item);
        });
    }

    var first = compose(params.get('title'), params.get('text'), params.get('url'));
    $('shareTitle').value = first.title;
    $('shareText').value = first.body;

    var recent = readRecent();
    recent.forEach(function (name) {
        var option = document.createElement('option');
        option.value = name;
        $('recentStashes').appendChild(option);
    });
    if (recent.length) $('shareStash').value = recent[0];
    (first.body ? $('shareStash') : $('shareText')).focus();

    if (received) {
        takePending().then(function (record) {
            if (!record) return;
            var shared = compose(record.title, record.text, record.url);
            $('shareTitle').value = shared.title;
            $('shareText').value = shared.body;
            files = Array.isArray(record.files) ? record.files.filter(function (file) { return file && file.size > 0; }) : [];
            drawFiles();
            // With files and no text there is nothing to type: go straight to choosing the stash
            $('shareStash').focus();
        });
    }

    function fail(message, link) {
        $('shareError').textContent = message;
        var open = $('shareOpen');
        if (link) { open.href = link; open.textContent = 'Open stash'; open.classList.remove('hidden'); }
        else open.classList.add('hidden');
    }

    function remember(slug) {
        try {
            var list = readRecent().filter(function (name) { return name !== slug; });
            list.unshift(slug);
            localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
        } catch (e) { /* not remembered */ }
    }

    function sent(slug, what) {
        remember(slug);
        $('shareStatus').textContent = 'Sent ' + what + ' to ' + slug + '.';
        var open = $('shareOpen');
        open.href = '/s/' + encodeURIComponent(slug);
        open.textContent = 'Open ' + slug;
        open.classList.remove('hidden');
        $('shareSend').textContent = 'Send again';
    }

    // Uploads the files with the same uploader the stash page uses (a big file goes up in pieces and is retried), one at a
    // time with a progress bar each. A file that arrives leaves the list; one that fails keeps its row with the reason and
    // stays in the list, so pressing Send again retries just those. Send works again once every row has settled.
    function sendFiles(slug, title, withNote) {
        var path = '/api/stashes/' + encodeURIComponent(slug);
        var container = $('shareUploads');
        var send = $('shareSend');
        var batch = files.slice();
        var done = 0;
        var locked = false;
        container.textContent = ''; // rows of an earlier try
        send.disabled = true;

        var uploader = window.StashlyUpload.create({
            container: container,
            url: path + '/files',
            uploadsUrl: path + '/uploads',
            maxBytes: 0, // the server knows its limit and says so for a file that is too big
            onDone: function (body, file) {
                done++;
                files = files.filter(function (kept) { return kept !== file; });
                drawFiles();
            },
            onLocked: function () { locked = true; },
        });

        // Settled: nothing is waiting or on its way (a failed row stays on the page but is finished)
        var observer = null;
        function check() {
            if (container.querySelector('.upload-row:not(.failed)')) return;
            if (observer) observer.disconnect();
            send.disabled = false;
            var failed = container.querySelectorAll('.upload-row.failed').length;
            if (locked) fail('That stash is locked. Open it and enter the password once, then share again.', '/s/' + encodeURIComponent(slug));
            else if (failed) fail(failed === 1 ? 'One file could not be sent (see below). Press Send to try it again.' : failed + ' files could not be sent (see below). Press Send to try them again.');
            else sent(slug, (withNote ? 'the note and ' : '') + (done === 1 ? 'the file' : done + ' files'));
        }
        observer = new MutationObserver(check);
        observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        // A title goes with a single file when there is no note to carry it
        uploader.add(batch, batch.length === 1 && !withNote && title ? { title: title } : undefined);
        check();
    }

    $('shareForm').addEventListener('submit', function (event) {
        event.preventDefault();
        fail('');
        $('shareStatus').textContent = '';
        var slug = $('shareStash').value.trim().toLowerCase();
        var note = $('shareText').value;
        var hasNote = Boolean(note.trim());
        if (!hasNote && !files.length) return fail('There is nothing to send. Write something first.');
        if (!slug) return fail('Pick or type the stash to send it to.');
        var send = $('shareSend');
        var path = '/api/stashes/' + encodeURIComponent(slug);

        // Files only: no note to send first
        if (!hasNote) return sendFiles(slug, $('shareTitle').value.trim(), false);

        send.disabled = true;
        fetch(path + '/notes', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: $('shareTitle').value, text: note }),
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) { return { res: res, data: data }; });
        }).then(function (result) {
            var status = result.res.status;
            if (result.res.ok) {
                // The note is in; its files follow. The fields are cleared so that trying a failed file again cannot send the note twice.
                if (files.length) {
                    $('shareText').value = '';
                    $('shareTitle').value = '';
                    return sendFiles(slug, '', true);
                }
                send.disabled = false;
                sent(slug, 'it');
            } else {
                send.disabled = false;
                if (status === 401) fail('That stash is locked. Open it and enter the password once, then share again.', '/s/' + encodeURIComponent(slug));
                else if (status === 404) fail('There is no stash called "' + slug + '" (it may have expired).');
                else fail((result.data && result.data.error) || 'Could not send that.');
            }
            return null;
        }).catch(function () {
            send.disabled = false;
            fail('Could not reach the server.');
        });
    });
})();
