// The page a link to one clip opens (/c/<token>): shows that note or file and nothing else. No stash, no sign-in; the
// token in the address is the whole of the access, and the server answers only for that one clip.
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var token = decodeURIComponent((location.pathname.split('/')[2] || '').trim());

    function make(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function size(bytes) {
        if (window.StashlyUpload && window.StashlyUpload.formatSize) return window.StashlyUpload.formatSize(bytes);
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function copy(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
        var area = make('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* not allowed here */ }
        area.remove();
        return Promise.resolve(ok);
    }

    function gone() {
        document.title = 'Link not available · Stashly';
        $('clipTitle').textContent = 'This link is not available';
        $('clipMeta').textContent = '';
        $('clipBody').appendChild(make('p', 'muted', 'It may have expired, or the person who shared it may have cancelled it. Ask them for a new one.'));
    }

    function button(label, className, onClick) {
        var b = make('button', className, label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }

    function show(clip) {
        var title = clip.title || 'Shared clip';
        document.title = title + ' · Stashly';
        $('clipTitle').textContent = title;
        var when = new Date(clip.createdAt).toLocaleString();
        var body = $('clipBody');
        var actions = $('clipActions');

        if (clip.kind === 'note') {
            $('clipMeta').textContent = ['Note', (clip.text || '').length + ' characters', when].join(' · ');
            var pre = make('div', 'detail-text');
            var md = window.StashlyMarkdown;
            var hl = window.StashlyHighlight;
            var text = clip.text || '';
            // Rendered like the stash page does: Markdown and chat text as blocks, code coloured, links clickable
            var language = md && md.looksSlack(text) ? 'slack' : md && md.hasFence(text) ? 'markdown' : hl ? hl.detect(text) : null;
            if (!language && md && md.looks(text)) language = 'markdown';
            if ((language === 'markdown' || language === 'slack') && md) {
                pre.classList.add('md');
                pre.appendChild(md.render(text, hl, language));
            } else if (hl) {
                pre.appendChild(hl.render(text, language));
            } else {
                pre.textContent = text;
            }
            body.appendChild(pre);
            actions.appendChild(button('Copy', 'primary', function (event) {
                var target = event.currentTarget;
                copy(text).then(function (ok) {
                    target.textContent = ok ? 'Copied' : 'Select the text and copy it';
                    setTimeout(function () { target.textContent = 'Copy'; }, 1500);
                });
            }));
        } else {
            $('clipMeta').textContent = [clip.fileName, size(clip.fileSize), when].join(' · ');
            var download = make('a', 'button-link primary-link', 'Download');
            download.href = clip.fileUrl + '?download=1';
            download.setAttribute('download', clip.fileName);
            actions.appendChild(download);
            var type = (clip.fileType || '').split(';')[0];
            if (clip.isImage) {
                var img = make('img');
                img.src = clip.fileUrl;
                img.alt = clip.fileName;
                var frame = make('a', 'detail-image');
                frame.href = clip.fileUrl;
                frame.target = '_blank';
                frame.rel = 'noopener noreferrer';
                frame.appendChild(img);
                body.appendChild(frame);
            } else if (/^(video|audio)\//.test(type)) {
                var player = make(type.indexOf('video') === 0 ? 'video' : 'audio', 'detail-media');
                player.controls = true;
                player.preload = 'metadata';
                player.src = clip.fileUrl;
                body.appendChild(player);
            } else {
                var card = make('div', 'file-card');
                var ext = (clip.fileName.split('.').pop() || '').slice(0, 4).toUpperCase();
                card.appendChild(make('span', 'file-icon large', ext));
                var info = make('div');
                info.appendChild(make('div', 'file-name', clip.fileName));
                info.appendChild(make('div', 'muted', size(clip.fileSize) + (clip.fileType ? ' · ' + clip.fileType : '')));
                card.appendChild(info);
                body.appendChild(card);
                if (type === 'application/pdf') {
                    var open = make('a', 'button-link', 'Open');
                    open.href = clip.fileUrl + '?view=1';
                    open.target = '_blank';
                    open.rel = 'noopener noreferrer';
                    actions.appendChild(open);
                }
            }
        }

        $('clipNote').textContent = (clip.expiresAt ? 'This link works until ' + new Date(clip.expiresAt).toLocaleString() + '. ' : 'This link does not expire. ') +
            'It opens only this clip, nothing else in the stash.';
    }

    if (!token) { gone(); return; }
    fetch('/api/clips/' + encodeURIComponent(token), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (clip) { if (clip) show(clip); else gone(); })
        .catch(function () {
            $('clipTitle').textContent = 'Could not reach the server';
            $('clipBody').appendChild(make('p', 'muted', 'Check your connection and reload the page.'));
        });
})();
