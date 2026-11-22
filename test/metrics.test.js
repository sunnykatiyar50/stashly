const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');
const { binary } = require('./helpers/unzip');
const { version } = require('../package.json');

const TOKEN = 'metrics-token-for-tests';
const ADMIN = 'admin-pass-123';
const auth = { Authorization: `Bearer ${TOKEN}` };

// Reads the exposition text into { types, helps, samples: [{ name, labels, value }] } (and checks every line is valid)
function parseMetrics(text) {
    const types = {};
    const helps = {};
    const samples = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        let m = /^# TYPE (\S+) (counter|gauge|histogram)$/.exec(line);
        if (m) { types[m[1]] = m[2]; continue; }
        m = /^# HELP (\S+) .+$/.exec(line);
        if (m) { helps[m[1]] = true; continue; }
        m = /^([a-z_:][a-z0-9_:]*)(\{(.*)\})? (-?[0-9.e+]+)$/i.exec(line);
        assert.ok(m, `not a valid exposition line: ${line}`);
        const labels = {};
        for (const pair of (m[3] || '').match(/[a-z_]+="(?:[^"\\]|\\.)*"/gi) || []) {
            const eq = pair.indexOf('=');
            labels[pair.slice(0, eq)] = pair.slice(eq + 2, -1);
        }
        samples.push({ name: m[1], labels, value: Number(m[4]) });
    }
    return { types, helps, samples };
}
const find = (parsed, name, labels = {}) =>
    parsed.samples.find(s => s.name === name && Object.keys(labels).every(k => s.labels[k] === labels[k]));
const value = (parsed, name, labels) => {
    const sample = find(parsed, name, labels);
    assert.ok(sample, `missing ${name} ${JSON.stringify(labels || {})}`);
    return sample.value;
};
const scrape = async ctx => parseMetrics((await request(ctx.app).get('/metrics').set(auth).expect(200)).text);

test('/metrics does not exist unless METRICS_TOKEN is set', async () => {
    const ctx = makeApp();
    await request(ctx.app).get('/metrics').expect(404);
    // not even with a header that looks right
    await request(ctx.app).get('/metrics').set(auth).expect(404);
});

test('/metrics needs the bearer token, and is never cached', async () => {
    const ctx = makeApp({ metricsToken: TOKEN });
    const none = await request(ctx.app).get('/metrics').expect(401);
    assert.match(none.headers['www-authenticate'], /Bearer/);
    await request(ctx.app).get('/metrics').set('Authorization', 'Bearer wrong-token').expect(401);
    await request(ctx.app).get('/metrics').set('Authorization', TOKEN).expect(401);
    await request(ctx.app).get('/metrics').set('Authorization', 'Basic abc').expect(401);
    await request(ctx.app).get('/metrics?token=' + TOKEN).expect(401);
    const ok = await request(ctx.app).get('/metrics').set(auth).expect(200);
    assert.match(ok.headers['content-type'], /^text\/plain; version=0\.0\.4/);
    assert.match(ok.headers['cache-control'], /no-store/);
    // a stash cookie or the admin cookie is no substitute
    const admin = makeApp({ metricsToken: TOKEN, adminPassword: ADMIN });
    const agent = request.agent(admin.app);
    await agent.post('/api/admin/login').send({ password: ADMIN }).expect(200);
    await agent.get('/metrics').expect(401);
});

test('/metrics has its own small limit, apart from the stash limiters', async () => {
    const ctx = makeApp({ metricsToken: TOKEN, rateRead: 2, rateNotFound: 2 });
    for (let i = 0; i < 20; i++) await request(ctx.app).get('/metrics').set(auth).expect(200);
    let status = 200;
    for (let i = 0; i < 150 && status === 200; i++) status = (await request(ctx.app).get('/metrics').set(auth)).status;
    assert.equal(status, 429);
});

