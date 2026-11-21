// The page the phone's share sheet opens: what was shared fills a note, you pick the stash, Send adds it.
(function () {
    'use strict';

    var RECENT_KEY = 'sl_recent_stashes';
    var $ = function (id) { return document.getElementById(id); };

    function readRecent() {
        try {
            var list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
            return Array.isArray(list) ? list.filter(function (name) { return typeof name === 'string'; }) : [];
        } catch (e) {
            return [];
        }
    }

    // Android usually puts the link in "text" and sometimes repeats it in "url"; share only one copy of it
    // The share sheet POSTs to /share, which hands the content over in the fragment (older installs still use the
    // query string). Either way it is taken out of the address at once, so it is not kept in the browser's history.
    var params = new URLSearchParams(location.hash.length > 1 ? location.hash.slice(1) : location.search);
    if (location.hash || location.search) {
        try { history.replaceState(null, '', '/share'); } catch (e) { /* the address keeps it; nothing else changes */ }
    }
    var title = (params.get('title') || '').trim();
    var text = (params.get('text') || '').trim();
    var url = (params.get('url') || '').trim();
    var body = text;
    if (url && text.indexOf(url) === -1) body = body ? body + '\n' + url : url;
    // A title that only repeats the start of the text adds nothing
    if (title && body.indexOf(title) === 0) title = '';

    $('shareTitle').value = title.slice(0, 150);
    $('shareText').value = body;

    var recent = readRecent();
    recent.forEach(function (name) {
        var option = document.createElement('option');
        option.value = name;
        $('recentStashes').appendChild(option);
    });
    if (recent.length) $('shareStash').value = recent[0];
    (body ? $('shareStash') : $('shareText')).focus();

    function fail(message, link) {
        $('shareError').textContent = message;
        var open = $('shareOpen');
        if (link) { open.href = link; open.textContent = 'Open stash'; open.classList.remove('hidden'); }
        else open.classList.add('hidden');
    }

    $('shareForm').addEventListener('submit', function (event) {
        event.preventDefault();
        fail('');
        $('shareStatus').textContent = '';
        var slug = $('shareStash').value.trim().toLowerCase();
        var note = $('shareText').value;
        if (!note.trim()) return fail('There is nothing to send. Write something first.');
        if (!slug) return fail('Pick or type the stash to send it to.');
        var send = $('shareSend');
        send.disabled = true;
        var path = '/api/stashes/' + encodeURIComponent(slug);
        fetch(path + '/notes', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: $('shareTitle').value, text: note }),
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) { return { res: res, data: data }; });
        }).then(function (result) {
            send.disabled = false;
            var status = result.res.status;
            if (result.res.ok) {
                try {
                    var list = readRecent().filter(function (name) { return name !== slug; });
                    list.unshift(slug);
                    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
                } catch (e) { /* not remembered */ }
                $('shareStatus').textContent = 'Sent to ' + slug + '.';
                var open = $('shareOpen');
                open.href = '/s/' + encodeURIComponent(slug);
                open.textContent = 'Open ' + slug;
                open.classList.remove('hidden');
                send.textContent = 'Send again';
            } else if (status === 401) {
                fail('That stash is locked. Open it and enter the password once, then share again.', '/s/' + encodeURIComponent(slug));
            } else if (status === 404) {
                fail('There is no stash called "' + slug + '" (it may have expired).');
            } else {
                fail((result.data && result.data.error) || 'Could not send that.');
            }
        }).catch(function () {
            send.disabled = false;
            fail('Could not reach the server.');
        });
    });
})();
