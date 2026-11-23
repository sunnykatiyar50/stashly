// The home page: two cards, one intent each — open a stash (by name or by a link you were given),
// or create a new one (a name, a password if you want one, and how long it lives)
(function () {
    'use strict';

    var MIN = 4;
    var GENERATED = 12;
    var minOpen = 0; // from the server: the shortest name allowed without a password
    var minPassword = 10; // from the server: the shortest password accepted
    var canCreate = true; // from the server: whether this visitor may create stashes
    var suggestion = ''; // a random name, shown as the placeholder and used when Create is pressed with the box empty
    var $ = function (id) { return document.getElementById(id); };

    var openInput = $('openInput');
    var slugInput = $('slugInput');
    var passwordInput = $('passwordInput');
    var ttlSelect = $('ttlSelect');
    var createButton = $('createButton');
    var openButton = $('openButton');
    var openStatus = $('openStatus');
    var createStatus = $('createStatus');
    var slugHint = $('slugHint');
    var DEFAULT_HINT = slugHint.textContent;

    var errors = { open: $('openError'), slug: $('slugError'), password: $('passwordError'), ttl: $('ttlError') };

    // Each card clears its own messages: what you type in one says nothing about the other
    function clearOpen() {
        errors.open.textContent = '';
        openStatus.textContent = '';
        openStatus.classList.remove('error');
    }

    function clearCreate() {
        ['slug', 'password', 'ttl'].forEach(function (key) { errors[key].textContent = ''; });
        createStatus.textContent = '';
        createStatus.classList.remove('error');
    }

    function say(status, message, isError) {
        status.textContent = message;
        status.classList.toggle('error', Boolean(isError));
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
            slugHint.textContent = 'To create it without a password, the name must be at least ' + minOpen + ' characters. Add a password, or use a longer name.';
            slugHint.classList.add('warn');
        } else if (length && noPassword && length < GENERATED) {
            slugHint.textContent = 'Short names are easy to guess. Add a password if this should stay private.';
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

    // When creating is limited (to the admin, or to signed-in users), a visitor gets a notice, and the whole create
    // card is switched off. Opening a stash still works.
    function lockCreate(rule) {
        canCreate = false;
        $(rule === 'login' ? 'loginNotice' : 'adminNotice').classList.remove('hidden');
        createButton.disabled = true;
        createButton.title = 'You cannot create stashes on this server';
        Array.prototype.forEach.call($('createFields').querySelectorAll('input, select, button'), function (el) { el.disabled = true; });
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
        clearOpen();
        var raw = openInput.value.trim();
        if (!raw) {
            errors.open.textContent = 'Type the name of a stash, or paste a link to one.';
            openInput.focus();
            return;
        }
        // Someone pasted a whole address into the box
        if (openLink(raw)) return;
        var name = raw.toLowerCase();
        var problem = validateName(name);
        if (problem) {
            errors.open.textContent = problem;
            openInput.focus();
            return;
        }
        openButton.disabled = true;
        openStatus.textContent = 'Looking for it...';
        api('/api/stashes/' + encodeURIComponent(name) + '/exists').then(function (res) {
            openButton.disabled = false;
            openStatus.textContent = '';
            if (res.ok) {
                window.location.href = '/s/' + encodeURIComponent(name);
            } else if (res.status === 404) {
                pointToCreate(name);
            } else {
                say(openStatus, (res.body && res.body.error) || 'Something went wrong. Try again.', true);
            }
        }).catch(function () {
            openButton.disabled = false;
            say(openStatus, 'Could not reach the server.', true);
        });
    }

    // The name is not a stash. Making one is the other card's job, so this says so and points there
    function pointToCreate(name) {
        errors.open.textContent = 'There is no stash called "' + name + '" — create it in the card beside this one.';
        var card = $('createForm');
        card.classList.add('point');
        card.scrollIntoView({ block: 'nearest' });
        setTimeout(function () { card.classList.remove('point'); }, 2500);
    }

    // ---- creating ----

    function createStash() {
        clearCreate();
        // Empty box: use the random name shown in it
        var name = (slugInput.value.trim() || suggestion).trim();
        var problem = validateName(name);
        if (problem) {
            errors.slug.textContent = problem;
            slugInput.focus();
            return;
        }
        if (!passwordInput.value && minOpen && name.length < minOpen) {
            errors.slug.textContent = 'Without a password the name must be at least ' + minOpen + ' characters. Add a password, or use a longer name.';
            slugInput.focus();
            return;
        }
        if (passwordInput.value && passwordInput.value.length < minPassword) {
            errors.password.textContent = 'The password must be at least ' + minPassword + ' characters.';
            passwordInput.focus();
            return;
        }
        createButton.disabled = true;
        createStatus.textContent = 'Creating...';
        api('/api/stashes', {
            method: 'POST',
            body: { slug: name, password: passwordInput.value || undefined, ttl: ttlSelect.value },
        }).then(function (res) {
            if (res.ok) {
                window.location.href = res.body.url;
                return;
            }
            createButton.disabled = !canCreate;
            createStatus.textContent = '';
            var message = (res.body && res.body.error) || 'Something went wrong. Try again.';
            var field = res.body && res.body.field;
            if (field && errors[field]) {
                errors[field].textContent = message;
                if (field !== 'slug') passwordInput.focus();
            } else {
                say(createStatus, message, true);
            }
        }).catch(function () {
            createButton.disabled = !canCreate;
            say(createStatus, 'Could not reach the server.', true);
        });
    }

    $('openForm').addEventListener('submit', function (event) {
        event.preventDefault();
        openStash();
    });

    $('createForm').addEventListener('submit', function (event) {
        event.preventDefault();
        createStash();
    });

    $('regenerateButton').addEventListener('click', function () {
        suggest().then(function () { slugInput.value = suggestion; updateHint(); });
        slugInput.focus();
    });
    slugInput.addEventListener('input', function () { errors.slug.textContent = ''; updateHint(); });
    passwordInput.addEventListener('input', function () { errors.password.textContent = ''; updateHint(); });
    openInput.addEventListener('input', function () { errors.open.textContent = ''; });

    $('curlExample').textContent =
        '# send a note\n' +
        'curl -d "text to share" -H "Content-Type: text/plain" ' + location.origin + '/api/stashes/NAME/notes\n\n' +
        '# send a file\n' +
        'curl -X POST ' + location.origin + '/api/stashes/NAME/files -H "X-File-Name: report.pdf" -H "Content-Type: application/octet-stream" --data-binary @report.pdf\n\n' +
        '# read the newest note\n' +
        'curl ' + location.origin + '/api/stashes/NAME/latest';

    loadConfig();
    suggest();
    openInput.focus();
})();
