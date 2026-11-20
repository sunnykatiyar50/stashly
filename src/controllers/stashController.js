const { generateSlug, parseSlug } = require('../utils/slug');
const { hashPassword, verifyPassword, MIN_PASSWORD, MAX_PASSWORD } = require('../utils/password');
const { signToken, verifyToken, parseCookies } = require('../utils/token');
const { detectFile, cleanFileName } = require('../utils/fileType');
const { dateRange } = require('../utils/time');

const cookieName = slug => `stashly_${slug}`;
const MAX_COOKIE_MS = 12 * 60 * 60 * 1000;

class StashController {
    constructor({ model, events, config, secret, now = () => new Date(), isAdmin = () => false }) {
        this.isAdmin = isAdmin;
        this.model = model;
        this.events = events;
        this.config = config;
        this.secret = secret;
        this.now = now;
    }

    // ---- presentation ----

    presentItem(slug, row) {
        const isFile = row.kind === 'file';
        return {
            id: row.id,
            kind: row.kind,
            text: isFile ? null : row.text,
            fileName: isFile ? row.file_name : null,
            fileType: isFile ? row.file_type : null,
            fileSize: isFile ? row.file_size : null,
            isImage: isFile && row.file_type.startsWith('image/'),
            url: isFile ? `/api/stashes/${slug}/files/${row.id}` : null,
            createdAt: row.created_at,
        };
    }

    limits() {
        const c = this.config;
        return {
            maxNoteBytes: c.maxNoteBytes,
            maxFileBytes: c.maxFileBytes,
            maxStashBytes: c.maxStashBytes,
            maxItemsPerStash: c.maxItemsPerStash,
            maxFilesPerStash: c.maxFilesPerStash,
        };
    }

    // ---- middleware ----

    // Finds the stash named in the URL. A stash whose time is up is deleted on the spot.
    loadStash = (req, res, next) => {
        const stash = this.model.findBySlug(String(req.params.slug || '').toLowerCase());
        if (stash && stash.expires_at && stash.expires_at <= this.now().toISOString()) {
            this.model.deleteStash(stash.id);
            this.events.closeAll(stash.slug, 'stash-gone', { reason: 'expired' });
            return res.status(404).json({ error: 'This stash has expired or does not exist.' });
        }
        if (!stash) return res.status(404).json({ error: 'This stash has expired or does not exist.' });
        req.stash = stash;
        next();
    };

    // A password-protected stash needs the cookie that /unlock sets
    requireAccess = (req, res, next) => {
        const stash = req.stash;
        if (stash.password_hash) {
            const token = parseCookies(req.headers.cookie)[cookieName(stash.slug)];
            if (!verifyToken(this.secret, stash.slug, stash.password_salt, token, this.now().getTime())) {
                return res.status(401).json({ error: 'This stash is locked. Enter the password.', locked: true });
            }
        }
        next();
    };

    // ---- handlers ----

    appConfig = (req, res) => {
        res.json({
            ttlOptions: this.config.ttlOptions.map(({ key, label }) => ({ key, label })),
            defaultTtl: this.config.defaultTtl,
            limits: this.limits(),
            allowNoExpiry: this.config.allowNoExpiry,
            // false when only the admin may create stashes and the visitor is not signed in as admin
            canCreate: this.canCreate(req),
            adminEnabled: Boolean(this.config.adminPassword),
        });
    };

    canCreate(req) {
        return !this.config.requireAdminToCreate || this.isAdmin(req);
    }

    suggest = (req, res) => {
        let slug = generateSlug();
        for (let i = 0; i < 5 && this.model.findBySlug(slug); i++) slug = generateSlug();
        res.json({ slug });
    };

