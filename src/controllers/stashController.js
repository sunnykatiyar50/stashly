const { generateSlug, parseSlug } = require('../utils/slug');
const { hashPassword, verifyPassword, MIN_PASSWORD, MAX_PASSWORD } = require('../utils/password');
const { signToken, verifyToken, parseCookies } = require('../utils/token');
const { detectFile, cleanFileName } = require('../utils/fileType');
const { dateRange } = require('../utils/time');
const { parseTitle, deriveTitle } = require('../utils/title');
const { listZip } = require('../utils/zip');

const cookieName = slug => `stashly_${slug}`;
const MAX_COOKIE_MS = 12 * 60 * 60 * 1000;

// "bytes=START-END", "bytes=START-" or "bytes=-SUFFIX" for one range. Returns { start, end }, 'invalid', or null when
// there is no range to honour (no header, or several ranges, which are served whole).
function parseRange(header, size) {
    if (typeof header !== 'string') return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (match[1] === '' && match[2] === '')) return header.startsWith('bytes=') && header.includes(',') ? null : 'invalid';
    let start;
    let end;
    if (match[1] === '') {
        const suffix = Number(match[2]);
        if (suffix === 0) return 'invalid';
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (start >= size || start > end) return 'invalid';
    return { start, end };
}

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

    // A burn-after-reading note never leaves the server in a list or live event: its text only comes out of /reveal.
    // A note with no title of its own would show its first words as a title, so secret and burn notes get a plain one.
    presentItem(slug, row) {
        const isFile = row.kind === 'file';
        const burn = !isFile && Boolean(row.burn);
        const secret = !isFile && Boolean(row.secret);
        const generic = burn ? 'Burn-after-reading note' : secret ? 'Secret note' : null;
        return {
            id: row.id,
            kind: row.kind,
            // Notes: the given title, or the first words of the text when there is none
            title: isFile ? null : row.title || generic || deriveTitle(row.text),
            hasTitle: !isFile && Boolean(row.title),
            text: isFile || burn ? null : row.text,
            burn,
            secret,
            expiresAt: isFile ? null : row.expires_at || null,
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
            itemTtlOptions: this.config.itemTtlOptions.map(({ key, label }) => ({ key, label })),
            fileTypes: this.config.fileTypes,
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

        const rows = this.model.listItems(stash.id, { search, from: range.from, to: range.to, now: this.now() });
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

    // The per-note options: from the JSON body of the page, or from headers when the body is plain text (curl)
    noteOptions(req) {
        const json = typeof req.body === 'string' ? null : req.body || {};
        const truthy = value => value === true || /^(1|true|yes|on)$/i.test(String(value || ''));
        const burn = json ? truthy(json.burn) : truthy(req.get('x-burn-after-read'));
        const secret = json ? truthy(json.secret) : truthy(req.get('x-secret'));
        const key = json ? json.expires : req.get('x-expires');
        if (key === undefined || key === null || key === '') return { burn, secret, ttl: null };
        const ttl = this.config.itemTtlOptions.find(option => option.key === key);
        if (!ttl) return { error: 'Pick one of the listed note expiry times.' };
        return { burn, secret, ttl };
    }

    addNote = (req, res) => {
        const stash = req.stash;
        // JSON { title?, text } from the page, or a plain-text body from curl (which has no title)
        const raw = typeof req.body === 'string' ? req.body : req.body && req.body.text;
        if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ error: 'Write something first.', field: 'text' });
        const title = parseTitle(typeof req.body === 'string' ? undefined : req.body && req.body.title);
        if (title.error) return res.status(400).json({ error: title.error, field: 'title' });
        const text = raw.replace(/\r\n/g, '\n');
        if (Buffer.byteLength(text) > this.config.maxNoteBytes) {
            return res.status(413).json({ error: `A note can be at most ${Math.round(this.config.maxNoteBytes / 1024)} KB.`, field: 'text' });
        }
        if (this.model.usage(stash.id).items >= this.config.maxItemsPerStash) {
            return res.status(413).json({ error: `This stash is full (${this.config.maxItemsPerStash} items). Delete something first.` });
        }
        const options = this.noteOptions(req);
        if (options.error) return res.status(400).json({ error: options.error, field: 'expires' });
        const now = this.now();
        // A note never outlives its stash
        let expiresAt = options.ttl ? new Date(now.getTime() + options.ttl.ms) : null;
        if (expiresAt && stash.expires_at && expiresAt.toISOString() > stash.expires_at) expiresAt = new Date(stash.expires_at);
        const row = this.model.addNote(stash.id, text, now, title.value, {
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            burn: options.burn,
            secret: options.secret,
        });
        const item = this.presentItem(stash.slug, row);
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

        const detected = detectFile(fileName, content, this.config.fileTypes);
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

    // Reads one file of this stash, or null
    fileRow(req) {
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? this.model.getItem(req.stash.id, id) : null;
        return row && row.kind === 'file' ? row : null;
    }

    getFile = (req, res) => {
        const row = this.fileRow(req);
        if (!row) return res.status(404).json({ error: 'File not found.' });
        const content = this.model.getFileContent(row.id);
        if (!content) return res.status(404).json({ error: 'File not found.' });

        const type = row.file_type;
        const download = req.query.download === '1';
        // Images show in the page. A PDF opens in its own tab on request (?view=1), because the browser's PDF
        // viewer does not run under the sandbox policy every other file gets.
        const viewPdf = req.query.view === '1' && type === 'application/pdf';
        const inline = (type.startsWith('image/') && !download) || viewPdf;
        const encoded = encodeURIComponent(row.file_name).replace(/['()]/g, escape);
        res.set({
            'Content-Type': type,
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': viewPdf ? "default-src 'none'" : "default-src 'none'; sandbox",
            'Cache-Control': 'private, no-store',
            'Accept-Ranges': 'bytes',
        });

        // Audio and video players ask for byte ranges so they can seek
        const range = parseRange(req.headers.range, content.length);
        if (range === 'invalid') {
            res.set('Content-Range', `bytes */${content.length}`);
            return res.status(416).end();
        }
        if (range) {
            res.status(206).set({
                'Content-Range': `bytes ${range.start}-${range.end}/${content.length}`,
                'Content-Length': String(range.end - range.start + 1),
            });
            return res.end(content.subarray(range.start, range.end + 1));
        }
        res.set('Content-Length', String(content.length));
        res.send(content);
    };

    // The names inside a zip file, for the preview. Nothing is unpacked.
    listArchive = (req, res) => {
        const row = this.fileRow(req);
        if (!row) return res.status(404).json({ error: 'File not found.' });
        if (row.file_type !== 'application/zip') return res.status(400).json({ error: 'Only zip files can be listed.' });
        const content = this.model.getFileContent(row.id);
        if (!content) return res.status(404).json({ error: 'File not found.' });
        const listing = listZip(content);
        if (listing.error) return res.status(422).json({ error: listing.error });
        res.json(listing);
    };

    latest = (req, res) => {
        const row = this.model.latestNote(req.stash.id, this.now());
        if (!row) return res.status(404).type('text/plain').send('No notes yet.\n');
        // Reading a burn-after-reading note this way uses it up
        if (row.burn) this.burn(req.stash, row);
        res.type('text/plain; charset=utf-8').send(row.text);
    };

    // Deletes a note that has been read and tells every open page
    burn(stash, row) {
        this.model.deleteItem(stash.id, row.id);
        this.events.publish(stash.slug, 'item-deleted', { id: row.id, burned: true });
    }

    // Returns the text of a burn-after-reading note, once: it is deleted as it is handed over
    reveal = (req, res) => {
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? this.model.getLiveItem(req.stash.id, id, this.now()) : null;
        if (!row || row.kind !== 'note' || !row.burn) {
            return res.status(404).json({ error: 'That note is gone, or it does not burn after reading.' });
        }
        this.burn(req.stash, row);
        res.set('Cache-Control', 'no-store').json({ id: row.id, text: row.text });
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
        for (const item of this.model.purgeExpiredItems(this.now())) this.events.publish(item.slug, 'item-deleted', { id: item.id });
        return removed;
    };
}

module.exports = StashController;
