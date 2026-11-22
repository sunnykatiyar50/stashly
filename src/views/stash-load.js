// The stash page, part 5 of 9: loading the stash, the header, locked and gone states, and search and dates.
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var slug = P.slug;
    var base = P.base;
    var $ = P.$;
    var state = P.state;
    var sections = P.sections;
    var narrow = P.narrow;
    var api = P.api;
    var toast = P.toast;
    var show = P.show;
    var relativeTime = P.relativeTime;
    var expiryText = P.expiryText;
    var findItem = P.findItem;
    var role = P.role;
    var stashContent = P.stashContent;
    var CLOCK_ICON = P.CLOCK_ICON;
    var setChip = P.setChip;
    var shortExpiry = P.shortExpiry;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function renderItems() { return P.renderItems.apply(null, arguments); }
    function openItem() { return P.openItem.apply(null, arguments); }
    function showSomethingElse() { return P.showSomethingElse.apply(null, arguments); }
    function renderDetail() { return P.renderDetail.apply(null, arguments); }
    function closeStream() { return P.closeStream.apply(null, arguments); }
    function onItemDeleted() { return P.onItemDeleted.apply(null, arguments); }
    function connect() { return P.connect.apply(null, arguments); }
    function updateSessionInfo() { return P.updateSessionInfo.apply(null, arguments); }

    function applyContent() {
        var content = stashContent();
        sections.main.classList.toggle('content-notes', content === 'notes');
        sections.main.classList.toggle('content-files', content === 'files');
        $('titleInput').placeholder = content === 'files' ? 'Title for the next file (Optional)' : 'Title (Optional)';
    }

    function applyRole() {
        var r = role();
        sections.main.classList.toggle('role-view', r === 'view');
        sections.main.classList.toggle('role-drop', r === 'drop');
        // Options has nothing for a drop-box link (it may be in the top bar, outside the section above)
        $('optionsButton').classList.toggle('hidden', r === 'drop');
        var banner = $('roleBanner');
        banner.classList.toggle('hidden', r === 'full');
        banner.textContent = r === 'view'
            ? 'You opened a read-only link. You can read and copy, but not add or delete anything.'
            : r === 'drop' ? 'You opened a drop-box link. You can add notes and files here, but you cannot see what is in the stash.' : '';
        // Log out of a password-protected stash, or just leave an open one
        var leaveWord = state.stash.hasPassword ? 'Log out' : 'Exit';
        $('logoutButton').querySelector('.btn-label').textContent = leaveWord;
        $('logoutButton').setAttribute('aria-label', leaveWord);
        updateSessionInfo();
        // Share links only make sense on a password-protected stash, and only for someone with full access
        $('shareButton').classList.toggle('hidden', !(r === 'full' && state.stash.hasPassword));
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
        var words = expiryText(state.stash.expiresAt);
        setChip(chip, words, shortExpiry(words), CLOCK_ICON);
        var soon = state.stash.expiresAt && new Date(state.stash.expiresAt).getTime() - Date.now() < 60 * 60 * 1000;
        chip.classList.toggle('warn', Boolean(soon));
        if (state.stash.expiresAt && new Date(state.stash.expiresAt).getTime() <= Date.now()) load(true);
    }

    function updateTimes() {
        Array.prototype.forEach.call(document.querySelectorAll('.item-time'), function (el) {
            el.textContent = relativeTime(el.dataset.iso);
        });
        // Notes with their own expiry: count down, and drop them from the page when the time is up
        state.items.filter(function (item) { return item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now(); })
            .forEach(function (item) { onItemDeleted(item.id); });
        Array.prototype.forEach.call(document.querySelectorAll('.clip-flags [data-expires]'), function (el) {
            var words = expiryText(el.dataset.expires);
            el.title = words;
            el.setAttribute('aria-label', words);
            var short = el.querySelector('.clip-flag-short');
            if (short) short.textContent = shortExpiry(words);
        });
        updateExpiry();
        updateSessionInfo();
    }

    function load(quiet) {
        var f = state.filters;
        // Sent in the body, not the address, so search words never end up in a proxy's access log
        // preview: long notes come as their first part only; the rest is fetched when a note is opened or copied
        var query = { tz: String(new Date().getTimezoneOffset()), preview: true };
        if (f.search) query.search = f.search;
        if (f.startDate) query.startDate = f.startDate;
        if (f.endDate) query.endDate = f.endDate;
        return api(base + '/query', { method: 'POST', body: query }).then(function (res) {
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
            var previousIndex = state.items.findIndex(function (item) { return item.id === state.selectedId; });
            state.stash = res.body;
            state.items = res.body.items;
            // Only a stash opened with full access is worth suggesting on the share page
            if (window.StashlyRemember && res.body.role === 'full') window.StashlyRemember(slug);
            // The installed app reopens this stash next time it is launched (whatever the role: a link visitor too)
            if (window.StashlyLast) window.StashlyLast.set(slug);
            applyRole();
            applyContent();
            sections.main.classList.contains('hidden') && show('main');
            updateHeader();
            renderItems();
            connect();

            if (!state.started) {
                state.started = true;
                // Desktop opens the newest clip (the usual reason to visit); a phone starts on the list
                if (!narrow.matches && state.items.length) openItem(state.items[0].id);
            } else if (state.selectedId !== null && state.revealedId !== state.selectedId) {
                if (findItem(state.selectedId)) { if (state.editingId !== state.selectedId) renderDetail(findItem(state.selectedId)); }
                else showSomethingElse(previousIndex);
            }
        }).catch(function () {
            if (!quiet) toast('Could not reach the server.', true);
        });
    }

    function gone() {
        closeStream();
        state.stash = null;
        // It no longer exists, so the installed app should not keep trying to open it
        if (window.StashlyLast) window.StashlyLast.clear(slug);
        show('gone');
    }

    function locked() {
        closeStream();
        state.stash = null;
        show('locked');
        $('unlockInput').focus();
    }

    $('unlockForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var error = $('unlockError');
        error.textContent = '';
        var password = $('unlockInput').value;
        if (!password) { error.textContent = 'Enter the password.'; return; }
        $('unlockButton').disabled = true;
        api(base + '/unlock', { method: 'POST', body: { password: password, session: $('sessionSelect').value } }).then(function (res) {
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

    function applyFilters() {
        var next = {
            search: $('searchInput').value.trim(),
            startDate: $('startDate').value,
            endDate: $('endDate').value,
        };
        if (next.startDate && next.endDate && next.startDate > next.endDate) {
            toast('The From date is after the To date.', true);
            return;
        }
        state.filters = next;
        load();
    }

    var searchTimer;

    $('searchInput').addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyFilters, 300);
    });

    $('searchInput').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { clearTimeout(searchTimer); applyFilters(); }
    });

    $('filterToggle').addEventListener('click', function () {
        var panel = $('filterPanel');
        panel.classList.toggle('hidden');
        $('filterToggle').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
    });

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

    // What the other parts use
    P.applyContent = applyContent;
    P.applyRole = applyRole;
    P.updateHeader = updateHeader;
    P.updateExpiry = updateExpiry;
    P.updateTimes = updateTimes;
    P.load = load;
    P.gone = gone;
    P.locked = locked;
    P.applyFilters = applyFilters;
})();
