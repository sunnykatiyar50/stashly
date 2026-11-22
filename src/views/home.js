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

    // "Sign in" when nobody is signed in to an account, "My stashes" when someone is (the link only exists when the
    // server has accounts)
    function showAccountLink() {
        $('accountLink').classList.remove('hidden');
        api('/api/me').then(function (res) {
            if (res.ok && res.body && res.body.user) {
                $('accountLinkLabel').textContent = 'My stashes';
                $('accountLink').title = 'My stashes, signed in as ' + res.body.user.username;
                showAccountTools();
            }
        }).catch(function () { /* keeps saying "Sign in" */ });
    }

    // Someone signed in to an account can also follow an existing stash from here (creating one follows it already)
    function showAccountTools() {
        $('followForm').classList.remove('hidden');
        $('createFollowNote').classList.remove('hidden');
    }

    $('followForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var fStatus = $('followStatus');
        fStatus.textContent = '';
        fStatus.classList.remove('error');
        $('followDone').classList.add('hidden');
        $('followSlugError').textContent = '';
        $('followError').textContent = '';
        var slug = $('followSlug').value.trim();
        var password = $('followPassword').value;
        var link = $('followLink').value.trim();
        // A whole read-only link carries the name too, so the name field can stay empty
        if (!slug && !link) { $('followSlugError').textContent = 'Enter the stash name.'; $('followSlug').focus(); return; }
        $('followButton').disabled = true;
        api('/api/me/stashes', { method: 'POST', body: { slug: slug || undefined, password: password || undefined, link: link || undefined } }).then(function (res) {
            $('followButton').disabled = false;
            // The password is never left in the form, whatever the answer
            $('followPassword').value = '';
            if (res.status === 401 && res.body && res.body.signedIn === false) {
                $('followForm').classList.add('hidden');
                $('createFollowNote').classList.add('hidden');
                $('accountLinkLabel').textContent = 'Sign in';
                return;
            }
            if (res.ok) {
                $('followSlug').value = '';
                $('followLink').value = '';
                fStatus.textContent = 'Following "' + res.body.slug + '"' + (res.body.role === 'view' ? ' (read-only)' : '') + '.';
                $('followDone').classList.remove('hidden');
            } else {
                var message = (res.body && res.body.error) || 'Could not follow the stash.';
                if (res.body && res.body.field === 'slug') $('followSlugError').textContent = message;
                else $('followError').textContent = message;
            }
        }).catch(function () {
            $('followButton').disabled = false;
            $('followError').textContent = 'Could not reach the server.';
        });
    });

    // The Admin link is for someone who is already signed in as an admin (the root admin or an admin-role user).
    // Guests never see it; an admin who is not signed in yet goes to /admin directly.
    function showAdminLink() {
        api('/api/admin/status').then(function (res) {
            if (res.ok && res.body && res.body.signedIn) $('adminLink').classList.remove('hidden');
        }).catch(function () { /* stays hidden */ });
    }

    function loadConfig() {
        return api('/api/config').then(function (res) {
            if (!res.ok) return;
            if (!res.body.canCreate) lockCreateForm(res.body.createRule);
            if (res.body.accountsEnabled) showAccountLink();
            if (res.body.adminEnabled) showAdminLink();
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
