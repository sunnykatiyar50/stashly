// The Back button (the Android back gesture, a browser's Back) closes what is open on top of the page before it leaves the
// page: a dialog, the phone's side menu, the three-dot menu, an open clip on a phone. Without this, Back from an open clip
// went to the page before the stash, or, in the installed app, closed the whole app.
//
// How: whatever opens registers itself with StashlyBack.push(key, close), which adds one history entry. Back then pops
// that entry and calls close(). When the same thing is closed some other way (its own button, Escape, a tap outside), it
// tells StashlyBack.release(key), which removes the entry again so the history does not fill up with dead ones.
//
// Calls to history.back() and pushState are queued and run one at a time: back() is asynchronous, so a menu that closes and
// a dialog that opens in the same moment would otherwise push its entry before the back had happened and lose it.
(function () {
    'use strict';

    var stack = [];     // what is open, oldest first: { key, close }
    var queue = [];     // history operations still to run: { type: 'push' | 'back', key }
    var busy = false;   // a back() of ours is on its way
    var silent = 0;     // popstate events caused by our own back(): not a person pressing Back
    var stale = 0;      // history entries whose thing was closed while something above it was still open
    var timer = null;

    function pump() {
        while (!busy && queue.length) {
            var op = queue.shift();
            if (op.type === 'push') {
                try { history.pushState({ stashlyBack: op.key }, ''); } catch (e) { /* no history: Back just leaves, as before */ }
            } else {
                busy = true;
                silent++;
                // If the browser never answers (nothing to go back to), do not stop here for ever
                timer = setTimeout(function () { busy = false; if (silent > 0) silent--; pump(); }, 400);
                try { history.back(); } catch (e) { busy = false; silent--; clearTimeout(timer); }
            }
        }
    }

    function indexOf(key) {
        for (var i = 0; i < stack.length; i++) if (stack[i].key === key) return i;
        return -1;
    }

    // Something opened on top of the page. close() must close it (and may call release itself; that is harmless).
    function push(key, close) {
        if (indexOf(key) !== -1) return;
        stack.push({ key: key, close: close });
        queue.push({ type: 'push', key: key });
        pump();
    }

    // It was closed some other way: take its history entry away again
    function release(key) {
        var i = indexOf(key);
        if (i === -1) return;
        var onTop = i === stack.length - 1;
        stack.splice(i, 1);
        // Under something else that is still open, its entry cannot be removed now; it is stepped over later
        if (onTop) queue.push({ type: 'back' }); else stale++;
        pump();
    }

    window.addEventListener('popstate', function () {
        if (silent) {
            silent--;
            if (busy) { clearTimeout(timer); busy = false; pump(); }
            return;
        }
        var top = stack.pop();
        if (top) { top.close(); return; }
        // A step back onto an entry whose thing is already closed: carry on to the one before it
        if (stale) { stale--; queue.push({ type: 'back' }); pump(); }
    });

    window.StashlyBack = { push: push, release: release, open: function () { return stack.length; } };

    // Dialogs: opening one is a thing to close with Back. They are all in the page's HTML, so they are watched once.
    function watchDialogs() {
        Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (dialog, index) {
            var key = 'dialog:' + (dialog.id || index);
            new MutationObserver(function () {
                if (dialog.hasAttribute('open')) push(key, function () { if (dialog.open) dialog.close(); });
                else release(key);
            }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchDialogs); else watchDialogs();
})();
