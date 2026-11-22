const express = require('express');
const rateLimit = require('express-rate-limit');

function createAdminRoutes({ controller, users, adminAuth, config }) {
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

    // A backup copies the whole database, so it is limited to a few a while per address
    const backupLimiter = rateLimit({
        windowMs: 10 * 60 * 1000,
        limit: 5,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many backups. Try again in a few minutes.' },
    });

    // Managing users: scrypt runs on create and reset, so these are limited per address too
    const userLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 120,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down.' },
    });

    router.get('/status', c.status);
    router.post('/login', loginLimiter, c.login);
    router.post('/logout', c.logout);

    router.get('/overview', admin, c.overview);
    router.delete('/stashes/:slug', admin, c.deleteStash);
    router.post('/stashes/:slug/extend', admin, c.extendStash);
    router.put('/stashes/:slug/password', admin, c.setPassword);
    router.get('/backup', admin, backupLimiter, c.backup);
    router.get('/settings', admin, c.getSettings);
    router.put('/settings', admin, c.putSettings);
    router.post('/settings/reset', admin, c.resetSettings);

    router.get('/users', admin, userLimiter, users.list);
    router.post('/users', admin, userLimiter, users.create);
    router.patch('/users/:id', admin, userLimiter, users.update);
    router.post('/users/:id/password', admin, userLimiter, users.resetPassword);
    router.post('/users/:id/sign-out', admin, userLimiter, users.signOut);
    router.delete('/users/:id', admin, userLimiter, users.remove);

    return router;
}

module.exports = createAdminRoutes;
