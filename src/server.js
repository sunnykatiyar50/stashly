const path = require('path');
const express = require('express');
const helmet = require('helmet');
const StashController = require('./controllers/stashController');
const AdminController = require('./controllers/adminController');
const createStashRoutes = require('./routes/stashRoutes');
const createAdminRoutes = require('./routes/adminRoutes');
const { AdminAuth } = require('./utils/adminAuth');
const { SettingsStore } = require('./utils/settings');

const viewsDir = path.join(__dirname, 'views');

// Builds the Express app. Kept separate from app.js so tests can create it with their own config and database.
function createApp({ config, model, events, secret, now }) {
    const app = express();
    const adminAuth = new AdminAuth({ config, secret, now });
    // Applies any limits the admin saved earlier on top of the environment's values
    const settings = new SettingsStore({ model, config });
    const controller = new StashController({ model, events, config, secret, now, isAdmin: adminAuth.isAdmin });
    const adminController = new AdminController({
        model, events, config, adminAuth, settings, now,
        // A new password clears the wrong-password count the stash controller keeps
        resetFailures: slug => controller.failures.delete(slug),
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

    // JSON bodies for the API. Uploads (and plain-text notes) read their own body in the routes.
    // The limit follows the live note-size setting, so it is read on each request.
    app.use('/api', (req, res, next) => {
        if (/\/files$/.test(req.path)) return next();
        express.json({ limit: `${Math.ceil((config.maxNoteBytes * 2) / 1024) + 4}kb` })(req, res, next);
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
    app.use('/api/admin', createAdminRoutes({ controller: adminController, adminAuth, config }));
    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

    // The QR code library, served from node_modules (the page's CSP only allows scripts from this server)
    app.get('/vendor/qrcode.js', (req, res) => res.sendFile(require.resolve('qrcode-generator')));

    // The stash page is one HTML file; the script reads the name from the URL
    app.get('/s/:slug', (req, res) => res.sendFile(path.join(viewsDir, 'stash.html')));
    // Where the phone's share sheet sends what was shared (the manifest's share target)
    app.get('/share', (req, res) => res.sendFile(path.join(viewsDir, 'share.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(viewsDir, 'admin.html')));
    app.use(express.static(viewsDir, { index: 'index.html' }));

    // Malformed JSON and oversized bodies come through here as 4xx errors from the body parsers
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const status = err.status || err.statusCode || 500;
        if (status >= 500) {
            console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
            return res.status(500).json({ error: 'Internal server error' });
        }
        const message = err.type === 'entity.too.large' ? 'That is too large to send.' : 'Bad request';
        res.status(status).json({ error: message });
    });

    return { app, controller, adminController, settings };
}

module.exports = { createApp };
