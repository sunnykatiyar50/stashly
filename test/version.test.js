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

test('the sidebar script shows that version centred right under the logo and name, and it hides when the menu is collapsed', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'shell.js'), 'utf8');
    assert.ok(script.includes('/api/config'));
    assert.ok(script.includes('res.body.version'));
    // The label carries the "label" class, which the collapsed sidebar already hides
    assert.ok(script.includes("'app-version label'"));
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'styles.css'), 'utf8');
    assert.ok(css.includes('.app-version'));
    // Under the brand block (logo and name), not in the footer, and centred
    assert.ok(script.includes("document.querySelector('.sidebar-brand')"));
    assert.ok(script.includes("insertAdjacentElement('afterend', label)"));
    assert.match(css, /\.app-version\s*\{[^}]*text-align:\s*center/);
});
