// Admin: sign in, see every stash, delete or extend one, change the limits.
// The admin can manage stashes but never reads them: no note text or file content is exposed here, and the
// admin session does not unlock a password-protected stash.
class AdminController {
    constructor({ model, events, config, adminAuth, settings, now = () => new Date() }) {
        this.model = model;
        this.events = events;
        this.config = config;
        this.adminAuth = adminAuth;
        this.settings = settings;
        this.now = now;
    }

    status = (req, res) => {
        res.json({ enabled: this.adminAuth.enabled, signedIn: this.adminAuth.isAdmin(req) });
    };

    login = (req, res) => {
        if (!this.adminAuth.enabled) return res.status(404).json({ error: 'Admin is not enabled on this server.' });
        const password = req.body && req.body.password;
        if (!this.adminAuth.checkPassword(password)) return res.status(401).json({ error: 'That password is not right.' });
        this.adminAuth.startSession(req, res);
        res.json({ ok: true });
    };

    logout = (req, res) => {
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
        this.model.deleteStash(stash.id);
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

    getSettings = (req, res) => {
        res.json({ fields: this.settings.describe() });
    };

    putSettings = (req, res) => {
        const result = this.settings.update(req.body && req.body.values);
        if (result.errors) return res.status(400).json({ error: 'Some settings need fixing.', errors: result.errors });
        res.json({ fields: this.settings.describe() });
    };

    resetSettings = (req, res) => {
        this.settings.reset();
        res.json({ fields: this.settings.describe() });
    };
}

module.exports = AdminController;
