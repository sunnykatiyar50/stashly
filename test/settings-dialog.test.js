// The stash page's Options: one scrolling page in groups (General, Organize, Access, This device, Danger zone) instead of tabs, with the
// name as a field, a tag manager and Move to... in select mode; the stash's own settings are shown to whoever manages the stash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const src = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', name), 'utf8').replace(/\r\n/g, '\n');
const dialogOf = html => html.slice(html.indexOf('<dialog id="optionsDialog"'), html.indexOf('<dialog id="moveDialog"'));
const sectionOf = (dialog, key) => {
    const start = dialog.indexOf(`<section class="opt-section`) >= 0 ? dialog.indexOf(`id="optSection-${key}"`) : -1;
    assert.ok(start >= 0, `${key} section`);
    const from = dialog.lastIndexOf('<section', start);
    return dialog.slice(from, dialog.indexOf('</section>', start));
};
const rowsIn = text => [...text.matchAll(/data-option="([a-z]+)"/g)].map(m => m[1]);

test('Options is one scrolling page in five groups with a jump bar, not tabs', () => {
    const html = src('stash.html');
    const dialog = dialogOf(html);
    assert.doesNotMatch(dialog, /role="tablist"|role="tabpanel"|opt-tab|optPanel/);
    const jump = [...dialog.matchAll(/data-jump="([a-z]+)"/g)].map(m => m[1]);
    assert.deepEqual(jump, ['general', 'organize', 'access', 'device', 'danger']);
    const order = [...dialog.matchAll(/id="optSection-([a-z]+)"/g)].map(m => m[1]);
    assert.deepEqual(order, ['general', 'organize', 'access', 'device', 'danger']);
    // What is in each group
    assert.deepEqual(rowsIn(sectionOf(dialog, 'general')), ['rename', 'expiry', 'owner']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'organize')), ['tags', 'move', 'content', 'keep']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'access')), ['session']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'device')), ['list', 'tab']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'danger')), ['danger']);
    // Everything that was in the old tabs is still there, with the same ids the script wires up
    for (const id of ['renameInput', 'renameSave', 'optExtendButton', 'ownerToggle', 'tagManager', 'optSelectClips', 'keepSelect', 'changePasswordToggle', 'signOutOthers', 'logoutNow', 'contentLinesInput', 'autoCopyInput', 'notifyInput', 'deleteStashButton', 'optionsClose']) {
        assert.match(dialog, new RegExp(`id="${id}"`), id);
    }
    // The name is a field that is always there, with its button waiting for a change
    assert.match(dialog, /<form id="renameForm" class="inline-form"[\s\S]*id="renameInput"[\s\S]*id="renameSave"[^>]*disabled/);
    assert.doesNotMatch(dialog, /id="renameToggle"|id="renameCancel"/);
});

test('select mode has Move to..., and its dialog offers move or copy to a chosen stash', () => {
    const html = src('stash.html');
    assert.match(html, /id="bulkMove" class="ghost small hidden" disabled>Move to\.\.\.</);
    const move = html.slice(html.indexOf('<dialog id="moveDialog"'), html.indexOf('<dialog id="shareDialog"'));
    assert.match(move, /id="moveTarget"/);
    assert.match(move, /name="moveMode" value="move" checked/);
    assert.match(move, /name="moveMode" value="copy"/);
    const select = src('stash-select.js');
    assert.match(select, /\/items\/move', \{ method: 'POST', body: \{ ids: ids, to: to, copy: copy \} \}/);
    // Only for whoever manages the stash, and only when signed in: a clip goes to a stash you own
    assert.match(select, /state\.stash\.canManage && P\.signedIn && P\.signedIn\(\)/);
    // Only your other stashes that you own are offered
    assert.match(select, /entry\.owned && entry\.slug !== state\.stash\.slug/);
    assert.match(src('stash-account.js'), /P\.signedIn = function \(\) \{ return accounts; \}/);
});

test('the settings are shown to whoever manages the stash, and the tag manager talks to the tags routes', () => {
    const js = src('stash-options.js');
    assert.match(js, /var manage = Boolean\(full && state\.stash && state\.stash\.canManage\);/);
    assert.match(js, /\['keep', 'danger', 'rename', 'content', 'tags'\]\.forEach/);
    assert.match(js, /\$\('optSelectClips'\)\.addEventListener\('click'/);
    assert.match(js, /api\(base \+ '\/tags\/rename', \{ method: 'POST', body: \{ from: entry\.name, to: to \} \}\)/);
    assert.match(js, /api\(base \+ '\/tags\/' \+ encodeURIComponent\(entry\.name\), \{ method: 'DELETE' \}\)/);
    // Another page's change reads the list again, unless this page made it
    assert.match(js, /Date\.now\(\) - lastOwnTagChange < 1500/);
    assert.match(src('stash-live.js'), /es\.addEventListener\('tags-changed'/);
    // A group with nothing for this visitor is hidden, and so is the jump bar when only one is left
    assert.match(js, /section\.classList\.toggle\('hidden', !any\)/);
    assert.match(js, /classList\.toggle\('hidden', shown\.length < 2\)/);
});

test('the styles drop the tabs and add the groups, the inline name and the tag manager', async () => {
    const ctx = makeApp();
    const css = (await request(ctx.app).get('/styles.css').expect(200)).text;
    assert.doesNotMatch(css, /\.opt-tab\b|\.opt-panel\b/);
    for (const rule of ['.opt-jump', '.opt-jump-link', '.opt-scroll', '.opt-section', '.opt-danger', '.inline-form', '.tag-manage-row', '.tag-rename-form']) {
        assert.ok(css.includes(rule), rule);
    }
});
