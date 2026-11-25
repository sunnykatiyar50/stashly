// A link to one clip: what the public side shows (only that clip), who may make links, and when a link stops working.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

const PASSWORD = 'correct horse battery';
const HOUR = 60 * 60 * 1000;
const advance = (ctx, ms) => { ctx.clock.time = new Date(ctx.clock.time.getTime() + ms); };

async function stash(ctx, slug = 'clip-share-stash', body = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);
    return `/api/stashes/${slug}`;
}
const addNote = (agent, base, text, extra = {}) => agent.post(`${base}/notes`).send({ text, ...extra }).expect(201);
const addFile = (agent, base, name = 'pic.png') =>
    agent.post(`${base}/files`).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
const share = (agent, base, id, expires) => agent.post(`${base}/items/${id}/share`).send(expires ? { expires } : {});
const view = (ctx, token) => request(ctx.app).get(`/api/clips/${token}`);

test('a link opens just that clip: its text and nothing about the stash or its other items', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const agent = request.agent(ctx.app);
    const shared = await addNote(agent, base, 'the shared note', { title: 'For Sam' });
    await addNote(agent, base, 'a different, private note');

    const made = await share(agent, base, shared.body.id).expect(201);
    assert.equal(made.body.shared, true);
    assert.match(made.body.path, /^\/c\/[A-Za-z0-9_-]{20,}$/);
    const token = made.body.token;
    assert.equal(made.body.path, `/c/${token}`);

    // No cookie, no password: just the link
    const opened = await view(ctx, token).expect(200);
    assert.equal(opened.body.kind, 'note');
    assert.equal(opened.body.title, 'For Sam');
    assert.equal(opened.body.text, 'the shared note');
    assert.deepEqual(Object.keys(opened.body).sort(), ['createdAt', 'expiresAt', 'fileName', 'fileSize', 'fileType', 'fileUrl', 'isImage', 'kind', 'text', 'title']);
    assert.ok(!JSON.stringify(opened.body).includes('clip-share-stash'), 'the stash name is not given away');
    assert.match(opened.headers['cache-control'], /no-store/);
    assert.match(opened.headers['x-robots-tag'], /noindex/);
    assert.equal(opened.headers['referrer-policy'], 'no-referrer');

    // The link does not work as access to the stash
    await request(ctx.app).get(`${base}/items/${shared.body.id}`).expect(res => assert.ok([200, 401].includes(res.status)));
    await request(ctx.app).get(`/api/clips/${token}/..%2Fstashes`).expect(404);
});

test('a link to a file shows it and serves the bytes, safely; a note has no file', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const agent = request.agent(ctx.app);
    const file = await addFile(agent, base, 'holiday.png');
    const note = await addNote(agent, base, 'just text');
    const link = (await share(agent, base, file.body.id).expect(201)).body;
    const noteLink = (await share(agent, base, note.body.id).expect(201)).body;

    const meta = await view(ctx, link.token).expect(200);
    assert.equal(meta.body.kind, 'file');
    assert.equal(meta.body.fileName, 'holiday.png');
    assert.equal(meta.body.isImage, true);
    assert.equal(meta.body.text, null);
    assert.equal(meta.body.fileUrl, `/api/clips/${link.token}/file`);

    const bytes = await request(ctx.app).get(meta.body.fileUrl).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.deepEqual(bytes.body, PNG);
    assert.equal(bytes.headers['content-type'], 'image/png');
    assert.equal(bytes.headers['x-content-type-options'], 'nosniff');
    assert.match(bytes.headers['content-security-policy'], /sandbox/);
    const forced = await request(ctx.app).get(`${meta.body.fileUrl}?download=1`).expect(200);
    assert.match(forced.headers['content-disposition'], /^attachment/);

    await request(ctx.app).get(`/api/clips/${noteLink.token}/file`).expect(404);
});

test('a link that does not exist, is malformed or points at another clip gives the same plain 404', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const agent = request.agent(ctx.app);
    const a = await addNote(agent, base, 'one');
    const token = (await share(agent, base, a.body.id).expect(201)).body.token;
    const body = (await view(ctx, 'x'.repeat(32)).expect(404)).body;
    assert.deepEqual(body, { error: 'This link does not exist or has expired.' });
    await view(ctx, 'short').expect(404);
    await view(ctx, `${token}x`).expect(404);
    await view(ctx, token).expect(200);
});

