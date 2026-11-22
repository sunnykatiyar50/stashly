// The stash page, part 8 of 9: QR code, share links, and uploads (picker, drop zone, paste).
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var base = P.base;
    var $ = P.$;
    var tabId = P.tabId;
    var state = P.state;
    var sections = P.sections;
    var api = P.api;
    var toast = P.toast;
    var copyText = P.copyText;
    var stashContent = P.stashContent;
    var role = P.role;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function locked() { return P.locked.apply(null, arguments); }
    function onItemAdded() { return P.onItemAdded.apply(null, arguments); }
    function onItemUpdated() { return P.onItemUpdated.apply(null, arguments); }

    $('copyLinkButton').addEventListener('click', function () {
        Promise.resolve(copyText(location.href)).then(function (ok) {
            toast(ok ? 'Link copied' : 'Could not copy the link.', !ok);
        });
    });

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

    // ---- image thumbnails ----
    // The server has no image library, so the page makes them: it shrinks the image on a canvas (see thumbnail.js)
    // and sends the small picture to PUT .../files/ID/thumb. It happens after an image upload succeeds, and for an
    // image that has none (sent from curl, or older than thumbnails) the first time someone with full access sees it.
    // One at a time, and silent: a failure only means the image keeps its file icon (or itself, when small).
    var thumbQueue = Promise.resolve();
    var thumbTried = {}; // an image is tried once per page load, whatever came of it
    var BIGGEST_LAZY = 30 * 1024 * 1024; // not worth downloading anything bigger just for a thumbnail

    function maxThumbBytes() {
        var limits = state.stash && state.stash.limits;
        return (limits && limits.maxThumbBytes) || 200 * 1024;
    }

    function sendThumb(item, blob) {
        return fetch(base + '/files/' + item.id + '/thumb', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': blob.type, 'X-Tab-Id': tabId },
            body: blob,
        }).then(function (res) { return res.ok ? res.json() : null; });
    }

    // getBlob() gives the image's bytes (the file just uploaded, or a download of it)
    function queueThumb(item, getBlob) {
        if (!window.StashlyThumb || thumbTried[item.id]) return;
        thumbTried[item.id] = true;
        thumbQueue = thumbQueue.then(function () {
            return Promise.resolve().then(getBlob)
                .then(function (blob) { return blob ? window.StashlyThumb.make(blob, { maxBytes: maxThumbBytes() }) : null; })
                .then(function (thumb) { return thumb ? sendThumb(item, thumb) : null; })
                // The page's own list takes the item with its thumbUrl (other pages get it from the live event)
                .then(function (updated) { if (updated) onItemUpdated(updated); })
                .catch(function () { /* no thumbnail: nothing to tell anyone */ });
        });
    }

    // An image upload just finished: its thumbnail comes from the file in hand
    function uploaded(item, file) {
        if (!item) return;
        onItemAdded(item);
        if (item.isImage && !item.thumbUrl && file) queueThumb(item, function () { return file; });
    }

    // A listed image with no thumbnail: made when its row is first on screen (or at once where the browser cannot tell)
    var thumbObserver = null;

    function lazyThumb(item) {
        if (item.fileSize > BIGGEST_LAZY) return;
        queueThumb(item, function () {
            return fetch(item.url, { credentials: 'same-origin' }).then(function (res) {
                if (!res.ok) throw new Error('download');
                return res.blob();
            });
        });
    }

    function wantThumb(item, element) {
        // Only full access may attach one to an image that was not just uploaded by this page
        if (role() !== 'full' || item.thumbUrl || thumbTried[item.id]) return;
        if (!window.IntersectionObserver) { lazyThumb(item); return; }
        if (!thumbObserver) {
            thumbObserver = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    thumbObserver.unobserve(entry.target);
                    if (entry.target._thumbItem) lazyThumb(entry.target._thumbItem);
                });
            });
        }
        element._thumbItem = item;
        thumbObserver.observe(element);
    }

    var uploader = window.StashlyUpload.create({
        container: $('uploads'),
        url: base + '/files',
        maxBytes: 0,
        tabId: tabId,
        onDone: uploaded,
        onLocked: locked,
    });

    // Upload progress shows under the composer, which is always on the page
    function addFiles(files) {
        if (stashContent() === 'notes') { toast('This stash only takes notes, not files.', true); return; }
        // A title typed in the composer goes with a single file (several files keep their own names)
        var titleInput = $('titleInput');
        var title = titleInput.value.trim();
        if (title && files.length === 1) {
            uploader.add(files, { title: title });
            titleInput.value = '';
        } else {
            uploader.add(files);
        }
    }

    // Start replaces the first uploader (no size limit known yet) with one that knows the real limit
    function replaceUploader(maxBytes) {
        uploader = window.StashlyUpload.create({
            container: $('uploads'),
            url: base + '/files',
            maxBytes: maxBytes,
            tabId: tabId,
            onDone: uploaded,
            onLocked: locked,
        });
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

    // What the other parts use
    P.replaceUploader = replaceUploader;
    P.wantThumb = wantThumb;
    P.isLocalHost = isLocalHost;
    P.showQr = showQr;
    P.renderShare = renderShare;
    P.redeemFromHash = redeemFromHash;
    P.addFiles = addFiles;
    P.chooseFiles = chooseFiles;
    P.hasFiles = hasFiles;
    P.mainVisible = mainVisible;
})();
