// A small per-stash hub for Server-Sent Events: every open page on a stash gets each new item as it happens.
class StashEvents {
    constructor({ heartbeatMs = 25000 } = {}) {
        this.heartbeatMs = heartbeatMs;
        this.clients = new Map(); // slug -> Set<res>
    }

    subscribe(slug, req, res) {
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

        // Comments keep proxies and browsers from closing an idle stream
        const timer = setInterval(() => res.write(': keep-alive\n\n'), this.heartbeatMs);
        timer.unref();
        req.on('close', () => {
            clearInterval(timer);
            const set = this.clients.get(slug);
            if (set) {
                set.delete(res);
                if (!set.size) this.clients.delete(slug);
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
