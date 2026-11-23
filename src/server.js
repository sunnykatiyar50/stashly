const path = require('path');
const express = require('express');
const helmet = require('helmet');
const StashController = require('./controllers/stashController');
const AdminController = require('./controllers/adminController');
const createStashRoutes = require('./routes/stashRoutes');
const createAdminRoutes = require('./routes/adminRoutes');
const createUserRoutes = require('./routes/userRoutes');
const UserController = require('./controllers/userController');
const { UserModel } = require('./models/userModel');
const { UserAuth } = require('./utils/userAuth');
const { AdminAuth } = require('./utils/adminAuth');
const { syncAdminUser } = require('./utils/adminUser');
const { SettingsStore } = require('./utils/settings');
const { Mailer } = require('./utils/mailer');
const { gzipAssets, revalidate } = require('./utils/staticAssets');
const { accessLog } = require('./utils/accessLog');
const { createAudit } = require('./utils/auditLog');
const { Metrics } = require('./utils/metrics');
const { checkConfig } = require('./config');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { version } = require('../package.json');

const viewsDir = path.join(__dirname, 'views');

// Builds the Express app. Kept separate from app.js so tests can create it with their own config and database.
// logOut and auditOut receive the access-log and audit-log lines (default: stdout); tests pass a collector.
function createApp({ config, model, events, secret, now, logOut, auditOut, mail }) {
    const app = express();
    // Throws with a clear message when a logging option is not one of the allowed values
    checkConfig(config);
    const adminAuth = new AdminAuth({ config, secret, now });
    // Applies any limits the admin saved earlier on top of the environment's values
    const settings = new SettingsStore({ model, config, secret });
    // The one place email goes out from (see utils/mailer.js). `mail` lets a test supply its own transport.
    const mailer = new Mailer({ config, now, createTransport: mail && mail.createTransport });
    const audit = createAudit({ mode: config.auditLog, out: auditOut, secret, now });
    const metrics = new Metrics();
    // Accounts (only on while the admin area is): who is signed in is read before every route, and the stash controller
    // consults the signed-in user's follow list when a visitor has no cookie for a stash
    const users = new UserModel(model.db);
    // The admin account (ADMIN_USERNAME + ADMIN_PASSWORD) is a user row like the others; make it match the environment
    // before the first request. Throws when a regular user already has that name (app.js shows it and stops).
    syncAdminUser({ users, config, log: line => console.log(line) });
    const userAuth = new UserAuth({ config, secret, users, now });
    const controller = new StashController({ model, events, config, secret, now, isAdmin: adminAuth.isAdmin, audit, metrics, users, userAuth });
    const userController = new UserController({ model, users, userAuth, adminAuth, config, stashes: controller, mailer, secret, now, audit, metrics });
    const adminController = new AdminController({
        model, events, config, adminAuth, settings, users, mailer, now, audit, metrics,
        // A new password clears the wrong-password count the stash controller keeps
        resetFailures: slug => controller.lockout.clear(slug),
    });

    const trust = String(config.trustProxy || '').trim();
    if (trust && !['false', 'no', 'off'].includes(trust.toLowerCase())) {
        // e.g. TRUST_PROXY=1 behind one reverse proxy, so req.ip / req.secure reflect the real client.
        // "true" is read as one proxy: Express would take the string "true" for an IP address and crash,
        // and trusting every hop would let clients fake their IP and dodge the rate limits.
        const hops = ['true', 'yes', 'on'].includes(trust.toLowerCase()) ? 1 : Number(trust);
        app.set('trust proxy', Number.isInteger(hops) ? hops : trust);
    }

    app.disable('x-powered-by');
    // First, so every request is seen, including the ones a later middleware refuses. It writes the access log when
    // LOG_FORMAT=json and always feeds the request metrics (which only cost a counter).
    app.use(accessLog({ format: config.logFormat, out: logOut, secret, now, observe: entry => metrics.recordRequest(entry) }));
    app.use(
        helmet({
            contentSecurityPolicy: {
                directives: {
                    'default-src': ["'self'"],
                    'script-src': ["'self'"],
                    'style-src': ["'self'"],
                    'img-src': ["'self'", 'data:'],
                    'form-action': ["'self'"],
                    'frame-ancestors': ["'none'"],
                    // often served over plain HTTP on a LAN address
                    'upgrade-insecure-requests': null,
                },
            },
            referrerPolicy: { policy: 'no-referrer' },
        })
    );
    // Stashes are private: nothing is cached or indexed. Stashly uses none of these browser features, so they are
    // switched off (copying to the clipboard is not on the list).
    app.use((req, res, next) => {
        res.set({
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
        });
        next();
    });

    // Values read from the database when /metrics is scraped: nothing here is kept between scrapes
    const startedAt = Math.round(Date.now() / 1000 - process.uptime());
    const gauges = () => {
        const totals = model.totals();
        const usage = process.memoryUsage();
        return [
            { name: 'stashly_stashes', help: 'Stashes that exist now.', samples: [{ value: totals.stashes }] },
            {
                name: 'stashly_items',
                help: 'Items in all stashes, by kind.',
                samples: [{ labels: { kind: 'note' }, value: totals.items - totals.files }, { labels: { kind: 'file' }, value: totals.files }],
            },
            { name: 'stashly_stored_bytes', help: 'Bytes of the files in all stashes.', samples: [{ value: totals.bytes }] },
            { name: 'stashly_trashed_items', help: 'Deleted items still waiting out their undo time.', samples: [{ value: model.countTrash() }] },
            { name: 'stashly_users', help: 'User accounts, by role.', samples: ['admin', 'user'].map(role => ({ labels: { role }, value: users.countByRole()[role] })) },
            { name: 'stashly_sse_connections', help: 'Open live-update streams.', samples: [{ value: events.connections() }] },
            { name: 'stashly_build_info', help: 'The running version.', samples: [{ labels: { version }, value: 1 }] },
            { name: 'stashly_process_start_time_seconds', help: 'When the server started (Unix time).', samples: [{ value: startedAt }] },
            { name: 'stashly_process_resident_memory_bytes', help: 'Resident memory of the server process.', samples: [{ value: usage.rss }] },
            { name: 'stashly_process_heap_used_bytes', help: 'JavaScript heap in use.', samples: [{ value: usage.heapUsed }] },
        ];
    };
    // Not the stash limiters (a scraper must not be slowed by visitors), but a small one against token guessing
    const metricsLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 120,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down.' },
    });

    // JSON bodies for the API. Uploads (and plain-text notes) read their own body in the routes.
    // The limit follows the live note-size setting, so it is read on each request.
    app.use('/api', (req, res, next) => {
        // (a thumbnail is raw image bytes too)
        if (/\/files(\/\d+\/thumb)?$/.test(req.path)) return next();
        // ...and so is a piece of a resumable upload, whatever Content-Type it claims
        if (req.method === 'PATCH' && /\/uploads\/[^/]+$/.test(req.path)) return next();
        express.json({ limit: `${Math.ceil((config.maxNoteBytes * 2) / 1024) + 4}kb` })(req, res, next);
    });

    // Who is signed in (req.user), for every request from here on. A cookie that does not check out is ignored.
    app.use(userAuth.load);

    app.get('/metrics', metricsLimiter, (req, res) => {
        // Off unless a token is set: a server that was never asked to publish numbers does not
        if (!config.metricsToken) return res.status(404).json({ error: 'Not found' });
        const match = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
        // Hashes of equal length, compared in constant time (the same way as the admin password)
        const given = crypto.createHash('sha256').update(match ? match[1] : '').digest();
        const expected = crypto.createHash('sha256').update(config.metricsToken).digest();
        if (!match || !crypto.timingSafeEqual(given, expected)) {
            return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'A bearer token is needed.' });
        }
        res.set({ 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' }).send(metrics.render(gauges()));
    });

    app.get('/health', (req, res) => {
        try {
            model.ping();
            res.json({ status: 'ok' });
        } catch {
            res.status(503).json({ status: 'error' });
        }
    });
    app.get('/api/config', controller.appConfig);
    app.use('/api/stashes', createStashRoutes({ controller, config }));
    app.use('/api/admin', createAdminRoutes({ controller: adminController, users: userController, adminAuth, config }));
    app.use('/api', createUserRoutes({ controller: userController, config }));
    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

    // Pages and static files read from disk, so they are rate limited too (per IP, the same budget as other reads)
    app.use(
        rateLimit({
            windowMs: 60 * 1000,
            limit: () => Math.max(config.rateRead, 1) * 2,
            standardHeaders: 'draft-8',
            legacyHeaders: false,
            message: 'Too many requests, slow down.',
        })
    );

    // The QR code library, served from node_modules (the page's CSP only allows scripts from this server)
    app.get('/vendor/qrcode.js', (req, res) => res.sendFile(require.resolve('qrcode-generator')));

    // The stash page is one HTML file; the script reads the name from the URL
    app.get('/s/:slug', (req, res) => res.sendFile(path.join(viewsDir, 'stash.html')));
    // Where the phone's share sheet sends what was shared (the manifest's share target)
    app.get('/share', (req, res) => res.sendFile(path.join(viewsDir, 'share.html')));
    // The share sheet POSTs what was shared, so it never lands in an address that proxies log or browsers keep in
    // their history. It is handed to the page in the fragment (#), which is never sent to a server, and the page
    // clears it from the address as soon as it has read it.
    app.post('/share', (req, res, next) => express.urlencoded({ extended: false, limit: `${Math.ceil((config.maxNoteBytes * 3) / 1024) + 4}kb` })(req, res, next), (req, res) => {
        const body = req.body || {};
        const params = new URLSearchParams();
        for (const key of ['title', 'text', 'url']) if (typeof body[key] === 'string' && body[key]) params.set(key, body[key]);
        const fragment = params.toString();
        res.redirect(303, fragment ? `/share#${fragment}` : '/share');
    });
    app.get('/admin', (req, res) => res.sendFile(path.join(viewsDir, 'admin.html')));
    // Sign in, and the stashes you follow
    app.get('/account', (req, res) => res.sendFile(path.join(viewsDir, 'account.html')));
    // The page's scripts, styles and icons: compressed, and revalidated instead of re-downloaded on every click
    app.use(gzipAssets(viewsDir));
    app.use(express.static(viewsDir, { index: 'index.html', setHeaders: revalidate }));

    // Malformed JSON and oversized bodies come through here as 4xx errors from the body parsers
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const status = err.status || err.statusCode || 500;
        if (status >= 500) {
            // The address is not logged: it can hold a stash name, which is a secret
            console.error(`Unhandled error on ${req.method} ${req.route && typeof req.route.path === 'string' ? req.route.path : 'unmatched'}:`, err);
            return res.status(500).json({ error: 'Internal server error' });
        }
        const message = err.type === 'entity.too.large' ? 'That is too large to send.' : 'Bad request';
        res.status(status).json({ error: message });
    });

    return { app, controller, adminController, userController, userAuth, users, settings, metrics, audit, mailer };
}

module.exports = { createApp };
