// .env.example holds what must be set before the server starts. Everything that can be changed in Admin > Settings is
// left out of it (the environment can still give those a starting value, and the README lists them). This test keeps
// the file, the settings page and the code in step: add a variable to the code and it has to be in one place or the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIELDS } = require('../src/utils/settings');

const root = path.join(__dirname, '..');

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'views') walk(full, out); }
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// The environment variables the server reads
const read = new Set();
for (const file of walk(path.join(root, 'src'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) read.add(match[1]);
}

// The variables that have a setting on the admin page. Each is a starting value for that setting.
const IN_SETTINGS = [
    'MAX_NOTE_KB', 'MAX_FILE_MB', 'MAX_FILES_PER_STASH', 'MAX_ITEMS_PER_STASH', 'MAX_STASH_MB', 'MAX_TOTAL_MB', 'MAX_STASHES',
    'MIN_OPEN_NAME_LENGTH', 'MIN_PASSWORD_LENGTH', 'RESERVE_OLD_NAMES_DAYS', 'USER_SESSION_DAYS', 'STASH_UNLOCK_FAILURES',
    'STASH_UNLOCK_WINDOW_MIN', 'RATE_USER_LOGIN', 'RATE_ADMIN_LOGIN', 'FILE_TYPES', 'ALLOW_NO_EXPIRY', 'UNDO_SECONDS',
    'REQUIRE_ADMIN_TO_CREATE', 'REQUIRE_LOGIN_TO_CREATE', 'ADMIN_CAN_RESET_STASH_PASSWORDS', 'RATE_CREATE', 'RATE_POST',
    'RATE_UPLOAD', 'RATE_READ', 'SMTP_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'SMTP_USER', 'SMTP_PASSWORD',
    'SMTP_FROM', 'SMTP_FROM_NAME', 'EMAIL_PER_HOUR', 'PUBLIC_URL', 'MCP_ENABLED',
];

const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
// A variable is "in" the file when it has a line, commented out or not
const inExample = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(match => match[1]));
// The variable tables live in docs/configuration.md
const readme = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');

test('every variable the server reads is in .env.example or is a starting value for a setting on the admin page', () => {
    const missing = [...read].filter(name => !inExample.has(name) && !IN_SETTINGS.includes(name));
    assert.deepEqual(missing, [], `add these to .env.example, or to a setting: ${missing.join(' ')}`);
});

test('.env.example does not list what the admin page already controls', () => {
    const doubled = IN_SETTINGS.filter(name => inExample.has(name));
    assert.deepEqual(doubled, [], `these are in Admin > Settings, so they do not belong in .env.example: ${doubled.join(' ')}`);
    // it says where the rest went
    assert.match(example, /Admin > Settings/);
});

test('.env.example only names variables the server reads', () => {
    const unknown = [...inExample].filter(name => !read.has(name));
    assert.deepEqual(unknown, [], `not read by the server: ${unknown.join(' ')}`);
});

test('every variable that has a setting is a real setting, and is documented in docs/configuration.md as one', () => {
    for (const name of IN_SETTINGS) {
        assert.ok(read.has(name), `${name} is read by the server`);
        const row = readme.split('\n').find(line => line.startsWith(`| \`${name}\` |`));
        assert.ok(row, `${name} has a row in docs/configuration.md`);
        assert.ok(row.includes('Admin > Settings'), `${name}'s configuration row points to Admin > Settings`);
    }
    // the settings page has a setting for each group the configuration doc names
    const groups = new Set(Object.values(FIELDS).map(field => field.group));
    for (const group of ['Limits', 'Security', 'Files', 'Stashes', 'Rate limits', 'Email', 'MCP']) assert.ok(groups.has(group), group);
});
