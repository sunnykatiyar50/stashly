const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');
const { binary } = require('./helpers/unzip');

const ADMIN = 'admin-pass-123';

// An app whose access log and audit log lines are collected instead of written to stdout
function logged(overrides = {}) {
    const access = [];
    const audit = [];
    const ctx = makeApp({ logFormat: 'json', auditLog: 'stdout', ...overrides }, { logOut: line => access.push(line), auditOut: line => audit.push(line) });
    return { ...ctx, access, audit, requests: () => access.map(line => JSON.parse(line)), events: () => audit.map(line => JSON.parse(line)) };
}

// The log line is written when the response closes, which can be just after the client has the answer
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

// ---- access log ----

test('there is no access log unless LOG_FORMAT=json', async () => {
    const lines = [];
    const ctx = makeApp({}, { logOut: line => lines.push(line), auditOut: line => lines.push(line) });
    await request(ctx.app).post('/api/stashes').send({ slug: 'quiet-stash' }).expect(201);
    await request(ctx.app).get('/api/stashes/quiet-stash').expect(200);
    await settle();
    assert.deepEqual(lines, []);
});

test('an unknown LOG_FORMAT or AUDIT_LOG stops the server from starting', () => {
    assert.throws(() => makeApp({ logFormat: 'xml' }), /LOG_FORMAT/);
    assert.throws(() => makeApp({ auditLog: 'file' }), /AUDIT_LOG/);
});

test('each request is one JSON line with the route pattern, not the real path', async () => {
    const ctx = logged();
    await request(ctx.app).post('/api/stashes').send({ slug: 'route-check' }).expect(201);
    await request(ctx.app).post('/api/stashes/route-check/notes').send({ text: 'hello' }).expect(201);
    await request(ctx.app).get('/api/stashes/route-check?search=anything').expect(200);
    await settle();

    const lines = ctx.requests();
    assert.equal(lines.length, 3);
    for (const line of lines) {
        assert.deepEqual(Object.keys(line), ['time', 'level', 'msg', 'method', 'route', 'status', 'ms', 'ip', 'stash', 'role', 'bytes']);
        assert.equal(line.level, 'info');
        assert.equal(line.msg, 'request');
        assert.equal(new Date(line.time).toISOString(), line.time);
        assert.equal(typeof line.ms, 'number');
        assert.ok(line.ip);
    }
    const [create, add, list] = lines;
    assert.deepEqual([create.method, create.route, create.status, create.stash], ['POST', '/api/stashes', 201, null]);
    assert.deepEqual([add.method, add.route, add.status, add.role], ['POST', '/api/stashes/:slug/notes', 201, 'full']);
    assert.deepEqual([list.method, list.route, list.status], ['GET', '/api/stashes/:slug', 200]);
    // a stash is named only by a short keyed hash, the same for every request about it
    assert.match(add.stash, /^[0-9a-f]{10}$/);
    assert.equal(add.stash, list.stash);
    assert.ok(list.bytes > 0);
});

test('different stashes get different tags, and the tag depends on the server secret', async () => {
    const ctx = logged();
    const other = logged();
    for (const c of [ctx, other]) {
        await request(c.app).post('/api/stashes').send({ slug: 'tag-one' }).expect(201);
        await request(c.app).get('/api/stashes/tag-one').expect(200);
        await request(c.app).post('/api/stashes').send({ slug: 'tag-two' }).expect(201);
        await request(c.app).get('/api/stashes/tag-two').expect(200);
    }
    await settle();
    const [one, two] = [ctx.requests()[1].stash, ctx.requests()[3].stash];
    assert.notEqual(one, two);
    assert.equal(one, other.requests()[1].stash);
    // (same secret in the test helper, so equal; a different secret would give a different tag)
    const { stashTag } = require('../src/utils/logLine');
    assert.notEqual(stashTag('another-secret', 'tag-one'), one);
    assert.equal(stashTag('test-secret', 'TAG-ONE'), one);
});

