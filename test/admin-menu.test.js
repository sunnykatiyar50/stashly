const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8');

test('the actions that change or remove something are in a "..." menu on each row, not loose buttons', () => {
    const script = view('admin.js');
    assert.ok(script.includes('function menuButton('));
    // Stash rows: Extend stays visible; password and Delete are menu items
    const stashRow = script.slice(script.indexOf('function buildRow(stash)'), script.indexOf('function extendStash('));
    assert.ok(stashRow.includes("menuButton(items, 'More actions for '"));
    assert.ok(stashRow.includes("label: 'Delete', danger: true"));
    assert.ok(!stashRow.includes("'danger-ghost small'"), 'no loose Delete button on a stash row');
    // the password item is only added when the server allows an admin reset for that stash
    assert.ok(stashRow.includes('if (stash.canResetPassword)'));
    // User rows: role, disable, reset password, sign out and Delete all live in the menu
    const userRow = script.slice(script.indexOf('function buildUserRow(user)'), script.indexOf('function changeUser('));
    for (const label of ["'Make user' : 'Make admin'", "'Enable' : 'Disable'", "'Reset password'", "'Sign out everywhere'", "label: 'Delete', danger: true"]) {
        assert.ok(userRow.includes(label), label);
    }
    assert.ok(!userRow.includes('actionButton('), 'no loose action buttons on a user row');
});

test('the menu is accessible: a labelled button, menu roles, Escape and arrow keys, and no markup built from data', () => {
    const script = view('admin.js');
    const menu = script.slice(script.indexOf('var openMenu = null'), script.indexOf('function actionButton('));
    for (const part of ["'aria-haspopup', 'menu'", "'aria-expanded'", "'role', 'menu'", "'role', 'menuitem'", "event.key === 'Escape'", "event.key === 'ArrowDown'", "event.key === 'ArrowUp'"]) {
        assert.ok(menu.includes(part), part);
    }
    // closed by a click elsewhere, a resize and a scroll, so it never hangs in the wrong place
    assert.ok(menu.includes("document.addEventListener('click'") && menu.includes("window.addEventListener('resize'") && menu.includes("window.addEventListener('scroll'"));
    // item text goes in as text; the dots are drawn as shapes
    assert.ok(menu.includes('entry.textContent = item.label'));
    assert.ok(!menu.includes('innerHTML'));
});

test('the stash and user tables centre their columns, headers and values alike', () => {
    const html = view('admin.html');
    assert.match(html, /<table class="table table-centered">/);
    assert.match(html, /<table class="table table-centered users-table">/);
    const css = view('styles.css');
    assert.match(css, /\.table-centered th:not\(:first-child\):not\(:last-child\), \.table-centered td:not\(:first-child\):not\(:last-child\)\s*\{\s*text-align:\s*center/);
    assert.match(css, /\.table-centered td\.num\s*\{\s*text-align:\s*center/);
    // the menu is positioned by the script, so the table's own scrolling cannot clip it
    assert.match(css, /\.row-menu\s*\{[^}]*position:\s*fixed/);
});
