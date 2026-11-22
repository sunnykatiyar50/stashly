// The stash page, part 9 of 9: start. Loads the settings, then the stash. Must be the last script.
(function () {
    'use strict';

    var P = window.StashlyPage;
    // From part 1 (already loaded)
    var $ = P.$;
    var state = P.state;
    var api = P.api;
    var make = P.make;

    // Functions that live in the other parts of the page. Called through P when used, so the order the
    // scripts load in does not matter.
    function updateTimes() { return P.updateTimes.apply(null, arguments); }
    function load() { return P.load.apply(null, arguments); }
    function redeemFromHash() { return P.redeemFromHash.apply(null, arguments); }

    api('/api/config').then(function (res) {
        if (!res.ok) return;
        state.minPassword = Number(res.body.minPasswordLength) || 10;
        // How long to stay signed in: on the unlock form, and in Options to change it later
        var sessionOptions = res.body.sessionOptions || [];
        if (sessionOptions.length) {
            $('sessionSelect').textContent = '';
            sessionOptions.forEach(function (option) {
                var el = make('option', null, option.label);
                el.value = option.key;
                if (option.key === res.body.defaultSession) el.selected = true;
                $('sessionSelect').appendChild(el);
            });
            state.sessionOptions = sessionOptions;
        }
        (res.body.itemTtlOptions || []).forEach(function (option) {
            var el = make('option', null, option.label);
            el.value = option.key;
            $('itemTtlSelect').appendChild(el);
        });
        var max = res.body.limits.maxFileBytes;
        $('limitHint').textContent = 'Up to ' + window.StashlyUpload.formatSize(max) + ' per file. Images, PDF, Office files, zip, certificates and any text file.';
        P.replaceUploader(max);
    });

    setInterval(updateTimes, 15000);

    redeemFromHash().then(function () { load(); });
})();
