const express = require('express');
const rateLimit = require('express-rate-limit');

function limiter(windowMs, limit, message) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: message },
    });
}

function createStashRoutes({ controller, config }) {
    const router = express.Router();
    const c = controller;
    const access = [c.loadStash, c.requireAccess];

    const createLimiter = limiter(60 * 1000, config.rateCreate, 'Too many stashes created, slow down.');
    const postLimiter = limiter(60 * 1000, config.ratePost, 'Too many notes, slow down.');
    const uploadLimiter = limiter(60 * 1000, config.rateUpload, 'Too many uploads, slow down.');
    // Only failed attempts count, so a person who types the right password is never blocked
    const unlockLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: config.rateUnlock,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { error: 'Too many wrong passwords. Try again in a few minutes.' },
    });

    // Refuse an oversized upload from its Content-Length before reading any of the body
    const checkUploadSize = (req, res, next) => {
        const length = Number(req.headers['content-length']);
        if (Number.isFinite(length) && length > config.maxFileBytes) {
            return res.status(413).json({ error: `A file can be at most ${Math.round(config.maxFileBytes / 1048576)} MB.` });
        }
        next();
    };
    // Built per request so the limits follow what the admin sets at runtime
    const rawBody = (req, res, next) => express.raw({ type: () => true, limit: config.maxFileBytes })(req, res, next);
    const textBody = (req, res, next) => express.text({ type: 'text/plain', limit: config.maxNoteBytes })(req, res, next);

    router.get('/suggest', c.suggest);
    router.post('/', createLimiter, c.create);

    router.get('/:slug', ...access, c.get);
    router.post('/:slug/unlock', unlockLimiter, c.loadStash, c.unlock);
    router.get('/:slug/events', ...access, c.stream);
    router.get('/:slug/latest', ...access, c.latest);
    router.post('/:slug/notes', postLimiter, ...access, textBody, c.addNote);
    router.post('/:slug/files', uploadLimiter, ...access, checkUploadSize, rawBody, c.addFile);
    router.get('/:slug/files/:id', ...access, c.getFile);
    router.delete('/:slug/items/:id', ...access, c.deleteItem);
    router.post('/:slug/extend', ...access, c.extend);
    router.delete('/:slug', ...access, c.remove);

    return router;
}

module.exports = createStashRoutes;
