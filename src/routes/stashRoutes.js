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
    // Who may use each route: full access (no password, or unlocked), a read-only share link, or a drop-box link
    const full = [c.loadStash, c.allow('full')];
    const read = [c.loadStash, c.allow('full', 'view')];
    const write = [c.loadStash, c.allow('full', 'drop')];
    const anyRole = [c.loadStash, c.allow('full', 'view', 'drop')];

    // The limits that can be changed in Admin > Settings are read on each request (a function), so a change applies at once
    const createLimiter = limiter(60 * 1000, () => config.rateCreate, 'Too many stashes created, slow down.');
    const postLimiter = limiter(60 * 1000, () => config.ratePost, 'Too many notes, slow down.');
    const uploadLimiter = limiter(60 * 1000, () => config.rateUpload, 'Too many uploads, slow down.');
    // The pieces of a resumable upload: one file is many requests, so this allows far more than uploadLimiter
    const chunkLimiter = limiter(60 * 1000, config.rateChunk, 'Too many pieces, slow down.');
    // Only failed attempts count, so a person who types the right password is never blocked
    const unlockLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: config.rateUnlock,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { error: 'Too many wrong passwords. Try again in a few minutes.' },
    });

    // Reading is limited per IP. Separately, only requests for a stash that does not exist count (every other
    // response is skipped), with a tighter limit, so names cannot be guessed at speed.
    const readLimiter = limiter(60 * 1000, () => config.rateRead, 'Too many requests, slow down.');
    const missLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: config.rateNotFound,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        requestWasSuccessful: (req, res) => res.statusCode !== 404,
        skipSuccessfulRequests: true,
        message: { error: 'Too many stashes that do not exist. Slow down.' },
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
    const textBody = (req, res, next) => express.text({ type: 'text/plain', limit: config.maxNoteBytes })(req, res, next);

    // A thumbnail is raw image bytes whatever Content-Type is claimed; anything over the limit is refused with a 413
    const thumbBody = (req, res, next) => express.raw({ type: () => true, limit: config.maxThumbBytes })(req, res, next);

    router.get('/suggest', readLimiter, c.suggest);
    router.post('/', createLimiter, c.create);

    // Every route below names a stash: count the ones that turn out not to exist
    router.use('/:slug', missLimiter);

    // Does this stash exist? Lets the home page decide between opening a name and offering to create it, without
    // loading the stash. Says nothing a locked stash's own 401 does not already say, and a miss counts towards missLimiter.
    router.get('/:slug/exists', readLimiter, c.exists);
    router.get('/:slug', readLimiter, ...anyRole, c.get);
    // The same listing with the search and dates in the body, so search words stay out of addresses and proxy logs
    router.post('/:slug/query', readLimiter, ...anyRole, c.get);
    router.post('/:slug/unlock', unlockLimiter, c.loadStash, c.unlock);
    router.post('/:slug/redeem', unlockLimiter, c.loadStash, c.redeem);
    // Always allowed: signing out must work even when the session has already ended
    router.post('/:slug/logout', c.loadStash, c.logout);
    router.post('/:slug/session', ...anyRole, c.setSession);
    // The whole stash as a zip (not for drop-box links, which cannot read)
    router.get('/:slug/export', readLimiter, ...read, c.exportZip);
    router.get('/:slug/events', readLimiter, ...read, c.stream);
    // GET never changes anything. POST also reads a burn-after-reading note, which deletes it.
    router.get('/:slug/latest', readLimiter, ...read, c.latest);
    router.post('/:slug/latest', readLimiter, ...read, c.latest);
    router.post('/:slug/notes', postLimiter, ...write, c.acceptsNotes, textBody, c.addNote);
    router.post('/:slug/files', uploadLimiter, ...write, c.acceptsFiles, checkUploadSize, c.receiveFile, c.addFile);
    // Resumable uploads: start (every check that needs no bytes), ask where it stands (GET, and HEAD for the offset
    // alone), send a piece at the offset the server expects, finish, or cancel. See the README.
    router.post('/:slug/uploads', uploadLimiter, ...write, c.acceptsFiles, c.createUpload);
    router.get('/:slug/uploads/:id', readLimiter, ...write, c.uploadOf, c.getUpload);
    router.patch('/:slug/uploads/:id', chunkLimiter, ...write, c.acceptsFiles, c.uploadOf, c.checkChunkSize, c.patchUpload);
    router.post('/:slug/uploads/:id/complete', postLimiter, ...write, c.acceptsFiles, c.uploadOf, c.completeUpload);
    router.delete('/:slug/uploads/:id', postLimiter, ...write, c.uploadOf, c.abortUpload);
    router.get('/:slug/items/:id', readLimiter, ...read, c.getItem);
    router.get('/:slug/files/:id', readLimiter, ...read, c.getFile);
    router.get('/:slug/files/:id/contents', readLimiter, ...read, c.listArchive);
    // An image's thumbnail, made by the page. A drop-box link may attach one to what it just uploaded (see
    // thumbTarget); the body is raw image bytes, read only after those checks, with its own small size limit.
    router.get('/:slug/files/:id/thumb', readLimiter, ...read, c.getThumb);
    router.put('/:slug/files/:id/thumb', postLimiter, ...write, c.thumbTarget, thumbBody, c.putThumb);
    // Revealing deletes the note, so it is not something a read-only link may do
    // Many clips at once: delete, undo that delete, pin or unpin (the select mode of the clip list)
    router.post('/:slug/items/bulk', postLimiter, ...full, c.bulkItems);
    router.post('/:slug/items/:id/reveal', ...full, c.reveal);
    router.delete('/:slug/items/:id', ...full, c.deleteItem);
    // Undoing a delete puts an item back (it counts against the same limits as adding one)
    router.post('/:slug/items/:id/restore', postLimiter, ...full, c.restore);
    router.put('/:slug/items/:id', ...full, c.editNote);
    router.post('/:slug/items/:id/pin', ...full, c.setPinned);
    // Dragging clips into a new order; a read-only or drop-box link cannot rearrange
    router.post('/:slug/reorder', ...full, c.reorder);
    router.put('/:slug/keep-last', ...full, c.setKeepLast);
    router.put('/:slug/content', ...full, c.setContent);
    router.post('/:slug/extend', ...full, c.extend);
    // The wrong-password limit applies here too: a stranger at an unlocked browser cannot guess the current password
    router.post('/:slug/password', unlockLimiter, ...full, c.changePassword);
    router.post('/:slug/rename', postLimiter, ...full, c.rename);
    router.post('/:slug/sign-out-others', ...full, c.signOutOthers);
    router.post('/:slug/share-links', ...full, c.createShareLink);
    router.delete('/:slug/share-links/:kind', ...full, c.revokeShareLink);
    router.delete('/:slug', ...full, c.remove);

    return router;
}

module.exports = createStashRoutes;
