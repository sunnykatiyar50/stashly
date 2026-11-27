// Saves what you copy to your Clipboard stash (a private stash only you can open). A page cannot watch the clipboard in
// the background: a browser lets it read the clipboard only while it is open and in focus. So this checks when you come
// back to Stashly (the tab or the installed app gets focus) and adds the text on the clipboard if it is new. Text only.
// Off until it is turned on for this device (account page), because the clipboard often holds things like passwords.
(function () {
    'use strict';

    var ON_KEY = 'sl_clip_on';
    var SLUG_KEY = 'sl_clip_slug';
    // The last text seen on the clipboard, so the same text is never saved twice (and text Stashly copied itself is skipped)
    var LAST_KEY = 'sl_clip_last';

    function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
    function set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* not remembered */ } }
    function remove(key) { try { localStorage.removeItem(key); } catch (e) { /* nothing to forget */ } }

    // Can this browser read the clipboard at all? (Needs a secure page; Firefox does not offer it to web pages.)
    function supported() {
        return Boolean(navigator.clipboard && typeof navigator.clipboard.readText === 'function' && window.isSecureContext);
    }

    function enabled() { return get(ON_KEY) === '1' && supported(); }

    function toast(message, isError) {
        var el = document.getElementById('toast');
        if (!el) return;
        el.textContent = message;
        el.classList.toggle('error', Boolean(isError));
        el.classList.remove('hidden');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(function () { el.classList.add('hidden'); }, isError ? 4000 : 2200);
    }

    function send(path, method, body) {
        return fetch(path, {
            method: method,
            credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) { return { ok: res.ok, status: res.status, body: data }; });
        });
    }

    // The name of the Clipboard stash, made if there is none (or it ended). Resolves to the name, or null with a reason.
    function ensureStash() {
        return send('/api/me/clipboard', 'POST').then(function (res) {
            if (res.ok && res.body && res.body.slug) { set(SLUG_KEY, res.body.slug); return { slug: res.body.slug }; }
            return { error: (res.body && res.body.error) || 'Could not make your Clipboard stash.', status: res.status };
        });
    }

    function addNote(slug, text) {
        return send('/api/stashes/' + encodeURIComponent(slug) + '/notes', 'POST', { text: text });
    }

    var busy = false;

    // Reads the clipboard and saves it when it holds new text. Quiet when there is nothing to do.
    function capture() {
        if (busy || !enabled() || document.visibilityState === 'hidden') return Promise.resolve();
        busy = true;
        return navigator.clipboard.readText().then(function (text) {
            var previous = get(LAST_KEY);
            if (!text || !text.trim() || text === previous) return null;
            set(LAST_KEY, text);
            var slug = get(SLUG_KEY);
            var saved = slug ? addNote(slug, text) : Promise.resolve({ status: 404 });
            // Its stash is gone (deleted or ended): make a new one and try once more
            return saved.then(function (res) {
                if (res.status !== 404) return res;
                return ensureStash().then(function (made) { return made.slug ? addNote(made.slug, text) : { ok: false, status: made.status, body: { error: made.error } }; });
            }).then(function (res) {
                if (res.ok) toast('Saved to your Clipboard stash');
                else if (res.status === 401) set(LAST_KEY, previous || ''); // signed out: save it once signed in again
                else if (res.status === 413) toast('That text is too long to save', true);
                else if (res.body && res.body.error) toast(res.body.error, true);
            });
        }).catch(function () { /* the browser did not allow reading it right now: try again at the next focus */ })
            .then(function () { busy = false; });
    }

    // Turns it on for this device. Must run from a click, because that is when the browser may ask for permission to read
    // the clipboard. What is on the clipboard now is not saved: only what is copied from now on.
    function enable() {
        if (!supported()) return Promise.resolve({ error: 'This browser cannot let Stashly read the clipboard.' });
        return navigator.clipboard.readText().then(function (text) {
            return ensureStash().then(function (made) {
                if (!made.slug) return { error: made.error };
                set(LAST_KEY, text || '');
                set(ON_KEY, '1');
                return { slug: made.slug };
            });
        }, function () {
            return { error: 'Stashly needs permission to read the clipboard. Allow it in the browser and try again.' };
        });
    }

    function disable() { remove(ON_KEY); }

    window.StashlyClipboard = {
        supported: supported,
        enabled: enabled,
        enable: enable,
        disable: disable,
        slug: function () { return get(SLUG_KEY); },
        ensureStash: ensureStash,
        capture: capture,
    };

    // When Stashly comes back into view or focus
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') capture(); });
    window.addEventListener('focus', capture);
    if (document.visibilityState === 'visible') setTimeout(capture, 600);
})();
