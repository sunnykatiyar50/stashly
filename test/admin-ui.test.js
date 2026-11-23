const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8');
// The opening tag of the element with this id
const tag = (html, id) => (html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [''])[0];

test('the admin section of the left menu is added by one shared script, only for a signed-in admin', () => {
    const script = view('admin-nav.js');
    // Asks who is signed in, and only an admin gets the section
    assert.ok(script.includes('/api/admin/status'));
    assert.match(script, /body\.enabled && body\.signedIn/);
    for (const link of ['/admin#/stashes', '/admin#/users']) assert.ok(script.includes(link), link);
    // Settings is one page for everyone (linked under the account), not part of the Admin section
    assert.ok(!script.includes('/admin#/settings'));
    // Pages that sign people in or out can refresh it without a reload
    assert.ok(script.includes('StashlyAdminNav'));

    // The pages with the main menu load it; none of them has a standalone Admin link any more
    for (const page of ['index.html', 'account.html', 'stash.html']) {
        const html = view(page);
        assert.ok(html.includes('src="/admin-nav.js"'), `${page} loads admin-nav.js`);
        assert.doesNotMatch(html, /href="\/admin"/, `${page} has no standalone Admin link`);
    }
    assert.ok(!view('home.js').includes('/api/admin/status'));
    assert.ok(!view('account.js').includes("'adminLink'"));
    // The sign-in page asks the menu to update once someone has signed in or out
    assert.ok(view('account.js').includes('StashlyAdminNav.refresh'));
});

test('the admin page uses the same menu: Home, My stashes, then an Admin section', () => {
    const html = view('admin.html');
    const nav = html.slice(html.indexOf('<nav class="sidebar-nav"'), html.indexOf('</nav>'));
    const at = text => nav.indexOf(text);
    assert.ok(at('title="Home"') > -1 && at('id="accountLink"') > at('title="Home"'));
    assert.ok(at('nav-section-label') > at('id="accountLink"'));
    assert.ok(at('data-view="stashes"') > at('nav-section-label'));
    assert.ok(at('data-view="users"') > at('data-view="stashes"'));
    assert.equal(at('data-view="settings"'), -1);
    // My stashes is in the menu, not tucked into the footer
    const footer = html.slice(html.indexOf('<div class="sidebar-footer">'), html.indexOf('</aside>'));
    assert.ok(!footer.includes('id="accountLink"'));
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

test('opening a stash follows it by itself: no follow form, no extra note, and My stashes stays in the main menu', () => {
    const home = view('index.html');
    // The home page has neither the follow form nor the note under the title
    assert.doesNotMatch(home, /id="followForm"/);
    assert.doesNotMatch(home, /createFollowNote/);
    // Signed in, "My stashes" is in the main menu (the sidebar nav), not only in the footer
    const nav = home.slice(home.indexOf('<nav class="sidebar-nav"'), home.indexOf('</nav>'));
    assert.match(nav, /id="accountNavLink"/);
    assert.match(tag(home, 'accountNavLink'), /class="[^"]*\bhidden\b/);
    assert.match(view('home.js'), /accountNavLink/);
    // The home page does not list stashes: My stashes is in the menu
    assert.ok(!view('home.js').includes('/api/me/stashes'));

    // The stash page adds the stash by itself, and respects "stop following" in the same tab
    const script = view('stash-account.js');
    assert.ok(script.includes('followNow(true)'));
    assert.ok(script.includes('sessionStorage'));

    // The account page has no follow form
    assert.doesNotMatch(view('account.html'), /id="followForm"/);
    assert.ok(!view('account.js').includes("'followForm'"));
});
