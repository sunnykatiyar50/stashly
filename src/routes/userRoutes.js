const express = require('express');
const rateLimit = require('express-rate-limit');

// Sign in, your own account, and the stashes you follow. Mounted at /api. All of it answers 404 when accounts are off.
function createUserRoutes({ controller, config }) {
    const router = express.Router();
    const c = controller;

    // Only wrong passwords count, like the admin sign-in, so typing it right never blocks anyone
    const wrongPasswords = () =>
        rateLimit({
            windowMs: 15 * 60 * 1000,
            limit: () => config.rateUserLogin,
            standardHeaders: 'draft-8',
            legacyHeaders: false,
            skipSuccessfulRequests: true,
            message: { error: 'Too many wrong passwords. Try again in a few minutes.' },
        });
    const loginLimiter = wrongPasswords();
    const passwordLimiter = wrongPasswords();
    // Following a stash checks its password, so it is limited like unlocking one (wrong ones only, per address)...
    const followLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: config.rateUnlock,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { error: 'Too many wrong passwords. Try again in a few minutes.' },
    });
    // ...and, like every route that names a stash, only requests for a stash that does not exist count here, with the
    // tighter limit, so names cannot be guessed quickly through the follow form
    const missLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: config.rateNotFound,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        requestWasSuccessful: (req, res) => res.statusCode !== 404,
        skipSuccessfulRequests: true,
        message: { error: 'Too many stashes that do not exist. Slow down.' },
    });

    router.post('/auth/login', c.enabledOnly, loginLimiter, c.login);
    router.post('/auth/logout', c.enabledOnly, c.logout);
    router.get('/me', c.me);
    router.post('/me/password', c.requireUser, passwordLimiter, c.changePassword);
    router.get('/me/stashes', c.requireUser, c.listStashes);
    router.post('/me/stashes', c.requireUser, followLimiter, missLimiter, c.follow);
    router.delete('/me/stashes/:slug', c.requireUser, c.unfollow);
    router.post('/me/stashes/:slug/seen', c.requireUser, c.seen);

    return router;
}

module.exports = createUserRoutes;
