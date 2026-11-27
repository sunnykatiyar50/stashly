// The "which files it accepts" setting of a stash (Options > Organize). FILE_TYPES is only the default for stashes that
// have not chosen.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const PASSWORD = 'correct horse battery';
const BINARY = Buffer.from([1, 0, 2, 0, 255, 254]);

async function stash(ctx, slug, body = {}) {
    await request(ctx.app).post('/api/stashes').send({ slug, ...body }).expect(201);
    return `/api/stashes/${slug}`;
}
const upload = (ctx, base, name, body = BINARY) =>
    request(ctx.app).post(`${base}/files`).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(body);

test('a stash starts on the server default, and the choice is its own', async () => {
    const ctx = makeApp();
    const a = await stash(ctx, 'types-stash-a');
    const b = await stash(ctx, 'types-stash-b');
    assert.equal((await request(ctx.app).get(a).expect(200)).body.fileTypes, 'safe');
    await upload(ctx, a, 'app.apk').expect(415);

    await request(ctx.app).put(`${a}/file-types`).send({ fileTypes: 'no-programs' }).expect(200, { fileTypes: 'no-programs' });
    assert.equal((await request(ctx.app).get(a).expect(200)).body.fileTypes, 'no-programs');
    await upload(ctx, a, 'app.apk').expect(201);
    await upload(ctx, a, 'setup.exe').expect(415);

    // Another stash is not affected
    assert.equal((await request(ctx.app).get(b).expect(200)).body.fileTypes, 'safe');
    await upload(ctx, b, 'app.apk').expect(415);

    await request(ctx.app).put(`${a}/file-types`).send({ fileTypes: 'any' }).expect(200);
    await upload(ctx, a, 'setup.exe').expect(201);
    await request(ctx.app).put(`${a}/file-types`).send({ fileTypes: 'safe' }).expect(200);
    await upload(ctx, a, 'again.apk').expect(415);
});

test('only a known mode is accepted, and the refusal tells where to change it', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'types-stash-bad');
    for (const bad of ['whatever', '', null, 5, undefined]) {
        await request(ctx.app).put(`${base}/file-types`).send({ fileTypes: bad }).expect(400);
    }
    assert.equal((await request(ctx.app).get(base).expect(200)).body.fileTypes, 'safe');
    const refused = await upload(ctx, base, 'app.apk').expect(415);
    assert.match(refused.body.error, /Options/);
});

test('a resumable upload follows the stash choice too', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'types-stash-resume');
    const start = () => request(ctx.app).post(`${base}/uploads`).send({ name: 'setup.exe', size: 100 });
    await start().expect(415);
    await request(ctx.app).put(`${base}/file-types`).send({ fileTypes: 'any' }).expect(200);
    await start().expect(201);
});

test('only someone who manages the stash can change it', async () => {
    const ctx = makeApp();
    const base = await stash(ctx, 'types-stash-locked', { password: PASSWORD });
    const owner = request.agent(ctx.app);
    await owner.post(`${base}/unlock`).send({ password: PASSWORD }).expect(200);
    const link = (await owner.post(`${base}/share-links`).send({ kind: 'drop' }).expect(201)).body;
    assert.ok(link.token || link.url, 'a drop-box link was made');
    await request(ctx.app).put(`${base}/file-types`).send({ fileTypes: 'any' }).expect(401);
    await owner.put(`${base}/file-types`).send({ fileTypes: 'any' }).expect(200);
});

test('the admin settings no longer have a file types setting', async () => {
    const ctx = makeApp({ adminPassword: 'admin-pass-123' });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: 'admin-pass-123' }).expect(200);
    const settings = await admin.get('/api/admin/settings').expect(200);
    assert.equal(settings.body.fields.find(f => f.key === 'fileTypes'), undefined);
    assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.fileTypes, undefined);
});

test('a database made before this setting gets the column, and its stashes start on the safe list', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { connect, SCHEMA_VERSION } = require('../src/database/sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-types-'));
    try {
        const file = path.join(dir, 'old.sqlite');
        connect(file).close();
        // Make it look like the release before: no file_types column (migration 13 not run yet)
        const raw = new DatabaseSync(file);
        raw.exec('ALTER TABLE stashes DROP COLUMN file_types');
        raw.exec('PRAGMA user_version = 12'); // the version the release before this setting left
        raw.exec("INSERT INTO stashes (slug, created_at) VALUES ('older-stash', '2025-01-01T00:00:00Z')");
        raw.close();

        const db = connect(file);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        assert.equal(db.prepare("SELECT file_types FROM stashes WHERE slug = 'older-stash'").get().file_types, null);
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a guest stash (no account, no password) starts on the safe list, and whoever has full access can change it', async () => {
    const ctx = makeApp();
    // A guest stash without a password needs a name of at least 10 characters
    const base = await stash(ctx, 'guest-types-stash');
    const view = await request(ctx.app).get(base).expect(200);
    assert.equal(view.body.fileTypes, 'safe');
    assert.equal(view.body.canManage, true);
    await upload(ctx, base, 'app.apk').expect(415);
    await request(ctx.app).put(`${base}/file-types`).send({ fileTypes: 'no-programs' }).expect(200);
    await upload(ctx, base, 'app.apk').expect(201);
});
