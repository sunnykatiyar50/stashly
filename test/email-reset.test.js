// Email addresses on accounts and password reset by email: who can set an address, that the reset link works once,
// expires, and never lets anyone find out which accounts exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { startSmtp } = require('./helpers/smtp');

const ADMIN = 'admin-pass-123';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new password';
const PUBLIC_URL = 'https://stash.example.com';

// An app whose mail goes to a local SMTP server, with a signed-in admin and users sam (sam@example.org) and kim (no email)
async function setup({ publicUrl = PUBLIC_URL, mailOn = true } = {}) {
    const smtp = await startSmtp();
    const ctx = makeApp({
        adminPassword: ADMIN,
        smtpEnabled: mailOn, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'none', smtpFromAddress: 'stashly@example.com', publicUrl,
    });
    const root = request.agent(ctx.app);
    await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    await root.post('/api/admin/users').send({ username: 'sam', password: PASSWORD, role: 'user', email: 'Sam@Example.org' }).expect(201);
    await root.post('/api/admin/users').send({ username: 'kim', password: PASSWORD, role: 'user' }).expect(201);
    const sign = async name => { const a = request.agent(ctx.app); await a.post('/api/auth/login').send({ username: name, password: PASSWORD }).expect(200); return a; };
    return { ...ctx, smtp, root, sign, done: () => smtp.close() };
}

// Waits for the emails started in the background by the server
const settle = ctx => ctx.userController.pending;
const tokenIn = message => /#reset=([\w.-]+)/.exec(message.text)[1];
const advance = (ctx, ms) => { ctx.clock.time = new Date(ctx.clock.time.getTime() + ms); };

test('an address is kept in lowercase, can be given when the admin creates the user, and is checked', async () => {
    const ctx = await setup();
    try {
        const users = (await ctx.root.get('/api/admin/users').expect(200)).body.users;
        assert.equal(users.find(u => u.username === 'sam').email, 'sam@example.org');
        assert.equal(users.find(u => u.username === 'kim').email, null);
        for (const bad of ['nope', 'a@b', 'a@example.org\r\nBcc: b@example.org', 42, 'x'.repeat(260) + '@example.org']) {
            await ctx.root.post('/api/admin/users').send({ username: 'bad-one', password: PASSWORD, email: bad }).expect(400);
        }
        // the admin can change and clear it
        const id = users.find(u => u.username === 'kim').id;
        assert.equal((await ctx.root.patch(`/api/admin/users/${id}`).send({ email: 'Kim@Example.org' }).expect(200)).body.email, 'kim@example.org');
        assert.equal((await ctx.root.patch(`/api/admin/users/${id}`).send({ email: '' }).expect(200)).body.email, null);
        await ctx.root.patch(`/api/admin/users/${id}`).send({ email: 'nope' }).expect(400);
    } finally { await ctx.done(); }
});

test('you set your own address with your current password; a wrong one is refused and counted; the old address is told', async () => {
    const ctx = await setup();
    try {
        const kim = await ctx.sign('kim');
        await kim.put('/api/me/email').send({ email: 'kim@example.org', currentPassword: 'wrong wrong wrong' }).expect(401);
        await kim.put('/api/me/email').send({ email: 'nope', currentPassword: PASSWORD }).expect(400);
        await kim.put('/api/me/email').send({ currentPassword: PASSWORD }).expect(400);
        await request(ctx.app).put('/api/me/email').send({ email: 'x@example.org', currentPassword: PASSWORD }).expect(401);
        assert.equal((await kim.put('/api/me/email').send({ email: 'Kim@Example.org', currentPassword: PASSWORD }).expect(200)).body.email, 'kim@example.org');
        assert.equal((await kim.get('/api/me').expect(200)).body.user.email, 'kim@example.org');
        assert.equal(ctx.smtp.messages.length, 0, 'no old address to tell');

        await kim.put('/api/me/email').send({ email: 'kim2@example.org', currentPassword: PASSWORD }).expect(200);
        await settle(ctx);
        assert.equal(ctx.smtp.messages.length, 1);
        assert.deepEqual(ctx.smtp.messages[0].envelopeTo, ['kim@example.org']);
        assert.match(ctx.smtp.messages[0].subject, /email address of your account changed/);

        await kim.put('/api/me/email').send({ email: null, currentPassword: PASSWORD }).expect(200);
        assert.equal((await kim.get('/api/me').expect(200)).body.user.email, null);
    } finally { await ctx.done(); }
});