    create = async (req, res) => {
        if (!this.canCreate(req)) {
            return res.status(403).json({ error: 'Only the admin can create stashes on this server. Sign in at /admin first.' });
        }
        const body = req.body || {};
        const parsed = parseSlug(body.slug);
        if (parsed.error) return res.status(400).json({ error: parsed.error, field: 'slug' });

        const ttlKey = body.ttl || this.config.defaultTtl;
        const ttl = this.config.ttlOptions.find(option => option.key === ttlKey);
        if (!ttl) return res.status(400).json({ error: 'Pick one of the listed expiry times.', field: 'ttl' });

        let password = null;
        if (body.password !== undefined && body.password !== null && body.password !== '') {
            if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD || body.password.length > MAX_PASSWORD) {
                return res
                    .status(400)
                    .json({ error: 'That password is too short or too long.', field: 'password' });
            }
            password = body.password;
        }

        if (this.model.countStashes() >= this.config.maxStashes) {
            return res.status(503).json({ error: 'This server has reached its limit of stashes. Try again later.' });
        }

        const hashed = password ? await hashPassword(password) : { hash: null, salt: null };
        try {
            const stash = this.model.createStash({
                slug: parsed.slug,
                passwordHash: hashed.hash,
                passwordSalt: hashed.salt,
                ttlMs: ttl.ms,
                now: this.now(),
            });
            // The creator is let in without retyping the password
            if (stash.password_hash) this.setAccessCookie(req, res, stash);
            res.status(201).json({
                slug: stash.slug,
                url: `/s/${stash.slug}`,
                createdAt: stash.created_at,
                expiresAt: stash.expires_at,
                hasPassword: Boolean(stash.password_hash),
            });
        } catch (err) {
            if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message, field: 'slug' });
            throw err;
        }
    };

    setAccessCookie(req, res, stash) {
        const now = this.now().getTime();
        const stashEnd = stash.expires_at ? new Date(stash.expires_at).getTime() : Infinity;
        const expiresAt = Math.min(now + MAX_COOKIE_MS, stashEnd);
        res.cookie(cookieName(stash.slug), signToken(this.secret, stash.slug, stash.password_salt, expiresAt), {
            httpOnly: true,
            sameSite: 'strict',
            secure: req.secure,
            path: '/',
            maxAge: Math.max(0, expiresAt - now),
        });
    }

    unlock = async (req, res) => {
        const stash = req.stash;
        if (!stash.password_hash) return res.json({ ok: true, hasPassword: false });
        const password = req.body && req.body.password;
        if (!(await verifyPassword(password, stash.password_hash, stash.password_salt))) {
            return res.status(401).json({ error: 'That password is not right.', locked: true });
        }
        this.setAccessCookie(req, res, stash);
        res.json({ ok: true });
    };

    get = (req, res) => {
        const stash = req.stash;
        const range = dateRange(req.query);
        if (range.error) return res.status(400).json({ error: range.error });
        const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';

        const rows = this.model.listItems(stash.id, { search, from: range.from, to: range.to });
        res.json({
            slug: stash.slug,
            hasPassword: Boolean(stash.password_hash),
            createdAt: stash.created_at,
            expiresAt: stash.expires_at,
            canExtend: Boolean(stash.ttl_ms),
            usage: this.model.usage(stash.id),
            limits: this.limits(),
            total: rows.length,
            items: rows.map(row => this.presentItem(stash.slug, row)),
        });
    };

    addNote = (req, res) => {
        const stash = req.stash;
        // JSON { text } from the page, or a plain-text body from curl
        const raw = typeof req.body === 'string' ? req.body : req.body && req.body.text;
        if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ error: 'Write something first.', field: 'text' });
        const text = raw.replace(/\r\n/g, '\n');
        if (Buffer.byteLength(text) > this.config.maxNoteBytes) {
            return res.status(413).json({ error: `A note can be at most ${Math.round(this.config.maxNoteBytes / 1024)} KB.`, field: 'text' });
        }
        if (this.model.usage(stash.id).items >= this.config.maxItemsPerStash) {
            return res.status(413).json({ error: `This stash is full (${this.config.maxItemsPerStash} items). Delete something first.` });
        }
        const item = this.presentItem(stash.slug, this.model.addNote(stash.id, text, this.now()));
        this.events.publish(stash.slug, 'item-added', item);
        res.status(201).json(item);
    };

    addFile = (req, res) => {
        const stash = req.stash;
        const content = req.body;
        if (!Buffer.isBuffer(content) || !content.length) return res.status(400).json({ error: 'The file is empty.' });

        let rawName = req.get('x-file-name') || '';
        try {
            rawName = decodeURIComponent(rawName);
        } catch {
            // keep the raw header value
        }
        const fileName = cleanFileName(rawName);
        if (!fileName) return res.status(400).json({ error: 'The file needs a name (X-File-Name header).' });

        const detected = detectFile(fileName, content);
        if (detected.error) return res.status(415).json({ error: detected.error });

        const usage = this.model.usage(stash.id);
        const c = this.config;
        if (usage.items >= c.maxItemsPerStash) {
            return res.status(413).json({ error: `This stash is full (${c.maxItemsPerStash} items). Delete something first.` });
        }
        if (usage.files >= c.maxFilesPerStash) {
            return res.status(413).json({ error: `A stash can hold ${c.maxFilesPerStash} files. Delete one first.` });
        }
        if (usage.bytes + content.length > c.maxStashBytes) {
            return res.status(413).json({ error: `This stash would pass its ${Math.round(c.maxStashBytes / 1048576)} MB limit.` });
        }
        if (this.model.totalBytes() + content.length > c.maxTotalBytes) {
            return res.status(507).json({ error: 'The server is out of file space. Try again later.' });
        }

        const row = this.model.addFile(stash.id, { fileName, fileType: detected.mime, content }, this.now());
        const item = this.presentItem(stash.slug, row);
        this.events.publish(stash.slug, 'item-added', item);
        res.status(201).json(item);
    };

    getFile = (req, res) => {
        const stash = req.stash;
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? this.model.getItem(stash.id, id) : null;
        if (!row || row.kind !== 'file') return res.status(404).json({ error: 'File not found.' });
        const content = this.model.getFileContent(row.id);
        if (!content) return res.status(404).json({ error: 'File not found.' });

        const inline = row.file_type.startsWith('image/') && req.query.download !== '1';
        const encoded = encodeURIComponent(row.file_name).replace(/['()]/g, escape);
        res.set({
            'Content-Type': row.file_type,
            'Content-Length': String(content.length),
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cache-Control': 'private, no-store',
        });
        res.send(content);
    };

    latest = (req, res) => {
        const row = this.model.latestNote(req.stash.id);
        if (!row) return res.status(404).type('text/plain').send('No notes yet.\n');
        res.type('text/plain; charset=utf-8').send(row.text);
    };

    deleteItem = (req, res) => {
        const stash = req.stash;
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || !this.model.deleteItem(stash.id, id)) {
            return res.status(404).json({ error: 'Item not found.' });
        }
        this.events.publish(stash.slug, 'item-deleted', { id });
        res.json({ ok: true });
    };

    extend = (req, res) => {
        const stash = this.model.extend(req.stash.id, this.now());
        if (!stash) return res.status(400).json({ error: 'This stash never expires, so there is nothing to extend.' });
        this.events.publish(stash.slug, 'stash-extended', { expiresAt: stash.expires_at });
        res.json({ expiresAt: stash.expires_at });
    };

    remove = (req, res) => {
        const stash = req.stash;
        this.model.deleteStash(stash.id);
        this.events.closeAll(stash.slug, 'stash-gone', { reason: 'deleted' });
        res.json({ ok: true });
    };

    stream = (req, res) => {
        this.events.subscribe(req.stash.slug, req, res);
    };

    // Called on a timer: removes stashes whose time is up and tells anyone still looking at them
    cleanup = () => {
        const removed = this.model.purgeExpired(this.now());
        for (const slug of removed) this.events.closeAll(slug, 'stash-gone', { reason: 'expired' });
        return removed;
    };
}

module.exports = StashController;
