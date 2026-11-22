// Admin: sign in, see every stash, delete or extend one, set a stash's password, change the limits.
// No note text or file content is exposed here, and the admin session does not unlock a password-protected stash.
// Setting a new password is the one way in: it signs everyone out of that stash, but whoever knows the new password
// (the admin included) can open it. That is what makes it a reset for a forgotten password.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { hashPassword, MAX_PASSWORD } = require('../utils/password');
const { ZipWriter, STORE, DEFLATE } = require('../utils/zipWriter');
const { noopAudit } = require('../utils/auditLog');
const { noopMetrics } = require('../utils/metrics');

// Windows can briefly hold a file that was just closed, so a few tries
const removeTemp = temp => fs.promises.rm(temp, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});

class AdminController {
    // audit and metrics: see StashController (they do nothing unless the app passes real ones)
    constructor({ model, events, config, adminAuth, settings, users = null, now = () => new Date(), resetFailures = () => {}, audit = noopAudit, metrics = noopMetrics }) {
        this.users = users;
        this.audit = audit;
        this.metrics = metrics;
        this.resetFailures = resetFailures;
        this.model = model;
        this.events = events;
        this.config = config;
        this.adminAuth = adminAuth;
        this.settings = settings;
        this.now = now;
    }

    status = (req, res) => {
        const signedIn = this.adminAuth.isAdmin(req);
        // via: how the admin is signed in (the page signs out of the account too when that is what it is)
        res.json({ enabled: this.adminAuth.enabled, signedIn, ...(signedIn ? { via: this.adminAuth.isRoot(req) ? 'password' : 'account' } : {}) });
    };

    login = (req, res) => {
        if (!this.adminAuth.enabled) return res.status(404).json({ error: 'Admin is not enabled on this server.' });
        const password = req.body && req.body.password;
        if (!this.adminAuth.checkPassword(password)) {
            this.metrics.inc('stashly_admin_logins_total', ['failure']);
            this.audit('admin.login_failed', { req, actor: 'visitor' });
            return res.status(401).json({ error: 'That password is not right.' });
        }
        this.adminAuth.startSession(req, res);
        this.metrics.inc('stashly_admin_logins_total', ['success']);
        this.audit('admin.login_succeeded', { req, actor: 'admin' });
        res.json({ ok: true });
    };

    logout = (req, res) => {
        if (this.adminAuth.isAdmin(req)) this.audit('admin.logout', { req, actor: 'admin' });
        this.adminAuth.endSession(res);
        res.json({ ok: true });
    };

    presentStash(row) {
        return {
            slug: row.slug,
            hasPassword: Boolean(row.has_password),
            items: row.items,
            files: row.files,
            bytes: row.bytes,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            canExtend: Boolean(row.ttl_ms),
        };
    }

