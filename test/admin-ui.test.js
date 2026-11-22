const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8');
// The opening tag of the element with this id
const tag = (html, id) => (html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [''])[0];

test('the home page does not show an Admin link to a guest: it starts hidden and only home.js reveals it', () => {
    const html = view('index.html');
    assert.match(tag(html, 'adminLink'), /class="[^"]*\bhidden\b/);
    // The guest-facing notice sends people to Sign in, not to the admin login
    assert.doesNotMatch(html, /Sign in as admin/);
    const script = view('home.js');
    assert.match(script, /api\('\/api\/admin\/status'\)/);
    assert.match(script, /signedIn/);
});

test('the admin page keeps Create user and Backup behind buttons', () => {
    const html = view('admin.html');
    assert.match(tag(html, 'userForm'), /class="[^"]*\bhidden\b/);
    assert.match(tag(html, 'backupCard'), /class="[^"]*\bhidden\b/);
    assert.match(tag(html, 'createUserToggle'), /aria-controls="userForm"/);
    assert.match(tag(html, 'backupToggle'), /aria-controls="backupCard"/);
    assert.match(tag(html, 'createUserToggle'), /aria-expanded="false"/);
    assert.match(tag(html, 'backupToggle'), /aria-expanded="false"/);
});

test('the admin sidebar has a Sign in link to the account page, shown once the admin is signed in', () => {
    const html = view('admin.html');
    assert.match(tag(html, 'accountLink'), /href="\/account"/);
    assert.match(tag(html, 'accountLink'), /class="[^"]*\badmin-only\b/);
    assert.match(tag(html, 'accountLink'), /class="[^"]*\bhidden\b/);
});