test('requests no route answers are "unmatched", the page files are "static", and /health is not logged', async () => {
    const ctx = logged();
    await request(ctx.app).get('/definitely/not/here-4411').expect(404);
    await request(ctx.app).get('/api/nothing-at-all-7788').expect(404);
    await request(ctx.app).get('/theme.js').expect(200);
    await request(ctx.app).get('/health').expect(200);
    await request(ctx.app).get('/api/stashes/missing-stash-name').expect(404);
    await settle();
    const lines = ctx.requests();
    assert.deepEqual(lines.map(l => l.route), ['unmatched', 'unmatched', 'static', '/api/stashes/:slug']);
    assert.deepEqual(lines.map(l => l.status), [404, 404, 200, 404]);
    assert.ok(!ctx.access.join('\n').includes('4411'));
    assert.ok(!ctx.access.join('\n').includes('7788'));
});

test('the roles are logged: full, view, drop, and none for a locked visitor', async () => {
    const ctx = logged();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'role-stash', password: 'long enough pw' }).expect(201);
    const view = (await owner.post('/api/stashes/role-stash/share-links').send({ kind: 'view' }).expect(201)).body;
    await owner.get('/api/stashes/role-stash').expect(200);
    await request(ctx.app).get('/api/stashes/role-stash').expect(401);
    const reader = request.agent(ctx.app);
    await reader.post('/api/stashes/role-stash/redeem').send({ token: view.token }).expect(200);
    await reader.get('/api/stashes/role-stash').expect(200);
    await settle();
    const roles = ctx.requests().filter(l => l.route === '/api/stashes/:slug').map(l => l.role);
    assert.deepEqual(roles, ['full', 'none', 'view']);
});

// The central rule: nothing a visitor typed, and no secret, may end up in a log line
test('a full flow leaves no stash name, password, token, cookie, note text, file name or query in either log', async () => {
    const SLUG = 'zebra-crossing-7731';
    const NEW_SLUG = 'giraffe-lookout-4410';
    const PASSWORD = 'Hunter2-Distinct-Pass';
    const NEW_PASSWORD = 'Another-Distinct-Pass-88';
    const NOTE = 'NOTE-TEXT-MARKER-5521 with more words';
    const TITLE = 'TITLE-MARKER-3302';
    const FILE = 'secret-holiday-photo-ZEBRA.png';
    const SEARCH = 'QUERYWORD-9981';
    const ctx = logged({ adminPassword: ADMIN, undoSeconds: 60 });

    const owner = request.agent(ctx.app);
    const created = await owner.post('/api/stashes').send({ slug: SLUG, password: PASSWORD, ttl: '1h' }).expect(201);
    const cookie = created.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    await owner.post(`/api/stashes/${SLUG}/unlock`).send({ password: PASSWORD }).expect(200);
    await request(ctx.app).post(`/api/stashes/${SLUG}/unlock`).send({ password: 'wrong-guess-MARKER-1' }).expect(401);
    const note = (await owner.post(`/api/stashes/${SLUG}/notes`).send({ title: TITLE, text: NOTE }).expect(201)).body;
    const file = (await owner.post(`/api/stashes/${SLUG}/files`).set('X-File-Name', encodeURIComponent(FILE)).set('Content-Type', 'application/octet-stream').send(PNG).expect(201)).body;
    await owner.get(`/api/stashes/${SLUG}?search=${SEARCH}&startDate=2020-01-01`).expect(200);
    await owner.post(`/api/stashes/${SLUG}/query`).send({ search: SEARCH }).expect(200);
    await owner.get(`/api/stashes/${SLUG}/files/${file.id}?download=1`).expect(200);
    await owner.get(`/api/stashes/${SLUG}/export`).buffer(true).parse(binary).expect(200);
    const link = (await owner.post(`/api/stashes/${SLUG}/share-links`).send({ kind: 'view' }).expect(201)).body;
    const reader = request.agent(ctx.app);
    await reader.post(`/api/stashes/${SLUG}/redeem`).send({ token: link.token }).expect(200);
    await owner.delete(`/api/stashes/${SLUG}/items/${note.id}`).expect(200);
    await owner.post(`/api/stashes/${SLUG}/items/${note.id}/restore`).expect(200);
    await owner.post(`/api/stashes/${SLUG}/password`).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
    await owner.post(`/api/stashes/${SLUG}/sign-out-others`).expect(200);
    await owner.post(`/api/stashes/${SLUG}/rename`).send({ slug: NEW_SLUG }).expect(200);
    await owner.delete(`/api/stashes/${NEW_SLUG}`).expect(200);
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    await admin.get(`/api/admin/overview?search=${SEARCH}`).expect(200);
    await request(ctx.app).get(`/api/stashes/${SLUG}/events`).set('Cookie', cookie).expect(404);
    await settle();

    const output = [...ctx.access, ...ctx.audit].join('\n');
    assert.ok(ctx.access.length > 15 && ctx.audit.length > 10, 'both logs were written');
    for (const secret of [
        SLUG, NEW_SLUG, PASSWORD, NEW_PASSWORD, 'wrong-guess-MARKER', NOTE, 'NOTE-TEXT-MARKER', TITLE, FILE, encodeURIComponent(FILE), 'ZEBRA',
        SEARCH, link.token, ADMIN, 'stashly_', 'stashlyv_', 'stashly_admin', 'Cookie', 'cookie', 'startDate',
    ]) {
        assert.ok(!output.includes(secret), `the logs must not contain "${secret}"`);
    }
    // the cookie value itself, and the real paths
    for (const value of (cookie.match(/=([^;]+)/g) || []).map(v => v.slice(1))) assert.ok(!output.includes(value));
    assert.ok(!output.includes('/api/stashes/z'));
    assert.ok(!output.includes('?'));
    // every line is JSON
    for (const line of [...ctx.access, ...ctx.audit]) JSON.parse(line);
});

