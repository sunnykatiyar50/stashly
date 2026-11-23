// Email: the SMTP settings (Admin > Settings > Email), how the password is kept, the test email, and the mailer's rules.
// Messages go to a real SMTP server on a local port (test/helpers/smtp.js), so the whole path is exercised.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { startSmtp } = require('./helpers/smtp');
const { Mailer, MailError, validAddress } = require('../src/utils/mailer');
const { loadConfig } = require('../src/config');

const ADMIN = 'admin-pass-123';
const SMTP_PASSWORD = 'smtp-secret-pa55word';

async function adminApp(overrides = {}, options) {
    const ctx = makeApp({ adminPassword: ADMIN, ...overrides }, options);
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    return { ...ctx, admin };
}

const save = (ctx, values) => ctx.admin.put('/api/admin/settings').send({ values });
const fieldOf = async (ctx, key) => (await ctx.admin.get('/api/admin/settings').expect(200)).body.fields.find(f => f.key === key);

// Settings that point the app at the local test server
const settingsFor = (smtp, extra = {}) => ({
    smtpEnabled: true, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'none',
    smtpFromAddress: 'stashly@example.com', smtpFromName: 'Stashly Test', ...extra,
});

test('the Email tab has the SMTP fields, with the environment as the starting point', async () => {
    const ctx = await adminApp({ smtpHost: 'mail.example.org', smtpPort: 2525, smtpFromAddress: 'noreply@example.org' });
    const fields = (await ctx.admin.get('/api/admin/settings').expect(200)).body.fields.filter(f => f.group === 'Email');
    assert.deepEqual(fields.map(f => f.key), ['smtpEnabled', 'smtpHost', 'smtpPort', 'smtpSecurity', 'smtpUser', 'smtpPassword', 'smtpFromAddress', 'smtpFromName', 'publicUrl', 'emailsPerHour']);
    assert.equal((await fieldOf(ctx, 'smtpHost')).value, 'mail.example.org');
    assert.equal((await fieldOf(ctx, 'smtpPort')).value, 2525);
    assert.equal((await fieldOf(ctx, 'smtpSecurity')).value, 'starttls');
    assert.equal((await fieldOf(ctx, 'smtpEnabled')).value, false);
    assert.deepEqual((await fieldOf(ctx, 'smtpSecurity')).options.map(o => o.value), ['starttls', 'ssl', 'none']);
    for (const field of fields) assert.ok(field.label && field.help, field.key);
});

test('the environment can give the SMTP settings, including the password', () => {
    const config = loadConfig({
        SMTP_ENABLED: 'true', SMTP_HOST: ' smtp.example.com ', SMTP_PORT: '465', SMTP_SECURITY: 'SSL', SMTP_USER: 'me',
        SMTP_PASSWORD: 'p w', SMTP_FROM: 'a@example.com', SMTP_FROM_NAME: 'Team', EMAIL_PER_HOUR: '30', PUBLIC_URL: 'https://stash.example.com/',
    });
    assert.deepEqual(
        [config.smtpEnabled, config.smtpHost, config.smtpPort, config.smtpSecurity, config.smtpUser, config.smtpPassword, config.smtpFromAddress, config.smtpFromName, config.emailsPerHour, config.publicUrl],
        [true, 'smtp.example.com', 465, 'ssl', 'me', 'p w', 'a@example.com', 'Team', 30, 'https://stash.example.com']
    );
    const empty = loadConfig({});
    assert.deepEqual([empty.smtpEnabled, empty.smtpPort, empty.smtpSecurity, empty.smtpFromName, empty.emailsPerHour, empty.publicUrl], [false, 587, 'starttls', 'Stashly', 100, '']);
    assert.equal(loadConfig({ SMTP_SECURITY: 'whatever', SMTP_PORT: '99999' }).smtpSecurity, 'starttls');
    assert.equal(loadConfig({ SMTP_PORT: '99999' }).smtpPort, 65535);
});