test('cancelling a link ends it at once, and a new link replaces the old one', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const agent = request.agent(ctx.app);
    const note = await addNote(agent, base, 'hello');
    const id = note.body.id;
    assert.deepEqual((await agent.get(`${base}/items/${id}/share`).expect(200)).body, { shared: false });

    const first = (await share(agent, base, id).expect(201)).body.token;
    const second = (await share(agent, base, id).expect(201)).body.token;
    assert.notEqual(first, second);
    await view(ctx, first).expect(404);
    await view(ctx, second).expect(200);

    // Opening counts, and the status never carries the link itself
    await view(ctx, second).expect(200);
    const status = (await agent.get(`${base}/items/${id}/share`).expect(200)).body;
    assert.equal(status.shared, true);
    assert.equal(status.views, 2);
    assert.ok(!('token' in status) && !('path' in status));

    await agent.delete(`${base}/items/${id}/share`).expect(200);
    await view(ctx, second).expect(404);
    assert.deepEqual((await agent.get(`${base}/items/${id}/share`).expect(200)).body, { shared: false });
    // Cancelling again is harmless
    await agent.delete(`${base}/items/${id}/share`).expect(200);
});

test('a link expires on its own time, by default after 7 days, and never outlives a note with its own expiry', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'clip-share-time', { ttl: '30d' });
    const agent = request.agent(ctx.app);
    const note = await addNote(agent, base, 'timed');

    const hour = (await share(agent, base, note.body.id, '1h').expect(201)).body;
    assert.equal(new Date(hour.expiresAt).getTime() - ctx.clock.time.getTime(), HOUR);
    advance(ctx, HOUR - 1000);
    await view(ctx, hour.token).expect(200);
    advance(ctx, 2000);
    await view(ctx, hour.token).expect(404);
    assert.deepEqual((await agent.get(`${base}/items/${note.body.id}/share`).expect(200)).body, { shared: false });

    const normal = (await share(agent, base, note.body.id).expect(201)).body;
    assert.equal(new Date(normal.expiresAt).getTime() - ctx.clock.time.getTime(), 7 * 24 * HOUR);
    const forever = (await share(agent, base, note.body.id, 'never').expect(201)).body;
    assert.equal(forever.expiresAt, null);
    await share(agent, base, note.body.id, 'a fortnight').expect(400);

    // A note that expires in an hour gets a link that ends with it, whatever was asked for
    const brief = await addNote(agent, base, 'short lived', { expires: '1h' });
    const capped = (await share(agent, base, brief.body.id, 'never').expect(201)).body;
    assert.equal(new Date(capped.expiresAt).getTime() - ctx.clock.time.getTime(), HOUR);
    advance(ctx, HOUR + 1000);
    await view(ctx, capped.token).expect(404);
});

test('a burn-after-reading note cannot be shared; a secret note can', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const agent = request.agent(ctx.app);
    const burn = await addNote(agent, base, 'once only', { burn: true });
    const refused = await share(agent, base, burn.body.id).expect(400);
    assert.match(refused.body.error, /burn-after-reading/);
    const secret = await addNote(agent, base, 'hidden in the page', { secret: true });
    const link = (await share(agent, base, secret.body.id).expect(201)).body;
    assert.equal((await view(ctx, link.token).expect(200)).body.text, 'hidden in the page');
});

test('only full access can make, check or cancel a link; read-only and drop-box links cannot', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'clip-share-locked', { password: PASSWORD });
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    const note = await addNote(owner, base, 'protected note');
    const id = note.body.id;

    // Nobody signed in
    await request(ctx.app).post(`${base}/items/${id}/share`).send({}).expect(401);
    await request(ctx.app).get(`${base}/items/${id}/share`).expect(401);

    const viewToken = (await owner.post(`${base}/share-links`).send({ kind: 'view' }).expect(201)).body.token;
    const dropToken = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body.token;
    const reader = request.agent(ctx.app);
    await reader.post(`${base}/redeem`).send({ token: viewToken }).expect(200);
    const dropper = request.agent(ctx.app);
    await dropper.post(`${base}/redeem`).send({ token: dropToken }).expect(200);
    for (const who of [reader, dropper]) {
        await who.post(`${base}/items/${id}/share`).send({}).expect(403);
        await who.get(`${base}/items/${id}/share`).expect(403);
        await who.delete(`${base}/items/${id}/share`).expect(403);
    }
    // The owner can, and the link works for someone with no access to the stash at all
    const link = (await share(owner, base, id).expect(201)).body;
    assert.equal((await view(ctx, link.token).expect(200)).body.text, 'protected note');
    await request(ctx.app).get(`${base}/items/${id}`).expect(401);
});

test('a stash with no password can share clips too (whoever has its name has full access anyway)', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'open-stash-name');
    const note = await addNote(request(ctx.app), base, 'open note');
    const link = (await share(request(ctx.app), base, note.body.id).expect(201)).body;
    assert.equal((await view(ctx, link.token).expect(200)).body.text, 'open note');
});