test('forgot password mails a link to the address on file, and the answer is the same for everyone', async () => {
    const ctx = await setup();
    try {
        const answers = [];
        for (const identifier of ['sam', 'SAM@example.org', 'kim', 'nobody-here']) {
            const res = await request(ctx.app).post('/api/auth/forgot').send({ identifier }).expect(200);
            answers.push(JSON.stringify(res.body));
        }
        await settle(ctx);
        assert.equal(new Set(answers).size, 1, 'no difference between known and unknown');
        // sam was asked for twice (by name, then by address): only one mail inside the cooldown; kim has no address
        assert.equal(ctx.smtp.messages.length, 1);
        const mail = ctx.smtp.messages[0];
        assert.deepEqual(mail.envelopeTo, ['sam@example.org']);
        assert.match(mail.text, /https:\/\/stash\.example\.com\/account#reset=/);
        assert.match(mail.subject, /reset your password/);
        assert.ok(!mail.text.includes(PASSWORD));
        await request(ctx.app).post('/api/auth/forgot').send({}).expect(400);
    } finally { await ctx.done(); }
});

test('the link is built from the public address, never from the request Host header', async () => {
    const ctx = await setup();
    try {
        await request(ctx.app).post('/api/auth/forgot').set('Host', 'evil.example.net').set('X-Forwarded-Host', 'evil.example.net').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        assert.ok(ctx.smtp.messages[0].text.includes(`${PUBLIC_URL}/account#reset=`));
        assert.ok(!/evil\.example\.net/.test(ctx.smtp.messages[0].text + ctx.smtp.messages[0].html));
    } finally { await ctx.done(); }
});

test('without email, or without the public address, reset by email is off', async () => {
    for (const options of [{ mailOn: false }, { publicUrl: '' }]) {
        const ctx = await setup(options);
        try {
            assert.equal((await request(ctx.app).get('/api/me').expect(200)).body.resetByEmail, false);
            await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(409);
            const sam = await ctx.sign('sam');
            const id = (await ctx.root.get('/api/admin/users').expect(200)).body.users.find(u => u.username === 'sam').id;
            await ctx.root.post(`/api/admin/users/${id}/email-reset`).expect(409);
            assert.equal(ctx.smtp.messages.length, 0);
            void sam;
        } finally { await ctx.done(); }
    }
    const ready = await setup();
    try { assert.equal((await request(ready.app).get('/api/me').expect(200)).body.resetByEmail, true); } finally { await ready.done(); }
});

test('the link sets a new password once, signs the user out everywhere, and a notice goes to the address', async () => {
    const ctx = await setup();
    try {
        const sam = await ctx.sign('sam');
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        const token = tokenIn(ctx.smtp.messages[0]);

        await request(ctx.app).post('/api/auth/reset').send({ token, password: 'x' }).expect(400);
        await request(ctx.app).post('/api/auth/reset').send({ token: token + 'x', password: NEW_PASSWORD }).expect(400);
        await request(ctx.app).post('/api/auth/reset').send({ token: '1.2.3', password: NEW_PASSWORD }).expect(400);
        await request(ctx.app).post('/api/auth/reset').send({ password: NEW_PASSWORD }).expect(400);

        await request(ctx.app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD }).expect(200);
        // the old session ended, the old password is gone, the new one works
        await sam.get('/api/me/stashes').expect(401);
        await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: PASSWORD }).expect(401);
        await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: NEW_PASSWORD }).expect(200);
        // single use
        const again = await request(ctx.app).post('/api/auth/reset').send({ token, password: 'yet another password' }).expect(400);
        assert.equal(again.body.field, 'token');
        await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: NEW_PASSWORD }).expect(200);

        await settle(ctx);
        assert.equal(ctx.smtp.messages.length, 2);
        assert.match(ctx.smtp.messages[1].subject, /password was changed/);
        assert.ok(!ctx.smtp.messages[1].text.includes(NEW_PASSWORD));
    } finally { await ctx.done(); }
});

test('two uses of the same link at once: one wins', async () => {
    const ctx = await setup();
    try {
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        const token = tokenIn(ctx.smtp.messages[0]);
        const results = await Promise.all(['first password one', 'second password two'].map(password => request(ctx.app).post('/api/auth/reset').send({ token, password })));
        assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    } finally { await ctx.done(); }
});

test('the link expires after an hour, and stops working when the email or the password changes', async () => {
    const ctx = await setup();
    try {
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        const token = tokenIn(ctx.smtp.messages[0]);

        // changing the email address ends it
        const sam = await ctx.sign('sam');
        await sam.put('/api/me/email').send({ email: 'sam2@example.org', currentPassword: PASSWORD }).expect(200);
        await request(ctx.app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD }).expect(400);

        // a fresh one works until an hour passes
        advance(ctx, 6 * 60 * 1000);
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        const fresh = tokenIn(ctx.smtp.messages.filter(m => m.subject.includes('reset your password')).pop());
        advance(ctx, 61 * 60 * 1000);
        await request(ctx.app).post('/api/auth/reset').send({ token: fresh, password: NEW_PASSWORD }).expect(400);

        // a password changed another way ends it too
        advance(ctx, 6 * 60 * 1000);
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        const third = tokenIn(ctx.smtp.messages.filter(m => m.subject.includes('reset your password')).pop());
        const id = (await ctx.root.get('/api/admin/users').expect(200)).body.users.find(u => u.username === 'sam').id;
        await ctx.root.post(`/api/admin/users/${id}/password`).send({ password: 'chosen by the admin' }).expect(200);
        await request(ctx.app).post('/api/auth/reset').send({ token: third, password: NEW_PASSWORD }).expect(400);
    } finally { await ctx.done(); }
});

