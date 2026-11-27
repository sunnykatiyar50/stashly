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
    // Reset by email. Every request counts (the answer is always the same), so nobody can mail-bomb an address
    const resetLimiter = limit => rateLimit({
        windowMs: 15 * 60 * 1000,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many attempts. Try again in a few minutes.' },
    });
    router.post('/auth/forgot', c.enabledOnly, resetLimiter(5), c.forgot);
    router.post('/auth/reset', c.enabledOnly, resetLimiter(10), c.reset);
    router.get('/me', c.me);
    router.patch('/me', c.requireUser, passwordLimiter, c.updateProfile);
    router.post('/me/password',c.requireUser, passwordLimiter, c.changePassword);
    router.put('/me/email', c.requireUser, passwordLimiter, c.setEmail);
    router.get('/me/clipboard', c.requireUser, c.clipboardStash);
    router.post('/me/clipboard', c.requireUser, followLimiter, c.makeClipboardStash);
    router.post('/me/clipboard/notes', c.requireUser, c.saveClipboardNote);
    router.get('/me/stashes', c.requireUser, c.listStashes);
    router.post('/me/stashes', c.requireUser, followLimiter, missLimiter, c.follow);
    router.delete('/me/stashes/:slug', c.requireUser, c.unfollow);
    router.post('/me/stashes/:slug/seen', c.requireUser, c.seen);
    router.put('/me/stashes/:slug/pin', c.requireUser, c.pin);
    router.delete('/me/stashes/:slug/pin', c.requireUser, c.unpin);

    return router;
}

module.exports = createUserRoutes;
