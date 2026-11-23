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
    for (const id of ['passwordInput', 'ttlSelect', 'linkInput', 'openLinkButton']) {
        assert.ok(options.indexOf(`id="${id}"`) > -1, `${id} is inside More options`);
    }
    // "Use a random name" is right under the name box, always visible (not behind the toggle)
    assert.ok(html.indexOf('id="regenerateButton"') > html.indexOf('id="slugInput"'));
    assert.ok(html.indexOf('id="regenerateButton"') < html.indexOf('id="slugHint"'));
    assert.ok(html.indexOf('id="regenerateButton"') < html.indexOf('id="moreOptions"'));
    // Password and "Delete after" share one row; the link has a row to itself
    const create = options.slice(options.indexOf('id="moreCreateTitle"'), options.indexOf('id="moreOpenTitle"'));
    assert.ok(create.includes('class="field-row"'));
    assert.ok(create.indexOf('id="passwordInput"') < create.indexOf('id="ttlSelect"'));
    const open = options.slice(options.indexOf('id="moreOpenTitle"'));
    assert.ok(open.includes('id="linkInput"') && !open.includes('id="ttlSelect"') && !open.includes('id="passwordInput"'));
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

test('the home page does not list stashes: My stashes is one click away in the menu', () => {
    const html = view('index.html');
    assert.doesNotMatch(html, /id="myStashes"|id="homeStashList"/);
    const script = view('home.js');
    assert.ok(!script.includes('/api/me/stashes'));
    assert.doesNotMatch(script, /innerHTML/);
    // the menu entry for My stashes is still there for someone signed in
    assert.match(tag(html, 'accountNavLink'), /class="[^"]*\bhidden\b/);
    assert.match(script, /accountNavLink/);
});

test('the home page uses the width: the form on top, the four steps in a row, then the tips and the command line', () => {
    const html = view('index.html');
    const form = html.indexOf('id="quickForm"');
    const how = html.indexOf('class="home-how"');
    const extras = html.indexOf('class="home-extras"');
    assert.ok(form > -1 && how > form && extras > how, 'the form, then how it works, then the extras');
    assert.equal(html.slice(how, extras).match(/<li class="card">/g).length, 4, 'four steps, each its own card');
    const after = html.slice(extras);
    assert.ok(after.includes('Good to know') && after.includes('id="curlExample"'));
    assert.doesNotMatch(html, /home-grid|home-main|home-side/);
    // four steps across a wide screen, two then one as it narrows; the tips and curl side by side, then stacked;
    // the curl lines wrap so all of them show
    const css = view('styles.css');
    assert.match(css, /\.how-steps\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /@media \(max-width: 900px\)\s*\{\s*\.how-steps\s*\{\s*grid-template-columns:\s*repeat\(2,/);
    assert.match(css, /\.home-extras\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /\.how-card \.code\s*\{[^}]*white-space:\s*pre-wrap/);
});