test('a link made for one user does not work for another, and disabled accounts get nothing', async () => {
    const ctx = await setup();
    try {
        const users = (await ctx.root.get('/api/admin/users').expect(200)).body.users;
        const sam = users.find(u => u.username === 'sam');
        const kim = users.find(u => u.username === 'kim');
        await ctx.root.patch(`/api/admin/users/${kim.id}`).send({ email: 'kim@example.org' }).expect(200);
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        const token = tokenIn(ctx.smtp.messages[0]);
        const swapped = `${kim.id}.${token.split('.').slice(1).join('.')}`;
        await request(ctx.app).post('/api/auth/reset').send({ token: swapped, password: NEW_PASSWORD }).expect(400);

        await ctx.root.patch(`/api/admin/users/${sam.id}`).send({ disabled: true }).expect(200);
        await request(ctx.app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD }).expect(400);
        advance(ctx, 6 * 60 * 1000);
        const before = ctx.smtp.messages.length;
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await settle(ctx);
        assert.equal(ctx.smtp.messages.length, before, 'nothing is sent for a disabled account');
    } finally { await ctx.done(); }
});

test('the environment admin account cannot be reset or given an address by email', async () => {
    const ctx = await setup();
    try {
        const root = request.agent(ctx.app);
        await root.post('/api/auth/login').send({ username: ctx.config.adminUsername, password: ADMIN }).expect(200);
        await root.put('/api/me/email').send({ email: 'boss@example.org', currentPassword: ADMIN }).expect(409);
        const row = ctx.db.prepare('SELECT id FROM users WHERE managed = 1').get();
        await ctx.root.post(`/api/admin/users/${row.id}/email-reset`).expect(409);
        await ctx.root.patch(`/api/admin/users/${row.id}`).send({ email: 'boss@example.org' }).expect(409);
    } finally { await ctx.done(); }
});

test('the admin can email a user a reset link; no address, a missing user and a mail failure are handled', async () => {
    const ctx = await setup();
    try {
        const users = (await ctx.root.get('/api/admin/users').expect(200)).body.users;
        const sam = users.find(u => u.username === 'sam');
        const kim = users.find(u => u.username === 'kim');
        await request(ctx.app).post(`/api/admin/users/${sam.id}/email-reset`).expect(401);
        await ctx.root.post(`/api/admin/users/${kim.id}/email-reset`).expect(409);
        await ctx.root.post('/api/admin/users/9999/email-reset').expect(404);

        await ctx.root.post(`/api/admin/users/${sam.id}/email-reset`).expect(200);
        assert.equal(ctx.smtp.messages.length, 1);
        assert.match(ctx.smtp.messages[0].text, /administrator sent you a link/);
        await request(ctx.app).post('/api/auth/reset').send({ token: tokenIn(ctx.smtp.messages[0]), password: NEW_PASSWORD }).expect(200);

        // the mail server goes away: the admin is told
        await ctx.smtp.close();
        const down = await ctx.root.post(`/api/admin/users/${sam.id}/email-reset`).expect(502);
        assert.ok(down.body.error);
    } finally { await ctx.done().catch(() => {}); }
});

test('the audit log records reset events without addresses, tokens or passwords', async () => {
    const lines = [];
    const smtp = await startSmtp();
    try {
        const ctx = makeApp({ adminPassword: ADMIN, auditLog: 'stdout', smtpEnabled: true, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'none', smtpFromAddress: 'stashly@example.com', publicUrl: PUBLIC_URL }, { auditOut: line => lines.push(line) });
        const root = request.agent(ctx.app);
        await root.post('/api/admin/login').send({ password: ADMIN }).expect(200);
        await root.post('/api/admin/users').send({ username: 'sam', password: PASSWORD, email: 'sam@example.org' }).expect(201);
        await request(ctx.app).post('/api/auth/forgot').send({ identifier: 'sam' }).expect(200);
        await ctx.userController.pending;
        const token = tokenIn(smtp.messages[0]);
        await request(ctx.app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD }).expect(200);
        const text = lines.join('\n');
        assert.match(text, /user\.reset_requested/);
        assert.match(text, /user\.password_reset_by_link/);
        for (const secret of [token, NEW_PASSWORD, 'sam@example.org', PASSWORD]) assert.ok(!text.includes(secret), `the log has ${secret}`);
    } finally { await smtp.close(); }
});

test('the forgot and reset routes are limited per address', async () => {
    const ctx = await setup();
    try {
        const statuses = [];
        for (let i = 0; i < 7; i++) statuses.push((await request(ctx.app).post('/api/auth/forgot').send({ identifier: `nobody-${i}` })).status);
        assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
    } finally { await ctx.done(); }
});