test('the SMTP password is write-only: never sent back, never in the audit log, encrypted in the database', async () => {
    const audit = [];
    const ctx = await adminApp({ auditLog: 'stdout' }, { auditOut: line => audit.push(line) });
    await save(ctx, { smtpHost: 'mail.example.org', smtpUser: 'me', smtpPassword: SMTP_PASSWORD }).expect(200);

    const page = await ctx.admin.get('/api/admin/settings').expect(200);
    assert.ok(!JSON.stringify(page.body).includes(SMTP_PASSWORD), 'the page never gets the password');
    const field = page.body.fields.find(f => f.key === 'smtpPassword');
    assert.equal(field.type, 'secret');
    assert.equal(field.value, '');
    assert.equal(field.isSet, true);
    const saved = await save(ctx, { smtpFromName: 'Someone' }).expect(200);
    assert.ok(!JSON.stringify(saved.body).includes(SMTP_PASSWORD), 'neither does the answer to a save');

    // the audit log says the password changed, never to what
    assert.ok(!audit.join('\n').includes(SMTP_PASSWORD));
    const change = audit.map(line => JSON.parse(line)).find(entry => entry.event === 'admin.settings_changed' && entry.detail.keys.includes('smtpPassword'));
    assert.ok(change, 'the change is audited');
    assert.ok(!('smtpPassword' in change.detail.values));

    // in the database it is encrypted
    const row = ctx.db.prepare("SELECT value FROM meta WHERE key = 'settings'").get().value;
    assert.ok(!row.includes(SMTP_PASSWORD), 'not stored as text');
    assert.match(JSON.parse(row).smtpPassword, /^enc:v1:/);
    assert.equal(ctx.config.smtpPassword, SMTP_PASSWORD, 'the server itself has it in memory');
});

test('a saved password survives a restart with the same server secret, and is dropped (to be entered again) with another', async () => {
    const ctx = await adminApp();
    await save(ctx, { smtpHost: 'mail.example.org', smtpPassword: SMTP_PASSWORD }).expect(200);

    const same = makeApp({ adminPassword: ADMIN }, { db: ctx.db });
    assert.equal(same.config.smtpPassword, SMTP_PASSWORD);
    assert.equal(same.config.smtpHost, 'mail.example.org');

    const other = makeApp({ adminPassword: ADMIN }, { db: ctx.db, secret: 'a-different-server-secret' });
    assert.equal(other.config.smtpPassword, '', 'cannot be decrypted, so it is not used');
    assert.equal(other.config.smtpHost, 'mail.example.org', 'the other settings are plain and stay');
    const login = request.agent(other.app);
    await login.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    const field = (await login.get('/api/admin/settings').expect(200)).body.fields.find(f => f.key === 'smtpPassword');
    assert.equal(field.isSet, false);
});

test('an empty password box keeps the saved one; null removes it; reset puts the environment value back', async () => {
    const ctx = await adminApp({ smtpPassword: 'from-the-environment' });
    await save(ctx, { smtpPassword: SMTP_PASSWORD }).expect(200);
    assert.equal(ctx.config.smtpPassword, SMTP_PASSWORD);
    await save(ctx, { smtpPassword: '', smtpHost: 'mail.example.org' }).expect(200);
    assert.equal(ctx.config.smtpPassword, SMTP_PASSWORD, 'left alone');
    await save(ctx, { smtpPassword: null }).expect(200);
    assert.equal(ctx.config.smtpPassword, '', 'removed');
    assert.equal((await fieldOf(ctx, 'smtpPassword')).isSet, false);
    await ctx.admin.post('/api/admin/settings/reset').expect(200);
    assert.equal(ctx.config.smtpPassword, 'from-the-environment');
});

test('values are checked: sending needs a server and an address, the address must look right, the public URL has no path', async () => {
    const ctx = await adminApp();
    const turnOn = (await save(ctx, { smtpEnabled: true }).expect(400)).body.errors;
    assert.ok(turnOn.smtpHost && turnOn.smtpFromAddress);
    assert.ok((await save(ctx, { smtpFromAddress: 'not an address' }).expect(400)).body.errors.smtpFromAddress);
    assert.ok((await save(ctx, { smtpFromAddress: 'a@b' }).expect(400)).body.errors.smtpFromAddress);
    assert.ok((await save(ctx, { smtpHost: 'mail\r\nBcc: x@example.com' }).expect(400)).body.errors.smtpHost);
    assert.ok((await save(ctx, { smtpHost: 'x'.repeat(300) }).expect(400)).body.errors.smtpHost);
    assert.ok((await save(ctx, { smtpPort: 0 }).expect(400)).body.errors.smtpPort);
    assert.ok((await save(ctx, { smtpPort: 70000 }).expect(400)).body.errors.smtpPort);
    assert.ok((await save(ctx, { smtpSecurity: 'maybe' }).expect(400)).body.errors.smtpSecurity);
    assert.ok((await save(ctx, { emailsPerHour: 0 }).expect(400)).body.errors.emailsPerHour);
    for (const bad of ['stash.example.com', 'ftp://stash.example.com', 'https://stash.example.com/app', 'https://stash.example.com/?x=1', 'https://me:pw@stash.example.com', 'javascript:alert(1)']) {
        assert.ok((await save(ctx, { publicUrl: bad }).expect(400)).body.errors.publicUrl, bad);
    }
    // a username with no password is refused when sending is on
    const noPassword = (await save(ctx, { smtpEnabled: true, smtpHost: 'mail.example.org', smtpFromAddress: 'a@example.com', smtpUser: 'me' }).expect(400)).body.errors;
    assert.ok(noPassword.smtpPassword);
    // good values are trimmed, and a trailing slash on the public URL goes
    await save(ctx, { smtpHost: '  mail.example.org  ', publicUrl: 'https://stash.example.com/' }).expect(200);
    assert.equal(ctx.config.smtpHost, 'mail.example.org');
    assert.equal(ctx.config.publicUrl, 'https://stash.example.com');
});

