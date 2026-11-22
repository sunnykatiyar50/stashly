const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/app');

test('pages and static files are rate limited per IP, and the API is not caught by that limit', async () => {
    // rateRead 2 means 4 page requests a minute
    const ctx = makeApp({ rateRead: 2 });
    for (let i = 0; i < 4; i++) await request(ctx.app).get('/account').expect(200);
    await request(ctx.app).get('/account').expect(429);
    await request(ctx.app).get('/admin').expect(429);
    await request(ctx.app).get('/styles.css').expect(429);
    // The health check and the API keep their own limits
    await request(ctx.app).get('/health').expect(200);
    await request(ctx.app).get('/api/config').expect(200);
});

test('the admin password still signs in through the keyed comparison, and a wrong one does not', async () => {
    const ctx = makeApp({ adminPassword: 'a-long-admin-password' });
    await request(ctx.app).post('/api/admin/login').send({ password: 'wrong' }).expect(401);
    await request(ctx.app).post('/api/admin/login').send({ password: 'a-long-admin-password' }).expect(200);
});
