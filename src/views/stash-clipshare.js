// The stash page: a link to one clip. The Share button in the open clip's actions opens a panel above its content to make
// a link that opens just that note or file (/c/<token>), see whether it has one, and cancel it. The link is shown once,
// when it is made (only a hash is kept), so it is held here while the page is open and drawn again if the pane is redrawn.
(function () {
    'use strict';

    var P = window.StashlyPage;
    var base = P.base;
    var api = P.api;
    var toast = P.toast;
    var make = P.make;
    var button = P.button;
    var role = P.role;
    var copyText = P.copyText;

    function locked() { return P.locked.apply(null, arguments); }

    var EXPIRIES = [
        { key: '1h', label: '1 hour' },
        { key: '1d', label: '1 day' },
        { key: '7d', label: '7 days' },
        { key: '30d', label: '30 days' },
        { key: 'never', label: 'Never' },
    ];

    // Per clip, for this page only: whether the panel is open, and the link just made (the one time it can be shown)
    var ui = {};

    function canShare(item) {
        return role() === 'full' && !(item.kind === 'note' && item.burn);
    }

    function when(iso) {
        return new Date(iso).toLocaleString();
    }

    // The Share button for the clip's action row (null when this clip cannot be shared)
    function shareButton(item) {
        if (!canShare(item)) return null;
        var btn = button('Share', 'ghost', function () {
            var open = !(ui[item.id] && ui[item.id].open);
            ui[item.id] = Object.assign(ui[item.id] || {}, { open: open });
            if (open) mount(item); else removePanel();
            btn.setAttribute('aria-expanded', String(open));
        });
        btn.setAttribute('aria-expanded', String(Boolean(ui[item.id] && ui[item.id].open)));
        btn.title = 'Make a link that opens only this clip';
        return btn;
    }

    function removePanel() {
        var old = document.querySelector('#detail .share-panel');
        if (old) old.remove();
    }

    // Puts the panel straight under the row of buttons (back, actions), pushing the title and the clip below it
    function mount(item) {
        removePanel();
        document.querySelector('#detail .pane-head').appendChild(panelFor(item));
    }

    // Called when the clip's pane is drawn: brings back the panel if it was open
    function restore(item) {
        removePanel();
        if (canShare(item) && ui[item.id] && ui[item.id].open) mount(item);
    }

    function panelFor(item) {
        var panel = make('div', 'share-panel');
        panel.dataset.id = item.id;
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', 'Share this clip');
        var content = make('div', 'share-panel-body');
        panel.appendChild(content);

        function draw(info) {
            content.textContent = '';
            var mine = ui[item.id] || {};
            content.appendChild(make('strong', 'share-title', 'Share this clip by link'));
            content.appendChild(make('span', 'muted', 'The link opens only this ' + (item.kind === 'file' ? 'file' : 'note') + '. Nothing else in the stash can be reached with it.'));

            // The link just made: shown now, never again
            if (mine.link) {
                var row = make('div', 'share-link-row');
                var input = make('input', 'mono');
                input.type = 'text';
                input.readOnly = true;
                input.value = mine.link;
                input.setAttribute('aria-label', 'Link to this clip');
                input.addEventListener('focus', function () { input.select(); });
                row.appendChild(input);
                row.appendChild(button('Copy link', 'primary', function (event) {
                    var target = event.currentTarget;
                    Promise.resolve(copyText(mine.link)).then(function (ok) {
                        toast(ok ? 'Link copied' : 'Could not copy. Select the link and copy it by hand.', !ok);
                        if (ok) { target.textContent = 'Copied'; setTimeout(function () { target.textContent = 'Copy link'; }, 1500); }
                    });
                }));
                row.appendChild(button('QR code', 'ghost', function () { if (P.showQr) P.showQr(mine.link); }));
                content.appendChild(row);
                content.appendChild(make('span', 'muted', 'Anyone with this link can see this clip. Copy it now: it is not shown again.'));
            }

            if (info === undefined) {
                content.appendChild(make('span', 'share-state muted', 'Checking…'));
            } else if (info && info.shared) {
                var views = info.views === 1 ? 'opened once' : 'opened ' + info.views + ' times';
                content.appendChild(make('span', 'share-state', 'A link is active, ' + (info.expiresAt ? 'until ' + when(info.expiresAt) : 'with no end date') + ', ' + views + (info.lastViewedAt ? ' (last ' + when(info.lastViewedAt) + ')' : '') + '.'));
            } else if (!mine.link) {
                content.appendChild(make('span', 'share-state', 'This clip has no link yet.'));
            }

            var form = make('div', 'share-form');
            var label = make('label', 'share-expiry');
            label.appendChild(make('span', null, 'Link lasts'));
            var select = make('select');
            EXPIRIES.forEach(function (option) {
                var el = make('option', null, option.label);
                el.value = option.key;
                if (option.key === (mine.expires || '7d')) el.selected = true;
                select.appendChild(el);
            });
            select.addEventListener('change', function () { ui[item.id].expires = select.value; });
            label.appendChild(select);
            form.appendChild(label);
            // While the status is still being read, or when only the new link is known, the form offers a new one
            var active = Boolean(info && info.shared);
            form.appendChild(button(active ? 'Make a new link' : 'Create link', active ? 'ghost' : 'primary', function (event) { create(event.currentTarget, select.value); }));
            if (active) form.appendChild(button('Stop sharing', 'danger-ghost', function (event) { stop(event.currentTarget); }));
            content.appendChild(form);
            if (active) content.appendChild(make('span', 'muted', 'A new link cancels the old one. A clip\'s link also ends when the clip is deleted, or when the stash\'s password changes.'));
        }

        function failure(res, fallback) {
            if (res.status === 401) locked();
            else toast((res.body && res.body.error) || fallback, true);
        }

        function create(trigger, expires) {
            // A secret note is hidden in the page; a link shows it in full, so that is asked about first
            if (item.kind === 'note' && item.secret && !window.confirm('This note is marked Secret. Anyone with the link will see its text. Share it anyway?')) return;
            trigger.disabled = true;
            api(base + '/items/' + item.id + '/share', { method: 'POST', body: { expires: expires } }).then(function (res) {
                if (!res.ok) { trigger.disabled = false; failure(res, 'Could not make the link.'); return; }
                ui[item.id] = Object.assign(ui[item.id] || {}, { open: true, expires: expires, link: location.origin + res.body.path });
                draw(res.body);
            }).catch(function () { trigger.disabled = false; toast('Could not reach the server.', true); });
        }

        function stop(trigger) {
            trigger.disabled = true;
            api(base + '/items/' + item.id + '/share', { method: 'DELETE' }).then(function (res) {
                if (!res.ok) { trigger.disabled = false; failure(res, 'Could not cancel the link.'); return; }
                delete ui[item.id].link;
                toast('Link cancelled');
                draw({ shared: false });
            }).catch(function () { trigger.disabled = false; toast('Could not reach the server.', true); });
        }

        // What the clip's link is now, from the server (a link made here is already known)
        draw(undefined);
        api(base + '/items/' + item.id + '/share').then(function (res) {
            if (!document.body.contains(panel)) return;
            if (res.ok) draw(res.body); else { draw({ shared: false }); failure(res, 'Could not check the link.'); }
        }).catch(function () { /* the panel still works without the status line */ });
        return panel;
    }

    P.clipShareButton = shareButton;
    P.restoreClipShare = restore;
})();
