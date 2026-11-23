const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const views = path.join(__dirname, '..', 'src', 'views');
const view = name => fs.readFileSync(path.join(views, name), 'utf8');
const tag = (html, id) => (html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`)) || [''])[0];

test('the menu entry is Home, and the home page is two cards rather than one box for both', () => {
    const html = view('index.html');
    for (const page of ['index.html', 'stash.html', 'account.html', 'admin.html']) {
        assert.match(view(page), /<a href="\/" class="nav-link[^"]*" title="Home"/, `${page} says Home`);
    }
    // Neither of the old layouts: one box for both intents, or a separate "Open an existing stash" card
    assert.doesNotMatch(html, /id="quickForm"|Open an existing stash/);
    // The home page does not list stashes: My stashes is one click away in the menu
    assert.doesNotMatch(html, /id="myStashes"|id="homeStashList"/);
});

test('opening and creating are cards side by side, each with only what it needs and nothing behind a toggle', () => {
    const html = view('index.html');
    const css = view('styles.css');
    assert.match(html, /<div class="home-pair">/);
    assert.match(css, /\.home-pair\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*0\.9fr\)\s*minmax\(0,\s*1\.1fr\)/);
    assert.match(css, /@media \(max-width: 860px\)\s*\{\s*\.home-pair\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

    // Opening: one box for a name or a pasted link, so a #view= / #drop= link keeps its access
    const open = html.slice(html.indexOf('id="openForm"'), html.indexOf('id="createForm"'));
    assert.match(tag(html, 'openForm'), /class="[^"]*\bintent-card\b/);
    assert.match(tag(html, 'openInput'), /type="text"/);
    assert.match(tag(html, 'openButton'), /type="submit"/);
    assert.match(tag(html, 'openError'), /role="alert"/);
    assert.ok(open.includes('id="openInput"'));
    assert.ok(!open.includes('id="passwordInput"') && !open.includes('id="ttlSelect"'), 'opening asks for nothing else');

    // Creating: a name, what to lock it with, and how long it lives — all in the card, no toggle to open first
    const create = html.slice(html.indexOf('id="createForm"'), html.indexOf('id="accountNotice"'));
    assert.match(tag(html, 'createForm'), /class="[^"]*\bintent-card\b/);
    assert.match(tag(html, 'createButton'), /type="submit"/);
    assert.match(tag(html, 'passwordInput'), /type="password"/);
    assert.ok(create.includes('id="passwordInput"') && create.includes('id="ttlSelect"'));
    // Password and "Delete after" share one row
    const lockRow = create.slice(create.indexOf('id="slugHint"'), create.indexOf('id="createStatus"'));
    assert.ok(lockRow.includes('class="field-row"'));
    assert.ok(create.indexOf('id="passwordInput"') < create.indexOf('id="ttlSelect"'));
    for (const id of ['slugError', 'passwordError']) assert.match(tag(html, id), /role="alert"/);

    // The old "More options" toggle is gone from the markup and the stylesheet
    assert.ok(!html.includes('More options') && !html.includes('moreToggle'));
    assert.doesNotMatch(css, /\.more-options|\.more-toggle/);
});

test('the name, the random name and Create share one row of the create card, and wrap without shrinking', () => {
    const html = view('index.html');
    const css = view('styles.css');
    const nameRow = html.slice(html.indexOf('id="slugInput"'), html.indexOf('id="slugHint"'));
    for (const id of ['slugInput', 'regenerateButton', 'createButton']) {
        assert.ok(nameRow.includes(`id="${id}"`), `${id} is in the name row`);
    }
    // Create last, so wrapping never splits a button from the box it acts on
    assert.ok(nameRow.indexOf('id="regenerateButton"') < nameRow.indexOf('id="createButton"'));
    assert.match(css, /\.intent-row\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(css, /\.random-name\s*\{\s*flex:\s*none/);
    assert.ok(!/\.intent-row > button:last-child \{ flex: 0 1 auto; \}/.test(css), 'buttons keep their own width');
    // A random name is for a stash you are making, so the button is in the create card alone
    assert.ok(html.indexOf('id="regenerateButton"') > html.indexOf('id="createForm"'));
    assert.ok(html.indexOf('id="regenerateButton"') < html.indexOf('id="createStatus"'));
});

test('a name that exists opens; one that does not says so and points at the create card', () => {
    const script = view('home.js');
    // Asks the server whether the name exists, then opens it or points at creating
    assert.ok(script.includes("'/exists'"));
    assert.ok(script.includes('pointToCreate(name)'));
    assert.ok(script.includes("window.location.href = '/s/' + encodeURIComponent(name)"));
    // Creating itself is the other card's form: the open card holds no create button and never posts one
    const opening = script.slice(script.indexOf('function openStash()'), script.indexOf('// ---- creating ----'));
    assert.ok(!opening.includes('createStash('));
    assert.match(script, /There is no stash called/);
    assert.match(script, /create it in the card beside this one/);
    assert.match(script, /var card = \$\('createForm'\);\s*card\.classList\.add\('point'\)/);
    // Create with the box empty uses the random name shown in it
    assert.ok(script.includes('|| suggestion'));
    // Someone who may not create gets the whole create card switched off, and can still open
    assert.ok(script.includes('createButton.disabled = true'));
    assert.match(script, /\$\('createFields'\)\.querySelectorAll\('input, select, button'\)/);
    // A pasted link keeps its #view= / #drop= token
    assert.ok(script.includes('addressOf('));
});

test('the home page does not list stashes: My stashes is one click away in the menu', () => {
    const html = view('index.html');
    const script = view('home.js');
    assert.ok(!script.includes('/api/me/stashes'));
    assert.doesNotMatch(script, /innerHTML/);
    // the menu entry for My stashes is still there for someone signed in
    assert.match(tag(html, 'accountNavLink'), /class="[^"]*\bhidden\b/);
    assert.ok(script.includes('accountNavLink'));
});

test('the home page uses the width: the two cards on top, the four steps in a row, then the tips and the command line', () => {
    const html = view('index.html');
    const css = view('styles.css');
    const pair = html.indexOf('class="home-pair"');
    const how = html.indexOf('class="home-how"');
    const extras = html.indexOf('class="home-extras"');
    assert.ok(pair > -1 && how > pair && extras > how, 'the cards, then how it works, then the extras');
    assert.equal(html.slice(how, extras).match(/<li class="card">/g).length, 4, 'four steps, each its own card');
    const after = html.slice(extras);
    assert.ok(after.includes('Good to know') && after.includes('id="curlExample"'));
    assert.doesNotMatch(html, /home-grid|home-main|home-side/);
    // four steps across a wide screen, two then one as it narrows; the tips and curl side by side, then stacked;
    // the curl lines wrap so all of them show
    assert.match(css, /\.how-steps\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /@media \(max-width: 900px\)\s*\{\s*\.how-steps\s*\{\s*grid-template-columns:\s*repeat\(2,/);
    assert.match(css, /\.home-extras\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /\.how-card \.code\s*\{[^}]*white-space:\s*pre-wrap/);
});
