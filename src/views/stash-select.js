// The stash page: select mode. A button above the list turns on a tick box on every clip; the bar that appears then pins,
// unpins or deletes the ticked clips together (the server does it in one request: POST /items/bulk). A delete is one
// Undo away, for all of them at once. Only for someone with full access.
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var base = P.base;
    var $ = P.$;
    var state = P.state;
    var api = P.api;
    var toast = P.toast;
    var findItem = P.findItem;

    // Functions that live in the other parts of the page, called through P when used so the load order does not matter
    function renderItems() { return P.renderItems.apply(null, arguments); }
    function onItemAdded() { return P.onItemAdded.apply(null, arguments); }
    function onItemUpdated() { return P.onItemUpdated.apply(null, arguments); }
    function onItemDeleted() { return P.onItemDeleted.apply(null, arguments); }
    function locked() { return P.locked.apply(null, arguments); }

    // The clip last ticked, where a Shift-click range starts
    var anchorId = null;

    function pickedIds() {
        return Object.keys(state.picked).map(Number);
    }

    function indexOfId(id) {
        return state.items.findIndex(function (item) { return item.id === id; });
    }

    function noun(n) {
        return n === 1 ? '1 clip' : n + ' clips';
    }

    // Brings the rows, the count and the buttons in line with what is ticked
    function updateBulk() {
        if (!state.selecting) return;
        // Clips that left the list (deleted here or elsewhere) are no longer ticked
        Object.keys(state.picked).forEach(function (id) {
            if (indexOfId(Number(id)) === -1) delete state.picked[id];
        });
        var ids = pickedIds();
        var items = ids.map(findItem).filter(Boolean);
        var pinnedCount = items.filter(function (item) { return item.pinned; }).length;
        $('bulkCount').textContent = ids.length ? ids.length + ' selected' : 'Nothing selected';
        var all = state.items.length > 0 && ids.length === state.items.length;
        $('bulkAll').textContent = all ? 'Clear' : 'Select all';
        $('bulkAll').title = state.hasMore ? 'Selects the clips loaded so far' : '';
        $('bulkAll').disabled = !state.items.length;
        // Pin is offered when a ticked clip is not pinned, Unpin when one is
        $('bulkPin').disabled = items.length === 0 || pinnedCount === items.length;
        $('bulkUnpin').disabled = pinnedCount === 0;
        // Move to... is for whoever manages the stash and is signed in (it goes to a stash of theirs)
        $('bulkMove').classList.toggle('hidden', !canMove());
        $('bulkMove').disabled = items.length === 0;
        $('bulkTag').disabled = items.length === 0;
        $('bulkUntag').disabled = !items.some(function (item) { return (item.tags || []).length; });
        $('bulkDelete').disabled = items.length === 0;
        Array.prototype.forEach.call($('items').children, function (el) {
            if (!el.dataset.id) return;
            var on = Boolean(state.picked[el.dataset.id]);
            el.classList.toggle('picked', on);
            el.setAttribute('aria-checked', String(on));
        });
    }

    function togglePick(id, range) {
        var at = indexOfId(id);
        if (at === -1) return;
        var from = anchorId === null ? -1 : indexOfId(anchorId);
        if (range && from !== -1) {
            // Shift-click: everything between the last ticked clip and this one, joining it in what that click does
            var turnOn = !state.picked[id];
            var lo = Math.min(from, at);
            var hi = Math.max(from, at);
            for (var i = lo; i <= hi; i++) {
                if (turnOn) state.picked[state.items[i].id] = true; else delete state.picked[state.items[i].id];
            }
        } else if (state.picked[id]) {
            delete state.picked[id];
        } else {
            state.picked[id] = true;
        }
        anchorId = id;
        updateBulk();
    }

    function setSelecting(on) {
        on = Boolean(on);
        if (state.selecting === on) return;
        state.selecting = on;
        state.picked = {};
        anchorId = null;
        $('selectToggle').setAttribute('aria-pressed', String(on));
        $('selectToggle').classList.toggle('active', on);
        $('bulkBar').classList.toggle('hidden', !on);
        $('items').classList.toggle('selecting', on);
        // The rows are drawn again, with a tick box (or the drag handle, when selecting ends)
        renderItems();
        updateBulk();
    }

    // After an action the ticks are cleared and select mode stays on, for the next round
    function clearPicks() {
        state.picked = {};
        anchorId = null;
        updateBulk();
    }

    // Sends one bulk request. Resolves to the answer's body, or null after telling the person what went wrong.
    function send(action, ids, failure) {
        return api(base + '/items/bulk', { method: 'POST', body: { action: action, ids: ids } }).then(function (res) {
            if (res.ok) return res.body;
            if (res.status === 401) locked();
            else toast((res.body && res.body.error) || failure, true);
            return null;
        }).catch(function () {
            toast('Could not reach the server.', true);
            return null;
        });
    }

    function setPinnedMany(pinned) {
        var ids = pickedIds().filter(function (id) {
            var item = findItem(id);
            return item && item.pinned !== pinned;
        });
        if (!ids.length) return;
        send(pinned ? 'pin' : 'unpin', ids, 'Could not do that.').then(function (body) {
            if (!body) return;
            body.items.forEach(onItemUpdated);
            clearPicks();
            toast((pinned ? 'Pinned ' : 'Unpinned ') + noun(body.items.length));
        });
    }

    // Brings back what a bulk delete removed (the Undo button), in one request
    function restoreMany(ids) {
        send('restore', ids, 'Could not bring them back.').then(function (body) {
            if (!body) return;
            body.items.forEach(onItemAdded);
            if (body.error) toast(body.items.length ? 'Restored ' + noun(body.items.length) + ', but not the rest: ' + body.error : body.error, true);
            else if (body.missing.length) toast(body.items.length ? 'Restored ' + noun(body.items.length) + '. The rest cannot be brought back any more.' : 'Too late: they cannot be brought back any more.', true);
            else toast('Restored ' + noun(body.items.length));
        });
    }

    function deleteMany() {
        var ids = pickedIds();
        if (!ids.length) return;
        var pinnedCount = ids.filter(function (id) { var item = findItem(id); return item && item.pinned; }).length;
        // Pinned clips were kept on purpose, so deleting them is asked about first
        var words = 'Delete ' + noun(ids.length) + (pinnedCount ? ', ' + (pinnedCount === 1 ? 'one of them pinned' : pinnedCount + ' of them pinned') : '') + '?';
        if (pinnedCount && !window.confirm(words)) return;
        send('delete', ids, 'Could not delete those.').then(function (body) {
            if (!body) return;
            // Clips the server did not find are gone already, so they leave the list too
            body.deleted.concat(body.missing).forEach(onItemDeleted);
            clearPicks();
            var message = noun(body.deleted.length) + ' deleted';
            if (!body.undoable.length) { toast(message); return; }
            // The Undo toast stays until the undo time is up, but never longer than 10 seconds
            var left = new Date(body.undoUntil).getTime() - Date.now();
            toast(message, false, {
                action: { label: 'Undo', onClick: function () { restoreMany(body.undoable); } },
                duration: left > 0 ? Math.min(10000, left) : 4000,
            });
        });
    }

    $('selectToggle').addEventListener('click', function () { setSelecting(!state.selecting); });
    $('bulkDone').addEventListener('click', function () {
        setSelecting(false);
        $('selectToggle').focus();
    });
    $('bulkAll').addEventListener('click', function () {
        var all = state.items.length > 0 && pickedIds().length === state.items.length;
        state.picked = {};
        if (!all) state.items.forEach(function (item) { state.picked[item.id] = true; });
        anchorId = null;
        updateBulk();
    });
    $('bulkPin').addEventListener('click', function () { setPinnedMany(true); });
    $('bulkUnpin').addEventListener('click', function () { setPinnedMany(false); });
    $('bulkDelete').addEventListener('click', deleteMany);

    // Adds one tag to the ticked clips, or takes one off. The name is asked for; the tags the ticked clips already
    // have are offered when taking one off.
    function tagManyAsk(add) {
        var ids = pickedIds();
        if (!ids.length) return;
        var have = [];
        ids.map(findItem).filter(Boolean).forEach(function (item) {
            (item.tags || []).forEach(function (tag) { if (have.indexOf(tag) === -1) have.push(tag); });
        });
        var question = add ? 'Add which tag to ' + noun(ids.length) + '?' : 'Remove which tag from ' + noun(ids.length) + '? (' + have.join(', ') + ')';
        var answer = window.prompt(question, '');
        if (answer === null) return;
        var tag = P.cleanTag(answer);
        if (!tag) { if (answer.trim()) toast('A tag can only have letters, numbers, - and _ (up to 24 characters).', true); return; }
        P.tagMany(add ? 'tag' : 'untag', ids, tag).then(function (body) {
            if (!body) return;
            body.items.forEach(onItemUpdated);
            clearPicks();
            var skipped = body.full && body.full.length ? ' (' + noun(body.full.length) + ' already had the most tags)' : '';
            toast((add ? 'Tagged ' : 'Untagged ') + noun(body.items.length) + ' ' + (add ? 'with ' : 'from ') + tag + skipped, Boolean(skipped));
        });
    }
    // ---- Move to... : the ticked clips go to another stash of yours, or are copied there ----

    function canMove() {
        return Boolean(state.stash && state.stash.canManage && P.signedIn && P.signedIn());
    }

    var moveDialog = $('moveDialog');

    function moveMode() {
        return document.querySelector('input[name="moveMode"]:checked').value;
    }

    function paintMoveButton() {
        $('moveSave').textContent = moveMode() === 'copy' ? 'Copy' : 'Move';
        $('moveTitle').textContent = (moveMode() === 'copy' ? 'Copy ' : 'Move ') + noun(pickedIds().length);
    }

    Array.prototype.forEach.call(document.querySelectorAll('input[name="moveMode"]'), function (input) { input.addEventListener('change', paintMoveButton); });

    function openMove() {
        var ids = pickedIds();
        if (!ids.length || !canMove()) return;
        document.querySelector('input[name="moveMode"][value="move"]').checked = true;
        paintMoveButton();
        $('moveIntro').textContent = 'The ticked clips go to another stash of yours. A moved clip keeps its tags and title, and a link made to it ends.';
        $('moveError').textContent = '';
        var select = $('moveTarget');
        select.textContent = '';
        select.disabled = true;
        $('moveSave').disabled = true;
        if (typeof moveDialog.showModal === 'function') moveDialog.showModal(); else moveDialog.setAttribute('open', '');
        // The stashes that are yours, other than this one
        api('/api/me/stashes').then(function (res) {
            if (!res.ok || !res.body) { $('moveError').textContent = 'Could not load your stashes.'; return; }
            var mine = res.body.stashes.filter(function (entry) { return entry.owned && entry.slug !== state.stash.slug; });
            if (!mine.length) { $('moveError').textContent = 'You have no other stash of your own to move them to. Make one first.'; return; }
            mine.forEach(function (entry) {
                var option = document.createElement('option');
                option.value = entry.slug;
                option.textContent = entry.label || entry.slug;
                select.appendChild(option);
            });
            select.disabled = false;
            $('moveSave').disabled = false;
            select.focus();
        }).catch(function () { $('moveError').textContent = 'Could not reach the server.'; });
    }

    $('moveCancel').addEventListener('click', function () { moveDialog.close(); });
    moveDialog.addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.close(); });
    $('bulkMove').addEventListener('click', openMove);
    $('moveForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var ids = pickedIds();
        var to = $('moveTarget').value;
        var copy = moveMode() === 'copy';
        if (!ids.length || !to) return;
        $('moveSave').disabled = true;
        $('moveError').textContent = '';
        api(base + '/items/move', { method: 'POST', body: { ids: ids, to: to, copy: copy } }).then(function (res) {
            $('moveSave').disabled = false;
            if (res.ok) {
                moveDialog.close();
                (res.body.moved || []).forEach(function (id) { onItemDeleted(id); });
                clearPicks();
                var done = copy ? res.body.copied.length : res.body.moved.length;
                var skipped = res.body.skipped.length;
                var reasons = { gone: 'no longer there', burn: 'burn-after-reading notes are not copied', kind: 'that stash does not take them' };
                var why = skipped ? ' (' + skipped + ' left out: ' + Array.from(new Set(res.body.skipped.map(function (item) { return reasons[item.reason] || item.reason; }))).join(', ') + ')' : '';
                toast((copy ? 'Copied ' : 'Moved ') + noun(done) + ' to ' + res.body.target + why, !done && skipped > 0);
            } else if (res.status === 401) {
                moveDialog.close();
                locked();
            } else {
                $('moveError').textContent = (res.body && res.body.error) || 'Could not do that.';
            }
        }).catch(function () { $('moveSave').disabled = false; $('moveError').textContent = 'Could not reach the server.'; });
    });

    $('bulkTag').addEventListener('click', function () { tagManyAsk(true); });
    $('bulkUntag').addEventListener('click', function () { tagManyAsk(false); });
    // Escape leaves select mode (when the keyboard is in the clip list or its bar)
    $('items').closest('.clip-pane').addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && state.selecting) {
            setSelecting(false);
            $('selectToggle').focus();
        }
    });

    P.togglePick = togglePick;
    P.setSelecting = setSelecting;
    P.updateBulk = updateBulk;
})();