test('downloads and live streams still work with the access log on, and a stream is logged when it ends', async () => {
    const ctx = logged();
    await request(ctx.app).post('/api/stashes').send({ slug: 'stream-check' }).expect(201);
    const file = (await request(ctx.app).post('/api/stashes/stream-check/files').set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201)).body;
    const download = await request(ctx.app).get(`/api/stashes/stream-check/files/${file.id}`).buffer(true).parse(binary).expect(200);
    assert.equal(Buffer.compare(download.body, PNG), 0);

    const server = ctx.app.listen(0);
    try {
        const open = await new Promise((resolve, reject) => {
            const req = http.get({ port: server.address().port, path: '/api/stashes/stream-check/events' }, res => {
                res.once('data', chunk => resolve({ req, res, first: chunk.toString() }));
            });
            req.on('error', reject);
        });
        assert.equal(open.res.statusCode, 200);
        assert.match(open.first, /retry: 3000/);
        // nothing is logged for a stream until it is over
        assert.ok(!ctx.requests().some(l => l.route === '/api/stashes/:slug/events'));
        open.req.destroy();
        await settle();
        const ended = ctx.requests().find(l => l.route === '/api/stashes/:slug/events');
        assert.equal(ended.status, 200);
        assert.equal(ended.method, 'GET');
        assert.equal(ended.bytes, null);
    } finally {
        server.closeAllConnections();
        server.close();
    }
    await settle();
    const fileLine = ctx.requests().find(l => l.route === '/api/stashes/:slug/files/:id');
    assert.equal(fileLine.bytes, PNG.length);
    assert.equal(ctx.requests().filter(l => l.route === '/api/stashes/:slug/events').length, 1);
});

// ---- audit log ----

const eventsOf = ctx => ctx.events().map(e => e.event);

test('there is no audit log unless AUDIT_LOG=stdout', async () => {
    const lines = [];
    const ctx = makeApp({ adminPassword: ADMIN }, { auditOut: line => lines.push(line) });
    await request(ctx.app).post('/api/stashes').send({ slug: 'no-audit', password: 'long enough pw' }).expect(201);
    await request(ctx.app).post('/api/admin/login').send({ password: 'nope' }).expect(401);
    assert.deepEqual(lines, []);
});

