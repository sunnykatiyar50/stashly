const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, PNG } = require('./helpers/app');

// Opens the live stream like a browser would, and collects the events it receives
function listen(server, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const events = [];
        // "presence" (how many pages are open) arrives on every connect and disconnect; it is kept apart so the
        // tests about items can count only the item events
        const presence = [];
        let buffer = '';
        const req = http.get({ port: server.address().port, path, headers }, res => {
            const stream = {
                status: res.statusCode,
                events,
                presence,
                ended: new Promise(done => res.on('end', done)),
                close: () => req.destroy(),
                waitFor: (count, ms = 2000) =>
                    new Promise((ok, fail) => {
                        const started = Date.now();
                        const timer = setInterval(() => {
                            if (events.length >= count) {
                                clearInterval(timer);
                                ok(events);
                            } else if (Date.now() - started > ms) {
                                clearInterval(timer);
                                fail(new Error(`Only ${events.length} of ${count} events arrived`));
                            }
                        }, 10);
                    }),
            };
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buffer += chunk;
                let index;
                while ((index = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const event = /^event: (.+)$/m.exec(frame);
                    const data = /^data: (.+)$/m.exec(frame);
                    if (!event) continue;
                    const parsed = { event: event[1], data: JSON.parse(data[1]) };
                    if (parsed.event === 'presence') presence.push(parsed.data.count);
                    else events.push(parsed);
                }
            });
            resolve(stream);
        });
        req.on('error', err => (err.code === 'ECONNRESET' ? null : reject(err)));
    });
}

async function withServer(ctx, fn) {
    const server = ctx.app.listen(0);
    try {
        await fn(server);
    } finally {
        server.closeAllConnections();
        server.close();
    }
}

test('a second page sees notes and files the moment they are added', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'live' }).expect(201);
    await withServer(ctx, async server => {
        const stream = await listen(server, '/api/stashes/live/events');
        assert.equal(stream.status, 200);

        const note = await request(ctx.app).post('/api/stashes/live/notes').send({ text: 'from machine A' }).expect(201);
        await request(ctx.app)
            .post('/api/stashes/live/files')
            .set('X-File-Name', 'a.png')
            .set('Content-Type', 'application/octet-stream')
            .send(PNG)
            .expect(201);
        await request(ctx.app).delete(`/api/stashes/live/items/${note.body.id}`).expect(200);

        const events = await stream.waitFor(3);
        assert.equal(events[0].event, 'item-added');
        assert.equal(events[0].data.text, 'from machine A');
        assert.equal(events[1].event, 'item-added');
        assert.equal(events[1].data.fileName, 'a.png');
        assert.equal(events[2].event, 'item-deleted');
        assert.equal(events[2].data.id, note.body.id);
        stream.close();
    });
});

test('events only go to the stash they belong to', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'stash-a' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'stash-b' }).expect(201);
    await withServer(ctx, async server => {
        const a = await listen(server, '/api/stashes/stash-a/events');
        const b = await listen(server, '/api/stashes/stash-b/events');
        await request(ctx.app).post('/api/stashes/stash-b/notes').send({ text: 'only for b' }).expect(201);
        await b.waitFor(1);
        await new Promise(r => setTimeout(r, 50));
        assert.equal(a.events.length, 0);
        a.close();
        b.close();
    });
});

test('open pages are told, and the stream ends, when the stash expires or is deleted', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'short-lived', ttl: '1h' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'to-delete', ttl: '1d' }).expect(201);
    await withServer(ctx, async server => {
        const expiring = await listen(server, '/api/stashes/short-lived/events');
        const deleting = await listen(server, '/api/stashes/to-delete/events');

        ctx.clock.time = new Date(ctx.clock.time.getTime() + 2 * 60 * 60 * 1000);
        ctx.controller.cleanup();
        const [gone] = await expiring.waitFor(1);
        assert.equal(gone.event, 'stash-gone');
        assert.equal(gone.data.reason, 'expired');
        await expiring.ended;

        await request(ctx.app).delete('/api/stashes/to-delete').expect(200);
        const [removed] = await deleting.waitFor(1);
        assert.equal(removed.event, 'stash-gone');
        assert.equal(removed.data.reason, 'deleted');
        await deleting.ended;
    });
});

test('extending tells open pages the new expiry', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'extend-me', ttl: '1h' }).expect(201);
    await withServer(ctx, async server => {
        const stream = await listen(server, '/api/stashes/extend-me/events');
        const res = await request(ctx.app).post('/api/stashes/extend-me/extend').expect(200);
        const [event] = await stream.waitFor(1);
        assert.equal(event.event, 'stash-extended');
        assert.equal(event.data.expiresAt, res.body.expiresAt);
        stream.close();
    });
});

test('a protected stash only streams to someone unlocked', async () => {
    const ctx = makeApp();
    const agent = request.agent(ctx.app);
    const created = await agent.post('/api/stashes').send({ slug: 'locked-live', password: 'hunter22' }).expect(201);
    const cookie = created.headers['set-cookie'][0].split(';')[0];
    await withServer(ctx, async server => {
        const denied = await listen(server, '/api/stashes/locked-live/events');
        assert.equal(denied.status, 401);
        const allowed = await listen(server, '/api/stashes/locked-live/events', { Cookie: cookie });
        assert.equal(allowed.status, 200);
        allowed.close();
    });
});

test('every open page is told how many pages are open on the stash', async () => {
    const ctx = makeApp();
    await request(ctx.app).post('/api/stashes').send({ slug: 'crowd' }).expect(201);
    await request(ctx.app).post('/api/stashes').send({ slug: 'elsewhere' }).expect(201);
    const waitFor = async (fn, ms = 2000) => {
        const started = Date.now();
        while (!fn()) {
            if (Date.now() - started > ms) throw new Error('timed out');
            await new Promise(r => setTimeout(r, 10));
        }
    };
    await withServer(ctx, async server => {
        const first = await listen(server, '/api/stashes/crowd/events');
        await waitFor(() => first.presence.length >= 1);
        assert.deepEqual(first.presence, [1]);

        const second = await listen(server, '/api/stashes/crowd/events');
        await waitFor(() => second.presence.length >= 1);
        await waitFor(() => first.presence.length >= 2);
        assert.deepEqual(first.presence, [1, 2]);
        assert.deepEqual(second.presence, [2]);

        // Another stash's pages are counted separately
        const other = await listen(server, '/api/stashes/elsewhere/events');
        await waitFor(() => other.presence.length >= 1);
        assert.deepEqual(other.presence, [1]);
        assert.equal(first.presence.length, 2);

        // A page closing is noticed by the one that is left
        second.close();
        await waitFor(() => first.presence.length >= 3);
        assert.deepEqual(first.presence, [1, 2, 1]);
        first.close();
        other.close();
    });
});
