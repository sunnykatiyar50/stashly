// The stash page, part 7 of 9: Options (tabs, rename, delete, password, sessions, keep the last N) and logging out.
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var slug = P.slug;
    var base = P.base;
    var $ = P.$;
    var state = P.state;
    var api = P.api;
    var toast = P.toast;
    var make = P.make;
    var expiryText = P.expiryText;
    var button = P.button;
    var role = P.role;
    var stashContent = P.stashContent;
    var untilText = P.untilText;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function applyContent() { return P.applyContent.apply(null, arguments); }
    function updateExpiry() { return P.updateExpiry.apply(null, arguments); }
    function load() { return P.load.apply(null, arguments); }
    function gone() { return P.gone.apply(null, arguments); }
    function locked() { return P.locked.apply(null, arguments); }
    function setTabFlag() { return P.setTabFlag.apply(null, arguments); }
    function notificationsReady() { return P.notificationsReady.apply(null, arguments); }

    // ---- keeping the stash longer ----
    // The clock chip in the header, the Extend button (and its place in the phone's three-dot menu) and Options > Expires all
    // open one dialog: pick how long, counted from now. Only lengths that end later than the stash does now are offered, and
    // the server decides who may (the owner; for a guest's stash anyone with full access).
    var extendDialog = $('extendDialog');
    var DATE_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };

    function canExtend() { return Boolean(state.stash && state.stash.canExtend); }

    // The lengths that still end later than the stash does now (it may have been extended elsewhere since the page loaded)
    function choicesNow() {
        var ends = state.stash && state.stash.expiresAt ? new Date(state.stash.expiresAt).getTime() : null;
        return ((state.stash && state.stash.extendChoices) || []).filter(function (choice) {
            return choice.ms === null || ends === null || Date.now() + choice.ms > ends;
        });
    }

    function openExtend() {
        if (!canExtend()) return;
        var choices = choicesNow();
        $('extendError').textContent = '';
        $('extendNow').textContent = state.stash.expiresAt
            ? expiryText(state.stash.expiresAt) + ' (' + new Date(state.stash.expiresAt).toLocaleString(undefined, DATE_FORMAT) + '). Pick a new end time, counted from now.'
            : 'This stash never expires.';
        var list = $('extendChoices');
        list.textContent = '';
        if (!choices.length) {
            var none = document.createElement('p');
            none.className = 'muted';
            none.textContent = 'There is no longer time to choose: this is already the longest.';
            list.appendChild(none);
        }
        choices.forEach(function (choice) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'extend-choice' + (choice.restart ? ' restart' : '');
            var name = document.createElement('strong');
            name.textContent = choice.never ? 'Never delete it' : choice.label;
            var when = document.createElement('span');
            when.className = 'muted';
            when.textContent = (choice.never ? 'It stays until someone deletes it' : 'Ends ' + new Date(Date.now() + choice.ms).toLocaleString(undefined, DATE_FORMAT)) + (choice.restart ? ' · restarts its usual length' : '');
            button.appendChild(name);
            button.appendChild(when);
            button.addEventListener('click', function () { extendTo(choice, button); });
            list.appendChild(button);
        });
        // "Never" is an admin setting; without it the list stops at the longest length, so say why there is no such choice
        if (state.stash.expiresAt && !state.stash.neverAllowed) {
            var note = document.createElement('p');
            note.className = 'muted extend-note';
            note.textContent = 'Never is not offered: this server does not allow stashes that never expire. An admin can turn it on in Admin > Settings > Stashes.';
            list.appendChild(note);
        }
        if (typeof extendDialog.showModal === 'function') extendDialog.showModal(); else extendDialog.setAttribute('open', '');
        var first = list.querySelector('button');
        if (first) first.focus();
    }

    function extendTo(choice, trigger) {
        Array.prototype.forEach.call($('extendChoices').querySelectorAll('button'), function (b) { b.disabled = true; });
        api(base + '/extend', { method: 'POST', body: { ttl: choice.key } }).then(function (res) {
            if (res.ok) {
                state.stash.expiresAt = res.body.expiresAt;
                state.stash.canExtend = res.body.canExtend;
                state.stash.extendChoices = res.body.extendChoices;
                extendDialog.close();
                paintExpiryAction();
                updateExpiry();
                // Say clearly that it worked and what it ends now
                toast(res.body.expiresAt
                    ? 'Extended "' + slug + '". ' + expiryText(res.body.expiresAt) + ' (' + new Date(res.body.expiresAt).toLocaleString(undefined, DATE_FORMAT) + ').'
                    : 'Extended "' + slug + '". It no longer expires.');
            } else if (res.status === 401) {
                extendDialog.close();
                locked();
            } else {
                Array.prototype.forEach.call($('extendChoices').querySelectorAll('button'), function (b) { b.disabled = false; });
                $('extendError').textContent = (res.body && res.body.error) || 'Could not extend.';
                // Someone may have extended it already: do not offer what no longer helps
                if (res.status === 409) { trigger.remove(); }
            }
        }).catch(function () {
            Array.prototype.forEach.call($('extendChoices').querySelectorAll('button'), function (b) { b.disabled = false; });
            $('extendError').textContent = 'Could not reach the server.';
        });
    }

    $('extendCancel').addEventListener('click', function () { extendDialog.close(); });
    extendDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('extendButton').addEventListener('click', openExtend);
    // Opened on top of Options, which stays under it: Cancel, Escape or Back come back to Options, and after extending the
    // Expires row there already shows the new time
    $('optExtendButton').addEventListener('click', openExtend);

    // The clock chip becomes the way in when the stash can be extended: easy to find, and it says what it does
    var expiryChip = $('expiryInfo');

    function paintExpiryAction() {
        var on = canExtend();
        expiryChip.classList.toggle('extendable', on);
        if (on) { expiryChip.setAttribute('role', 'button'); expiryChip.tabIndex = 0; } else { expiryChip.removeAttribute('role'); expiryChip.removeAttribute('tabindex'); }
        expiryChip.dataset.tip = on ? 'Press to keep it longer' : 'When this stash is deleted';
        $('extendButton').classList.toggle('hidden', !on);
        paintExpiryRow();
    }

    expiryChip.addEventListener('click', function () { if (canExtend()) openExtend(); });
    expiryChip.addEventListener('keydown', function (event) {
        if ((event.key === 'Enter' || event.key === ' ') && canExtend()) { event.preventDefault(); openExtend(); }
    });

    // Options > General > Expires: when it ends, and the same way to extend it
    function paintExpiryRow() {
        var row = document.querySelector('[data-option="expiry"]');
        var manage = role() === 'full' && Boolean(state.stash && state.stash.canManage);
        row.classList.toggle('hidden', !manage);
        if (!manage) return;
        $('optExpiry').textContent = state.stash.expiresAt
            ? expiryText(state.stash.expiresAt) + ' (' + new Date(state.stash.expiresAt).toLocaleString(undefined, DATE_FORMAT) + ').'
            : 'This stash never expires.';
        $('optExtendButton').classList.toggle('hidden', !canExtend());
    }

    P.paintExpiryAction = paintExpiryAction;

    // Renaming the stash (whoever manages it). The name is a field in Options > General that is always there: change it and
    // press Rename. The address changes, so this page moves to the new one when it is done.
    var renameForm = $('renameForm');

    // Back to the stash's own name, with the button waiting for a change
    function closeRenameForm() {
        $('renameInput').value = slug;
        $('renameError').textContent = '';
        $('renameSave').disabled = true;
    }

    $('renameInput').addEventListener('input', function () {
        $('renameSave').disabled = $('renameInput').value.trim().toLowerCase() === slug || !$('renameInput').value.trim();
        $('renameError').textContent = '';
    });

    renameForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('renameError');
        error.textContent = '';
        var next = $('renameInput').value.trim().toLowerCase();
        if (!next) { error.textContent = 'A stash name is required.'; return; }
        if (next === slug) { error.textContent = 'That is already the name of this stash.'; return; }
        if (!/^[a-z0-9_-]+$/.test(next)) { error.textContent = 'Use only letters, numbers, dashes and underscores.'; return; }
        $('renameSave').disabled = true;
        api(base + '/rename', { method: 'POST', body: { slug: next } }).then(function (res) {
            $('renameSave').disabled = false;
            if (res.ok) {
                if (window.StashlyRenamed) window.StashlyRenamed(slug, res.body.slug);
                // Move to the new address: the old one no longer exists
                location.replace(res.body.url);
            } else if (res.status === 401) {
                $('optionsDialog').close();
                locked();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not rename the stash.';
            }
        }).catch(function () { $('renameSave').disabled = false; error.textContent = 'Could not reach the server.'; });
    });

    // Passing ownership on (the owner only). The server checks everything; this asks once more, since only the new owner can
    // undo it. Afterwards the page is loaded again, because it no longer belongs to you.
    var ownerForm = $('ownerForm');

    function closeOwnerForm() {
        ownerForm.classList.add('hidden');
        ownerForm.reset();
        $('ownerError').textContent = '';
        $('ownerToggle').classList.remove('hidden');
    }

    $('ownerToggle').addEventListener('click', function (event) {
        ownerForm.classList.remove('hidden');
        event.currentTarget.classList.add('hidden');
        $('ownerInput').focus();
    });

    $('ownerCancel').addEventListener('click', closeOwnerForm);

    ownerForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('ownerError');
        error.textContent = '';
        var username = $('ownerInput').value.trim();
        if (!username) { error.textContent = 'Enter the username of the new owner.'; $('ownerInput').focus(); return; }
        if (!window.confirm('Pass "' + slug + '" on to ' + username + '? You will no longer own it, and only they can pass it on again.')) return;
        $('ownerSave').disabled = true;
        api(base + '/owner', { method: 'POST', body: { username: username } }).then(function (res) {
            $('ownerSave').disabled = false;
            if (res.ok) {
                toast('"' + slug + '" now belongs to ' + res.body.owner + '.');
                location.reload();
            } else if (res.status === 401) {
                $('optionsDialog').close();
                locked();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not pass the stash on.';
                $('ownerInput').focus();
            }
        }).catch(function () { $('ownerSave').disabled = false; error.textContent = 'Could not reach the server.'; });
    });

    // Deleting the stash lives in Options, and needs the stash's name typed in, so it cannot happen by accident
    var deleteForm = $('deleteStashForm');

    function closeDeleteForm() {
        deleteForm.classList.add('hidden');
        deleteForm.reset();
        $('deleteStashConfirm').disabled = true;
        $('deleteStashButton').classList.remove('hidden');
    }

    $('deleteStashSlug').textContent = slug;

    $('deleteStashButton').addEventListener('click', function (event) {
        deleteForm.classList.remove('hidden');
        event.currentTarget.classList.add('hidden');
        $('deleteStashName').focus();
    });

    $('deleteStashCancel').addEventListener('click', closeDeleteForm);

    $('deleteStashName').addEventListener('input', function (event) {
        $('deleteStashConfirm').disabled = event.target.value.trim().toLowerCase() !== slug;
    });

    deleteForm.addEventListener('submit', function (event) {
        event.preventDefault();
        if ($('deleteStashName').value.trim().toLowerCase() !== slug) return;
        $('deleteStashConfirm').disabled = true;
        api(base, { method: 'DELETE' }).then(function (res) {
            if (res.ok) {
                closeDeleteForm();
                $('optionsDialog').close();
                gone();
            } else if (res.status === 401) {
                $('optionsDialog').close();
                locked();
            } else {
                $('deleteStashConfirm').disabled = false;
                toast((res.body && res.body.error) || 'Could not delete the stash.', true);
            }
        }).catch(function () { $('deleteStashConfirm').disabled = false; toast('Could not reach the server.', true); });
    });

    // The button's hint and the Options text say when this browser is signed out
    function updateSessionInfo() {
        var stash = state.stash;
        if (!stash) return;
        var end = stash.hasPassword && stash.sessionEndsAt;
        $('logoutButton').title = end
            ? 'Close this stash and forget its password in this browser. It would lock itself ' + untilText(end) + ' anyway.'
            : 'Close this stash';
        $('sessionInfo').textContent = end ? 'Signed in until ' + new Date(end).toLocaleString() + ' (' + untilText(end) + ').' : '';
        // The sign-in ran out while the page was open: ask for the password again
        if (end && new Date(end).getTime() <= Date.now()) load(true);
    }

    // "Close" clears this browser's sign-in for the stash and goes home. An open stash has nothing to clear: Close just goes home.
    function leaveStash() {
        // Closing a stash is leaving on purpose: the installed app should start at home next time
        if (window.StashlyLast) window.StashlyLast.clear(slug);
        if (!state.stash || !state.stash.hasPassword) { location.href = '/'; return; }
        api(base + '/logout', { method: 'POST' }).then(function () { location.href = '/'; }).catch(function () { location.href = '/'; });
    }

    $('logoutButton').addEventListener('click', leaveStash);

    $('logoutNow').addEventListener('click', leaveStash);

    // Change the stash's password. Whoever knows the current one is the owner, so it is asked for again here.
    var passwordForm = $('changePasswordForm');

    function closePasswordForm() {
        passwordForm.classList.add('hidden');
        passwordForm.reset();
        $('changePasswordError').textContent = '';
        $('changePasswordToggle').classList.remove('hidden');
    }

    function openPasswordForm(toggle) {
        passwordForm.classList.remove('hidden');
        toggle.classList.add('hidden');
        // The owner is signed in to their account, which is proof enough: they need not type the old password
        var owned = Boolean(state.stash && state.stash.owned);
        $('currentPasswordInput').classList.toggle('hidden', owned);
        (owned ? $('newPasswordInput') : $('currentPasswordInput')).focus();
    }

    $('changePasswordToggle').addEventListener('click', function (event) { openPasswordForm(event.currentTarget); });

    $('changePasswordCancel').addEventListener('click', closePasswordForm);

    passwordForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('changePasswordError');
        error.textContent = '';
        var current = $('currentPasswordInput').value;
        var next = $('newPasswordInput').value;
        var owned = Boolean(state.stash && state.stash.owned);
        if (!owned && !current) { error.textContent = 'Enter the current password.'; $('currentPasswordInput').focus(); return; }
        var minPassword = state.minPassword || 10;
        if (next.length < minPassword) { error.textContent = 'The new password must be at least ' + minPassword + ' characters.'; $('newPasswordInput').focus(); return; }
        if (next !== $('repeatPasswordInput').value) { error.textContent = 'The two new passwords do not match.'; $('repeatPasswordInput').focus(); return; }
        $('changePasswordSave').disabled = true;
        api(base + '/password', { method: 'POST', body: owned ? { newPassword: next } : { currentPassword: current, newPassword: next } }).then(function (res) {
            $('changePasswordSave').disabled = false;
            if (res.ok) {
                state.stash.sessionEndsAt = res.body.sessionEndsAt;
                // A password the owner chose is not an admin's doing any more, so the notice about it goes away
                state.stash.passwordResetAt = null;
                $('resetNotice').classList.add('hidden');
                // The stash had share links; they were cancelled with the old password
                if (state.stash.shareLinks) state.stash.shareLinks = { view: false, drop: false };
                closePasswordForm();
                updateSessionInfo();
                toast('Password changed. Everyone else was signed out.');
            } else if (res.status === 401 && res.body && res.body.field !== 'currentPassword') {
                locked();
            } else {
                error.textContent = (res.body && res.body.error) || 'Could not change the password.';
                if (res.status === 401) { $('currentPasswordInput').select(); }
            }
        }).catch(function () { $('changePasswordSave').disabled = false; error.textContent = 'Could not reach the server.'; });
    });

    var optionsDialog = $('optionsDialog');

    var NOTIFY_HINT = $('notifyHint').textContent;

    var KEEP_CHOICES = [5, 10, 20, 50, 100, 200, 500];

    function renderOptions() {
        // Start with the delete confirmation closed, so it always has to be asked for again
        closeDeleteForm();
        var protectedStash = Boolean(state.stash && state.stash.hasPassword);
        document.querySelector('[data-option="session"]').classList.toggle('hidden', !protectedStash);
        // The dialog sits outside the page section that carries the role classes, so the rows are hidden here. The stash's own
        // settings (name, expiry, tags, what it holds, keep-last, delete) are for whoever manages it: its owner, or anyone with
        // full access on a guest's stash (the server checks the same rule). Changing the password is for full access.
        var full = role() === 'full';
        var manage = Boolean(full && state.stash && state.stash.canManage);
        ['keep', 'danger', 'rename', 'content', 'filetypes', 'tags'].forEach(function (name) {
            document.querySelector('[data-option="' + name + '"]').classList.toggle('hidden', !manage);
        });
        paintExpiryRow();
        // Only the owner can pass the stash on (the server checks it too)
        document.querySelector('[data-option="owner"]').classList.toggle('hidden', !(manage && state.stash.owned));
        // So can the Private switch: it only means something for a stash that has an owner
        document.querySelector('[data-option="private"]').classList.toggle('hidden', !(manage && state.stash.owned));
        $('privateToggle').checked = Boolean(state.stash.private);
        closeOwnerForm();
        paintMoveRow(manage);
        renderTagManager();
        Array.prototype.forEach.call(document.querySelectorAll('input[name="stashContent"]'), function (input) {
            input.checked = input.value === stashContent();
        });
        restoreFileTypesChoice((state.stash && state.stash.fileTypes) || 'safe');
        closeRenameForm();
        closePasswordForm();
        $('changePasswordToggle').classList.toggle('hidden', role() !== 'full');
        if (protectedStash) {
            updateSessionInfo();
            var change = $('sessionChange');
            change.textContent = '';
            var keep = make('option', null, 'choose...');
            keep.value = '';
            change.appendChild(keep);
            state.sessionOptions.forEach(function (option) { var el = make('option', null, option.label); el.value = option.key; change.appendChild(el); });
        }
        $('autoCopyInput').checked = state.autoCopy;
        var ready = notificationsReady();
        var denied = ready && Notification.permission === 'denied';
        $('notifyInput').checked = state.notify;
        $('notifyInput').disabled = !ready || denied;
        $('notifyHint').textContent = !ready ? 'Notifications need a secure address (https or localhost), so they are off here.'
            : denied ? 'Notifications are blocked for this site in the browser settings.' : NOTIFY_HINT;
        var current = state.stash && state.stash.keepLast;
        var choices = KEEP_CHOICES.slice();
        if (current && choices.indexOf(current) === -1) { choices.push(current); choices.sort(function (a, b) { return a - b; }); }
        var select = $('keepSelect');
        select.textContent = '';
        var all = make('option', null, 'everything (no limit)');
        all.value = '';
        select.appendChild(all);
        choices.forEach(function (n) { var el = make('option', null, n + ' items'); el.value = String(n); select.appendChild(el); });
        select.value = current ? String(current) : '';
        updateOptionSections();
    }

    // ---- the groups: General, Organize, Access, This device, Danger zone ----
    // Down the left on a wide screen, across the top on a phone (the CSS decides), one group at a time. A group is shown only
    // when it has a row for this visitor.
    var navItems = Array.prototype.slice.call(document.querySelectorAll('.opt-nav-item'));
    var sections = Array.prototype.slice.call(document.querySelectorAll('.opt-section'));
    var activeGroup = null;

    function sectionOf(key) { return document.getElementById('optSection-' + key); }

    function hasRows(section) {
        return Array.prototype.some.call(section.querySelectorAll('.share-row'), function (row) { return !row.classList.contains('hidden'); });
    }

    function selectGroup(key, focus) {
        activeGroup = key;
        navItems.forEach(function (item) {
            var on = item.dataset.group === key;
            item.setAttribute('aria-selected', on ? 'true' : 'false');
            item.tabIndex = on ? 0 : -1;
            sectionOf(item.dataset.group).classList.toggle('hidden', !on || !hasRows(sectionOf(item.dataset.group)));
            if (on && focus) item.focus();
        });
        document.getElementById('optScroll').scrollTop = 0;
    }

    // Which groups have anything for this visitor; keeps the one that was open, else the first
    function updateOptionSections() {
        navItems.forEach(function (item) { item.classList.toggle('hidden', !hasRows(sectionOf(item.dataset.group))); });
        var visible = navItems.filter(function (item) { return !item.classList.contains('hidden'); });
        // With a single group there is nothing to choose between
        document.getElementById('optLayout').classList.toggle('single', visible.length < 2);
        var pick = visible.filter(function (item) { return item.dataset.group === activeGroup; })[0] || visible[0];
        if (pick) selectGroup(pick.dataset.group, false);
    }

    navItems.forEach(function (item) {
        item.addEventListener('click', function () { selectGroup(item.dataset.group, false); });
        // Arrow keys move between the groups (up and down down the side, left and right across the top), Home and End go to the ends
        item.addEventListener('keydown', function (event) {
            var visible = navItems.filter(function (other) { return !other.classList.contains('hidden'); });
            var index = visible.indexOf(item);
            var next = null;
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = visible[(index + 1) % visible.length];
            else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = visible[(index - 1 + visible.length) % visible.length];
            else if (event.key === 'Home') next = visible[0];
            else if (event.key === 'End') next = visible[visible.length - 1];
            if (!next) return;
            event.preventDefault();
            selectGroup(next.dataset.group, true);
        });
    });

    // ---- short hints, the rest in a tooltip ----
    // A hint with data-more shows its short line. The rest is its tooltip (a mouse), and an "i" button next to it opens the
    // same words under it (a touch screen has no hover).
    Array.prototype.forEach.call(document.querySelectorAll('#optionsDialog [data-more]'), function (hint) {
        var more = hint.getAttribute('data-more');
        hint.title = more;
        var line = make('span', 'opt-hintline');
        hint.parentNode.insertBefore(line, hint);
        line.appendChild(hint);
        var info = make('button', 'opt-info', 'i');
        info.type = 'button';
        info.title = more;
        info.setAttribute('aria-label', 'More about this');
        info.setAttribute('aria-expanded', 'false');
        line.appendChild(info);
        var detail = make('span', 'muted opt-detail hidden', more);
        line.parentNode.insertBefore(detail, line.nextSibling);
        info.addEventListener('click', function () {
            var open = detail.classList.toggle('hidden') === false;
            info.setAttribute('aria-expanded', String(open));
        });
    });

    // ---- Options > Organize > Tags: every tag with its count, to rename or delete across the whole stash ----

    function tagError(message) { $('tagManagerError').textContent = message || ''; }

    // Applies a rename or a delete to what this page knows: the tag list, the strip above the list, the tags being filtered by
    function appliedTags(body, from, to) {
        state.tagList = body.tags || [];
        var filters = state.filters.tags || [];
        if (filters.indexOf(from) !== -1) {
            state.filters = { search: state.filters.search, startDate: state.filters.startDate, endDate: state.filters.endDate, tags: filters.filter(function (name) { return name !== from; }).concat(to && filters.indexOf(to) === -1 ? [to] : []) };
        }
        if (P.renderTagBar) P.renderTagBar();
        renderTagManager();
        // The rows show the new names: read the list again (other pages are told by the server)
        lastOwnTagChange = Date.now();
        load(true);
    }

    var lastOwnTagChange = 0;

    // Another page changed the tags: read the list again, unless this page just did
    function onTagsChanged() {
        if (Date.now() - lastOwnTagChange < 1500) return;
        load(true);
    }

    function tagRow(entry) {
        var row = make('div', 'tag-manage-row');
        var chip = make('span', 'tag-chip static');
        chip.appendChild(make('span', null, entry.name));
        row.appendChild(chip);
        row.appendChild(make('span', 'muted tag-manage-count', entry.count + (entry.count === 1 ? ' clip' : ' clips')));
        var actions = make('span', 'tag-manage-actions');
        var rename = make('button', 'ghost small', 'Rename');
        rename.type = 'button';
        rename.setAttribute('aria-label', 'Rename the tag ' + entry.name);
        var remove = make('button', 'danger-ghost small', 'Delete');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Delete the tag ' + entry.name);
        actions.appendChild(rename);
        actions.appendChild(remove);
        row.appendChild(actions);

        rename.addEventListener('click', function () {
            tagError('');
            row.textContent = '';
            var form = make('form', 'tag-rename-form');
            form.noValidate = true;
            var input = make('input', 'mono');
            input.type = 'text';
            input.maxLength = 24;
            input.value = entry.name;
            input.autocomplete = 'off';
            input.setAttribute('aria-label', 'New name for the tag ' + entry.name);
            var save = make('button', 'primary small', 'Save');
            save.type = 'submit';
            var cancel = make('button', 'ghost small', 'Cancel');
            cancel.type = 'button';
            form.appendChild(input);
            form.appendChild(save);
            form.appendChild(cancel);
            row.appendChild(form);
            input.focus();
            input.select();
            cancel.addEventListener('click', renderTagManager);
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                var to = P.cleanTag(input.value);
                if (!to) { tagError('A tag can only have letters, numbers, - and _ (up to 24 characters).'); input.focus(); return; }
                if (to === entry.name) { renderTagManager(); return; }
                save.disabled = true;
                api(base + '/tags/rename', { method: 'POST', body: { from: entry.name, to: to } }).then(function (res) {
                    if (res.ok) {
                        appliedTags(res.body, entry.name, to);
                        toast('Renamed ' + entry.name + ' to ' + to + ' on ' + res.body.changed + (res.body.changed === 1 ? ' clip' : ' clips'));
                    } else if (res.status === 401) { $('optionsDialog').close(); locked(); }
                    else { save.disabled = false; tagError((res.body && res.body.error) || 'Could not rename the tag.'); }
                }).catch(function () { save.disabled = false; tagError('Could not reach the server.'); });
            });
        });

        remove.addEventListener('click', function () {
            tagError('');
            if (!window.confirm('Remove the tag "' + entry.name + '" from ' + entry.count + (entry.count === 1 ? ' clip' : ' clips') + '? The clips stay.')) return;
            remove.disabled = true;
            api(base + '/tags/' + encodeURIComponent(entry.name), { method: 'DELETE' }).then(function (res) {
                if (res.ok) {
                    appliedTags(res.body, entry.name, null);
                    toast('Removed the tag ' + entry.name + ' from ' + res.body.changed + (res.body.changed === 1 ? ' clip' : ' clips'));
                } else if (res.status === 401) { $('optionsDialog').close(); locked(); }
                else { remove.disabled = false; tagError((res.body && res.body.error) || 'Could not remove the tag.'); }
            }).catch(function () { remove.disabled = false; tagError('Could not reach the server.'); });
        });
        return row;
    }

    function renderTagManager() {
        var box = $('tagManager');
        box.textContent = '';
        var list = state.tagList || [];
        if (!list.length) {
            box.appendChild(make('span', 'muted', 'No tags yet. Open a clip and add one on its Tags line.'));
            return;
        }
        list.forEach(function (entry) { box.appendChild(tagRow(entry)); });
    }

    // ---- Options > Organize > Move or copy clips ----

    // Offered to whoever manages the stash and is signed in (a clip can only go to a stash you own, and that needs an account)
    function paintMoveRow(manage) {
        var show = manage && P.signedIn && P.signedIn();
        document.querySelector('[data-option="move"]').classList.toggle('hidden', !show);
    }

    $('optSelectClips').addEventListener('click', function () {
        $('optionsDialog').close();
        if (P.setSelecting) P.setSelecting(true);
    });

    // What the stash can hold
    var CONTENT_WORDS = { all: 'This stash takes notes and files', notes: 'This stash now takes notes only', files: 'This stash now takes files only' };

    Array.prototype.forEach.call(document.querySelectorAll('input[name="stashContent"]'), function (input) {
        input.addEventListener('change', function () {
            if (!input.checked) return;
            var previous = stashContent();
            api(base + '/content', { method: 'PUT', body: { content: input.value } }).then(function (res) {
                if (res.ok) {
                    state.stash.content = res.body.content;
                    applyContent();
                    toast(CONTENT_WORDS[res.body.content]);
                } else {
                    restoreContentChoice(previous);
                    toast((res.body && res.body.error) || 'Could not change that.', true);
                }
            }, function () {
                restoreContentChoice(previous);
                toast('Could not reach the server.', true);
            });
        });
    });

    function restoreContentChoice(value) {
        Array.prototype.forEach.call(document.querySelectorAll('input[name="stashContent"]'), function (input) {
            input.checked = input.value === value;
        });
    }

    // Private: only the owner opens the stash
    $('privateToggle').addEventListener('change', function () {
        var box = $('privateToggle');
        var wanted = box.checked;
        if (wanted && !window.confirm('Make this stash private? Nobody else can open it, even with the password or a link, and anyone following it loses it until you turn this off. Links to single clips keep working.')) {
            box.checked = false;
            return;
        }
        api(base + '/private', { method: 'PUT', body: { private: wanted } }).then(function (res) {
            if (res.ok) {
                state.stash.private = res.body.private;
                toast(res.body.private ? 'This stash is now private' : 'This stash is no longer private');
            } else {
                box.checked = !wanted;
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        }, function () {
            box.checked = !wanted;
            toast('Could not reach the server.', true);
        });
    });

    // Which files the stash takes
    var FILE_TYPES_WORDS = { safe: 'This stash takes the safe list of files', 'no-programs': 'This stash takes any file except programs', any: 'This stash takes any file' };

    function restoreFileTypesChoice(value) {
        Array.prototype.forEach.call(document.querySelectorAll('input[name="stashFileTypes"]'), function (input) {
            input.checked = input.value === value;
        });
    }

    Array.prototype.forEach.call(document.querySelectorAll('input[name="stashFileTypes"]'), function (input) {
        input.addEventListener('change', function () {
            if (!input.checked) return;
            var previous = (state.stash && state.stash.fileTypes) || 'safe';
            api(base + '/file-types', { method: 'PUT', body: { fileTypes: input.value } }).then(function (res) {
                if (res.ok) {
                    state.stash.fileTypes = res.body.fileTypes;
                    toast(FILE_TYPES_WORDS[res.body.fileTypes]);
                } else {
                    restoreFileTypesChoice(previous);
                    toast((res.body && res.body.error) || 'Could not change that.', true);
                }
            }, function () {
                restoreFileTypesChoice(previous);
                toast('Could not reach the server.', true);
            });
        });
    });

    // Opens Options, on one group when the caller names it ('signin' is the Access group) and it has something for this visitor
    function openOptions(group) {
        renderOptions();
        if (typeof optionsDialog.showModal === 'function') optionsDialog.showModal(); else optionsDialog.setAttribute('open', '');
        var key = group === 'signin' ? 'access' : group;
        if (key && !navItems.some(function (item) { return item.dataset.group === key && item.classList.contains('hidden'); })) selectGroup(key, false);
    }

    $('optionsButton').addEventListener('click', function () { openOptions(); });

    // A link to a stash's settings (the gear on My stashes) ends in #options, or #options=general / organize / access. Once the
    // stash has loaded, Options opens on it and the address goes back to the stash's own.
    function openOptionsFromAddress() {
        var found = /^#options(?:=([a-z]+))?$/.exec(location.hash);
        if (!found) return;
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the address keeps it */ }
        // The stash's first batch can arrive while the page is still being read, before back.js is watching dialogs: wait until it is
        // ready, so that Back closes Options instead of leaving the page
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { openOptions(found[1]); });
        else openOptions(found[1]);
    }
    P.openOptionsFromAddress = openOptionsFromAddress;

    // From the notice that an admin chose this stash's password, straight to the form that puts it right
    $('resetNoticePassword').addEventListener('click', function () {
        openOptions('signin');
        var toggle = $('changePasswordToggle');
        if (!toggle.classList.contains('hidden')) openPasswordForm(toggle);
    });

    $('optionsClose').addEventListener('click', function () { optionsDialog.close(); });

    optionsDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });

    $('autoCopyInput').addEventListener('change', function (event) {
        state.autoCopy = event.target.checked;
        setTabFlag('autocopy', state.autoCopy);
        if (!state.autoCopy) state.pendingCopy = null;
        toast(state.autoCopy ? 'New notes from other devices will be copied' : 'Auto-copy is off');
    });

    $('notifyInput').addEventListener('change', function (event) {
        var box = event.target;
        if (!box.checked) { state.notify = false; setTabFlag('notify', false); return; }
        // Asking for permission has to come from a click, which this is
        Promise.resolve(Notification.requestPermission()).then(function (permission) {
            state.notify = permission === 'granted';
            box.checked = state.notify;
            setTabFlag('notify', state.notify);
            if (!state.notify) { toast('Notifications were not allowed', true); renderOptions(); }
        });
    });

    $('sessionChange').addEventListener('change', function (event) {
        var select = event.target;
        if (!select.value) return;
        api(base + '/session', { method: 'POST', body: { session: select.value } }).then(function (res) {
            select.value = '';
            if (res.ok) {
                state.stash.sessionEndsAt = res.body.sessionEndsAt;
                updateSessionInfo();
                toast(res.body.capped
                    ? 'A sign-in lasts at most 30 days, so you will be signed out ' + untilText(res.body.sessionEndsAt) + '. Unlock again to start a new one.'
                    : 'You will be signed out ' + untilText(res.body.sessionEndsAt));
            } else if (res.status === 401) {
                locked();
            } else {
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        });
    });

    // Ends every other sign-in to this stash (and sessions opened from share links); this browser stays signed in
    $('signOutOthers').addEventListener('click', function () {
        if (!window.confirm('Sign out every other browser and device from this stash? They will need the password again. Read-only and drop-box links keep working; cancel them under Share links if you need to.')) return;
        var button = $('signOutOthers');
        button.disabled = true;
        api(base + '/sign-out-others', { method: 'POST' }).then(function (res) {
            button.disabled = false;
            if (res.ok) {
                state.stash.sessionEndsAt = res.body.sessionEndsAt;
                updateSessionInfo();
                toast('Every other device was signed out');
            } else if (res.status === 401) {
                locked();
            } else {
                toast((res.body && res.body.error) || 'Could not sign the others out.', true);
            }
        }).catch(function () {
            button.disabled = false;
            toast('Could not reach the server.', true);
        });
    });

    $('keepSelect').addEventListener('change', function (event) {
        var select = event.target;
        var keep = select.value ? Number(select.value) : null;
        var previous = state.stash.keepLast || null;
        var unpinned = state.items.filter(function (item) { return !item.pinned; }).length;
        if (keep && unpinned > keep && !window.confirm('This deletes the oldest unpinned items now, keeping the newest ' + keep + '. Continue?')) {
            select.value = previous ? String(previous) : '';
            return;
        }
        api(base + '/keep-last', { method: 'PUT', body: { keepLast: keep } }).then(function (res) {
            if (res.ok) {
                state.stash.keepLast = keep;
                toast(keep ? 'Keeping the last ' + keep + (res.body.removed ? '. Removed ' + res.body.removed + '.' : '') : 'Keeping everything');
            } else {
                select.value = previous ? String(previous) : '';
                toast((res.body && res.body.error) || 'Could not change that.', true);
            }
        });
    });

    // What the other parts use
    P.closeRenameForm = closeRenameForm;
    P.closeDeleteForm = closeDeleteForm;
    P.updateSessionInfo = updateSessionInfo;
    P.leaveStash = leaveStash;
    P.closePasswordForm = closePasswordForm;
    P.renderOptions = renderOptions;
    P.updateOptionSections = updateOptionSections;
    P.selectOptionGroup = selectGroup;
    P.renderTagManager = renderTagManager;
    P.onTagsChanged = onTagsChanged;
    P.restoreContentChoice = restoreContentChoice;
})();