test('audit lines carry the event, address, stash tag and actor, and nothing about the content', async () => {
    const ctx = logged();
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'audit-one', password: 'long enough pw', ttl: '8h' }).expect(201);
    const note = (await owner.post('/api/stashes/audit-one/notes').send({ text: 'private words' }).expect(201)).body;
    const file = (await owner.post('/api/stashes/audit-one/files').set('X-File-Name', 'pic.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201)).body;
    await owner.delete(`/api/stashes/audit-one/items/${note.id}`).expect(200);
    await owner.post(`/api/stashes/audit-one/items/${note.id}/restore`).expect(200);
    await owner.delete(`/api/stashes/audit-one/items/${file.id}`).expect(200);
    await owner.get('/api/stashes/audit-one/export').buffer(true).parse(binary).expect(200);
    await owner.post('/api/stashes/audit-one/share-links').send({ kind: 'drop' }).expect(201);
    await owner.delete('/api/stashes/audit-one/share-links/drop').expect(200);
    await owner.post('/api/stashes/audit-one/sign-out-others').expect(200);
    await owner.post('/api/stashes/audit-one/password').send({ currentPassword: 'long enough pw', newPassword: 'a new long password' }).expect(200);
    await owner.post('/api/stashes/audit-one/rename').send({ slug: 'audit-two' }).expect(200);
    await owner.delete('/api/stashes/audit-two').expect(200);

    const events = ctx.events();
    assert.deepEqual(eventsOf(ctx), [
        'stash.created', 'item.deleted', 'item.restored', 'item.deleted', 'stash.exported', 'stash.share_link_created',
        'stash.share_link_revoked', 'stash.sessions_signed_out', 'stash.password_changed', 'stash.renamed', 'stash.deleted',
    ]);
    const { stashTag } = require('../src/utils/logLine');
    const tag = slug => stashTag('test-secret', slug);
    for (const e of events) {
        assert.deepEqual(Object.keys(e), ['time', 'level', 'event', 'ip', 'stash', 'actor', 'detail']);
        assert.equal(e.level, 'audit');
        assert.equal(e.actor, 'visitor');
        assert.ok(e.ip);
    }
    assert.equal(events[0].stash, tag('audit-one'));
    assert.deepEqual(events[0].detail, { password: true, ttl: '8h' });
    assert.deepEqual(events[1].detail, { kind: 'note', undoable: true });
    assert.deepEqual(events[3].detail, { kind: 'file', undoable: true });
    assert.deepEqual(events[5].detail, { kind: 'drop' });
    assert.deepEqual(events[6].detail, { kind: 'drop' });
    assert.deepEqual(events[9].detail, { from: tag('audit-one'), to: tag('audit-two') });
    assert.equal(events[9].stash, tag('audit-two'));
    assert.deepEqual(events[10].detail, { reason: 'visitor' });
    const text = ctx.audit.join('\n');
    for (const secret of ['audit-one', 'audit-two', 'private words', 'pic.png', 'long enough pw', 'a new long password']) assert.ok(!text.includes(secret));
});

test('wrong passwords are logged each time with the address, and the lockout is logged once when it trips', async () => {
    const ctx = logged({ stashUnlockFailures: 3 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'lock-me-out', password: 'long enough pw' }).expect(201);
    for (let i = 0; i < 3; i++) await request(ctx.app).post('/api/stashes/lock-me-out/unlock').send({ password: `wrong-${i}` }).expect(401);
    await request(ctx.app).post('/api/stashes/lock-me-out/unlock').send({ password: 'wrong-again' }).expect(429);
    assert.deepEqual(eventsOf(ctx), ['stash.created', 'stash.unlock_failed', 'stash.unlock_failed', 'stash.unlock_failed', 'stash.locked_out']);
    const failed = ctx.events()[1];
    assert.deepEqual(failed.detail, { via: 'unlock' });
    assert.ok(failed.ip);
    assert.ok(!ctx.audit.join('\n').includes('wrong-'));
});

