const express = require('express');
const rateLimit = require('express-rate-limit');

// The public side of a link to one clip: /api/clips/<token>. There is no stash, password or cookie here: the token is
// the whole of the access, and it opens one clip and nothing else (see the clip-share methods of the controller).
function createClipRoutes({ controller, config }) {
    const router = express.Router();
    const c = controller;

    // Reads are limited per address. Separately, only links that do not work count (every other answer is skipped), with
    // a tighter limit, so tokens cannot be tried at speed (they are 192 random bits, so this is belt and braces).
    const readLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: () => config.rateRead,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down.' },
    });
    const missLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: () => config.rateNotFound,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        requestWasSuccessful: (req, res) => res.statusCode !== 404,
        skipSuccessfulRequests: true,
        message: { error: 'Too many links that do not work. Slow down.' },
    });

    router.get('/:token', readLimiter, missLimiter, c.viewClip);
    router.get('/:token/file', readLimiter, missLimiter, c.clipFile);
    return router;
}

module.exports = { createClipRoutes };
