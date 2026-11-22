// A small per-stash hub for Server-Sent Events: every open page on a stash gets each new item as it happens.
class StashEvents {
    constructor({ heartbeatMs = 25000 } = {}) {
        this.heartbeatMs = heartbeatMs;
        this.clients = new Map(); // slug -> Set<res>
        this.ips = new Map(); // ip -> number of open streams
    }

    // options (all optional):
    //  verify()      called on each heartbeat; returns null to carry on, or an event name ('access-changed', 'stash-gone')
    //                to send this one page before ending its stream
    //  ip, maxPerIp, maxPerStash   caps on open streams (0 or missing = no cap); over a cap the request gets a 429
    subscribe(slug, req, res, { verify, ip, maxPerStash = 0, maxPerIp = 0 } = {}) {
        if (maxPerStash && this.count(slug) >= maxPerStash) {
            return res.status(429).json({ error: 'Too many pages are open on this stash.' });
        }
        if (ip && maxPerIp && (this.ips.get(ip) || 0) >= maxPerIp) {
            return res.status(429).json({ error: 'Too many pages are open from this address.' });
        }
        if (ip) this.ips.set(ip, (this.ips.get(ip) || 0) + 1);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        res.write(': connected\n\n');

        if (!this.clients.has(slug)) this.clients.set(slug, new Set());
        this.clients.get(slug).add(res);
        // Everyone on the stash, this page included, learns how many pages are open
        this.publish(slug, 'presence', { count: this.count(slug) });

        // Comments keep proxies and browsers from closing an idle stream
        const timer = setInterval(() => {
            const ending = verify ? verify() : null;
            if (ending) {
                res.write(`event: ${ending}\ndata: {}\n\n`);
                res.end();
                return;
            }
            res.write(': keep-alive\n\n');
        }, this.heartbeatMs);
        timer.unref();
        req.on('close', () => {
            clearInterval(timer);
            if (ip) {
                const left = (this.ips.get(ip) || 1) - 1;
                if (left > 0) this.ips.set(ip, left);
                else this.ips.delete(ip);
            }
            const set = this.clients.get(slug);
            if (set) {
                set.delete(res);
                if (!set.size) this.clients.delete(slug);
                else this.publish(slug, 'presence', { count: set.size });
            }
        });
    }

    publish(slug, event, data = {}) {
        const set = this.clients.get(slug);
        if (!set) return;
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of set) res.write(frame);
    }

    // The stash is gone: tell the open pages, then end their streams
    closeAll(slug, event, data = {}) {
        const set = this.clients.get(slug);
        if (!set) return;
        this.publish(slug, event, data);
        for (const res of set) res.end();
        this.clients.delete(slug);
    }

    count(slug) {
        return this.clients.has(slug) ? this.clients.get(slug).size : 0;
    }
}

module.exports = { StashEvents };
