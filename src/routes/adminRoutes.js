const express = require('express');
const rateLimit = require('express-rate-limit');

function createAdminRoutes({ controller, adminAuth, config }) {
    const router = express.Router();
    const c = controller;
    const admin = adminAuth.require;

    // Only wrong passwords count, so the admin is never locked out by typing it right
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: config.rateAdminLogin,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { error: 'Too many wrong passwords. Try again in a few minutes.' },
    });

    router.get('/status', c.status);
    router.post('/login', loginLimiter, c.login);
    router.post('/logout', c.logout);

    router.get('/overview', admin, c.overview);
    router.delete('/stashes/:slug', admin, c.deleteStash);
    router.post('/stashes/:slug/extend', admin, c.extendStash);
    router.put('/stashes/:slug/password', admin, c.setPassword);
    router.get('/settings', admin, c.getSettings);
    router.put('/settings', admin, c.putSettings);
    router.post('/settings/reset', admin, c.resetSettings);

    return router;
}

module.exports = createAdminRoutes;
