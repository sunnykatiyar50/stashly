// The home page: create a stash, or open one by name
(function () {
    'use strict';

    var MIN = 4;
    var GENERATED = 12;
    var minOpen = 0; // from the server: the shortest name allowed without a password
    var minPassword = 10; // from the server: the shortest password accepted
    var $ = function (id) { return document.getElementById(id); };

    var slugInput = $('slugInput');
    var passwordInput = $('passwordInput');
    var ttlSelect = $('ttlSelect');
    var createButton = $('createButton');
    var status = $('createStatus');
    var slugHint = $('slugHint');
    var DEFAULT_HINT = slugHint.textContent;

    var errors = { slug: $('slugError'), password: $('passwordError'), ttl: $('ttlError') };

    function clearErrors() {
        Object.keys(errors).forEach(function (key) { errors[key].textContent = ''; });
        status.textContent = '';
        status.classList.remove('error');
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
            slugHint.textContent = 'Without a password the name must be at least ' + minOpen + ' characters. Add a password, or use a longer name.';
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
                slugInput.value = res.body.slug;
                errors.slug.textContent = '';
                updateHint();
            }
        });
    }

    // When creating is limited (to the admin, or to signed-in users), a visitor gets a notice instead of a form that
    // would be refused
    function lockCreateForm(rule) {
        $(rule === 'login' ? 'loginNotice' : 'adminNotice').classList.remove('hidden');
        Array.prototype.forEach.call($('createForm').elements, function (el) { el.disabled = true; });
    }

    // "Sign in" when nobody is signed in to an account, "My stashes" in the main menu when someone is (the link only
    // exists when the server has accounts)
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
            }
            if (res.ok && res.body && res.body.user) {
                // Signed in: "My stashes" joins the main menu (the same place it has on the My stashes page) and the
                // footer's "Sign in" goes away
                $('accountNavLink').classList.remove('hidden');
                $('accountNavLink').title = 'My stashes, signed in as ' + res.body.user.username;
                $('accountLink').classList.add('hidden');
            }
        }).catch(function () { /* keeps saying "Sign in" */ });
    }

    function loadConfig() {
        // shell.js has already asked for the config; reuse that answer instead of asking again
        return (window.StashlyConfig ? window.StashlyConfig() : api('/api/config')).then(function (res) {
            if (!res.ok) return;
            if (!res.body.canCreate) lockCreateForm(res.body.createRule);
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

    $('regenerateButton').addEventListener('click', function () { suggest(); slugInput.focus(); });
    slugInput.addEventListener('input', function () { errors.slug.textContent = ''; updateHint(); });
    passwordInput.addEventListener('input', function () { errors.password.textContent = ''; updateHint(); });

    $('createForm').addEventListener('submit', function (event) {
        event.preventDefault();
        clearErrors();
        var problem = validateName(slugInput.value);
        if (problem) {
            errors.slug.textContent = problem;
            slugInput.focus();
            return;
        }
        if (!passwordInput.value && minOpen && slugInput.value.trim().length < minOpen) {
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
        status.textContent = 'Creating...';
        api('/api/stashes', {
            method: 'POST',
            body: { slug: slugInput.value.trim(), password: passwordInput.value || undefined, ttl: ttlSelect.value },
        }).then(function (res) {
            if (res.ok) {
                window.location.href = res.body.url;
                return;
            }
            createButton.disabled = false;
            status.textContent = '';
            var message = (res.body && res.body.error) || 'Something went wrong. Try again.';
            var field = res.body && res.body.field;
            if (field && errors[field]) errors[field].textContent = message;
            else {
                status.textContent = message;
                status.classList.add('error');
            }
        }).catch(function () {
            createButton.disabled = false;
            status.textContent = 'Could not reach the server.';
            status.classList.add('error');
        });
    });

    $('openForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var name = $('openInput').value.trim().toLowerCase();
        if (name) window.location.href = '/s/' + encodeURIComponent(name);
    });

    $('curlExample').textContent =
        'curl -d "text to share" -H "Content-Type: text/plain" ' + location.origin + '/api/stashes/NAME/notes\n' +
        'curl ' + location.origin + '/api/stashes/NAME/latest';

    loadConfig();
    suggest();
})();
