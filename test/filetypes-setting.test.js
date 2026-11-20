// The admin "File types" setting
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

const PASSWORD = 'admin-pass-123';

test('the file types setting is a choice, applies at once, and shows in the public config', async () => {
    const ctx = makeApp({ adminPassword: PASSWORD });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ password: PASSWORD }).expect(200);

    const settings = await admin.get('/api/admin/settings').expect(200);
    const field = settings.body.fields.find(f => f.key === 'fileTypes');
    assert.equal(field.type, 'choice');
    assert.equal(field.value, 'safe');
    assert.deepEqual(field.options.map(o => o.value), ['safe', 'no-programs', 'any']);
    assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.fileTypes, 'safe');

    await request(ctx.app).post('/api/stashes').send({ slug: 'types' }).expect(201);
    const upload = () =>
        request(ctx.app)
            .post('/api/stashes/types/files')
            .set('X-File-Name', 'data.bin')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from([1, 0, 2, 0, 255, 254]));
    assert.equal((await upload()).status, 415);

    await admin.put('/api/admin/settings').send({ values: { fileTypes: 'no-programs' } }).expect(200);
    assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.fileTypes, 'no-programs');
    assert.equal((await upload()).status, 201);

    const bad = await admin.put('/api/admin/settings').send({ values: { fileTypes: 'whatever' } }).expect(400);
    assert.match(bad.body.errors.fileTypes, /choices/);
    assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.fileTypes, 'no-programs');

    await admin.post('/api/admin/settings/reset').expect(200);
    assert.equal((await request(ctx.app).get('/api/config').expect(200)).body.fileTypes, 'safe');
});

test('FILE_TYPES from the environment sets the starting mode, and an unknown value falls back to safe', () => {
    const { loadConfig } = require('../src/config');
    assert.equal(loadConfig({ FILE_TYPES: 'any' }).fileTypes, 'any');
    assert.equal(loadConfig({ FILE_TYPES: 'no-programs' }).fileTypes, 'no-programs');
    assert.equal(loadConfig({ FILE_TYPES: 'everything' }).fileTypes, 'safe');
    assert.equal(loadConfig({}).fileTypes, 'safe');
});