test('the numbers match what happened', async () => {
    const ctx = makeApp({ metricsToken: TOKEN, adminPassword: ADMIN, stashUnlockFailures: 0, undoSeconds: 60 });
    const owner = request.agent(ctx.app);
    await owner.post('/api/stashes').send({ slug: 'count-one', password: 'long enough pw' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'count-two' }).expect(201);
    await owner.post('/api/stashes/count-one/notes').send({ text: 'a' }).expect(201);
    const b = (await owner.post('/api/stashes/count-one/notes').send({ text: 'b' }).expect(201)).body;
    await owner.post('/api/stashes/count-one/files').set('X-File-Name', 'a.png').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
    await owner.delete(`/api/stashes/count-one/items/${b.id}`).expect(200); // into the trash
    await owner.get('/api/stashes/count-one/export').buffer(true).parse(binary).expect(200);
    await request(ctx.app).post('/api/stashes/count-one/unlock').send({ password: 'wrong one' }).expect(401);
    await request(ctx.app).post('/api/stashes/count-one/unlock').send({ password: 'wrong two' }).expect(401);
    await request(ctx.app).post('/api/admin/login').send({ password: 'nope' }).expect(401);
    await request(ctx.app).post('/api/admin/login').send({ password: ADMIN }).expect(200);
    await request(ctx.app).get('/definitely-not-a-page').expect(404);

    const text = (await request(ctx.app).get('/metrics').set(auth).expect(200)).text;
    const m = parseMetrics(text);

    assert.equal(m.types.stashly_http_requests_total, 'counter');
    assert.equal(m.types.stashly_http_request_duration_seconds, 'histogram');
    for (const gauge of ['stashly_stashes', 'stashly_items', 'stashly_stored_bytes', 'stashly_trashed_items', 'stashly_sse_connections', 'stashly_build_info', 'stashly_process_start_time_seconds', 'stashly_process_resident_memory_bytes', 'stashly_process_heap_used_bytes']) {
        assert.equal(m.types[gauge], 'gauge', gauge);
    }
    for (const name of Object.keys(m.types)) assert.ok(m.helps[name], `${name} has HELP`);
    for (const s of m.samples) assert.ok(s.name.startsWith('stashly_'), s.name);

    assert.equal(value(m, 'stashly_stashes'), 2);
    assert.equal(value(m, 'stashly_items', { kind: 'note' }), 1);
    assert.equal(value(m, 'stashly_items', { kind: 'file' }), 1);
    assert.equal(value(m, 'stashly_stored_bytes'), PNG.length);
    assert.equal(value(m, 'stashly_trashed_items'), 1);
    assert.equal(value(m, 'stashly_sse_connections'), 0);
    assert.equal(value(m, 'stashly_unlock_failures_total'), 2);
    assert.equal(value(m, 'stashly_uploads_total'), 1);
    assert.equal(value(m, 'stashly_uploaded_bytes_total'), PNG.length);
    assert.equal(value(m, 'stashly_exports_total'), 1);
    assert.equal(value(m, 'stashly_admin_logins_total', { result: 'failure' }), 1);
    assert.equal(value(m, 'stashly_admin_logins_total', { result: 'success' }), 1);
    assert.equal(value(m, 'stashly_build_info', { version }), 1);
    assert.ok(value(m, 'stashly_process_start_time_seconds') > 1.7e9);
    assert.ok(value(m, 'stashly_process_resident_memory_bytes') > 0);

    assert.equal(value(m, 'stashly_http_requests_total', { method: 'POST', route: '/api/stashes', status_class: '2xx' }), 2);
    assert.equal(value(m, 'stashly_http_requests_total', { method: 'POST', route: '/api/stashes/:slug/unlock', status_class: '4xx' }), 2);
    assert.equal(value(m, 'stashly_http_requests_total', { method: 'POST', route: '/api/stashes/:slug/files', status_class: '2xx' }), 1);
    assert.equal(value(m, 'stashly_http_requests_total', { method: 'GET', route: 'unmatched', status_class: '4xx' }), 1);

    // the histogram: cumulative buckets that end in +Inf = count, and a sum
    const buckets = m.samples.filter(s => s.name === 'stashly_http_request_duration_seconds_bucket' && s.labels.route === '/api/stashes/:slug/notes');
    assert.ok(buckets.length > 5);
    assert.equal(buckets[buckets.length - 1].labels.le, '+Inf');
    for (let i = 1; i < buckets.length; i++) assert.ok(buckets[i].value >= buckets[i - 1].value);
    const count = value(m, 'stashly_http_request_duration_seconds_count', { route: '/api/stashes/:slug/notes' });
    assert.equal(count, 2);
    assert.equal(buckets[buckets.length - 1].value, count);
    assert.ok(value(m, 'stashly_http_request_duration_seconds_sum', { route: '/api/stashes/:slug/notes' }) >= 0);

    // no name, and no address, anywhere in the text
    assert.ok(!text.includes('count-one') && !text.includes('count-two'));
});