    overview = (req, res) => {
        const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 64) : '';
        res.json({
            totals: this.model.totals(),
            maxTotalBytes: this.config.maxTotalBytes,
            maxStashes: this.config.maxStashes,
            userCount: this.users ? this.users.count() : 0,
            stashes: this.model.listStashes({ search }).map(row => this.presentStash(row)),
        });
    };

    findStash(req, res) {
        const stash = this.model.findBySlug(String(req.params.slug || '').toLowerCase());
        if (!stash) res.status(404).json({ error: 'That stash does not exist (it may have expired).' });
        return stash;
    }

    deleteStash = (req, res) => {
        const stash = this.findStash(req, res);
        if (!stash) return;
        this.model.deleteStash(stash.id, this.now());
        this.audit('stash.deleted', { req, stash, actor: 'admin', detail: { reason: 'admin' } });
        this.events.closeAll(stash.slug, 'stash-gone', { reason: 'deleted' });
        res.json({ ok: true });
    };

    extendStash = (req, res) => {
        const stash = this.findStash(req, res);
        if (!stash) return;
        const extended = this.model.extend(stash.id, this.now());
        if (!extended) return res.status(400).json({ error: 'This stash never expires, so there is nothing to extend.' });
        this.events.publish(stash.slug, 'stash-extended', { expiresAt: extended.expires_at });
        res.json({ expiresAt: extended.expires_at });
    };

    // Sets (or replaces) a stash's password. Everyone signed in to it is signed out, its read-only and drop-box links
    // are cancelled, and any wrong-password lockout is cleared.
    setPassword = async (req, res) => {
        const stash = this.findStash(req, res);
        if (!stash) return;
        const password = req.body && req.body.password;
        const min = this.config.minPasswordLength;
        if (typeof password !== 'string' || password.length < min || password.length > MAX_PASSWORD) {
            return res.status(400).json({ error: `The password must be ${min} to ${MAX_PASSWORD} characters.`, field: 'password' });
        }
        const hashed = await hashPassword(password);
        this.model.setPassword(stash.id, hashed.hash, hashed.salt);
        this.resetFailures(stash.slug);
        this.audit('stash.password_reset_by_admin', { req, stash, actor: 'admin' });
        // Open pages hold cookies for the old password: end their streams so they are asked again
        this.events.closeAll(stash.slug, 'access-changed', {});
        res.json({ ok: true, hasPassword: true });
    };

    getSettings = (req, res) => {
        res.json({ fields: this.settings.describe() });
    };

    // The audit line names the settings that changed. Every setting is a limit or a switch (none is a secret), so
    // the new values are fine to record too.
    auditSettings(req, before) {
        const after = this.settings.values();
        const keys = Object.keys(after).filter(key => after[key] !== before[key]);
        if (!keys.length) return;
        const values = {};
        for (const key of keys) values[key] = after[key];
        this.audit('admin.settings_changed', { req, actor: 'admin', detail: { keys, values } });
    }

    putSettings = (req, res) => {
        const before = this.settings.values();
        const result = this.settings.update(req.body && req.body.values);
        if (result.errors) return res.status(400).json({ error: 'Some settings need fixing.', errors: result.errors });
        this.auditSettings(req, before);
        res.json({ fields: this.settings.describe() });
    };

    resetSettings = (req, res) => {
        const before = this.settings.values();
        this.settings.reset();
        this.auditSettings(req, before);
        res.json({ fields: this.settings.describe() });
    };

    // A backup as one zip: stashly.sqlite and files/<id> for every stored file (plus files/<id>.thumb for thumbnails). Unzip both into the data folder to restore.
    //
    // The database is copied with VACUUM INTO, which makes a complete, consistent snapshot even while the server is
    // busy (copying the live file, or its write-ahead log, could catch it half way through a change). The snapshot
    // goes to a private temp file that is deleted whatever happens. The files are then streamed straight from disk.
    // Note that this holds everything, including the session secret and the password hashes: keep it private.
    backup = async (req, res) => {
        const files = this.model.files;
        files.ensure();
        const temp = path.join(files.tmpDir, `backup-${crypto.randomBytes(12).toString('hex')}.sqlite`);
        try {
            // VACUUM INTO needs a missing or empty file; making it first, private to this user, keeps the snapshot
            // from ever existing with looser permissions
            fs.closeSync(fs.openSync(temp, 'wx', 0o600));
            this.model.db.prepare('VACUUM INTO ?').run(temp);

            const now = this.now();
            res.set({
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="stashly-backup-${now.toISOString().slice(0, 10)}.zip"`,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'private, no-store',
            });
            const zip = new ZipWriter(res, { now });
            await zip.addStream('stashly.sqlite', fs.createReadStream(temp), { method: DEFLATE });
            // Done with it: remove it now, not after the files have gone out (the finally below covers the failures)
            await removeTemp(temp);
            // Every file, and every thumbnail (`<id>.thumb`): a restored backup then has its thumbnails too, and the
            // startup sweep keeps them because the database says which items have one
            for (const name of files.storedNames()) {
                const source = files.streamName(name);
                try {
                    await once(source, 'open', { signal: zip.signal });
                } catch (err) {
                    source.destroy();
                    if (zip.signal.aborted) throw err;
                    continue; // deleted since the listing, or not a plain file
                }
                // Uploads are mostly compressed already; storing them avoids burning CPU for nothing
                await zip.addStream(`files/${name}`, source, { method: STORE });
            }
            await zip.finish();
            this.audit('admin.backup_downloaded', { req, actor: 'admin' });
        } catch (err) {
            // Removed before answering, so by the time the admin sees the error nothing is left on disk
            await removeTemp(temp);
            if (!res.headersSent) {
                if (!res.destroyed) res.status(500).json({ error: 'The backup could not be made.' });
                console.error('Backup failed:', err);
            } else {
                res.destroy();
            }
        } finally {
            // Always removed, also after an error or a client that left part way
            await removeTemp(temp);
        }
    };
}

module.exports = AdminController;
