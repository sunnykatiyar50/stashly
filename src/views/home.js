// The home page: create a stash, or open one by name
(function () {
    'use strict';

    var MIN = 4;
    var GENERATED = 12;
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
        if (slug.length < MIN) return 'The name must be at least ' + MIN + ' characters.';
        if (!/^[a-z0-9_-]+$/.test(slug)) return 'Use only letters, numbers, dashes and underscores.';
        return '';
    }

    // A short, memorable name is easy to guess: nudge towards a password
    function updateHint() {
        var short = slugInput.value.trim().length < GENERATED;
        var noPassword = !passwordInput.value;
        if (short && noPassword && slugInput.value.trim()) {
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

    // When only the admin may create stashes, a visitor gets a notice instead of a form that would be refused
    function lockCreateForm() {
        $('adminNotice').classList.remove('hidden');
        Array.prototype.forEach.call($('createForm').elements, function (el) { el.disabled = true; });
    }

    function loadConfig() {
        return api('/api/config').then(function (res) {
            if (!res.ok) return;
            if (!res.body.canCreate) lockCreateForm();
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
        if (passwordInput.value && passwordInput.value.length < 4) {
            errors.password.textContent = 'The password must be at least 4 characters.';
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