test('live streams are counted while they are open', async () => {
    const ctx = makeApp({ metricsToken: TOKEN });
    await request(ctx.app).post('/api/stashes').send({ slug: 'sse-count' }).expect(201);
    const server = ctx.app.listen(0);
    try {
        const open = await new Promise((resolve, reject) => {
            const req = http.get({ port: server.address().port, path: '/api/stashes/sse-count/events' }, res => res.once('data', () => resolve(req)));
            req.on('error', reject);
        });
        assert.equal(value(await scrape(ctx), 'stashly_sse_connections'), 1);
        open.destroy();
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(value(await scrape(ctx), 'stashly_sse_connections'), 0);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

// The series (metric name + label names/values) must come from a fixed set, not from what visitors send
test('many different stashes and addresses create no new series', async () => {
    const ctx = makeApp({ metricsToken: TOKEN, rateNotFound: 100000, rateRead: 100000 });
    const traffic = async slug => {
        await request(ctx.app).post('/api/stashes').send({ slug }).expect(201);
        await request(ctx.app).post(`/api/stashes/${slug}/notes`).send({ text: 'x' }).expect(201);
        await request(ctx.app).get(`/api/stashes/${slug}?search=${slug}`).expect(200);
        await request(ctx.app).get(`/api/stashes/${slug}/latest`).expect(200);
        await request(ctx.app).get(`/api/stashes/missing-${slug}`).expect(404);
        await request(ctx.app).get(`/s/${slug}`).expect(200);
        await request(ctx.app).get(`/no/such/${slug}`).expect(404);
        await request(ctx.app).delete(`/api/stashes/${slug}`).expect(200);
    };
    const seriesOf = text => {
        const keys = new Set();
        for (const s of parseMetrics(text).samples) {
            const labels = Object.entries(s.labels).filter(([k]) => k !== 'le').map(([k, v]) => `${k}=${v}`).join(',');
            keys.add(`${s.name}{${labels}}${s.labels.le ? `le=${s.labels.le}` : ''}`);
        }
        return keys;
    };
    await traffic('series-first');
    const before = (await request(ctx.app).get('/metrics').set(auth)).text;
    for (let i = 0; i < 40; i++) await traffic(`series-${i}-abcdef`);
    const after = (await request(ctx.app).get('/metrics').set(auth)).text;
    assert.deepEqual([...seriesOf(after)].sort(), [...seriesOf(before)].sort());
    assert.ok(!after.includes('series-'));
    assert.ok(seriesOf(after).size < 150);
});

test('/metrics itself and /health are left out of the request counts and the access log', async () => {
    const lines = [];
    const ctx = makeApp({ metricsToken: TOKEN, logFormat: 'json' }, { logOut: line => lines.push(line) });
    await request(ctx.app).get('/health').expect(200);
    await request(ctx.app).get('/metrics').set(auth).expect(200);
    const m = await scrape(ctx);
    assert.ok(!m.samples.some(s => s.labels.route === '/metrics' || s.labels.route === '/health'));
    assert.deepEqual(lines, []);
});
