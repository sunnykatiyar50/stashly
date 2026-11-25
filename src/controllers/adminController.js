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
const { validAddress } = require('../utils/mailer');
const { generateLinkToken, hashLinkToken } = require('../utils/token');
const { normalizeUsername } = require('../models/userModel');
const templates = require('../utils/emailTemplates');

// Windows can briefly hold a file that was just closed, so a few tries
const removeTemp = temp => fs.promises.rm(temp, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});

class AdminController {
    // audit and metrics: see StashController (they do nothing unless the app passes real ones)
    constructor({ model, events, config, adminAuth, settings, users = null, mailer = null, now = () => new Date(), resetFailures = () => {}, audit = noopAudit, metrics = noopMetrics }) {
        this.users = users;
        this.mailer = mailer;
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
            // The user who made it (null: a guest did). An admin cannot reset the password of a stash that has an owner.
            owner: row.owner || null,
            canResetPassword: this.config.adminCanResetStashPasswords && !row.owner_id,
            // An admin can give a guest's stash to a user. On a password-protected one that also lets that user in without the
            // password, which is the same power as resetting its password, so it is switched off together with it.
            canSetOwner: Boolean(this.users) && !row.owner_id && (!row.has_password || this.config.adminCanResetStashPasswords),
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

    // Gives a stash that has no owner (a guest made it, or its owner's account was deleted) to a user. The people already using it
    // keep what they have; the user becomes its owner, with all that means (always in their list, opens with no password, may
    // change the password and transfer it on). A stash that already has an owner can only be passed on by that owner.
    setOwner = (req, res) => {
        const stash = this.findStash(req, res);
        if (!stash) return;
        if (!this.users) return res.status(404).json({ error: 'Accounts are not enabled on this server.' });
        if (stash.owner_id) {
            return res.status(409).json({ error: 'This stash already has an owner. Only its owner can pass it on.' });
        }
        if (stash.password_hash && !this.config.adminCanResetStashPasswords) {
            return res.status(403).json({ error: 'Choosing an owner for a password-protected stash lets that user in without the password, so it is switched off together with resetting stash passwords on this server.' });
        }
        const user = this.users.findByUsername(normalizeUsername(req.body && req.body.username));
        if (!user || user.disabled) return res.status(404).json({ error: 'No active user has that username.', field: 'username' });
        if (!this.users.setStashOwner(stash, user.id, null, this.now())) return res.status(404).json({ error: 'That stash does not exist (it may have expired).' });
        this.audit('stash.owner_set_by_admin', { req, stash, actor: 'admin', detail: { user: user.id } });
        res.json({ ok: true, owner: user.username });
    };

    // Sets (or replaces) a stash's password. Everyone signed in to it is signed out, its read-only and drop-box links
    // are cancelled, and any wrong-password lockout is cleared.
    setPassword = async (req, res) => {
        const stash = this.findStash(req, res);
        if (!stash) return;
        if (!this.config.adminCanResetStashPasswords) {
            return res.status(403).json({ error: 'Resetting stash passwords is switched off on this server.' });
        }
        // A stash made by a signed-in user belongs to them: the admin cannot take it over by choosing its password
        // (the owner can change it, and the admin can still delete the stash)
        if (stash.owner_id) {
            return res.status(409).json({ error: 'This stash has an owner, so an admin cannot reset its password. The owner can change it, or you can delete the stash.' });
        }
        const password = req.body && req.body.password;
        const min = this.config.minPasswordLength;
        if (typeof password !== 'string' || password.length < min || password.length > MAX_PASSWORD) {
            return res.status(400).json({ error: `The password must be ${min} to ${MAX_PASSWORD} characters.`, field: 'password' });
        }
        const hashed = await hashPassword(password);
        // The time is kept, so the people using the stash can see that an admin chose its password
        this.model.setPassword(stash.id, hashed.hash, hashed.salt, this.now().toISOString());
        this.resetFailures(stash.slug);
        this.audit('stash.password_reset_by_admin', { req, stash, actor: 'admin' });
        // Open pages hold cookies for the old password: end their streams so they are asked again
        this.events.closeAll(stash.slug, 'access-changed', {});
        res.json({ ok: true, hasPassword: true });
    };

    // Sends one test message with the settings as they are saved, so the admin can see that the mail server works.
    // Failures say what went wrong (the mail server's own words included): this is the admin, who needs them.
    testEmail = async (req, res) => {
        const to = req.body && typeof req.body.to === 'string' ? req.body.to.trim() : '';
        if (!validAddress(to)) return res.status(400).json({ error: 'Enter a valid email address to send the test to.', field: 'to' });
        if (!this.mailer || !this.mailer.enabled) {
            return res.status(409).json({ error: 'Email is not ready. Turn on "Send emails", fill in the mail server and the From address, and save.' });
        }
        try {
            await this.mailer.send({ to, ...templates.testEmail({ serverName: this.config.smtpFromName || 'Stashly', url: this.mailer.publicUrl }) });
            this.audit('email.test_sent', { req, actor: 'admin' });
            res.json({ ok: true });
        } catch (err) {
            this.audit('email.send_failed', { req, actor: 'admin', detail: { kind: 'test', reason: err.code || 'failed' } });
            res.status(err.code === 'rate' ? 429 : 502).json({ error: err.message, reason: err.code || 'failed', detail: err.detail || '' });
        }
    };

    // ---- the MCP endpoint's access token ----
    // The endpoint (POST /mcp) is mounted at startup when the setting is on; `running` is what this run started with, so the
    // page can say that a restart is still needed. The token is shown once, when it is made: only its hash is kept.
    mcpState() {
        const token = this.model.getMcpToken();
        return {
            enabled: Boolean(this.config.mcpEnabled),
            running: Boolean(this.config.mcpRunning),
            tokenSet: Boolean(token),
            tokenCreatedAt: token ? token.createdAt : null,
            path: '/mcp',
        };
    }

    getMcp = (req, res) => res.json(this.mcpState());

    createMcpToken = (req, res) => {
        const token = `stm_${generateLinkToken()}`;
        this.model.setMcpToken(hashLinkToken(token), this.now());
        this.audit('admin.mcp_token_created', { req, actor: 'admin' });
        res.status(201).json({ ...this.mcpState(), token });
    };

    revokeMcpToken = (req, res) => {
        if (this.model.clearMcpToken()) this.audit('admin.mcp_token_revoked', { req, actor: 'admin' });
        res.json(this.mcpState());
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
        // A secret (the SMTP password) is named as changed, but its value is never written to the log
        const values = {};
        for (const key of keys) if (!this.settings.isSecret(key)) values[key] = after[key];
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
