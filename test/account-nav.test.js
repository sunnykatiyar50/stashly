const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8');

test('who is signed in, and Sign out, are shown at the bottom of the left menu on every page that has one', () => {
    for (const page of ['index.html', 'stash.html', 'account.html', 'admin.html']) {
        const html = view(page);
        assert.ok(html.includes('src="/account-nav.js"'), `${page} loads account-nav.js`);
        // after shell.js, which the script's page needs, and with a footer to put the block in
        assert.ok(html.indexOf('src="/account-nav.js"') > html.indexOf('src="/shell.js"'), `${page} loads it after shell.js`);
        assert.ok(html.includes('class="sidebar-footer"'), `${page} has the footer`);
    }
});

test('the account block asks who is signed in, shows the name, the username and the role, and signs out of both sessions', () => {
    const script = view('account-nav.js');
    assert.ok(script.includes('/api/me'));
    // Only an account that is on and signed in gets the block
    assert.match(script, /body\.enabled && body\.user/);
    // The display name when there is one, with the username and the role under it
    assert.match(script, /user\.displayName \|\| user\.username/);
    assert.ok(script.includes("'Admin'") && script.includes("'User'"));
    // Sign out ends the account session and the old admin-password cookie, forgets what the menu remembered, and reloads
    assert.ok(script.includes('/api/auth/logout') && script.includes('/api/admin/logout'));
    assert.ok(script.includes("'sl_signed_in'") && script.includes("'sl_admin_nav'"));
    assert.ok(script.includes('location.reload()'));
    // Text only goes in with textContent, never as markup (names are chosen by users)
    assert.equal(script.split('innerHTML').length - 1, 1, 'innerHTML is used once');
    assert.ok(script.includes('holder.innerHTML = ICON'), 'and only for the constant icon');
    // The pages that sign people in or out can refresh it
    assert.ok(script.includes('StashlyAccountNav'));
    assert.ok(view('account.js').includes('StashlyAccountNav.refresh'));
    assert.ok(view('admin.js').includes('StashlyAccountNav.refresh'));
});

test('Theme sits above the account block: the block is added last in the footer', () => {
    const script = view('account-nav.js');
    assert.ok(script.includes('footer.appendChild(block)'));
    assert.ok(!script.includes('footer.insertBefore(block, footer.firstChild)'));
    // its separator is a line above it, between Theme and the name
    assert.match(view('styles.css'), /\.nav-account\s*\{[^}]*border-top:/);
});

test('the admin page does not show two Sign out buttons once the account block is there', () => {
    const css = view('styles.css');
    assert.match(css, /body\.has-account-nav #logoutButton\s*\{\s*display:\s*none/);
    assert.ok(view('account-nav.js').includes("'has-account-nav'"));
});

test('a stash is closed, not logged out of: the stash page says Close, and Sign out is only for the account', () => {
    const html = view('stash.html');
    assert.match(html, /id="logoutButton"[^>]*aria-label="Close"/);
    assert.ok(html.includes('Close stash now'));
    assert.doesNotMatch(html, /Log out|log out|>Exit</);
    for (const file of ['stash-load.js', 'stash-options.js']) {
        const js = view(file);
        assert.doesNotMatch(js, /'Log out'|'Exit'|Log out of this stash|Leave this stash/, file);
    }
    assert.ok(view('stash-load.js').includes("var leaveWord = 'Close'"));
    // The account's own Sign out is in the left menu block, which the stash page loads too
    assert.ok(html.includes('src="/account-nav.js"'));
});

test('the stash page menu order is Home, My stashes, Pinned, then the open stash; the open stash is hidden when it is pinned', () => {
    const html = view('stash.html');
    const at = text => html.indexOf(text);
    assert.ok(at('title="Home"') < at('id="accountLink"'));
    assert.ok(at('id="accountLink"') < at('id="thisStashLink"'));
    const script = view('account-nav.js');
    // The pinned list goes in front of the open stash (and so in front of Admin), and hides the open stash's own entry
    assert.ok(script.includes("nav.querySelector('#thisStashLink, .nav-section, .nav-section-label')"));
    assert.ok(script.includes('setOpenStashVisible(!(here && pinned.some('));
});

test('the stash page reuses the config and /api/me answers the page start already asked for', () => {
    assert.ok(view('stash.js').includes('window.StashlyConfig ? window.StashlyConfig()'));
    assert.ok(view('stash-account.js').includes('nav.firstMe()'));
});
