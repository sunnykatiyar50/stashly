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

    // Renaming the stash (full access only). The address changes, so this page moves to the new one when it is done.
    var renameForm = $('renameForm');

    function closeRenameForm() {
        renameForm.classList.add('hidden');
        renameForm.reset();
        $('renameError').textContent = '';
        $('renameToggle').classList.remove('hidden');
    }

    $('renameCurrent').textContent = slug;

    $('renameToggle').addEventListener('click', function (event) {
        renameForm.classList.remove('hidden');
        event.currentTarget.classList.add('hidden');
        $('renameInput').value = slug;
        $('renameInput').focus();
        $('renameInput').select();
    });

    $('renameCancel').addEventListener('click', closeRenameForm);

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
        // The dialog sits outside the page section that carries the role classes, so the rows are hidden here. Only
        // someone with full access can keep-last, delete the stash or change the password.
        var full = role() === 'full';
        document.querySelector('[data-option="keep"]').classList.toggle('hidden', !full);
        document.querySelector('[data-option="danger"]').classList.toggle('hidden', !full);
        document.querySelector('[data-option="rename"]').classList.toggle('hidden', !full);
        document.querySelector('[data-option="content"]').classList.toggle('hidden', !full);
        Array.prototype.forEach.call(document.querySelectorAll('input[name="stashContent"]'), function (input) {
            input.checked = input.value === stashContent();
        });
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
        updateOptionTabs();
    }

    var optionTabs = Array.prototype.slice.call(document.querySelectorAll('.opt-tab'));

    var optionTab = null;

    function panelOf(tab) { return $('optPanel-' + tab.dataset.tab); }

    // A tab is shown only when its panel has something for this visitor; the last one picked stays picked
    function updateOptionTabs() {
        optionTabs.forEach(function (tab) {
            var rows = panelOf(tab).querySelectorAll('.share-row');
            var any = Array.prototype.some.call(rows, function (row) { return !row.classList.contains('hidden'); });
            tab.classList.toggle('hidden', !any);
        });
        var visible = optionTabs.filter(function (tab) { return !tab.classList.contains('hidden'); });
        var pick = visible.filter(function (tab) { return tab.dataset.tab === optionTab; })[0] || visible[0];
        if (pick) selectOptionTab(pick, false);
    }

    function selectOptionTab(tab, focus) {
        optionTab = tab.dataset.tab;
        optionTabs.forEach(function (other) {
            var on = other === tab;
            other.setAttribute('aria-selected', on ? 'true' : 'false');
            other.tabIndex = on ? 0 : -1;
            panelOf(other).classList.toggle('hidden', !on);
        });
        if (focus) tab.focus();
    }

    optionTabs.forEach(function (tab) {
        tab.addEventListener('click', function () { selectOptionTab(tab, false); });
        // Arrow keys move between the tabs, Home and End go to the first and last
        tab.addEventListener('keydown', function (event) {
            var visible = optionTabs.filter(function (other) { return !other.classList.contains('hidden'); });
            var index = visible.indexOf(tab);
            var next = null;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = visible[(index + 1) % visible.length];
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = visible[(index - 1 + visible.length) % visible.length];
            else if (event.key === 'Home') next = visible[0];
            else if (event.key === 'End') next = visible[visible.length - 1];
            if (!next) return;
            event.preventDefault();
            selectOptionTab(next, true);
        });
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

    // Opens Options, on one tab when the caller names it (and only if that tab has something for this visitor)
    function openOptions(tab) {
        renderOptions();
        if (typeof optionsDialog.showModal === 'function') optionsDialog.showModal(); else optionsDialog.setAttribute('open', '');
        var chosen = optionTabs.filter(function (el) { return el.dataset.tab === tab && !el.classList.contains('hidden'); })[0];
        if (chosen) selectOptionTab(chosen, false);
    }

    $('optionsButton').addEventListener('click', function () { openOptions(); });

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
    P.panelOf = panelOf;
    P.updateOptionTabs = updateOptionTabs;
    P.selectOptionTab = selectOptionTab;
    P.restoreContentChoice = restoreContentChoice;
})();
