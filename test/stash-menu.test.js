// The stash page's left menu is the same in every state, like the home page's: "My stashes" in the main menu for someone signed in,
// "Sign in" above Theme for a visitor (when the server has accounts), neither when it has none. It used to lack "Sign in", and the
// account check only ran once the stash had loaded, so signing out on a password-protected stash (which then asks for the
// password) left the menu without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'stash-account.js'), 'utf8');

// Runs stash-account.js against a fake page. The stash never loads (a locked one): only what the script does on its own shows.
function runPage({ me, remembered = {} }) {
    const elements = {};
    const fakeElement = id => ({
        id,
        // Everything starts hidden, as in the page's HTML
        hiddenNow: true,
        classList: {
            add(name) { if (name === 'hidden') elements[id].hiddenNow = true; },
            remove(name) { if (name === 'hidden') elements[id].hiddenNow = false; },
            toggle(name, force) { if (name === 'hidden') elements[id].hiddenNow = Boolean(force); },
            contains(name) { return name === 'hidden' && elements[id].hiddenNow; },
        },
        addEventListener() {},
        querySelector() { return { textContent: '' }; },
        setAttribute() {},
    });
    const get = id => elements[id] || (elements[id] = fakeElement(id));
    const store = { ...remembered };
    const localStorage = { getItem: key => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); } };
    const page = { $: get, state: { stash: null }, api: () => new Promise(() => {}), toast() {}, role: () => null };
    const sandbox = {
        window: { StashlyPage: page, StashlyAccountNav: { firstMe: () => me } },
        document: { hidden: false, addEventListener() {} },
        localStorage, sessionStorage: localStorage, setInterval() {}, clearInterval() {}, setTimeout, Promise,
    };
    vm.runInNewContext(SOURCE, sandbox);
    return { shown: id => !get(id).hiddenNow, store };
}

const answer = body => Promise.resolve({ ok: true, status: 200, body });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a visitor on a locked stash sees "Sign in", and no "My stashes": the check does not wait for the stash to load', async () => {
    const page = runPage({ me: answer({ enabled: true, user: null }) });
    await settle();
    assert.equal(page.shown('signInLink'), true);
    assert.equal(page.shown('accountLink'), false);
    assert.equal(page.store.sl_signed_in, '0');
    assert.equal(page.store.sl_accounts_on, '1');
});

test('someone signed in sees "My stashes" and not "Sign in"; with no accounts on the server, neither', async () => {
    const signedIn = runPage({ me: answer({ enabled: true, user: { username: 'sam' } }) });
    await settle();
    assert.equal(signedIn.shown('accountLink'), true);
    assert.equal(signedIn.shown('signInLink'), false);
    assert.equal(signedIn.store.sl_signed_in, '1');

    const none = runPage({ me: answer({ enabled: false }), remembered: { sl_accounts_on: '1' } });
    await settle();
    assert.equal(none.shown('accountLink'), false);
    assert.equal(none.shown('signInLink'), false);
    assert.equal(none.store.sl_accounts_on, '0', 'forgotten once the server says there are none');
});

test('what was seen last time is drawn at once, before the server has answered', () => {
    const never = new Promise(() => {});
    // Signed out a moment ago (the page reloaded after Sign out): the entry is there from the first paint
    const afterSignOut = runPage({ me: never, remembered: { sl_signed_in: '0', sl_accounts_on: '1' } });
    assert.equal(afterSignOut.shown('signInLink'), true);
    assert.equal(afterSignOut.shown('accountLink'), false);
    const known = runPage({ me: never, remembered: { sl_signed_in: '1', sl_accounts_on: '1' } });
    assert.equal(known.shown('accountLink'), true);
    assert.equal(known.shown('signInLink'), false);
    // First visit: nothing is guessed
    const first = runPage({ me: never });
    assert.equal(first.shown('accountLink'), false);
    assert.equal(first.shown('signInLink'), false);
});

test('the page has the Sign in link in the footer above Theme, and Sign out keeps what says accounts exist', async () => {
    const ctx = makeApp();
    const html = (await request(ctx.app).get('/s/any-stash-name').expect(200)).text;
    const footer = html.slice(html.indexOf('<div class="sidebar-footer">'));
    assert.ok(footer.indexOf('id="signInLink"') > 0, 'the link is in the footer');
    assert.ok(footer.indexOf('id="signInLink"') < footer.indexOf('id="themeSwitch"'), 'above the theme switch, as on the home page');
    assert.match(footer, /id="signInLink" class="nav-link hidden"/);
    assert.match(footer, /href="\/account" id="signInLink"/);
    // Same order in the main menu as ever: Home, My stashes, then this stash
    const nav = html.slice(html.indexOf('<nav class="sidebar-nav"'), html.indexOf('</nav>'));
    assert.ok(nav.indexOf('title="Home"') < nav.indexOf('id="accountLink"') && nav.indexOf('id="accountLink"') < nav.indexOf('id="thisStashLink"'));
    // Signing out only forgets who was signed in; it must not forget that the server has accounts
    const accountNav = (await request(ctx.app).get('/account-nav.js').expect(200)).text;
    assert.doesNotMatch(accountNav, /sl_accounts_on/);
    assert.match(accountNav, /localStorage\.setItem\('sl_signed_in', '0'\)/);
});