test('the public config says whether the server can send email', async () => {
    const smtp = await startSmtp();
    try {
        const ctx = await adminApp();
        assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.emailEnabled, false);
        await save(ctx, settingsFor(smtp)).expect(200);
        assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.emailEnabled, true);
        await save(ctx, { smtpEnabled: false }).expect(200);
        assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.emailEnabled, false);
    } finally {
        await smtp.close();
    }
});

test('a test email goes out through the saved settings, with the From name, a plain-text and an HTML part', async () => {
    const smtp = await startSmtp();
    try {
        const ctx = await adminApp();
        await save(ctx, settingsFor(smtp, { publicUrl: 'https://stash.example.com' })).expect(200);
        await ctx.admin.post('/api/admin/email/test').send({ to: 'me@example.org' }).expect(200);

        assert.equal(smtp.messages.length, 1);
        const mail = smtp.messages[0];
        assert.deepEqual(mail.envelopeTo, ['me@example.org']);
        assert.equal(mail.from.address, 'stashly@example.com');
        assert.equal(mail.from.name, 'Stashly Test');
        assert.match(mail.subject, /test email/i);
        assert.match(mail.text, /test message/i);
        assert.match(mail.text, /https:\/\/stash\.example\.com/);
        assert.match(mail.html, /<h2[^>]*>Test email<\/h2>/);
        // automatic replies are told to leave it alone
        assert.equal(mail.headers.get('auto-submitted'), 'auto-generated');
    } finally {
        await smtp.close();
    }
});

test('the test email signs in to the mail server with the saved username and password', async () => {
    const smtp = await startSmtp({ auth: { user: 'mailer', pass: SMTP_PASSWORD } });
    try {
        const ctx = await adminApp();
        await save(ctx, settingsFor(smtp, { smtpUser: 'mailer', smtpPassword: SMTP_PASSWORD })).expect(200);
        await ctx.admin.post('/api/admin/email/test').send({ to: 'me@example.org' }).expect(200);
        assert.equal(smtp.messages[0].user, 'mailer');
    } finally {
        await smtp.close();
    }
});

test('a failed test says what went wrong in plain words, shows the server\'s reply to the admin, and never leaks the password', async () => {
    const smtp = await startSmtp({ auth: { user: 'mailer', pass: SMTP_PASSWORD }, rejectRecipient: address => address === 'nobody@example.org' });
    try {
        const ctx = await adminApp();

        // wrong password
        await save(ctx, settingsFor(smtp, { smtpUser: 'mailer', smtpPassword: 'the wrong one' })).expect(200);
        const wrong = await ctx.admin.post('/api/admin/email/test').send({ to: 'me@example.org' }).expect(502);
        assert.equal(wrong.body.reason, 'auth');
        assert.match(wrong.body.error, /username or password/);
        assert.ok(!JSON.stringify(wrong.body).includes('the wrong one'));

        // the right one, but a recipient the server refuses
        await save(ctx, { smtpPassword: SMTP_PASSWORD }).expect(200);
        const refused = await ctx.admin.post('/api/admin/email/test').send({ to: 'nobody@example.org' }).expect(502);
        assert.equal(refused.body.reason, 'recipient');
        assert.ok(refused.body.detail, 'the admin sees what the server said');

        // nothing listening on that port
        const closed = await startSmtp();
        const port = closed.port;
        await closed.close();
        await save(ctx, { smtpPort: port, smtpUser: '', smtpPassword: null }).expect(200);
        const down = await ctx.admin.post('/api/admin/email/test').send({ to: 'me@example.org' }).expect(502);
        assert.equal(down.body.reason, 'connect');
        assert.match(down.body.error, /Could not reach the mail server/);
    } finally {
        await smtp.close();
    }
});

