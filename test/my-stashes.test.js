// My stashes: two lists (the stashes you own, the ones you follow) in compact, wide rows, with a settings gear on each stash you own that
// opens the stash on its Options. Also: the Options side list is left-aligned, and Extend from Options opens on top of Options.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const page = async (ctx, url) => (await request(ctx.app).get(url).expect(200)).text;

test('the page has two lists with counts, and the empty message for neither', async () => {
    const html = await page(makeApp({ adminPassword: 'admin-pass-123' }), '/account');
    assert.match(html, /<section id="ownedGroup" class="stash-group hidden"[^>]*>\s*<h2 id="ownedTitle" class="group-title">Your stashes <span id="ownedCount"/);
    assert.match(html, /<ul id="ownedList" class="follow-list"/);
    assert.match(html, /<section id="followGroup" class="stash-group hidden"[^>]*>\s*<h2 id="followTitle" class="group-title">Following <span id="followCount"/);
    assert.match(html, /<ul id="followList" class="follow-list"/);
    assert.ok(html.indexOf('id="ownedGroup"') < html.indexOf('id="followGroup"') && html.indexOf('id="followGroup"') < html.indexOf('id="followEmpty"'));
});

test('owned stashes and followed ones go to their own list; the row has Open, a pin, the settings gear (owned) or Unfollow (followed)', async () => {
    const js = await page(makeApp({ adminPassword: 'admin-pass-123' }), '/account.js');
    assert.match(js, /stashes\.filter\(function \(stash\) \{ return stash\.owned; \}\)/);
    assert.match(js, /stashes\.filter\(function \(stash\) \{ return !stash\.owned; \}\)/);
    assert.match(js, /\$\(name \+ 'Group'\)\.classList\.toggle\('hidden', stashes\.length === 0\)/);
    // The gear opens the stash on its Options, and only for a stash you own
    assert.match(js, /if \(stash\.owned\) \{\s*var settings = make\('a', 'button-link ghost small icon-action'\);\s*settings\.href = '\/s\/' \+ encodeURIComponent\(stash\.slug\) \+ '#options';/);
    assert.match(js, /settings\.setAttribute\('aria-label', 'Settings for ' \+ stash\.slug\)/);
    // The green Owner tag stays; Unfollow only for stashes someone else made
    assert.match(js, /if \(stash\.owned\) id\.appendChild\(make\('span', 'chip owner-chip', 'Owner'\)\)/);
    assert.match(js, /if \(!stash\.owned\) \{\s*var unfollow = make\('button', 'ghost small danger-ghost', 'Unfollow'\)/);
    // A pin is an icon button that says which way it is set
    assert.match(js, /pin\.setAttribute\('aria-pressed', String\(Boolean\(stash\.pinned\)\)\)/);
});

test('the rows are one wide compact line, and two lines on a phone', async () => {
    const css = await page(makeApp(), '/styles.css');
    assert.match(css, /#viewAccount > \* \{ width: 100%; max-width: 1100px; margin-inline: auto; \}/);
    assert.match(css, /\.stash-row \{ display: grid; grid-template-columns: minmax\(200px, 1\.15fr\) minmax\(0, 1\.5fr\) auto; align-items: center;[^}]*padding: 8px 14px; min-height: 48px; \}/);
    // The old roomy cards are gone
    assert.doesNotMatch(css, /#viewAccount \.follow-item \{ padding: 18px 22px/);
    const phone = css.slice(css.indexOf('.stash-row { grid-template-columns: minmax(0, 1fr) auto;'));
    assert.match(phone, /\.stash-meta \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
    assert.match(css, /\.group-title \{[^}]*text-transform: uppercase/);
});

test('a stash opens on its Options for #options (or #options=group), once it has loaded and the page is ready, and the address is cleaned', async () => {
    const ctx = makeApp();
    const options = await page(ctx, '/stash-options.js');
    assert.match(options, /\/\^#options\(\?:=\(\[a-z\]\+\)\)\?\$\/\.exec\(location\.hash\)/);
    assert.match(options, /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/);
    // After the first load, and not before back.js is watching dialogs (so Back closes Options instead of leaving the page)
    assert.match(options, /document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', function \(\) \{ openOptions\(found\[1\]\); \}\)/);
    const load = await page(ctx, '/stash-load.js');
    assert.match(load, /if \(P\.openOptionsFromAddress\) P\.openOptionsFromAddress\(\);/);
    // #options is not a share link, so the page's own first batch of clips is still used
    assert.match(load, /!\/\^#options\(=\[a-z\]\+\)\?\$\/\.test\(location\.hash\)/);
});

test('the Options side list starts at the left: icon and label are not centred', async () => {
    const css = await page(makeApp(), '/styles.css');
    assert.match(css, /\.opt-nav-item \{ display: flex; align-items: center; justify-content: flex-start; gap: 10px; width: 100%;/);
});

test('Extend in Options opens on top of Options, so Cancel comes back to it', async () => {
    const options = await page(makeApp(), '/stash-options.js');
    assert.match(options, /\$\('optExtendButton'\)\.addEventListener\('click', openExtend\);/);
    assert.doesNotMatch(options, /\$\('optionsDialog'\)\.close\(\);\s*openExtend\(\)/);
});

test('the Options dialog keeps one size whichever group is open: fixed width and a fixed content height, changing only with the window', async () => {
    const css = await page(makeApp(), '/styles.css');
    assert.match(css, /#optionsDialog \{ width: min\(780px, calc\(100vw - 24px\)\); \}/);
    // A fixed height, not a minimum and maximum that the content moves between
    assert.match(css, /\.opt-scroll \{ min-width: 0; height: min\(62vh, 480px\); overflow-y: auto;/);
    assert.doesNotMatch(css, /\.opt-scroll \{[^}]*(?:min|max)-height/);
    // The same on a phone
    assert.match(css, /\.opt-scroll \{ height: min\(64vh, 520px\); \}/);
});
