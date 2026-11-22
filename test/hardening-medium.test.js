const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const request = require('supertest');
const { makeApp } = require('./helpers/app');
const { StashEvents } = require('../src/utils/events');

const PASSWORD = 'correct horse';
// With one trusted proxy, the X-Forwarded-For header stands in for different visitors
const from = (ctx, ip) => ({
    unlock: (slug, password) => request(ctx.app).post(`/api/stashes/${slug}/unlock`).set('X-Forwarded-For', ip).send({ password }),
});

async function protectedStash(ctx, slug = 'vault') {
    await request(ctx.app).post('/api/stashes').send({ slug, password: PASSWORD }).expect(201);
}

// ---- 1. a stranger cannot lock the owner out ----

test('wrong passwords lock out only the visitor who typed them', async () => {
    const ctx = makeApp({ stashUnlockFailures: 3, trustProxy: '1' });
    await protectedStash(ctx);
    const attacker = from(ctx, '203.0.113.9');
    for (let i = 0; i < 3; i++) await attacker.unlock('vault', 'nope').expect(401);
    await attacker.unlock('vault', PASSWORD).expect(429);
    // The owner, from another address, still gets in
    await from(ctx, '198.51.100.7').unlock('vault', PASSWORD).expect(200);
});

test('guessing from many addresses still locks the whole stash', async () => {
    const ctx = makeApp({ stashUnlockFailures: 2, trustProxy: '1' });
    await protectedStash(ctx);
    // 2 x 5 = 10 wrong passwords from ten different visitors
    for (let i = 1; i <= 10; i++) await from(ctx, `203.0.113.${i}`).unlock('vault', 'nope').expect(401);
    await from(ctx, '198.51.100.7').unlock('vault', PASSWORD).expect(429);
});

// ---- 2. reading is limited ----

test('reading a stash is rate limited per IP', async () => {
    const ctx = makeApp({ rateRead: 3 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'readable' }).expect(201);
    for (let i = 0; i < 3; i++) await request(ctx.app).get('/api/stashes/readable').expect(200);
    await request(ctx.app).get('/api/stashes/readable').expect(429);
});

test('guessing stash names is limited, while using a real stash is not counted', async () => {
    const ctx = makeApp({ rateNotFound: 3 });
    await request(ctx.app).post('/api/stashes').send({ slug: 'real-stash' }).expect(201);
    for (let i = 0; i < 20; i++) await request(ctx.app).get('/api/stashes/real-stash').expect(200);
    for (let i = 0; i < 3; i++) await request(ctx.app).get(`/api/stashes/missing-${i}`).expect(404);
    await request(ctx.app).get('/api/stashes/missing-x').expect(429);
});

// ---- 3. admin cookie ----

test('COOKIE_SECURE=true marks the admin cookie Secure over plain HTTP', async () => {
    const secure = makeApp({ adminPassword: 'admin-pass', cookieSecure: 'true' });
    const res = await request(secure.app).post('/api/admin/login').send({ password: 'admin-pass' }).expect(200);
    assert.match(res.headers['set-cookie'][0], /; Secure/i);

    const plain = makeApp({ adminPassword: 'admin-pass', cookieSecure: 'auto' });
    const res2 = await request(plain.app).post('/api/admin/login').send({ password: 'admin-pass' }).expect(200);
    assert.doesNotMatch(res2.headers['set-cookie'][0], /; Secure/i);
});

// ---- 4. a GET never burns a note ----

test('GET latest leaves a burn note alone; POST reads it and deletes it', async () => {
    const ctx = makeApp();
    const base = '/api/stashes/burnable';
    await request(ctx.app).post('/api/stashes').send({ slug: 'burnable' }).expect(201);
    await request(ctx.app).post(`${base}/notes`).set('Content-Type', 'text/plain').set('X-Burn-After-Read', '1').send('once').expect(201);

    const refused = await request(ctx.app).get(`${base}/latest`).expect(409);
    assert.match(refused.text, /POST/);
    // Still there after the GET
    await request(ctx.app).get(`${base}/latest`).expect(409);
    assert.equal((await request(ctx.app).get(base).expect(200)).body.items.length, 1);

    assert.equal((await request(ctx.app).post(`${base}/latest`).expect(200)).text, 'once');
    await request(ctx.app).post(`${base}/latest`).expect(404);
});

test('POST latest on an ordinary note just returns it', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'ordinary' }).expect(201);
    await request(ctx.app).post('/api/stashes/ordinary/notes').set('Content-Type', 'text/plain').send('hello').expect(201);
    assert.equal((await request(ctx.app).post('/api/stashes/ordinary/latest').expect(200)).text, 'hello');
    assert.equal((await request(ctx.app).get('/api/stashes/ordinary/latest').expect(200)).text, 'hello');
});

// ---- 5. live streams ----

function fakeStream() {
    const req = new EventEmitter();
    const res = {
        written: [],
        ended: false,
        statusCode: 200,
        writeHead() {},
        write(chunk) {
            this.written.push(chunk);
        },
        end() {
            this.ended = true;
            req.emit('close');
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json() {
            this.ended = true;
        },
    };
    return { req, res };
}

const wait = ms => new Promise(done => setTimeout(done, ms));

test('a stream ends with access-changed once its sign-in stops being valid', async () => {
    const events = new StashEvents({ heartbeatMs: 10 });
    let valid = true;
    const { req, res } = fakeStream();
    events.subscribe('vault', req, res, { verify: () => (valid ? null : 'access-changed') });
    await wait(40);
    assert.equal(res.ended, false);
    valid = false;
    await wait(40);
    assert.equal(res.ended, true);
    assert.ok(res.written.some(chunk => chunk.startsWith('event: access-changed')));
    assert.equal(events.count('vault'), 0);
});

test('open streams are capped per stash and per IP, and freed when they close', () => {
    const events = new StashEvents({ heartbeatMs: 1e9 });
    const open = (slug, ip, caps) => {
        const s = fakeStream();
        events.subscribe(slug, s.req, s.res, { ip, ...caps });
        return s;
    };
    const a = open('one', '1.1.1.1', { maxPerIp: 2 });
    open('one', '1.1.1.1', { maxPerIp: 2 });
    const third = open('one', '1.1.1.1', { maxPerIp: 2 });
    assert.equal(third.res.statusCode, 429);
    // Another address is fine, until the stash itself is full
    open('one', '2.2.2.2', { maxPerStash: 3 });
    assert.equal(open('one', '3.3.3.3', { maxPerStash: 3 }).res.statusCode, 429);
    // Closing one frees a place for that IP
    a.req.emit('close');
    assert.equal(open('two', '1.1.1.1', { maxPerIp: 2 }).res.statusCode, 200);
});
