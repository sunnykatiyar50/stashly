const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8');
const tag = (html, id) => (html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [''])[0];

test('the home page is one box to open a stash by name or create it', () => {
    const html = view('index.html');
    // One name box with Open and Create next to it
    assert.match(tag(html, 'slugInput'), /type="text"/);
    assert.ok(html.includes('id="openButton"') && html.includes('id="createButton"'));
    // Nothing of the old separate "Open an existing stash" card
    assert.doesNotMatch(html, /id="openForm"|id="openInput"|Open an existing stash/);
    // The menu entry is Home on every page
    for (const page of ['index.html', 'stash.html', 'account.html', 'admin.html']) {
        assert.match(view(page), /<a href="\/" class="nav-link[^"]*" title="Home"/, `${page} says Home`);
    }
});

test('More options hides the password, expiry and open-by-link behind a toggle that starts closed', () => {
    const html = view('index.html');
    assert.match(tag(html, 'moreToggle'), /aria-expanded="false"/);
    assert.match(tag(html, 'moreToggle'), /aria-controls="moreOptions"/);
    assert.match(tag(html, 'moreOptions'), /class="[^"]*\bhidden\b/);
    const options = html.slice(html.indexOf('id="moreOptions"'));
    for (const id of ['passwordInput', 'ttlSelect', 'regenerateButton', 'linkInput', 'openLinkButton']) {
        assert.ok(options.indexOf(`id="${id}"`) > -1, `${id} is inside More options`);
    }
    // It is not drawn open on the first paint, and the choice is remembered in the browser
    assert.ok(view('home.js').includes('sl_home_more'));
});

test('typing a name that is not a stash offers to create it; a name that is opens it', () => {
    const script = view('home.js');
    // Asks the server whether the name exists, then opens it or offers to create it
    assert.ok(script.includes("'/exists'"));
    assert.ok(script.includes('offerToCreate(name)'));
    assert.ok(script.includes("window.location.href = '/s/' + encodeURIComponent(name)"));
    // Create with the box empty uses the random name shown in it
    assert.ok(script.includes('|| suggestion'));
    // Someone who may not create gets Create switched off, and can still open
    assert.ok(script.includes('createButton.disabled = true'));
    assert.match(script, /There is no stash called/);
    // A pasted link keeps its #view= / #drop= token
    assert.ok(script.includes('addressOf('));
});

test('a signed-in account sees the stashes it follows on the home page, and a guest does not', () => {
    const html = view('index.html');
    assert.match(tag(html, 'myStashes'), /class="[^"]*\bhidden\b/);
    assert.ok(html.includes('href="/account"') && html.includes('See all'));
    const script = view('home.js');
    // Only asked for after /api/me says someone is signed in
    assert.ok(script.lastIndexOf('loadMyStashes()') > script.indexOf("api('/api/me')"));
    assert.ok(script.includes('/api/me/stashes'));
    // Names go in as text, never as markup
    assert.doesNotMatch(script, /innerHTML/);
});

test('the home page has two columns: the form and your stashes on the left, how it works on the right', () => {
    const html = view('index.html');
    const grid = html.indexOf('class="home-grid"');
    const main = html.indexOf('class="home-main"');
    const side = html.indexOf('class="home-side"');
    assert.ok(grid > -1 && main > grid && side > main, 'home-grid holds home-main, then home-side');
    // the open/create form and the followed stashes are in the left column, how it works in the right
    const left = html.slice(main, side);
    assert.ok(left.includes('id="quickForm"') && left.includes('id="myStashes"'));
    assert.ok(!left.includes('How it works'));
    const right = html.slice(side);
    assert.ok(right.includes('How it works') && right.includes('id="curlExample"'));
    // two columns on a wide screen, one when there is no room, and the curl lines wrap so all of them show
    const css = view('styles.css');
    assert.match(css, /\.home-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.55fr\)\s*minmax\(280px,\s*1fr\)/);
    assert.match(css, /@media \(max-width: 900px\)\s*\{\s*\.home-grid\s*\{\s*grid-template-columns:\s*1fr/);
    assert.match(css, /\.how-card \.code\s*\{[^}]*white-space:\s*pre-wrap/);
});
