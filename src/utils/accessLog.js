// One structured line per finished request (LOG_FORMAT=json), and the numbers the metrics need from the same place.
//
// What is deliberately NOT here: the real path, the query string, headers, cookies and bodies. A stash name is the
// secret of a password-less stash and it sits in the path, so only the route *pattern* is logged
// (/api/stashes/:slug/notes) and the stash is named by a short keyed hash (see logLine.js).
const { writeLine, stashTag } = require('./logLine');

// Anything else a client sends as a method is counted as OTHER, so odd requests cannot create new metric series
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// The Express route pattern that handled the request, never the real path. A request no route answered (a 404 for an
// unknown address, a limiter that refused it before the route) is 'unmatched'; the static page files are 'static'.
function routeOf(req, status) {
    const pattern = req.route && req.route.path;
    // (a router's "/" under /api/stashes is /api/stashes, not /api/stashes/)
    if (typeof pattern === 'string') return `${req.baseUrl || ''}${pattern}`.replace(/(.)\/$/, '$1');
    if ((req.method === 'GET' || req.method === 'HEAD') && status < 400) return 'static';
    return 'unmatched';
}

function roleOf(req) {
    if (req.role) return req.role;
    return req.stash ? 'none' : null;
}

// format: 'off' (no log lines) or 'json'. observe(entry) is optional and gets the same facts, for the metrics.
// /health and /metrics are skipped: a monitor calling them every few seconds would drown the log.
function accessLog({ format = 'off', out = writeLine, secret, now = () => new Date(), observe = null } = {}) {
    const logging = format === 'json';
    if (!logging && !observe) return (req, res, next) => next();
    return (req, res, next) => {
        if (req.path === '/health' || req.path === '/metrics') return next();
        const started = process.hrtime.bigint();
        let done = false;
        // 'finish' is a response that was sent; 'close' also covers a client that went away, and is the only end an
        // event stream has. Whichever comes first logs, once.
        const finish = () => {
            if (done) return;
            done = true;
            try {
                const status = res.statusCode;
                const ms = Number(process.hrtime.bigint() - started) / 1e6;
                const length = Number(res.getHeader('content-length'));
                const slug = (req.stash && req.stash.slug) || (req.params && req.params.slug);
                const entry = {
                    method: METHODS.has(req.method) ? req.method : 'OTHER',
                    route: routeOf(req, status),
                    status,
                    ms: Math.round(ms * 10) / 10,
                    ip: req.ip || null,
                    stash: stashTag(secret, slug),
                    role: roleOf(req),
                    bytes: res.hasHeader('content-length') && Number.isFinite(length) ? length : null,
                };
                if (observe) observe(entry);
                if (logging) out(JSON.stringify({ time: now().toISOString(), level: 'info', msg: 'request', ...entry }));
            } catch {
                // logging must never break a request
            }
        };
        res.on('finish', finish);
        res.on('close', finish);
        next();
    };
}

module.exports = { accessLog, routeOf };
