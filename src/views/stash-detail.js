// The stash page, part 3 of 9: the open clip on the right (notes, files, previews, burn notes), and copying.
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var base = P.base;
    var $ = P.$;
    var state = P.state;
    var sections = P.sections;
    var narrow = P.narrow;
    var api = P.api;
    var toast = P.toast;
    var make = P.make;
    var svg = P.svg;
    var copyText = P.copyText;
    var canCopyImage = P.canCopyImage;
    var copyImage = P.copyImage;
    var relativeTime = P.relativeTime;
    var expiryText = P.expiryText;
    var extensionOf = P.extensionOf;
    var fileKind = P.fileKind;
    var findItem = P.findItem;
    var button = P.button;
    var setLabel = P.setLabel;
    var MASK = P.MASK;
    var COPY_ICON = P.COPY_ICON;
    var CHECK_ICON = P.CHECK_ICON;
    var role = P.role;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function itemTitle() { return P.itemTitle.apply(null, arguments); }
    function markSelected() { return P.markSelected.apply(null, arguments); }
    function locked() { return P.locked.apply(null, arguments); }
    function setPinned() { return P.setPinned.apply(null, arguments); }
    function editFileTitle() { return P.editFileTitle.apply(null, arguments); }
    function editNote() { return P.editNote.apply(null, arguments); }
    function onItemDeleted() { return P.onItemDeleted.apply(null, arguments); }
    function removeItem() { return P.removeItem.apply(null, arguments); }

    // The whole text of a note. A listing carries only the start of a long note (item.truncated), so this fetches the
    // rest once and keeps it on the item. Rejects when it cannot be had.
    function loadFull(item) {
        if (!item.truncated) return Promise.resolve(item.text || '');
        return api(base + '/items/' + item.id).then(function (res) {
            if (res.status === 401) { locked(); throw new Error('locked'); }
            if (!res.ok || !res.body || typeof res.body.text !== 'string') throw new Error('load');
            item.text = res.body.text;
            delete item.truncated;
            delete item.textLength;
            return item.text;
        });
    }

    // Copies a note's text (fetching the rest of a long note first); the row button shows a tick for a moment
    function copyItem(item, trigger) {
        return loadFull(item).then(function (text) { return copyNote(text, trigger); }, function () {
            toast('Could not load that note.', true);
            return false;
        });
    }

    // Copies a note's text; the row button shows a tick for a moment
    function copyNote(text, trigger) {
        return Promise.resolve(copyText(text)).then(function (ok) {
            toast(ok ? 'Copied' : 'Could not copy. Open the note and select the text.', !ok);
            if (ok && trigger) {
                trigger.textContent = '';
                trigger.appendChild(svg(CHECK_ICON));
                setTimeout(function () { trigger.textContent = ''; trigger.appendChild(svg(COPY_ICON)); }, 1200);
            }
            return ok;
        });
    }

    // The newest note whose text is on the page. A burn note has none (copying it would mean revealing it).
    function copyLatest() {
        for (var i = 0; i < state.items.length; i++) {
            var item = state.items[i];
            if (item.kind === 'note' && !item.burn && item.text) return copyItem(item, null);
        }
        toast(state.items.some(function (item) { return item.burn; }) ? 'Only burn-after-reading notes here. Reveal one to copy it.' : 'No note to copy yet.', true);
        return Promise.resolve(false);
    }

    $('copyLatestButton').addEventListener('click', copyLatest);

    // Alt+C copies the newest note from anywhere on the page
    document.addEventListener('keydown', function (event) {
        if (!(event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c')) return;
        if (sections.main.classList.contains('hidden')) return;
        event.preventDefault();
        copyLatest();
    });

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
        state.revealedId = null;
        state.editingId = null;
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

    // The names inside a zip file (the server reads the directory only, nothing is unpacked)
    function showZipContents(item, body) {
        var box = make('div', 'zip-list');
        box.appendChild(make('div', 'muted', 'Reading the zip file...'));
        body.appendChild(box);
        fetch(item.url + '/contents', { credentials: 'same-origin' })
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
                if (state.selectedId !== item.id) return;
                box.textContent = '';
                if (!result.ok) { box.remove(); return; }
                var data = result.data;
                var files = data.entries.filter(function (entry) { return !entry.isDir; }).length;
                box.appendChild(make('div', 'zip-title', data.total + (data.total === 1 ? ' entry' : ' entries') + (files !== data.total ? ' (' + files + ' files)' : '')));
                data.entries.forEach(function (entry) {
                    var row = make('div', 'zip-row');
                    row.appendChild(make('span', 'zip-name', entry.name));
                    row.appendChild(make('span', 'muted', entry.isDir ? '' : window.StashlyUpload.formatSize(entry.size)));
                    box.appendChild(row);
                });
                if (data.truncated) box.appendChild(make('div', 'muted', 'And ' + (data.total - data.entries.length) + ' more.'));
            })
            .catch(function () { box.remove(); });
    }

    function copyButton(label, className, value) {
        return button(label, className, function (event) {
            var target = event.currentTarget;
            Promise.resolve(copyText(value)).then(function (ok) {
                toast(ok ? 'Copied' : 'Could not copy. Select the text and copy it by hand.', !ok);
                if (ok) { setLabel(target, 'Copied'); setTimeout(function () { setLabel(target, label); }, 1500); }
            });
        });
    }

    // Asks the server for a burn note's text. The note is deleted as it is handed over, so what is shown here
    // is the only copy; it stays on screen until another clip is opened.
    function revealBurn(item, trigger) {
        trigger.disabled = true;
        state.revealedId = item.id;
        api(base + '/items/' + item.id + '/reveal', { method: 'POST' }).then(function (res) {
            if (res.status === 401) { locked(); return; }
            if (!res.ok) {
                trigger.disabled = false;
                state.revealedId = null;
                toast((res.body && res.body.error) || 'Could not reveal that note.', true);
                if (res.status === 404) onItemDeleted(item.id);
                return;
            }
            onItemDeleted(item.id);
            if (state.selectedId !== item.id) return;
            var actions = $('detailActions');
            var body = $('detailBody');
            actions.textContent = '';
            body.textContent = '';
            $('detailMeta').textContent = 'Revealed once · now deleted for everyone';
            body.appendChild(make('pre', 'detail-text', res.body.text));
            actions.appendChild(copyButton('Copy', 'primary', res.body.text));
            actions.appendChild(button('Done', 'ghost', function () {
                state.revealedId = null;
                showSomethingElse(0);
            }));
        }).catch(function () {
            trigger.disabled = false;
            state.revealedId = null;
            toast('Could not reach the server.', true);
        });
    }

    // What a note looks like: a code or data language, 'markdown', 'slack' for a note pasted from a chat app, or null
    // for plain text. A note with a fenced code block is Markdown whatever is inside the fences; otherwise code is
    // checked before Markdown, because a shell comment starts with the same # as a Markdown heading. Chat formatting is
    // checked first: one asterisk for bold, • bullets and :emoji: names do not appear in code or in ordinary prose.
    function detectFormat(text) {
        var markdown = window.StashlyMarkdown;
        var highlight = window.StashlyHighlight;
        if (markdown && markdown.looksSlack(text)) return 'slack';
        if (markdown && markdown.hasFence(text)) return 'markdown';
        var code = highlight ? highlight.detect(text) : null;
        if (code) return code;
        return markdown && markdown.looks(text) ? 'markdown' : null;
    }

    function renderDetail(item) {
        var actions = $('detailActions');
        var body = $('detailBody');
        actions.textContent = '';
        body.textContent = '';
        $('detailTitle').textContent = itemTitle(item);
        var when = new Date(item.createdAt).toLocaleString();

        if (item.kind === 'note' && item.burn) {
            // The text is not here: it stays on the server until someone reveals it, and then it is deleted
            $('detailMeta').textContent = ['Note', 'Burns after reading', item.expiresAt ? expiryText(item.expiresAt) : '', when].filter(Boolean).join(' · ');
            var warning = make('div', 'burn-card');
            warning.appendChild(make('strong', null, 'This note burns after reading.'));
            warning.appendChild(make('span', 'muted', 'Its text has not been sent to this page. Revealing it shows it once and deletes it for everyone, so be ready to copy it.'));
            body.appendChild(warning);
            // Revealing deletes the note, so a read-only link cannot do it
            if (role() === 'full') actions.appendChild(button('Reveal and delete', 'primary', function (event) { revealBurn(item, event.currentTarget); }));
            else warning.appendChild(make('strong', null, 'Only someone with full access can reveal it.'));
        } else if (item.kind === 'note' && item.truncated) {
            // Only the start of a long note is here: fetch the rest, then draw it again
            $('detailMeta').textContent = ['Note', item.textLength + ' characters', when].join(' · ');
            body.appendChild(make('p', 'muted', 'Loading the whole note…'));
            loadFull(item).then(function () {
                var current = findItem(item.id) || item;
                if (state.selectedId === item.id && state.editingId !== item.id && state.revealedId !== item.id) renderDetail(current);
            }, function () {
                body.textContent = '';
                body.appendChild(make('p', 'muted', 'Could not load this note. Try again.'));
            });
        } else if (item.kind === 'note') {
            var language = detectFormat(item.text);
            $('detailMeta').textContent = ['Note', item.secret ? 'Secret' : '', item.expiresAt ? expiryText(item.expiresAt) : '', (item.text || '').length + ' characters', when, item.editedAt ? 'edited ' + relativeTime(item.editedAt) : ''].filter(Boolean).join(' · ');
            var pre = make('div', 'detail-text');
            body.appendChild(pre);
            // Web addresses are clickable; Markdown is rendered and code is coloured when it is recognised, and
            // "Plain text" turns that off (the text itself is never changed)
            var shown = !item.secret;
            var plain = Boolean(state.plainIds[item.id]);
            var paint = function () {
                pre.textContent = '';
                // Markdown and chat text are both drawn as blocks; the style picks which rules apply
                var rich = language === 'markdown' || language === 'slack';
                var asMarkdown = shown && !plain && rich && window.StashlyMarkdown;
                pre.classList.toggle('md', Boolean(asMarkdown));
                if (!shown) { pre.textContent = MASK; return; }
                if (asMarkdown) pre.appendChild(window.StashlyMarkdown.render(item.text, window.StashlyHighlight, language));
                else if (window.StashlyHighlight) pre.appendChild(window.StashlyHighlight.render(item.text, plain || rich ? null : language));
                else pre.textContent = item.text;
            };
            paint();
            actions.appendChild(copyButton('Copy', 'primary', item.text));
            if (item.secret) {
                actions.appendChild(button('Show', 'ghost', function (event) {
                    shown = !shown;
                    paint();
                    setLabel(event.currentTarget, shown ? 'Hide' : 'Show');
                }));
            }
            if (language) {
                var rich = language === 'markdown' || language === 'slack';
                var label = language === 'markdown' ? 'Markdown' : language === 'slack' ? 'Slack text' : window.StashlyHighlight.label(language);
                var verb = rich ? 'Render ' : 'Highlight ';
                actions.appendChild(button(plain ? verb + label : 'Plain text', 'ghost', function (event) {
                    plain = !plain;
                    state.plainIds[item.id] = plain;
                    setLabel(event.currentTarget, plain ? verb + label : 'Plain text');
                    paint();
                }));
            }
            if (role() === 'full') actions.appendChild(button('Edit', 'ghost', function () { editNote(item); }));
        } else {
            $('detailMeta').textContent = [fileKind(item), window.StashlyUpload.formatSize(item.fileSize), when, item.editedAt ? 'edited ' + relativeTime(item.editedAt) : ''].filter(Boolean).join(' · ');

            var download = make('a', 'button-link primary-link');
            setLabel(download, 'Download');
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

                // Audio and video play in the page, a PDF opens in its own tab, a zip shows what is inside
                var mediaType = (item.fileType || '').split(';')[0];
                if (/^(video|audio)\//.test(mediaType)) {
                    var player = make(mediaType.indexOf('video') === 0 ? 'video' : 'audio', 'detail-media');
                    player.controls = true;
                    player.preload = 'metadata';
                    player.src = item.url;
                    body.insertBefore(player, card);
                } else if (mediaType === 'application/pdf') {
                    var open = make('a', 'button-link');
                    setLabel(open, 'Open');
                    open.href = item.url + '?view=1';
                    open.target = '_blank';
                    open.rel = 'noopener';
                    actions.appendChild(open);
                } else if (mediaType === 'application/zip' && /\.zip$/i.test(item.fileName)) {
                    showZipContents(item, body);
                }

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

        if (role() === 'full') {
            if (item.kind === 'file') actions.appendChild(button('Edit', 'ghost', function () { editFileTitle(item); }));
            actions.appendChild(button(item.pinned ? 'Unpin' : 'Pin', 'ghost', function () { setPinned(item, !item.pinned); }));
            actions.appendChild(button('Delete', 'danger-ghost', function () { removeItem(item); }));
        }
        body.scrollTop = 0;
    }

    document.querySelectorAll('[data-back]').forEach(function (el) {
        el.addEventListener('click', function () { setPane('list'); });
    });

    // What the other parts use
    P.loadFull = loadFull;
    P.copyItem = copyItem;
    P.copyNote = copyNote;
    P.copyLatest = copyLatest;
    P.setPane = setPane;
    P.showNothing = showNothing;
    P.openItem = openItem;
    P.showSomethingElse = showSomethingElse;
    P.isTextType = isTextType;
    P.showZipContents = showZipContents;
    P.copyButton = copyButton;
    P.revealBurn = revealBurn;
    P.detectFormat = detectFormat;
    P.renderDetail = renderDetail;
})();
