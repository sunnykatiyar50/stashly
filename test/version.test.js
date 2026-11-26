const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { version } = require('../package.json');

test('the public config says which release is running, taken from package.json', async () => {
    const ctx = makeApp();
    assert.equal(ctx.config.version, version);
    const res = await request(ctx.app).get('/api/config').expect(200);
    assert.equal(res.body.version, version);
});

test('the footer of the menu shows the version with a "What is new" link, between the theme switch and the account card', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'shell.js'), 'utf8');
    assert.ok(script.includes('/api/config'));
    assert.ok(script.includes('res.body.version'));
    // The link carries the "label" class, which the collapsed sidebar already hides
    assert.ok(script.includes("'version-btn label'"));
    assert.ok(script.includes("document.querySelector('.sidebar-footer')"));
    assert.ok(script.includes('footer.appendChild(link)'));
    assert.ok(script.includes('/releases'));
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'styles.css'), 'utf8');
    assert.match(css, /\.theme-switch button\.active/);
    // Footer order: theme switch, version, account
    assert.match(css, /\.sidebar-footer \.theme-switch \{ order: 1;/);
    assert.match(css, /\.version-btn \{ order: 2;/);
    assert.match(css, /\.nav-account \{ order: 10;/);
    for (const page of ['index', 'stash', 'account', 'admin', 'settings']) {
        const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', page + '.html'), 'utf8');
        assert.equal((html.match(/data-theme-set="/g) || []).length, 3, page);
    }
});
