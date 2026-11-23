// The home page: one box to open a stash by name or create it, with more options on request
(function () {
    'use strict';

    var MIN = 4;
    var GENERATED = 12;
    var minOpen = 0; // from the server: the shortest name allowed without a password
    var minPassword = 10; // from the server: the shortest password accepted
    var canCreate = true; // from the server: whether this visitor may create stashes
    var suggestion = ''; // a random name, shown as the placeholder and used when Create is pressed with the box empty
    var $ = function (id) { return document.getElementById(id); };

    var slugInput = $('slugInput');
    var passwordInput = $('passwordInput');
    var ttlSelect = $('ttlSelect');
    var createButton = $('createButton');
    var openButton = $('openButton');
    var status = $('createStatus');
    var slugHint = $('slugHint');
    var offer = $('createOffer');
    var DEFAULT_HINT = slugHint.textContent;

    var errors = { slug: $('slugError'), password: $('passwordError'), ttl: $('ttlError'), link: $('linkError') };

    function clearMessages() {
        Object.keys(errors).forEach(function (key) { errors[key].textContent = ''; });
        status.textContent = '';
        status.classList.remove('error');
        offer.classList.add('hidden');
    }

    function api(path, options) {
        options = options || {};
        return fetch(path, {
            method: options.method || 'GET',
            credentials: 'same-origin',
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
            body: options.body ? JSON.stringify(options.body) : undefined,
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        });
    }

    function validateName(value) {
        var slug = value.trim().toLowerCase();
        if (!slug) return 'A stash name is required.';
        if (slug.length < MIN) return 'That name is too short.';
        if (!/^[a-z0-9_-]+$/.test(slug)) return 'Use only letters, numbers, dashes and underscores.';
        return '';
    }

    // Without a password the name is the only lock. The server refuses a name shorter than minOpen; shorter than a
    // generated name is still easy to guess, so nudge towards a password.
    function updateHint() {
        var length = slugInput.value.trim().length;
        var noPassword = !passwordInput.value;
        if (length && noPassword && minOpen && length < minOpen) {
            slugHint.textContent = 'To create it without a password, the name must be at least ' + minOpen + ' characters. Add a password under More options, or use a longer name.';
            slugHint.classList.add('warn');
        } else if (length && noPassword && length < GENERATED) {
            slugHint.textContent = 'Short names are easy to guess. Add a password under More options if this should stay private.';
            slugHint.classList.add('warn');
        } else {
            slugHint.textContent = DEFAULT_HINT;
            slugHint.classList.remove('warn');
        }
    }

    function suggest() {
        return api('/api/stashes/suggest').then(function (res) {
            if (res.ok) {
                suggestion = res.body.slug;
                slugInput.placeholder = suggestion;
            }
        });
    }

    // When creating is limited (to the admin, or to signed-in users), a visitor gets a notice, and Create is off.
    // Opening a stash still works.
    function lockCreate(rule) {
        canCreate = false;
        $(rule === 'login' ? 'loginNotice' : 'adminNotice').classList.remove('hidden');
        createButton.disabled = true;
        createButton.title = 'You cannot create stashes on this server';
        Array.prototype.forEach.call(document.querySelectorAll('#moreCreateTitle ~ *, #moreCreateTitle ~ * *'), function (el) {
            if ('disabled' in el) el.disabled = true;
        });
    }

    // ---- the signed-in account: "My stashes" in the menu and on this page ----

    var SIGNED_IN_KEY = 'sl_signed_in';
    function rememberedSignedIn() {
        try { return localStorage.getItem(SIGNED_IN_KEY) === '1'; } catch (e) { return false; }
    }
    function rememberSignedIn(value) {
        try { localStorage.setItem(SIGNED_IN_KEY, value ? '1' : '0'); } catch (e) { /* not remembered */ }
    }
    // Someone who was signed in last time sees "My stashes" in the menu straight away (the check below confirms it),
    // instead of the menu changing after the page has drawn
    if (rememberedSignedIn()) $('accountNavLink').classList.remove('hidden');

    function showAccountLink() {
        if (!rememberedSignedIn()) $('accountLink').classList.remove('hidden');
        api('/api/me').then(function (res) {
            var user = res.ok && res.body && res.body.user;
            rememberSignedIn(Boolean(user));
            if (!user) {
                $('accountNavLink').classList.add('hidden');
                $('accountLink').classList.remove('hidden');
                return;
            }
            // Signed in: "My stashes" joins the main menu and the footer's "Sign in" goes away
            $('accountNavLink').classList.remove('hidden');
            $('accountNavLink').title = 'My stashes, signed in as ' + user.username;
            $('accountLink').classList.add('hidden');
        }).catch(function () { /* keeps saying "Sign in" */ });
    }

    function loadConfig() {
        // shell.js has already asked for the config; reuse that answer instead of asking again
        return (window.StashlyConfig ? window.StashlyConfig() : api('/api/config')).then(function (res) {
            if (!res.ok) return;
            if (!res.body.canCreate) lockCreate(res.body.createRule);
            if (res.body.accountsEnabled) showAccountLink();
            minOpen = Number(res.body.minOpenNameLength) || 0;
            minPassword = Number(res.body.minPasswordLength) || minPassword;
            updateHint();
            ttlSelect.textContent = '';
            res.body.ttlOptions.forEach(function (option) {
                var el = document.createElement('option');
                el.value = option.key;
                el.textContent = option.label;
                if (option.key === res.body.defaultTtl) el.selected = true;
                ttlSelect.appendChild(el);
            });
        });
    }

    // ---- More options ----

    var MORE_KEY = 'sl_home_more';
    var moreToggle = $('moreToggle');
    var moreOptions = $('moreOptions');

    function setMore(open, remember) {
        moreOptions.classList.toggle('hidden', !open);
        moreToggle.setAttribute('aria-expanded', String(open));
        moreToggle.classList.toggle('open', open);
        $('moreToggleLabel').textContent = open ? 'Fewer options' : 'More options';
        if (remember) {
            try { localStorage.setItem(MORE_KEY, open ? '1' : '0'); } catch (e) { /* not remembered */ }
        }
    }
    moreToggle.addEventListener('click', function () { setMore(moreOptions.classList.contains('hidden'), true); });
    try { if (localStorage.getItem(MORE_KEY) === '1') setMore(true, false); } catch (e) { /* closed by default */ }

    // ---- opening ----

    // A pasted address or link (it holds /s/NAME) opens as it is, so a #view= or #drop= token survives
    function addressOf(text) {
        var found = /\/s\/[^\s?#]+(?:#\S*)?/.exec(text);
        return found ? found[0] : null;
    }

    function openLink(text) {
        var target = addressOf(text);
        if (!target) return false;
        window.location.href = target;
        return true;
    }

    function openStash() {
        clearMessages();
        var raw = slugInput.value.trim();
        if (!raw) {
            errors.slug.textContent = 'Type the name of a stash to open. To make a new one, press Create.';
            slugInput.focus();
            return;
        }
        // Someone pasted a whole address into the name box
        if (openLink(raw)) return;
        var name = raw.toLowerCase();
        var problem = validateName(name);
        if (problem) {
            errors.slug.textContent = problem;
            slugInput.focus();
            return;
        }
        openButton.disabled = true;
        status.textContent = 'Looking for it...';
        api('/api/stashes/' + encodeURIComponent(name) + '/exists').then(function (res) {
            openButton.disabled = false;
            status.textContent = '';
            if (res.ok) {
                window.location.href = '/s/' + encodeURIComponent(name);
            } else if (res.status === 404) {
                offerToCreate(name);
            } else {
                status.textContent = (res.body && res.body.error) || 'Something went wrong. Try again.';
                status.classList.add('error');
            }
        }).catch(function () {
            openButton.disabled = false;
            status.textContent = 'Could not reach the server.';
            status.classList.add('error');
        });
    }

    // The name is not a stash: say so, and offer to make it
    function offerToCreate(name) {
        $('createOfferText').textContent = canCreate
            ? 'There is no stash called "' + name + '".'
            : 'There is no stash called "' + name + '", and you cannot create stashes on this server.';
        var button = $('createOfferButton');
        button.textContent = 'Create "' + name + '"';
        button.classList.toggle('hidden', !canCreate);
        button.dataset.name = name;
        offer.classList.remove('hidden');
    }

    $('quickForm').addEventListener('submit', function (event) {
        event.preventDefault();
        openStash();
    });

    $('openLinkButton').addEventListener('click', function () {
        clearMessages();
        var text = $('linkInput').value.trim();
        if (!text) { errors.link.textContent = 'Paste a stash link first.'; return; }
        if (!openLink(text)) errors.link.textContent = 'That does not look like a stash link. It should contain /s/ and the stash name.';
    });
    $('linkInput').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); $('openLinkButton').click(); }
    });

    // ---- creating ----

    function createStash(name) {
        clearMessages();
        // Empty box: use the random name shown in it
        name = (name || slugInput.value.trim() || suggestion).trim();
        var problem = validateName(name);
        if (problem) {
            errors.slug.textContent = problem;
            slugInput.focus();
            return;
        }
        if (!passwordInput.value && minOpen && name.length < minOpen) {
            errors.slug.textContent = 'Without a password the name must be at least ' + minOpen + ' characters. Add a password under More options, or use a longer name.';
            setMore(true, false);
            slugInput.focus();
            return;
        }
        if (passwordInput.value && passwordInput.value.length < minPassword) {
            errors.password.textContent = 'The password must be at least ' + minPassword + ' characters.';
            setMore(true, false);
            passwordInput.focus();
            return;
        }
        createButton.disabled = true;
        status.textContent = 'Creating...';
        api('/api/stashes', {
            method: 'POST',
            body: { slug: name, password: passwordInput.value || undefined, ttl: ttlSelect.value },
        }).then(function (res) {
            if (res.ok) {
                window.location.href = res.body.url;
                return;
            }
            createButton.disabled = !canCreate;
            status.textContent = '';
            var message = (res.body && res.body.error) || 'Something went wrong. Try again.';
            var field = res.body && res.body.field;
            if (field && errors[field]) {
                errors[field].textContent = message;
                if (field !== 'slug') setMore(true, false);
            } else {
                status.textContent = message;
                status.classList.add('error');
            }
        }).catch(function () {
            createButton.disabled = !canCreate;
            status.textContent = 'Could not reach the server.';
            status.classList.add('error');
        });
    }

    createButton.addEventListener('click', function () { createStash(''); });
    $('createOfferButton').addEventListener('click', function (event) { createStash(event.currentTarget.dataset.name); });
    $('regenerateButton').addEventListener('click', function () {
        suggest().then(function () { slugInput.value = suggestion; updateHint(); });
        slugInput.focus();
    });
    slugInput.addEventListener('input', function () { errors.slug.textContent = ''; offer.classList.add('hidden'); updateHint(); });
    passwordInput.addEventListener('input', function () { errors.password.textContent = ''; updateHint(); });

    $('curlExample').textContent =
        '# send a note\n' +
        'curl -d "text to share" -H "Content-Type: text/plain" ' + location.origin + '/api/stashes/NAME/notes\n\n' +
        '# send a file\n' +
        'curl -X POST ' + location.origin + '/api/stashes/NAME/files -H "X-File-Name: report.pdf" -H "Content-Type: application/octet-stream" --data-binary @report.pdf\n\n' +
        '# read the newest note\n' +
        'curl ' + location.origin + '/api/stashes/NAME/latest';

    loadConfig();
    suggest();
    slugInput.focus();
})();
