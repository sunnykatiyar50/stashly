// The stash page on a phone: one row for the stash name and its chips, and the stash's buttons in a three-dot menu in the top bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const get = async (ctx, url) => (await request(ctx.app).get(url).expect(200)).text;

// The rules inside the first @media (max-width: 760px) block that follows a marker comment
function phoneBlock(css, marker) {
    const start = css.indexOf(marker);
    assert.ok(start >= 0, `${marker} is in the stylesheet`);
    const open = css.indexOf('@media (max-width: 760px) {', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}' && --depth === 0) return css.slice(open, i + 1);
    }
    throw new Error('unterminated block');
}

test('the page has the three-dot button, in the header with the other buttons, and loads the menu script', async () => {
    const ctx = makeApp();
    const html = (await get(ctx, '/s/any-stash-name')).replace(/\?v=[0-9a-f]+"/g, '"');
    assert.match(html, /id="moreButton"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
    assert.match(html, /id="moreButton"[^>]*aria-label="More actions"/);
    assert.ok(html.indexOf('id="moreButton"') > html.indexOf('id="pinStashButton"'), 'after the buttons it collects');
    assert.ok(html.indexOf('src="/stash-more.js"') < html.indexOf('src="/stash.js"'), 'loaded before stash.js starts the page');
    // The real buttons stay: the menu presses them
    for (const id of ['copyLatestButton', 'copyLinkButton', 'qrButton', 'shareButton', 'extendButton', 'followStashButton', 'pinStashButton']) assert.match(html, new RegExp(`id="${id}"`));
});

test('on a phone the menu button moves to the top bar after Close and Options, and goes back on a wide screen', async () => {
    const js = await get(makeApp(), '/stash-list.js');
    // Close, then Options (the gear), then the three-dot menu last
    assert.match(js, /var moved = \[\$\('logoutButton'\), \$\('optionsButton'\), \$\('moreButton'\)\];/);
});

test('the phone layout keeps the name and its chips on one row and hides the header buttons', async () => {
    const css = await get(makeApp(), '/styles.css');
    const phone = phoneBlock(css, 'Phone: the top of a stash in two rows');
    assert.match(phone, /#stateMain \.view-header \{[^}]*flex-wrap: nowrap/);
    assert.match(phone, /#stateMain \.header-actions \{ display: none; \}/);
    assert.match(phone, /\.more-button\.in-topbar \{ display: inline-flex; \}/);
    // The old forced line break between the name and the chips is gone
    assert.doesNotMatch(phone, /::after/);
    // Only the name shrinks (with an ellipsis) when the row is too narrow
    assert.match(phone, /#stashTitle \{[^}]*flex: 0 1 auto[^}]*text-overflow: ellipsis/);
    // It is hidden while a clip is open, and the button does not exist on a wide screen
    assert.match(phone, /body:has\(\.view-stash\.detail-open\) \.more-button \{ display: none; \}/);
    assert.match(css, /\n\.more-button \{ display: none; \}/);
});

test('the menu is built from the live header buttons and presses them, with keyboard support', async () => {
    const js = await get(makeApp(), '/stash-more.js');
    for (const id of ['copyLatestButton', 'copyLinkButton', 'qrButton', 'shareButton', 'extendButton', 'followStashButton', 'pinStashButton']) assert.match(js, new RegExp(`'${id}'`));
    assert.match(js, /classList\.contains\('hidden'\)/, 'a button that is hidden is not offered');
    assert.match(js, /source\.click\(\)/, 'pressing an entry presses the real button');
    assert.match(js, /menuitemcheckbox/, 'Follow and Pin say which way they are set');
    for (const key of ['Escape', 'ArrowDown', 'ArrowUp']) assert.match(js, new RegExp(`'${key}'`));
});