test('a stash that expires is logged as deleted by the system, whether found by a visitor or by the cleanup', async () => {
    const ctx = logged();
    await request(ctx.app).post('/api/stashes').send({ slug: 'expire-one', ttl: '1h' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'expire-two', ttl: '1h' }).expect(201);
    ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * 3600 * 1000);
    await request(ctx.app).get('/api/stashes/expire-one').expect(404);
    ctx.controller.cleanup();
    const deleted = ctx.events().filter(e => e.event === 'stash.deleted');
    assert.equal(deleted.length, 2);
    for (const e of deleted) {
        assert.equal(e.actor, 'system');
        assert.deepEqual(e.detail, { reason: 'expired' });
        assert.match(e.stash, /^[0-9a-f]{10}$/);
    }
    assert.equal(deleted[0].ip, null);
});

test('a burn-after-reading note is logged as deleted by kind only', async () => {
    const ctx = logged();
    await request(ctx.app).post('/api/stashes').send({ slug: 'burn-audit' }).expect(201);
    const note = (await request(ctx.app).post('/api/stashes/burn-audit/notes').send({ text: 'burn me', burn: true }).expect(201)).body;
    await request(ctx.app).post(`/api/stashes/burn-audit/items/${note.id}/reveal`).expect(200);
    const burned = ctx.events().find(e => e.event === 'item.deleted');
    assert.deepEqual(burned.detail, { kind: 'note', reason: 'burned' });
});

test('admin sign-in, sign-out, settings, backup, password reset and delete are logged as the admin', async () => {
    const ctx = logged({ adminPassword: ADMIN });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: 'nope' }).expect(401);
    await admin.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    await request(ctx.app).post('/api/stashes').send({ slug: 'admin-target', password: 'long enough pw' }).expect(201);
    await admin.put('/api/admin/stashes/admin-target/password').send({ password: 'reset by the admin' }).expect(200);
    await admin.put('/api/admin/settings').send({ values: { maxFileMb: 7, undoSeconds: 30 } }).expect(200);
    await admin.put('/api/admin/settings').send({ values: { maxFileMb: 7 } }).expect(200); // nothing changed: not logged
    await admin.post('/api/admin/settings/reset').expect(200);
    await admin.get('/api/admin/backup').buffer(true).parse(binary).expect(200);
    await admin.delete('/api/admin/stashes/admin-target').expect(200);
    await admin.post('/api/admin/logout').expect(200);
    await request(ctx.app).post('/api/admin/logout').expect(200); // not signed in: not logged

    assert.deepEqual(eventsOf(ctx), [
        'admin.login_failed', 'admin.login_succeeded', 'stash.created', 'stash.password_reset_by_admin', 'admin.settings_changed',
        'admin.settings_changed', 'admin.backup_downloaded', 'stash.deleted', 'admin.logout',
    ]);
    const events = ctx.events();
    assert.equal(events[0].actor, 'visitor');
    assert.deepEqual(events[0].detail, {});
    assert.equal(events[1].actor, 'admin');
    assert.equal(events[3].actor, 'admin');
    assert.match(events[3].stash, /^[0-9a-f]{10}$/);
    assert.deepEqual(events[4].detail, { keys: ['maxFileMb', 'undoSeconds'], values: { maxFileMb: 7, undoSeconds: 30 } });
    assert.deepEqual(events[5].detail.keys, ['maxFileMb', 'undoSeconds']); // the reset
    assert.deepEqual(events[7].detail, { reason: 'admin' });
    const text = ctx.audit.join('\n');
    for (const secret of [ADMIN, 'nope', 'reset by the admin', 'admin-target']) assert.ok(!text.includes(secret));
});

test('code that builds the controllers without logging still works', () => {
    const StashController = require('../src/controllers/stashController');
    const controller = new StashController({ model: {}, events: {}, config: {}, secret: 's' });
    assert.doesNotThrow(() => controller.audit('anything', { stash: 'x' }));
    assert.doesNotThrow(() => controller.metrics.inc('anything'));
});
