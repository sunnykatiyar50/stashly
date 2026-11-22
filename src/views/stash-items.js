// The stash page, part 4 of 9: changing items (pin, edit, delete) and the new-note box.
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
    var findItem = P.findItem;
    var button = P.button;
    var stashContent = P.stashContent;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function updateCounts() { return P.updateCounts.apply(null, arguments); }
    function showSomethingElse() { return P.showSomethingElse.apply(null, arguments); }
    function renderDetail() { return P.renderDetail.apply(null, arguments); }
    function locked() { return P.locked.apply(null, arguments); }
    function onItemAdded() { return P.onItemAdded.apply(null, arguments); }
    function onItemUpdated() { return P.onItemUpdated.apply(null, arguments); }

    function setPinned(item, pinned) {
        api(base + '/items/' + item.id + '/pin', { method: 'POST', body: { pinned: pinned } }).then(function (res) {
            if (res.ok) { onItemUpdated(res.body); toast(pinned ? 'Pinned' : 'Unpinned'); }
            else if (res.status === 401) locked();
            else toast((res.body && res.body.error) || 'Could not do that.', true);
        });
    }

    // The box a form shows when a save finds the item changed by someone else since the form was opened. The form
    // (and what was typed in it) stays as it is, and there are two real buttons: overwrite their version with mine, or
    // drop mine and take theirs. Built fresh each time so screen readers announce it.
    function conflictPrompt(form, noun) {
        var box = null;
        function clear() { if (box) { box.remove(); box = null; } }
        function show(onOverwrite, onTheirs) {
            clear();
            box = make('div', 'edit-conflict');
            box.setAttribute('role', 'alert');
            box.tabIndex = -1;
            box.appendChild(make('p', '', 'Someone else changed this ' + noun + ' while you were editing.'));
            var row = make('div', 'edit-conflict-actions');
            row.appendChild(button('Overwrite with mine', 'primary', onOverwrite));
            row.appendChild(button('Use theirs', 'ghost', onTheirs));
            box.appendChild(row);
            form.appendChild(box);
            box.focus();
        }
        return { show: show, clear: clear };
    }

    // Give a file a title of its own: the title becomes a field above the file. Empty goes back to the file's name.
    function editFileTitle(item) {
        state.editingId = item.id;
        // The version this form started from. The server compares it with the current one; a live update for this
        // item while the form is open does not change it (the form is never silently rebased onto someone else's edit).
        var baseEditedAt = item.editedAt || null;
        var actions = $('detailActions');
        var body = $('detailBody');
        actions.textContent = '';
        var form = make('form', 'edit-form');
        var title = make('input');
        title.type = 'text';
        title.maxLength = 150;
        title.placeholder = item.fileName;
        title.value = item.hasTitle ? item.title : '';
        title.setAttribute('aria-label', 'Title (empty uses the file name)');
        var hint = make('small', 'field-hint', 'Leave it empty to show the file name. The download keeps the real name.');
        var error = make('small', 'field-error');
        error.setAttribute('role', 'alert');
        form.appendChild(title);
        form.appendChild(hint);
        form.appendChild(error);
        body.insertBefore(form, body.firstChild);
        var conflict = conflictPrompt(form, 'file');

        function leave() {
            state.editingId = null;
            var current = findItem(item.id);
            if (current && state.selectedId === item.id) renderDetail(current); else showSomethingElse(0);
        }
        var save = button('Save', 'primary', function () { form.requestSubmit(); });
        actions.appendChild(save);
        actions.appendChild(button('Cancel', 'ghost', leave));

        function send() {
            error.textContent = '';
            conflict.clear();
            save.disabled = true;
            api(base + '/items/' + item.id, { method: 'PUT', body: { title: title.value, baseEditedAt: baseEditedAt } }).then(function (res) {
                save.disabled = false;
                if (res.ok) {
                    state.editingId = null;
                    onItemUpdated(res.body);
                    toast('Saved');
                } else if (res.status === 401) {
                    locked();
                } else if (res.status === 404) {
                    error.textContent = 'That file is gone.';
                } else if (res.status === 409 && res.body && res.body.conflict) {
                    var theirs = res.body.item;
                    save.disabled = true; // saving again would only conflict again: choose first
                    conflict.show(function () {
                        baseEditedAt = theirs.editedAt || null;
                        send();
                    }, function () {
                        conflict.clear();
                        state.editingId = null;
                        if (findItem(item.id)) onItemUpdated(theirs); else leave();
                        toast('Showing their version');
                    });
                } else {
                    error.textContent = (res.body && res.body.error) || 'Could not save.';
                }
            }).catch(function () { save.disabled = false; error.textContent = 'Could not reach the server.'; });
        }
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            if (!save.disabled) send();
        });
        form.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') { event.preventDefault(); leave(); }
        });
        title.focus();
        title.select();
    }

    // Edit a note in place: the title and text become fields, Save sends them, Cancel goes back
    function editNote(item) {
        state.editingId = item.id;
        // The version this form started from (see editFileTitle): the server decides whether it is still current
        var baseEditedAt = item.editedAt || null;
        var actions = $('detailActions');
        var body = $('detailBody');
        actions.textContent = '';
        body.textContent = '';
        var form = make('form', 'edit-form');
        var title = make('input');
        title.type = 'text';
        title.maxLength = 150;
        title.placeholder = 'Title (Optional)';
        title.value = item.hasTitle ? item.title : '';
        title.setAttribute('aria-label', 'Title (optional)');
        var text = make('textarea');
        text.value = item.text;
        text.setAttribute('aria-label', 'Note');
        var error = make('small', 'field-error');
        error.setAttribute('role', 'alert');
        form.appendChild(title);
        form.appendChild(text);
        form.appendChild(error);
        body.appendChild(form);
        var conflict = conflictPrompt(form, 'note');

        function leave() {
            state.editingId = null;
            var current = findItem(item.id);
            if (current && state.selectedId === item.id) renderDetail(current); else showSomethingElse(0);
        }
        var save = button('Save', 'primary', function () { form.requestSubmit(); });
        actions.appendChild(save);
        actions.appendChild(button('Cancel', 'ghost', leave));

        function send() {
            error.textContent = '';
            conflict.clear();
            if (!text.value.trim()) { error.textContent = 'A note cannot be empty.'; text.focus(); return; }
            save.disabled = true;
            api(base + '/items/' + item.id, { method: 'PUT', body: { title: title.value, text: text.value, baseEditedAt: baseEditedAt } }).then(function (res) {
                save.disabled = false;
                if (res.ok) {
                    state.editingId = null;
                    onItemUpdated(res.body); // also shows the saved note in the pane
                    toast('Saved');
                } else if (res.status === 401) {
                    locked();
                } else if (res.status === 404) {
                    error.textContent = 'That note is gone.';
                } else if (res.status === 409 && res.body && res.body.conflict) {
                    // Nothing was saved and nothing typed here is lost: the form stays as it is
                    var theirs = res.body.item;
                    save.disabled = true; // saving again would only conflict again: choose first
                    conflict.show(function () {
                        baseEditedAt = theirs.editedAt || null;
                        send();
                    }, function () {
                        conflict.clear();
                        state.editingId = null;
                        if (findItem(item.id)) onItemUpdated(theirs); else leave();
                        toast('Showing their version');
                    });
                } else {
                    error.textContent = (res.body && res.body.error) || 'Could not save.';
                }
            }).catch(function () { save.disabled = false; error.textContent = 'Could not reach the server.'; });
        }
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            if (!save.disabled) send();
        });
        form.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); }
            else if (event.key === 'Escape') { event.preventDefault(); leave(); }
        });
        text.focus();
    }

    function onItemDeleted(id) {
        if (state.editingId === id) state.editingId = null;
        var index = state.items.findIndex(function (item) { return item.id === id; });
        state.items = state.items.filter(function (item) { return item.id !== id; });
        var el = document.querySelector('.clip[data-id="' + id + '"]');
        if (el) el.remove();
        updateCounts();
        // A note that was just revealed stays on screen (its text is no longer anywhere else) until another clip is opened
        if (state.selectedId === id && state.revealedId !== id) showSomethingElse(index);
    }

    // Brings a deleted item back (the Undo button). The live event may deliver it too: onItemAdded ignores a known id.
    function restoreItem(id) {
        api(base + '/items/' + id + '/restore', { method: 'POST' }).then(function (res) {
            if (res.ok) { onItemAdded(res.body); toast('Restored'); }
            else if (res.status === 401) locked();
            else if (res.status === 404) toast('Too late: that item cannot be brought back any more.', true);
            else toast((res.body && res.body.error) || 'Could not bring it back.', true);
        }).catch(function () { toast('Could not reach the server.', true); });
    }

    function removeItem(item) {
        api(base + '/items/' + item.id, { method: 'DELETE' }).then(function (res) {
            if (res.ok || res.status === 404) onItemDeleted(item.id);
            else if (res.status === 401) locked();
            else toast('Could not delete that.', true);
            if (res.ok && res.body && res.body.undoUntil) {
                // The Undo toast stays until the undo time is up, but never longer than 10 seconds
                var left = new Date(res.body.undoUntil).getTime() - Date.now();
                toast((item.kind === 'file' ? 'File' : 'Note') + ' deleted', false, {
                    action: { label: 'Undo', onClick: function () { restoreItem(item.id); } },
                    duration: left > 0 ? Math.min(10000, left) : 4000,
                });
            }
        });
    }

    $('composer').addEventListener('submit', function (event) {
        event.preventDefault();
        if (stashContent() === 'files') return;
        var input = $('noteInput');
        var error = $('noteError');
        error.textContent = '';
        var text = input.value;
        if (!text.trim()) { error.textContent = 'Write something first.'; input.focus(); return; }
        var submit = $('addNoteButton');
        submit.disabled = true;
        var note = {
            title: $('titleInput').value,
            text: text,
            burn: $('burnInput').checked,
            secret: $('secretInput').checked,
            expires: $('itemTtlSelect').value,
        };
        api(base + '/notes', { method: 'POST', body: note }).then(function (res) {
            submit.disabled = false;
            if (res.ok) {
                input.value = '';
                $('titleInput').value = '';
                // The options are for one note: the next one starts plain
                $('burnInput').checked = false;
                $('secretInput').checked = false;
                $('itemTtlSelect').value = '';
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

    // What the other parts use
    P.setPinned = setPinned;
    P.editFileTitle = editFileTitle;
    P.editNote = editNote;
    P.onItemDeleted = onItemDeleted;
    P.removeItem = removeItem;
    P.setExpanded = setExpanded;
})();