test('the link dies with its clip (and an undo does not bring it back), with the stash, and with a password change', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'clip-share-life', { password: PASSWORD });
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);

    const deleted = await addNote(owner, base, 'to be deleted');
    const deletedLink = (await share(owner, base, deleted.body.id).expect(201)).body.token;
    await owner.delete(`${base}/items/${deleted.body.id}`).expect(200);
    await view(ctx, deletedLink).expect(404);
    await owner.post(`${base}/items/${deleted.body.id}/restore`).expect(200);
    await view(ctx, deletedLink).expect(404);
    assert.deepEqual((await owner.get(`${base}/items/${deleted.body.id}/share`).expect(200)).body, { shared: false });

    const kept = await addNote(owner, base, 'kept');
    const keptLink = (await share(owner, base, kept.body.id).expect(201)).body.token;
    await view(ctx, keptLink).expect(200);
    await owner.post(`${base}/password`).send({ currentPassword: PASSWORD, newPassword: 'a fresh password' }).expect(200);
    await view(ctx, keptLink).expect(404);

    const last = await addNote(owner, base, 'last');
    const lastLink = (await share(owner, base, last.body.id).expect(201)).body.token;
    await owner.delete(base).expect(200);
    await view(ctx, lastLink).expect(404);
    assert.equal(ctx.model.db.prepare('SELECT COUNT(*) AS n FROM item_shares').get().n, 0);
});

test('an expired stash takes its links with it, and a rename keeps them working', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'clip-share-stash-ttl', { ttl: '1h' });
    const agent = request.agent(ctx.app);
    const note = await addNote(agent, base, 'short lived stash');
    const link = (await share(agent, base, note.body.id, 'never').expect(201)).body.token;
    advance(ctx, HOUR + 1000);
    await view(ctx, link).expect(404);

    const ctx2 = makeApp();
    const base2 = await stash(ctx2, 'clip-share-rename');
    const a2 = request.agent(ctx2.app);
    const n2 = await addNote(a2, base2, 'survives a rename');
    const l2 = (await share(a2, base2, n2.body.id).expect(201)).body.token;
    await a2.post(`${base2}/rename`).send({ slug: 'clip-share-renamed' }).expect(200);
    assert.equal((await view(ctx2, l2).expect(200)).body.text, 'survives a rename');
});

test('the page for a link is a plain HTML file that asks not to be indexed, and the cleanup removes expired links', async () => {
    const ctx = makeApp();
    const base = await stash(ctx);
    const agent = request.agent(ctx.app);
    const note = await addNote(agent, base, 'tidy up');
    const link = (await share(agent, base, note.body.id, '1h').expect(201)).body;
    const page = await request(ctx.app).get(link.path).expect(200);
    assert.match(page.headers['content-type'], /html/);
    assert.match(page.text, /name="robots" content="noindex, nofollow"/);
    assert.match(page.text, /name="referrer" content="no-referrer"/);
    assert.ok(!page.text.includes(link.token), 'the page itself does not contain the token');
    assert.ok(!/<script>[^<]/.test(page.text), 'no inline script (the page CSP only allows files)');

    advance(ctx, HOUR + 1000);
    ctx.controller.cleanup();
    assert.equal(ctx.model.db.prepare('SELECT COUNT(*) AS n FROM item_shares').get().n, 0);
});

test('opening links that do not work is rate limited, so tokens cannot be tried at speed', async () => {
    const ctx = makeApp({ rateNotFound: 5 });
    const results = [];
    for (let i = 0; i < 8; i++) results.push((await view(ctx, 'y'.repeat(30 + i)).expect(res => assert.ok([404, 429].includes(res.status)))).status);
    assert.ok(results.includes(429), `expected a 429 after the limit, got ${results.join(',')}`);
});

test('the token never reaches the access log or the audit log, only the route pattern and the kind of event', async () => {
    const access = [];
    const audit = [];
    const ctx = makeApp({ logFormat: 'json', auditLog: 'stdout' }, { logOut: line => access.push(line), auditOut: line => audit.push(line) });
    const base = await stash(ctx);
    const agent = request.agent(ctx.app);
    const note = await addNote(agent, base, 'logged');
    const token = (await share(agent, base, note.body.id).expect(201)).body.token;
    await view(ctx, token).expect(200);
    await request(ctx.app).get(`/c/${token}`).expect(200);
    await agent.delete(`${base}/items/${note.body.id}/share`).expect(200);
    const lines = [...access, ...audit].join('\n');
    assert.ok(!lines.includes(token), 'the token is in a log line');
    assert.ok(access.some(line => JSON.parse(line).route === '/api/clips/:token'));
    assert.deepEqual(audit.map(line => JSON.parse(line).event).filter(name => name.startsWith('item.share')), ['item.share_created', 'item.share_revoked']);
});
