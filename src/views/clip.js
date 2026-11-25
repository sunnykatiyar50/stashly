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

    var ICONS = {
        copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'
    };

    // Puts an icon and the words on a button or link, replacing what was there
    function setLabel(el, icon, label) {
        el.textContent = '';
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.innerHTML = ICONS[icon];
        el.appendChild(svg);
        el.appendChild(make('span', 'btn-text', label));
    }

    function button(label, icon, className, onClick) {
        var b = make('button', className);
        b.type = 'button';
        setLabel(b, icon, label);
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
            actions.appendChild(button('Copy', 'copy', 'primary', function (event) {
                var target = event.currentTarget;
                copy(text).then(function (ok) {
                    setLabel(target, ok ? 'check' : 'copy', ok ? 'Copied' : 'Select the text and copy it');
                    setTimeout(function () { setLabel(target, 'copy', 'Copy'); }, 1500);
                });
            }));
        } else {
            $('clipMeta').textContent = [clip.fileName, size(clip.fileSize), when].join(' · ');
            var download = make('a', 'button-link primary-link');
            setLabel(download, 'download', 'Download');
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
                    var open = make('a', 'button-link');
                    setLabel(open, 'open', 'Open');
                    open.href = clip.fileUrl + '?view=1';
                    open.target = '_blank';
                    open.rel = 'noopener noreferrer';
                    actions.appendChild(open);
                }
            }
        }

        $('clipNote').textContent = clip.expiresAt ? 'Expires ' + new Date(clip.expiresAt).toLocaleString() : 'Does not expire';
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
