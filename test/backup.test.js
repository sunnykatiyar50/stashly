const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');
const { unzip, binary } = require('./helpers/unzip');

const PASSWORD = 'admin-pass-123';

async function adminApp(overrides = {}) {
    const ctx = makeApp({ adminPassword: PASSWORD, ...overrides });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: PASSWORD }).expect(200);
    return { ...ctx, admin };
}
const backupOf = agent => agent.get('/api/admin/backup').buffer(true).parse(binary);
const leftovers = ctx => (fs.existsSync(ctx.fileStore.tmpDir) ? fs.readdirSync(ctx.fileStore.tmpDir) : []);

async function stashWithFiles(ctx) {
    await request(ctx.app).post('/api/stashes').send({ slug: 'precious' }).expect(201);
    await request(ctx.app).post('/api/stashes/precious/notes').send({ title: 'Hello', text: 'backed up text' }).expect(201);
    const png = await request(ctx.app).post('/api/stashes/precious/files').set('X-File-Name', 'shot.png').send(PNG).expect(201);
    const text = Buffer.from('some file text\n'.repeat(200));
    const txt = await request(ctx.app).post('/api/stashes/precious/files').set('X-File-Name', 'a.txt').set('Content-Type', 'application/octet-stream').send(text).expect(201);
    return { png: png.body.id, txt: txt.body.id, text };
}

test('the backup is for the admin only', async () => {
    const off = makeApp();
    await request(off.app).get('/api/admin/backup').expect(404);

    const ctx = makeApp({ adminPassword: PASSWORD });
    const res = await request(ctx.app).get('/api/admin/backup').expect(401);
    assert.match(res.body.error, /Sign in/);
    assert.ok(!(res.headers['content-type'] || '').includes('zip'));
    // a stash's own cookie is no use here either
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'mine', password: 'long enough pw' }).expect(201);
    await owner.get('/api/admin/backup').expect(401);
});

test('the backup zip holds a readable snapshot of the database and every file', async () => {
    const ctx = await adminApp();
    const ids = await stashWithFiles(ctx);
    const res = await backupOf(ctx.admin).expect(200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="stashly-backup-2026-01-15.zip"');
    assert.match(res.headers['cache-control'], /no-store/);

    const files = unzip(res.body);
    assert.deepEqual([...files.keys()].sort(), ['stashly.sqlite', `files/${ids.png}`, `files/${ids.txt}`].sort());
    assert.ok(files.get(`files/${ids.png}`).equals(PNG));
    assert.ok(files.get(`files/${ids.txt}`).equals(ids.text));

    // The snapshot is a database that opens, with the same content (and the right schema version)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-restore-'));
    try {
        const copy = path.join(dir, 'stashly.sqlite');
        fs.writeFileSync(copy, files.get('stashly.sqlite'));
        const db = new DatabaseSync(copy, { readOnly: true });
        assert.equal(db.prepare('SELECT slug FROM stashes').get().slug, 'precious');
        assert.equal(db.prepare("SELECT text FROM items WHERE kind = 'note'").get().text, 'backed up text');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 3);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, ctx.db.prepare('PRAGMA user_version').get().user_version);
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an empty server still backs up', async () => {
    const ctx = await adminApp();
    const files = unzip((await backupOf(ctx.admin).expect(200)).body);
    assert.deepEqual([...files.keys()], ['stashly.sqlite']);
});

test('the snapshot temp file is gone afterwards, on success and on failure', async () => {
    const ctx = await adminApp();
    await stashWithFiles(ctx);
    await backupOf(ctx.admin).expect(200);
    assert.deepEqual(leftovers(ctx), []);

    // The snapshot cannot be made: a clean 500, nothing sent, nothing left behind
    const prepare = ctx.db.prepare.bind(ctx.db);
    ctx.db.prepare = sql => {
        if (String(sql).startsWith('VACUUM')) throw new Error('disk full');
        return prepare(sql);
    };
    const failed = await ctx.admin.get('/api/admin/backup').expect(500);
    assert.deepEqual(failed.body, { error: 'The backup could not be made.' });
    assert.deepEqual(leftovers(ctx), []);
});

test('the temp file is removed when the admin disconnects part way', async () => {
    const ctx = await adminApp({ maxFileBytes: 50 * 1024 * 1024, maxStashBytes: 200 * 1024 * 1024 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'bulk' }).expect(201);
    await request(ctx.app).post('/api/stashes/bulk/files').set('X-File-Name', 'big.txt').set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(12 * 1024 * 1024, 'abcdefgh')).expect(201);
    const login = await request(ctx.app).post('/api/admin/login').send({ password: PASSWORD }).expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const server = ctx.app.listen(0);
    try {
        await new Promise((resolve, reject) => {
            const req = http.get({ port: server.address().port, path: '/api/admin/backup', headers: { cookie } }, res => {
                res.once('data', () => { req.destroy(); resolve(); });
            });
            req.on('error', err => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
        });
        for (let i = 0; i < 60 && leftovers(ctx).length; i++) await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(leftovers(ctx), []);
    } finally {
        server.close();
    }
});

test('backups are limited to five per ten minutes', async () => {
    const ctx = await adminApp();
    for (let i = 0; i < 5; i++) await backupOf(ctx.admin).expect(200);
    const sixth = await ctx.admin.get('/api/admin/backup').expect(429);
    assert.match(sixth.body.error, /Too many backups/);
});

test('the admin page offers a download link and warns what the backup holds', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/views/admin.html'), 'utf8');
    assert.match(html, /<a [^>]*href="\/api\/admin\/backup"[^>]*download/);
    assert.match(html, /password hashes and the session secret/);
    assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline scripts (CSP)');
});
