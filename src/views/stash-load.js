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

    // Dismissing the "an admin chose this password" notice. Remembered in this browser only, per stash, and tied to the
    // time of that one reset: an admin choosing a password again shows the notice again, and another browser or person
    // still sees it.
    var RESET_SEEN_PREFIX = 'sl_reset_seen_';

    function dismissedResetAt() {
        try { return localStorage.getItem(RESET_SEEN_PREFIX + slug) || ''; } catch (e) { return ''; }
    }

    function applyRole() {
        var r = role();
        sections.main.classList.toggle('role-view', r === 'view');
        sections.main.classList.toggle('role-drop', r === 'drop');
        // Options has nothing for a drop-box link (it may be in the top bar, outside the section above)
        $('optionsButton').classList.toggle('hidden', r === 'drop');
        // Picking several clips is for someone who can change them
        $('selectToggle').classList.toggle('hidden', r !== 'full');
        if (r !== 'full' && P.setSelecting) P.setSelecting(false);
        // An admin chose this password: everyone using the stash sees that, and when. Changing it is only offered to
        // someone who can actually change it; everyone else is told who can.
        var reset = $('resetNotice');
        var resetAt = state.stash.passwordResetAt;
        reset.classList.toggle('hidden', !resetAt || resetAt === dismissedResetAt());
        if (resetAt) {
            var words = "An admin chose this stash's password on " + new Date(resetAt).toLocaleString() + '.';
            $('resetNoticeText').textContent = r === 'full' ? words : words + ' Whoever knows the password can choose a new one.';
            $('resetNoticePassword').classList.toggle('hidden', r !== 'full');
        }
        var banner = $('roleBanner');
        banner.classList.toggle('hidden', r === 'full');
        banner.textContent = r === 'view'
            ? 'You opened a read-only link. You can read and copy, but not add or delete anything.'
            : r === 'drop' ? 'You opened a drop-box link. You can add notes and files here, but you cannot see what is in the stash.' : '';
        // Closing a stash leaves it, and on a password-protected one also forgets the password in this browser.
        // (Signing out of an account is a different thing, in the left menu.)
        var leaveWord = 'Close';
        $('logoutButton').querySelector('.btn-label').textContent = leaveWord;
        $('logoutButton').setAttribute('aria-label', leaveWord);
        updateSessionInfo();
        // Share links only make sense on a password-protected stash, and only for someone with full access
        $('shareButton').classList.toggle('hidden', !(r === 'full' && state.stash.hasPassword));
        // The account's Follow button (stash-account.js) follows the role too
        if (P.afterRole) P.afterRole();
    }

    function updateHeader() {
        var stash = state.stash;
        $('lockChip').classList.toggle('hidden', !stash.hasPassword);
        $('extendButton').classList.toggle('hidden', !stash.canExtend);
        // The clock chip is the way in to extending, when this person may (stash-options.js)
        if (P.paintExpiryAction) P.paintExpiryAction();
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

    // The list loads a page at a time: the first 100 matches, then 100 more each time "Show more" is pressed (or scrolled
    // to). The server caps one request at 200, and a refresh re-reads at most MAX_KEEP so it cannot run away.
    var PAGE_SIZE = 100;
    var MAX_PAGE = 200;
    var MAX_KEEP = 2000;

    // The first page, when the server put it inside the page (it does for a visitor it knows may read the stash): the
    // first load uses it instead of asking, which saves a round trip. Used once. A share link in the address (#view=...)
    // changes who this visitor is, so then the page asks as before.
    var initialPage = (function () {
        var el = document.getElementById('initialPage');
        if (!el) return null;
        var data = null;
        try { data = JSON.parse(el.textContent); } catch (e) { data = null; }
        el.remove();
        // (a link to the settings, #options, is not a share link: the page's own first batch is still used)
        return (location.hash && !/^#options(=[a-z]+)?$/.test(location.hash)) || !data || !Array.isArray(data.items) ? null : data;
    })();

    // The listing request for one page. Sent in the body, not the address, so search words never end up in a proxy's
    // access log. preview: long notes come as their first part only; the rest is fetched when a note is opened or copied.
    function queryFor(offset, limit) {
        var f = state.filters;
        var query = { tz: String(new Date().getTimezoneOffset()), preview: true, limit: limit, offset: offset };
        // The first item of the list is opened at once, so it comes in full
        if (offset === 0) query.fullFirst = true;
        if (f.search) query.search = f.search;
        if (f.tags && f.tags.length) query.tag = f.tags;
        if (f.startDate) query.startDate = f.startDate;
        if (f.endDate) query.endDate = f.endDate;
        return query;
    }

    // Reads pages from the start until `want` clips are in hand (or the server has no more). A page that repeats a clip
    // already read (the list shifted while paging, because someone added or moved something) is counted in `dupes`
    // and skipped, so the next offset still lands on the first clip not yet seen. A later page that fails is dropped:
    // what was read stays, and "Show more" can try again. Resolves { error } when even the first page failed.
    function collect(want) {
        var out = { items: [], dupes: 0, first: null, last: null, error: null };
        var seen = {};
        function step() {
            var limit = Math.min(MAX_PAGE, want - out.items.length);
            var f = state.filters;
            var inline = initialPage;
            initialPage = null;
            // The page's own first page fits only the first load: from the top, no search or dates, the usual size
            var usable = inline && !out.items.length && !out.dupes && limit === PAGE_SIZE && !f.search && !f.startDate && !f.endDate && !(f.tags && f.tags.length);
            var request = usable
                ? Promise.resolve({ ok: true, status: 200, body: inline })
                : api(base + '/query', { method: 'POST', body: queryFor(out.items.length + out.dupes, limit) });
            return request.then(function (res) {
                if (!res.ok) {
                    if (!out.first) out.error = res;
                    return out;
                }
                if (!out.first) out.first = res.body;
                out.last = res.body;
                res.body.items.forEach(function (item) {
                    if (seen[item.id]) out.dupes++;
                    else { seen[item.id] = true; out.items.push(item); }
                });
                if (res.body.hasMore && res.body.items.length && out.items.length < want) return step();
                return out;
            });
        }
        return step();
    }

    // Loads the stash and its first page. A quiet load (a live reconnect, an expiry check) keeps as many clips on the
    // page as were there, so a long list does not shrink under someone who has scrolled down it; any other load
    // (opening the stash, a new search or date range, Refresh) starts again at the first page.
    function load(quiet) {
        var gen = ++state.loadGen;
        state.loadingMore = false;
        state.moreFailed = false;
        var want = quiet ? Math.min(MAX_KEEP, Math.max(PAGE_SIZE, state.items.length)) : PAGE_SIZE;
        return collect(want).then(function (out) {
            // A newer load (the search changed while this one was on its way) owns the page now
            if (gen !== state.loadGen) return;
            var res = out.error;
            if (res) {
                if (res.status === 404) return gone();
                if (res.status === 401) return locked();
                if (res.status === 400) {
                    toast(res.body && res.body.error ? res.body.error : 'Check the search and dates.', true);
                    return;
                }
                if (!quiet) toast('Could not load the stash.', true);
                return;
            }
            var previousIndex = state.items.findIndex(function (item) { return item.id === state.selectedId; });
            var list = $('items');
            var scrolled = list.scrollTop;
            state.stash = out.first;
            state.tagList = out.first.tags || [];
            state.items = out.items;
            state.total = out.last.total;
            state.hasMore = out.last.hasMore;
            state.dupes = out.dupes;
            // Pages come in the server's order; sorting is only a guard for a list that shifted between them
            P.sortItems();
            // Only a stash opened with full access is worth suggesting on the share page
            if (window.StashlyRemember && out.first.role === 'full') window.StashlyRemember(slug);
            // The installed app reopens this stash next time it is launched (whatever the role: a link visitor too)
            if (window.StashlyLast) window.StashlyLast.set(slug);
            applyRole();
            applyContent();
            sections.main.classList.contains('hidden') && show('main');
            updateHeader();
            P.renderTagBar();
            renderItems();
            // A quiet reload leaves the list where it was; a new search, date range or Refresh starts from the top
            list.scrollTop = quiet ? scrolled : 0;
            connect();

            if (!state.started) {
                state.started = true;
                // Desktop opens the newest clip (the usual reason to visit); a phone starts on the list
                if (!narrow.matches && state.items.length) openItem(state.items[0].id);
                // Arrived from the gear on My stashes: open the stash's Options (stash-options.js)
                if (P.openOptionsFromAddress) P.openOptionsFromAddress();
            } else if (state.selectedId !== null && state.revealedId !== state.selectedId) {
                if (findItem(state.selectedId)) { if (state.editingId !== state.selectedId) renderDetail(findItem(state.selectedId)); }
                else showSomethingElse(previousIndex);
            }
        }).catch(function () {
            if (!quiet) toast('Could not reach the server.', true);
        });
    }

    // Adds the next page to the end of the list. Only the new rows are built: what is on screen stays as it is (rows,
    // focus, the open clip, loaded images), and a clip that arrives out of place goes where the list's own order puts it.
    function loadMore() {
        if (state.loadingMore || !state.hasMore || !state.stash) return Promise.resolve();
        var gen = state.loadGen;
        state.loadingMore = true;
        state.moreFailed = false;
        P.updateCounts();
        return api(base + '/query', { method: 'POST', body: queryFor(state.items.length + state.dupes, PAGE_SIZE) }).then(function (res) {
            if (gen !== state.loadGen) return; // the list was replaced meanwhile (load() already reset the flag)
            state.loadingMore = false;
            if (res.status === 404) return gone();
            if (res.status === 401) return locked();
            if (!res.ok) {
                state.moreFailed = true;
                toast('Could not load more.', true);
                P.updateCounts();
                return;
            }
            var known = {};
            state.items.forEach(function (item) { known[item.id] = true; });
            // Live events can add or remove clips while paging, so a clip this page repeats is skipped
            var fresh = res.body.items.filter(function (item) { return !known[item.id]; });
            state.dupes += res.body.items.length - fresh.length;
            state.total = res.body.total;
            state.hasMore = res.body.hasMore;
            P.addPage(fresh);
        }).catch(function () {
            if (gen !== state.loadGen) return;
            state.loadingMore = false;
            state.moreFailed = true;
            toast('Could not reach the server.', true);
            P.updateCounts();
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
            tags: state.filters.tags || [],
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
        state.filters.tags = [];
        applyFilters();
    });

    $('rangeChip').addEventListener('click', function () {
        $('startDate').value = '';
        $('endDate').value = '';
        applyFilters();
    });

    // "Dismiss" only puts the notice away here; the password stays as the admin set it until somebody changes it
    $('resetNoticeDismiss').addEventListener('click', function () {
        var resetAt = state.stash && state.stash.passwordResetAt;
        if (resetAt) {
            try { localStorage.setItem(RESET_SEEN_PREFIX + slug, resetAt); } catch (e) { /* not remembered */ }
        }
        $('resetNotice').classList.add('hidden');
    });

    $('refreshButton').addEventListener('click', function () { load(); });

    // What the other parts use
    P.applyContent = applyContent;
    P.applyRole = applyRole;
    P.updateHeader = updateHeader;
    P.updateExpiry = updateExpiry;
    P.updateTimes = updateTimes;
    P.load = load;
    P.loadMore = loadMore;
    P.gone = gone;
    P.locked = locked;
    P.applyFilters = applyFilters;
})();