test('the test email is for admins, needs a valid address, and says so when email is not ready', async () => {
    const ctx = await adminApp();
    // not set up yet
    const off = await ctx.admin.post('/api/admin/email/test').send({ to: 'me@example.org' }).expect(409);
    assert.match(off.body.error, /not ready/);
    // a bad address is refused first
    for (const to of ['', 'nope', 'a@b', 'a@example.org\r\nBcc: b@example.org', 42, null]) {
        await ctx.admin.post('/api/admin/email/test').send({ to }).expect(400);
    }
    // not an admin: no access at all
    await request(ctx.app).post('/api/admin/email/test').send({ to: 'me@example.org' }).expect(401);
});

test('the server-wide cap on emails an hour is enforced, and follows the setting', async () => {
    const smtp = await startSmtp();
    try {
        const ctx = await adminApp();
        await save(ctx, settingsFor(smtp, { emailsPerHour: 2 })).expect(200);
        await ctx.admin.post('/api/admin/email/test').send({ to: 'a@example.org' }).expect(200);
        await ctx.admin.post('/api/admin/email/test').send({ to: 'b@example.org' }).expect(200);
        const capped = await ctx.admin.post('/api/admin/email/test').send({ to: 'c@example.org' }).expect(429);
        assert.equal(capped.body.reason, 'rate');
        assert.equal(smtp.messages.length, 2, 'the third never left the server');
        // raising the cap lets it through at once; an hour later the old ones no longer count
        await save(ctx, { emailsPerHour: 10 }).expect(200);
        await ctx.admin.post('/api/admin/email/test').send({ to: 'c@example.org' }).expect(200);
        await save(ctx, { emailsPerHour: 3 }).expect(200);
        ctx.clock.time = new Date(ctx.clock.time.getTime() + 61 * 60 * 1000);
        await ctx.admin.post('/api/admin/email/test').send({ to: 'd@example.org' }).expect(200);
    } finally {
        await smtp.close();
    }
});

test('the mailer refuses a malformed address, a header injection, too many recipients and a bad subject', async () => {
    const config = loadConfig({}, { smtpEnabled: true, smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none', smtpFromAddress: 'a@example.com' });
    let sent = 0;
    const mailer = new Mailer({ config, createTransport: () => ({ sendMail: async () => { sent++; return { accepted: ['x'] }; }, close() {} }) });
    const rejects = async (message, code) => {
        await assert.rejects(() => mailer.send(message), error => error instanceof MailError && error.code === code);
    };
    const ok = { subject: 'Hello', text: 'Hi' };
    await rejects({ ...ok, to: 'not an address' }, 'invalid');
    await rejects({ ...ok, to: 'a@example.org\r\nBcc: evil@example.org' }, 'invalid');
    await rejects({ ...ok, to: ['a@example.org', 'b@example.org\nCc: c@example.org'] }, 'invalid');
    await rejects({ ...ok, to: [] }, 'invalid');
    await rejects({ ...ok, to: Array.from({ length: 11 }, (_, i) => `u${i}@example.org`) }, 'invalid');
    await rejects({ to: 'a@example.org', subject: 'Hi\r\nBcc: evil@example.org', text: 'x' }, 'invalid');
    await rejects({ to: 'a@example.org', subject: '', text: 'x' }, 'invalid');
    await rejects({ ...ok, to: 'a@example.org', replyTo: 'bad' }, 'invalid');
    assert.equal(sent, 0, 'nothing reached the transport');
    await mailer.send({ ...ok, to: ['a@example.org', 'b@example.org'] });
    assert.equal(sent, 1);

    // off, or incomplete: refused before anything is built
    const off = new Mailer({ config: loadConfig({}), createTransport: () => { throw new Error('must not connect'); } });
    await assert.rejects(() => off.send({ ...ok, to: 'a@example.org' }), error => error.code === 'disabled');
    for (const bad of ['', 'x', 'a@b', 'a b@example.org', 'a@example.org>', '<a@example.org>', 'a@@example.org', 'a@example..', 'a'.repeat(250) + '@example.org']) {
        assert.equal(validAddress(bad), false, bad);
    }
    for (const good of ['a@example.org', 'first.last+tag@sub.example.co.uk', 'a_b-c@example.io']) assert.equal(validAddress(good), true, good);
});
