// The stash page's Options: the groups (General, Organize, Access, This device, Danger zone) down the side, or across the top on a phone, one at a
// time; short hints with the detail in a tooltip; the name as a field, a tag manager and Move to... in select mode; the stash's own settings are
// shown to whoever manages the stash.
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

test('Options has five groups as a side list of tabs, one panel each, and the rows are where they belong', () => {
    const html = src('stash.html');
    const dialog = dialogOf(html);
    assert.match(dialog, /<div class="opt-layout" id="optLayout">\s*<nav class="opt-nav" role="tablist"[^>]*aria-orientation="vertical"/);
    const tabs = [...dialog.matchAll(/class="opt-nav-item[^"]*" role="tab" id="optNav-([a-z]+)" data-group="([a-z]+)" aria-controls="optSection-\1"/g)].map(m => m[2]);
    assert.deepEqual(tabs, ['general', 'organize', 'access', 'device', 'danger']);
    const panels = [...dialog.matchAll(/id="optSection-([a-z]+)"[^>]*role="tabpanel" aria-labelledby="optNav-\1"/g)].map(m => m[1]);
    assert.deepEqual(panels, tabs);
    // The two long labels have a short form for a phone
    assert.match(dialog, /<span class="opt-long">This device<\/span><span class="opt-short">Device<\/span>/);
    assert.match(dialog, /<span class="opt-long">Danger zone<\/span><span class="opt-short">Danger<\/span>/);
    // Panels start hidden; the script shows the one that is open
    assert.equal((dialog.match(/class="opt-section[^"]* hidden"/g) || []).length, 5);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'general')), ['rename', 'expiry', 'owner']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'organize')), ['tags', 'move', 'content', 'keep']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'access')), ['session']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'device')), ['list', 'tab']);
    assert.deepEqual(rowsIn(sectionOf(dialog, 'danger')), ['danger']);
    for (const id of ['renameInput', 'renameSave', 'optExtendButton', 'ownerToggle', 'tagManager', 'optSelectClips', 'keepSelect', 'changePasswordToggle', 'signOutOthers', 'logoutNow', 'contentLinesInput', 'autoCopyInput', 'notifyInput', 'deleteStashButton', 'optionsClose']) {
        assert.match(dialog, new RegExp(`id="${id}"`), id);
    }
    // The name is a field that is always there, with its button waiting for a change
    assert.match(dialog, /<form id="renameForm" class="inline-form"[\s\S]*id="renameInput"[\s\S]*id="renameSave"[^>]*disabled/);
    assert.doesNotMatch(dialog, /id="renameToggle"|id="renameCancel"|opt-jump/);
});

test('the hints are short lines with the rest in data-more (a tooltip, and an "i" on touch screens)', () => {
    const dialog = dialogOf(src('stash.html'));
    const more = [...dialog.matchAll(/<(span|small) class="([^"]*)"[^>]*data-more="([^"]+)"[^>]*>([^<]+)<\//g)];
    assert.ok(more.length >= 12, 'every long explanation moved into a tooltip: ' + more.length);
    for (const [, , , detail, shortText] of more) {
        assert.ok(shortText.length <= 60, `short hint too long: "${shortText}"`);
        assert.ok(detail.length > 0);
    }
    // No static hint left that is a paragraph
    for (const m of dialog.matchAll(/<(?:span|small) class="(?:muted|field-hint)[^"]*"[^>]*>([^<]+)</g)) {
        assert.ok(m[1].trim().length <= 90, `still long: "${m[1].trim()}"`);
    }
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
    // One group at a time, keyboard arrows between them, and a group with nothing for this visitor is hidden (the side list too when one is left)
    assert.match(js, /function selectGroup\(key, focus\)/);
    assert.match(js, /'ArrowDown' \|\| event\.key === 'ArrowRight'/);
    assert.match(js, /classList\.toggle\('hidden', !hasRows\(sectionOf\(item\.dataset\.group\)\)\)/);
    assert.match(js, /classList\.toggle\('single', visible\.length < 2\)/);
    // Short hints: the detail is the tooltip and opens under the hint from the "i"
    assert.match(js, /hint\.title = more;/);
    assert.match(js, /make\('button', 'opt-info', 'i'\)/);
    assert.match(js, /info\.setAttribute\('aria-expanded', String\(open\)\)/);
});

test('the styles put the groups down the side, and across the top on a phone, with the small "i"', async () => {
    const ctx = makeApp();
    const css = (await request(ctx.app).get('/styles.css').expect(200)).text;
    assert.doesNotMatch(css, /\.opt-jump|\.opt-tab\b|\.opt-panel\b/);
    for (const rule of ['.opt-layout', '.opt-nav', '.opt-nav-item', '.opt-scroll', '.opt-section', '.opt-info', '.opt-detail', '.inline-form', '.tag-manage-row', '.tag-rename-form']) {
        assert.ok(css.includes(rule), rule);
    }
    assert.match(css, /\.opt-layout \{ display: grid; grid-template-columns: 170px minmax\(0, 1fr\);/);
    // On a phone: one column, and the list becomes a row of tabs
    const phone = css.slice(css.indexOf('.opt-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }'));
    // The tabs share the row in equal widths (all in view, nothing to scroll to), icon above a short label
    assert.match(phone, /\.opt-nav \{ display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\);/);
    assert.doesNotMatch(phone, /\.opt-nav \{[^}]*overflow-x/);
    assert.match(phone, /\.opt-nav-item \{ flex-direction: column;/);
    assert.match(phone, /\.opt-long \{ display: none; \}\s*\.opt-short \{ display: inline; \}/);
});
