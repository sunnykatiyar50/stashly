const { generateSlug, parseSlug } = require('../utils/slug');
const { hashPassword, verifyPassword, MAX_PASSWORD } = require('../utils/password');
const { signToken, verifyToken, parseCookies, generateLinkToken, hashLinkToken, linkTokenMatches } = require('../utils/token');
const { detectFile, detectThumb, cleanFileName, extensionProblem } = require('../utils/fileType');
const crypto = require('crypto');
const { dateRange } = require('../utils/time');
const { parseTitle, deriveTitle } = require('../utils/title');
const { parseTag, parseTags, tagsOf, splitSearch, MAX_TAGS } = require('../utils/tags');
const { listZip } = require('../utils/zip');
const { emailReady } = require('../utils/mailer');
const { UnlockLockout } = require('../utils/lockout');
const { pipeline } = require('stream');
const { once } = require('events');
const { ZipWriter } = require('../utils/zipWriter');
const { planExport } = require('../utils/stashExport');
const { noopAudit } = require('../utils/auditLog');
const { noopMetrics } = require('../utils/metrics');
const { grantRole } = require('../models/userModel');

// Three cookies per stash: full access (the password), or one of the two share links. The names cannot collide,
// because the prefixes differ before the stash name starts.
const cookieName = slug => `stashly_${slug}`;
const ROLE_COOKIES = { view: slug => `stashlyv_${slug}`, drop: slug => `stashlyd_${slug}` };
// What a share link signs: its own label plus the hash of its token, so a new link voids cookies from the old one
const roleSubject = (slug, kind) => `${slug}:${kind}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// The most clips one reorder may move (a stash holds at most a few thousand; a page shows them all)
const MAX_REORDER = 5000;
// The most clips one bulk delete, restore, pin or unpin may name
const MAX_BULK = 500;
// The most items one listing can be asked for with `limit` (the extension asks for a few; without a limit, all come)
const MAX_LIST_LIMIT = 200;
// A listing asked for with `preview` carries only this many characters of each note (the rest comes from
// GET .../items/:id), so a stash full of large notes does not make every page load huge
const PREVIEW_CHARS = 2000;

// The first PREVIEW_CHARS characters of a note, without cutting a character in half
function previewOf(text) {
    if (text.length <= PREVIEW_CHARS) return text;
    const code = text.charCodeAt(PREVIEW_CHARS - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? PREVIEW_CHARS - 1 : PREVIEW_CHARS);
}

// The optional `limit` of a listing: undefined for none, a whole number from 1 to MAX_LIST_LIMIT, or an error
function parseLimit(value) {
    if (value === undefined || value === null || value === '') return { value: undefined };
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return { error: `limit must be a whole number from 1 to ${MAX_LIST_LIMIT}.` };
    return { value: Math.min(n, MAX_LIST_LIMIT) };
}
// The optional `offset` of a listing (how many items to skip): undefined for none, or a whole number from 0, or an error
function parseOffset(value) {
    if (value === undefined || value === null || value === '') return { value: undefined };
    const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) return { error: 'offset must be a whole number, 0 or more.' };
    return { value: n };
}

// A drop-box link may attach a thumbnail only to an image it has just uploaded: while the image has none, and for this
// long after the item was made. Full access may attach or replace a thumbnail at any time.
const THUMB_DROP_WINDOW_MS = 5 * 60 * 1000;
const RESERVED_MESSAGE = 'That name belonged to a stash that was deleted, expired or renamed recently, so it is reserved for now. Pick another.';

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

// What a stash takes: notes and files, notes only, or files only (older rows have no value: everything)
const CONTENT_KINDS = ['all', 'notes', 'files'];
const contentOf = stash => (CONTENT_KINDS.includes(stash.content) ? stash.content : 'all');

class StashController {
    // audit(event, { req, stash, actor, detail }) writes the audit log and metrics counts what is worth counting; both
    // do nothing unless the app passes real ones (see utils/auditLog.js and utils/metrics.js)
    // users (the follow list) and userAuth (who is signed in) are only given when accounts exist; without them nothing
    // about accounts is consulted
    constructor({ model, events, config, secret, now = () => new Date(), isAdmin = () => false, audit = noopAudit, metrics = noopMetrics, users = null, userAuth = null }) {
        this.users = users;
        this.userAuth = userAuth;
        this.audit = audit;
        this.metrics = metrics;
        this.isAdmin = isAdmin;
        this.model = model;
        this.events = events;
        this.config = config;
        this.secret = secret;
        this.now = now;
        this.lockout = new UnlockLockout({ config, now });
    }

    // Wrong-password counts per stash name (read by the tests)
    get failures() {
        return this.lockout.global;
    }

    // ---- presentation ----

    // A burn-after-reading note never leaves the server in a list or live event: its text only comes out of /reveal.
    // A note with no title of its own would show its first words as a title, so secret and burn notes get a plain one.
    // preview: cut a long note's text for a listing (text is then only the start, and truncated is true)
    presentItem(slug, row, { preview = false } = {}) {
        const isFile = row.kind === 'file';
        const burn = !isFile && Boolean(row.burn);
        const secret = !isFile && Boolean(row.secret);
        const generic = burn ? 'Burn-after-reading note' : secret ? 'Secret note' : null;
        const full = isFile || burn ? null : row.text;
        const cut = preview && full !== null && full.length > PREVIEW_CHARS;
        return {
            id: row.id,
            kind: row.kind,
            // Notes: the given title, or the first words of the text when there is none.
            // Files: the given title, or the file's name.
            title: isFile ? row.title || row.file_name : row.title || generic || deriveTitle(row.text),
            hasTitle: Boolean(row.title),
            text: cut ? previewOf(full) : full,
            // Only in a preview listing: the text above is just the start of a longer note
            ...(cut ? { truncated: true, textLength: full.length } : {}),
            burn,
            secret,
            pinned: Boolean(row.pinned),
            tags: tagsOf(row),
            // The item's place in the list (higher is nearer the top); the page sorts by it
            order: row.sort_order,
            editedAt: row.edited_at || null,
            expiresAt: isFile ? null : row.expires_at || null,
            fileName: isFile ? row.file_name : null,
            fileType: isFile ? row.file_type : null,
            fileSize: isFile ? row.file_size : null,
            isImage: isFile && row.file_type.startsWith('image/'),
            url: isFile ? `/api/stashes/${slug}/files/${row.id}` : null,
            // A small picture for the list, when the page has made one (the bytes never travel in a listing)
            thumbUrl: isFile && row.has_thumb ? `/api/stashes/${slug}/files/${row.id}/thumb` : null,
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
            maxThumbBytes: c.maxThumbBytes,
        };
    }

    // ---- middleware ----

    // Whether a stash with this name exists, and whether it has a password. Nothing else is told.
    exists = (req, res) => {
        const stash = this.liveStash(req.params.slug);
        if (!stash) return res.status(404).json({ exists: false });
        res.json({ exists: true, locked: Boolean(stash.password_hash) });
    };

    // Finds the stash named in the URL. A stash whose time is up is deleted on the spot.
    loadStash = (req, res, next) => {
        const stash = this.liveStash(req.params.slug);
        if (!stash) return res.status(404).json({ error: 'This stash has expired or does not exist.' });
        req.stash = stash;
        next();
    };

    // The stash with this name, or null when there is none. A stash whose time is up is deleted on the spot.
    liveStash(slug) {
        const stash = this.model.findBySlug(String(slug || '').toLowerCase());
        if (stash && stash.expires_at && stash.expires_at <= this.now().toISOString()) {
            this.model.deleteStash(stash.id, this.now());
            this.events.closeAll(stash.slug, 'stash-gone', { reason: 'expired' });
            this.audit('stash.deleted', { stash, actor: 'system', detail: { reason: 'expired' } });
            return null;
        }
        return stash || null;
    }

    // What this visitor may do in this stash: 'full' (no password, or unlocked), 'view' (a read-only link),
    // 'drop' (a drop-box link: can add, cannot read) or null (locked out).
    roleOf(req, stash, user = req.user) {
        return this.access(req, stash, user).role;
    }

    // The role, plus the valid sign-in token it came from ({ expiresAt, signedInAt }; none for a stash with no password,
    // or when the access comes from the signed-in user's follow list).
    // `user` is the signed-in user (req.user unless the caller has looked them up again, as a live stream does on each
    // heartbeat). A follow only counts while its snapshot still matches the stash (see grantRole), so it ends with a
    // password change, "sign out other devices" or a replaced read-only link, exactly as a cookie does. A cookie that
    // gives more than the follow wins.
    access(req, stash, user = req.user) {
        // The owner of a stash (the signed-in user who created it) always has full access, password or not
        if (this.ownedBy(user, stash)) return { role: 'full', token: null };
        if (!stash.password_hash) return { role: 'full', token: null };
        const cookies = parseCookies(req.headers.cookie);
        const now = this.now().getTime();
        const full = verifyToken(this.secret, stash.slug, this.saltFor(stash, 'full'), cookies[cookieName(stash.slug)], now);
        if (full) return { role: 'full', token: full };
        const granted = this.grantFor(user, stash);
        if (granted === 'full') return { role: 'full', token: null };
        for (const kind of ['view', 'drop']) {
            if (!stash[`${kind}_token_hash`]) continue;
            const token = verifyToken(this.secret, roleSubject(stash.slug, kind), this.saltFor(stash, kind), cookies[ROLE_COOKIES[kind](stash.slug)], now);
            if (token) return { role: kind, token };
        }
        if (granted) return { role: granted, token: null };
        return { role: null, token: null };
    }

    // Whether this user made this stash. A stash made by a guest (or whose owner was deleted) has no owner.
    ownedBy(user, stash) {
        return Boolean(user && stash && stash.owner_id && stash.owner_id === user.id);
    }

    isOwner(req, stash = req.stash) {
        return this.ownedBy(req.user, stash);
    }

    // What the user's follow of this stash lets them do right now ('full', 'view' or null)
    grantFor(user, stash) {
        if (!user || !this.users) return null;
        return grantRole(this.users.getFollow(user.id, stash.id), stash);
    }

    // The person who changed a stash's password or signed out the other devices stays in (their cookie is renewed). If
    // they follow the stash, their follow is renewed the same way; everyone else's follow stops working.
    renewOwnFollow(req, stash) {
        if (!req.user || !this.users) return;
        const follow = this.users.getFollow(req.user.id, stash.id);
        if (!follow || follow.grant_role !== 'full') return;
        this.users.follow(req.user.id, stash.id, { role: 'full', salt: stash.password_salt, version: stash.session_version || 0, viewHash: null }, this.now());
    }

    // What a sign-in cookie is tied to: the password's salt (or the share link's hash), and the stash's session
    // version, which "Sign out other devices" raises to end every sign-in at once. Version 0 leaves the salt as it
    // was, so sign-ins made before the version existed keep working.
    saltFor(stash, kind) {
        const base = kind === 'full' ? stash.password_salt : stash[`${kind}_token_hash`];
        const version = stash.session_version || 0;
        return version ? `${base}.v${version}` : base;
    }

    // Route guard: the roles that may use the route. A locked-out visitor is asked for the password; a share-link
    // visitor who goes beyond what the link allows is told no.
    allow = (...roles) => (req, res, next) => {
        const { role, token } = this.access(req, req.stash);
        if (!role) return res.status(401).json({ error: 'This stash is locked. Enter the password.', locked: true });
        if (!roles.includes(role)) {
            return res.status(403).json({ error: role === 'view' ? 'This link is read-only.' : 'This drop-box link can only add things.', role });
        }
        req.role = role;
        req.signIn = token;
        next();
    };

    // ---- handlers ----

    appConfig = (req, res) => {
        res.json({
            // Shown at the bottom of the left menu
            version: this.config.version || null,
            ttlOptions: this.config.ttlOptions.map(({ key, label }) => ({ key, label })),
            defaultTtl: this.config.defaultTtl,
            limits: this.limits(),
            allowNoExpiry: this.config.allowNoExpiry,
            minOpenNameLength: this.config.minOpenNameLength,
            minPasswordLength: this.config.minPasswordLength,
            sessionOptions: this.config.sessionOptions.map(({ key, label }) => ({ key, label })),
            defaultSession: this.config.defaultSession,
            itemTtlOptions: this.config.itemTtlOptions.map(({ key, label }) => ({ key, label })),
            fileTypes: this.config.fileTypes,
            // false when creating is limited (to admins, or to signed-in users) and the visitor does not qualify
            canCreate: this.canCreate(req),
            // Who may create: 'open' (anyone, the default), 'login' (signed-in users and admins) or 'admin'
            createRule: this.config.requireAdminToCreate ? 'admin' : this.config.requireLoginToCreate ? 'login' : 'open',
            adminEnabled: Boolean(this.config.adminPassword),
            // Whether the server can send email (the pages offer "email this link" and the like only when it can)
            emailEnabled: emailReady(this.config),
            accountsEnabled: Boolean(this.config.adminPassword),
        });
    };

    // Anyone, unless the admin limited it: to admins (the ADMIN_PASSWORD admin or a user with the admin role), or to
    // anyone signed in. Visitors without an account keep opening and using stashes either way.
    canCreate(req) {
        if (this.config.requireAdminToCreate) return this.isAdmin(req);
        if (this.config.requireLoginToCreate) return this.isAdmin(req) || Boolean(req.user);
        return true;
    }

    // A name another stash gave up recently (deleted, expired or renamed away) is kept from new stashes for a while:
    // a device or script still using it would otherwise send its notes to whoever took the name next
    nameReserved(slug) {
        const days = this.config.reserveOldNamesDays;
        if (!days) return false;
        return this.model.isRetired(slug, new Date(this.now().getTime() - days * DAY));
    }

    suggest = (req, res) => {
        let slug = generateSlug();
        for (let i = 0; i < 5 && this.model.findBySlug(slug); i++) slug = generateSlug();
        res.json({ slug });
    };

    create = async (req, res) => {
        if (!this.canCreate(req)) {
            return this.config.requireAdminToCreate
                ? res.status(403).json({ error: 'Only the admin can create stashes on this server. Sign in at /admin first.' })
                : res.status(403).json({ error: 'You need to sign in to create stashes on this server. Sign in at /account first.' });
        }
        const body = req.body || {};
        const parsed = parseSlug(body.slug);
        if (parsed.error) return res.status(400).json({ error: parsed.error, field: 'slug' });

        const ttlKey = body.ttl || this.config.defaultTtl;
        const ttl = this.config.ttlOptions.find(option => option.key === ttlKey);
        if (!ttl) return res.status(400).json({ error: 'Pick one of the listed expiry times.', field: 'ttl' });

        let password = null;
        if (body.password !== undefined && body.password !== null && body.password !== '') {
            const min = this.config.minPasswordLength;
            if (typeof body.password !== 'string' || body.password.length < min || body.password.length > MAX_PASSWORD) {
                return res
                    .status(400)
                    .json({ error: `The password must be ${min} to ${MAX_PASSWORD} characters.`, field: 'password' });
            }
            password = body.password;
        }

        // Without a password the name is the only lock, so it must be long enough not to be guessed
        const minName = this.config.minOpenNameLength;
        if (!password && minName && parsed.slug.length < minName) {
            return res.status(400).json({
                error: `Without a password the name must be at least ${minName} characters. Add a password, or use a longer name.`,
                field: 'slug',
            });
        }

        if (this.nameReserved(parsed.slug)) return res.status(409).json({ error: RESERVED_MESSAGE, field: 'slug' });

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
                // A signed-in user owns what they create; a guest's stash has no owner
                ownerId: req.user ? req.user.id : null,
                now: this.now(),
            });
            // The creator is let in without retyping the password
            if (stash.password_hash) this.setAccessCookie(req, res, stash);
            this.audit('stash.created', { req, stash, detail: { password: Boolean(password), ttl: ttl.key, owned: Boolean(req.user) } });
            // A signed-in user follows what they create: it shows up on their page without typing the password again
            if (req.user && this.users) {
                this.users.follow(req.user.id, stash.id, { role: 'full', salt: stash.password_salt, version: stash.session_version || 0, viewHash: null }, this.now());
                this.audit('user.followed', { req, stash, actor: 'user', detail: { user: req.user.id, role: 'full', via: 'create' } });
            }
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

    // Always HttpOnly and SameSite=Strict. Secure follows the connection, or is forced with COOKIE_SECURE=true
    // (for a TLS proxy that Express was not told about).
    // durationMs is how long this browser stays signed in (the person's choice), never past the end of the stash.
    // signedInAt is when this browser first signed in: a session can be changed later, but never made to run past the
    // longest session length counted from then, so a copied cookie cannot be kept alive forever.
    // Returns when the session ends (ms).
    setAccessCookie(req, res, stash, kind = 'full', durationMs = this.sessionMs(null), signedInAt = null) {
        const now = this.now().getTime();
        const since = Number.isFinite(signedInAt) ? signedInAt : now;
        const stashEnd = stash.expires_at ? new Date(stash.expires_at).getTime() : Infinity;
        const expiresAt = Math.max(now, Math.min(now + durationMs, since + this.maxSessionMs(), stashEnd));
        const [name, subject] =
            kind === 'full' ? [cookieName(stash.slug), stash.slug] : [ROLE_COOKIES[kind](stash.slug), roleSubject(stash.slug, kind)];
        const salt = this.saltFor(stash, kind);
        const secure = this.config.cookieSecure === 'true' ? true : this.config.cookieSecure === 'false' ? false : req.secure;
        res.cookie(name, signToken(this.secret, subject, salt, expiresAt, since), {
            httpOnly: true,
            sameSite: 'strict',
            secure,
            path: '/',
            maxAge: Math.max(0, expiresAt - now),
        });
        return expiresAt;
    }

    // The longest session on offer: no sign-in lasts longer than this from when it started
    maxSessionMs() {
        return Math.max(...this.config.sessionOptions.map(option => option.ms));
    }

    // When the visitor's current sign-in started (null for an older cookie that does not say, or no password)
    signedInAt(req) {
        return req.signIn && Number.isFinite(req.signIn.signedInAt) ? req.signIn.signedInAt : null;
    }

    // How long a session lasts, from one of the listed choices (the default when none is given). null when the choice
    // is not on the list.
    sessionOptionFor(key) {
        const wanted = key === undefined || key === null || key === '' ? this.config.defaultSession : key;
        return this.config.sessionOptions.find(option => option.key === wanted) || null;
    }

    sessionMs(key) {
        const option = this.sessionOptionFor(key) || this.config.sessionOptions[this.config.sessionOptions.length - 1];
        return option.ms;
    }

    cookieFor(slug, kind) {
        return kind === 'full' ? cookieName(slug) : ROLE_COOKIES[kind](slug);
    }

    // When this browser's session for the stash ends. The cookie's first part is its (signed) expiry time.
    sessionEnd(req, stash, role) {
        if (!stash.password_hash || !role) return null;
        const token = parseCookies(req.headers.cookie)[this.cookieFor(stash.slug, role)];
        const expiresAt = Number(String(token || '').split('.')[0]);
        return Number.isFinite(expiresAt) && expiresAt > 0 ? new Date(expiresAt).toISOString() : null;
    }

    // Wrong passwords are counted by this.lockout (see utils/lockout.js). Sends the 429 and returns true when this
    // visitor must wait before trying this stash's password again.
    refuseIfLocked(req, res, extra = {}) {
        const wait = this.lockout.locked(req.stash.slug, req.ip);
        if (!wait) return false;
        const minutes = Math.max(1, Math.ceil(wait / 60000));
        res.status(429)
            .set('Retry-After', String(Math.ceil(wait / 1000)))
            .json({ error: `Too many wrong passwords for this stash. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`, ...extra });
        return true;
    }

    // How long this browser has left on its sign-in, to carry over when the password, the name or the sessions change
    remainingSession(req, stash) {
        const end = this.sessionEnd(req, stash, 'full');
        return end ? Math.max(0, new Date(end).getTime() - this.now().getTime()) : this.sessionMs(null);
    }

    // A wrong password: counted for the lockout, in the metrics and in the audit log (with the address, never the
    // password). The log also says when this wrong guess is the one that locks the visitor out.
    noteFailure(req, stash, via) {
        const wasLocked = this.lockout.locked(stash.slug, req.ip) > 0;
        this.lockout.note(stash.slug, req.ip);
        this.metrics.inc('stashly_unlock_failures_total');
        this.audit('stash.unlock_failed', { req, stash, detail: { via } });
        if (!wasLocked && this.lockout.locked(stash.slug, req.ip) > 0) this.audit('stash.locked_out', { req, stash });
    }

    unlock = async (req, res) => {
        const stash = req.stash;
        if (!stash.password_hash) return res.json({ ok: true, hasPassword: false });
        // Too many wrong passwords for this stash: refuse before even checking, so guessing gets nowhere
        if (this.refuseIfLocked(req, res, { locked: true })) return;
        const password = req.body && req.body.password;
        const session = this.sessionOptionFor(req.body && req.body.session);
        if (!session) return res.status(400).json({ error: 'Pick one of the listed session lengths.', field: 'session' });
        if (!(await verifyPassword(password, stash.password_hash, stash.password_salt))) {
            this.noteFailure(req, stash, 'unlock');
            return res.status(401).json({ error: 'That password is not right.', locked: true });
        }
        this.lockout.clear(stash.slug);
        this.setAccessCookie(req, res, stash, 'full', session.ms);
        res.json({ ok: true, sessionEndsAt: new Date(this.now().getTime() + session.ms).toISOString() });
    };

    // Signs this browser out of the stash: every cookie it holds for it is cleared. It works whatever the role, and
    // even when the cookie is already invalid, so the button never fails.
    logout = (req, res) => {
        for (const kind of ['full', 'view', 'drop']) res.clearCookie(this.cookieFor(req.stash.slug, kind), { path: '/' });
        res.json({ ok: true });
    };

    // Changes how much longer this browser stays signed in (a new session length from now, never past the stash's end)
    setSession = (req, res) => {
        const stash = req.stash;
        const session = this.sessionOptionFor(req.body && req.body.session);
        if (!session || !(req.body && req.body.session)) return res.status(400).json({ error: 'Pick one of the listed session lengths.', field: 'session' });
        if (!stash.password_hash) return res.status(400).json({ error: 'This stash has no password, so there is no session to change.' });
        // An older cookie does not say when it signed in, so its limit is counted from now
        const ends = this.setAccessCookie(req, res, stash, req.role, session.ms, this.signedInAt(req));
        const stashEnd = stash.expires_at ? new Date(stash.expires_at).getTime() : Infinity;
        // capped: the choice was cut short by the longest-session limit (not by the stash's own end)
        const capped = ends < this.now().getTime() + session.ms && ends < stashEnd;
        res.json({ ok: true, sessionEndsAt: new Date(ends).toISOString(), capped });
    };

    // Renames the stash (full access only). The address changes, so:
    //  - the old name stops working at once, and is free for anyone to take;
    //  - on a password-protected stash everyone else is signed out (their sign-in is tied to the old name), while this
    //    browser is signed in again under the new name for the time it had left;
    //  - the read-only and drop-box links are cancelled, since they carry the old name.
    // Open pages are told the new address and follow it.
    rename = (req, res) => {
        const stash = req.stash;
        const parsed = parseSlug(req.body && req.body.slug);
        if (parsed.error) return res.status(400).json({ error: parsed.error, field: 'slug' });
        if (parsed.slug === stash.slug) return res.status(400).json({ error: 'That is already the name of this stash.', field: 'slug' });
        // The same rule as creating: without a password the name is the only lock, so it has to be long enough
        const minName = this.config.minOpenNameLength;
        if (!stash.password_hash && minName && parsed.slug.length < minName) {
            return res.status(400).json({ error: `Without a password the name must be at least ${minName} characters.`, field: 'slug' });
        }

        if (this.nameReserved(parsed.slug)) return res.status(409).json({ error: RESERVED_MESSAGE, field: 'slug' });

        const remaining = this.remainingSession(req, stash);
        let updated;
        try {
            updated = this.model.renameStash(stash.id, parsed.slug, this.now());
        } catch (err) {
            if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message, field: 'slug' });
            throw err;
        }

        // A wrong-password count belongs to the stash, not the name
        this.lockout.rename(stash.slug, updated.slug);
        for (const kind of ['full', 'view', 'drop']) res.clearCookie(this.cookieFor(stash.slug, kind), { path: '/' });
        if (updated.password_hash) this.setAccessCookie(req, res, updated, 'full', remaining, this.signedInAt(req));
        this.audit('stash.renamed', { req, stash: updated, detail: { from: this.audit.tag(stash.slug), to: this.audit.tag(updated.slug) } });
        this.events.closeAll(stash.slug, 'stash-renamed', { slug: updated.slug, origin: this.withOrigin({}, req).origin });
        res.json({ ok: true, slug: updated.slug, url: `/s/${updated.slug}` });
    };

    // Changes the stash's password. Stashly has no accounts, so there is no separate "owner": the owner is whoever knows
    // the current password, and they prove it again here (so a browser someone walked away from cannot be used to take
    // the stash over). Wrong guesses count towards the same lockout as unlocking.
    //
    // Only a stash that already has a password can be changed. On a stash without one, anyone with its name could set a
    // password and lock everyone else out, so that is not offered (the admin can do it).
    changePassword = async (req, res) => {
        const stash = req.stash;
        if (!stash.password_hash) return res.status(400).json({ error: 'This stash has no password to change.' });
        const { currentPassword, newPassword } = req.body || {};
        const min = this.config.minPasswordLength;
        if (typeof newPassword !== 'string' || newPassword.length < min || newPassword.length > MAX_PASSWORD) {
            return res.status(400).json({ error: `The new password must be ${min} to ${MAX_PASSWORD} characters.`, field: 'newPassword' });
        }
        // The owner is signed in to their account, which is proof enough: they may set a new password without the old one
        // (they never had to type it to get in). Everyone else proves they know it.
        const owner = this.isOwner(req, stash);
        if (!owner) {
            if (this.refuseIfLocked(req, res)) return;
            if (!(await verifyPassword(currentPassword, stash.password_hash, stash.password_salt))) {
                this.noteFailure(req, stash, 'password_change');
                return res.status(401).json({ error: 'That is not the current password.', field: 'currentPassword' });
            }
        }
        if (typeof currentPassword === 'string' && newPassword === currentPassword) {
            return res.status(400).json({ error: 'The new password is the same as the current one.', field: 'newPassword' });
        }

        // This browser stays signed in for as long as it had left; everyone else is signed out (a new password means a
        // new salt, which the sign-in cookies are tied to), and the read-only and drop-box links are cancelled
        const remaining = this.remainingSession(req, stash);
        const hashed = await hashPassword(newPassword);
        const updated = this.model.setPassword(stash.id, hashed.hash, hashed.salt);
        this.lockout.clear(stash.slug);
        const ends = this.setAccessCookie(req, res, updated, 'full', remaining, this.signedInAt(req));
        this.renewOwnFollow(req, updated);
        this.audit('stash.password_changed', { req, stash });
        this.events.closeAll(stash.slug, 'access-changed', { origin: this.withOrigin({}, req).origin });
        res.json({ ok: true, sessionEndsAt: new Date(ends).toISOString() });
    };

    // Ends every other sign-in to this stash (other browsers, a forgotten shared computer, a copied cookie), and the
    // sessions opened from read-only and drop-box links. This browser stays signed in for the time it had left. The
    // links themselves still work; cancel them under Share links to stop new visits.
    signOutOthers = (req, res) => {
        const stash = req.stash;
        if (!stash.password_hash) return res.status(400).json({ error: 'This stash has no password, so nobody is signed in to it.' });
        const remaining = this.remainingSession(req, stash);
        const updated = this.model.bumpSessionVersion(stash.id);
        const ends = this.setAccessCookie(req, res, updated, 'full', remaining, this.signedInAt(req));
        this.renewOwnFollow(req, updated);
        this.audit('stash.sessions_signed_out', { req, stash });
        this.events.closeAll(stash.slug, 'access-changed', { origin: this.withOrigin({}, req).origin });
        res.json({ ok: true, sessionEndsAt: new Date(ends).toISOString() });
    };

    // ---- share links (password-protected stashes only) ----
    // Without a password the name already gives full access, so a limited link would limit nothing.

    // The page opens /s/name#view=TOKEN (or #drop=TOKEN) and trades the token for a cookie here
    redeem = (req, res) => {
        const stash = req.stash;
        const token = req.body && req.body.token;
        const kind = ['view', 'drop'].find(k => linkTokenMatches(token, stash[`${k}_token_hash`]));
        if (!stash.password_hash || !kind) return res.status(401).json({ error: 'That link is not valid any more.' });
        this.setAccessCookie(req, res, stash, kind, this.sessionMs(req.body && req.body.session));
        res.json({ ok: true, role: kind });
    };

    createShareLink = (req, res) => {
        const stash = req.stash;
        const kind = req.body && req.body.kind;
        if (!['view', 'drop'].includes(kind)) return res.status(400).json({ error: 'Pick a read-only link or a drop-box link.' });
        if (!stash.password_hash) {
            return res.status(400).json({ error: 'Share links need a password on the stash. Without one, the name already gives full access.' });
        }
        const token = generateLinkToken();
        this.model.setShareToken(stash.id, kind, hashLinkToken(token));
        this.audit('stash.share_link_created', { req, stash, detail: { kind } });
        // The token is shown once. It is in the fragment (#), which browsers never send to the server.
        res.status(201).json({ kind, token, path: `/s/${stash.slug}#${kind}=${token}` });
    };

    revokeShareLink = (req, res) => {
        const kind = req.params.kind;
        if (!['view', 'drop'].includes(kind)) return res.status(404).json({ error: 'No such link.' });
        this.model.setShareToken(req.stash.id, kind, null);
        this.audit('stash.share_link_revoked', { req, stash: req.stash, detail: { kind } });
        res.json({ ok: true });
    };

    get = (req, res) => {
        // The page sends its search in the body (POST .../query), so the words never appear in an address that a
        // proxy logs; GET with ?search= still works for scripts
        const out = this.listing(req, req.method === 'POST' ? req.body || {} : req.query);
        res.status(out.status).json(out.body);
    };

    // The first page of a stash, to send inside the stash page itself (see the /s/:slug route), or null when it is not
    // sent that way. Only for a visitor who proves they know the stash beyond its name: an unlocked password stash
    // (cookie or follow), its owner, or someone who follows it. For anyone else (a stash with no password reached by
    // its name alone, a locked one, one that does not exist) nothing is added, so the page says nothing about the name
    // that the API's own rate limits for guessing do not already cover, and the page asks the API as before.
    initialPage(req, slug) {
        const stash = this.model.findBySlug(String(slug || '').toLowerCase());
        if (!stash || (stash.expires_at && stash.expires_at <= this.now().toISOString())) return null;
        const { role, token } = this.access(req, stash);
        if (!role) return null;
        const known = Boolean(stash.password_hash) || this.ownedBy(req.user, stash) || Boolean(req.user && this.users && this.users.getFollow(req.user.id, stash.id));
        if (!known) return null;
        req.stash = stash;
        req.role = role;
        req.signIn = token;
        // The same request the page makes for its first page (stash-load.js queryFor)
        const out = this.listing(req, { preview: true, limit: 100, offset: 0, fullFirst: true });
        return out.status === 200 ? out.body : null;
    }

    // A stash's listing for this visitor as { status, body }: one page of items (or all of them) with the stash's details
    listing(req, input) {
        const stash = req.stash;
        const range = dateRange(input);
        if (range.error) return { status: 400, body: { error: range.error } };
        // "#work" words in the search box (and `tag`, one name or a list) narrow the list to clips that carry every one
        // of those tags; the other words search the text as before
        const typed = splitSearch(typeof input.search === 'string' ? input.search.trim().slice(0, 200) : '');
        const search = typed.text;
        const asked = parseTags(input.tag === undefined ? [] : Array.isArray(input.tag) ? input.tag : [input.tag]);
        if (asked.error) return { status: 400, body: { error: asked.error, field: 'tag' } };
        const tags = Array.from(new Set([...typed.tags, ...asked.value]));
        // Optional: only the first `limit` items (pinned, then newest), with `total` still counting every match
        const preview = input.preview === true || input.preview === '1' || input.preview === 'true';
        const limit = parseLimit(input.limit);
        if (limit.error) return { status: 400, body: { error: limit.error, field: 'limit' } };
        // Optional: skip the first `offset` items, to read a long list a page at a time (limit + offset)
        const offset = parseOffset(input.offset);
        if (offset.error) return { status: 400, body: { error: offset.error, field: 'offset' } };
        const skip = offset.value || 0;
        // Optional, with a preview: the first item of the first page comes in full. The page opens that one straight
        // away, so a long note does not cost a second request.
        const fullFirst = preview && skip === 0 && (input.fullFirst === true || input.fullFirst === '1' || input.fullFirst === 'true');

        // A drop-box visitor can add but not read: they get the stash's shape and no items or counts
        const dropOnly = req.role === 'drop';
        const filters = { search, tags, from: range.from, to: range.to, now: this.now() };
        const rows = dropOnly ? [] : this.model.listItems(stash.id, { ...filters, limit: limit.value, offset: skip });
        // The whole list is only counted when the rows above are not already all of it (a full page, or a page that
        // starts past the first item)
        const counted = !dropOnly && (skip > 0 || (limit.value && rows.length === limit.value));
        const total = dropOnly ? 0 : counted ? this.model.countItems(stash.id, filters) : rows.length;
        return { status: 200, body: {
            slug: stash.slug,
            role: req.role,
            hasPassword: Boolean(stash.password_hash),
            // Whether the signed-in visitor made this stash (it is then always in their list, and they need no password)
            owned: this.isOwner(req, stash),
            // When an admin last chose this stash's password, so the people using it can see it happened
            passwordResetAt: req.role === 'drop' ? null : stash.password_reset_at || null,
            createdAt: stash.created_at,
            expiresAt: stash.expires_at,
            // Only someone with full access sees which share links exist
            shareLinks: req.role === 'full' ? { view: Boolean(stash.view_token_hash), drop: Boolean(stash.drop_token_hash) } : null,
            // When this browser's sign-in ends (only a password-protected stash has one)
            sessionEndsAt: this.sessionEnd(req, stash, req.role),
            canExtend: req.role === 'full' && Boolean(stash.ttl_ms),
            keepLast: stash.keep_last || null,
            content: contentOf(stash),
            usage: dropOnly ? { items: 0, files: 0, bytes: 0 } : this.model.usage(stash.id),
            limits: this.limits(),
            // Every match, not just this page
            total,
            // True when items remain after this page, so a page can offer "Show more" without doing the sums
            hasMore: skip + rows.length < total,
            // Every tag in use in the stash, with how many clips carry it (for the tag filter and the editor's suggestions)
            tags: dropOnly ? [] : this.model.tagCounts(stash.id, this.now()).map(entry => ({ name: entry.tag, count: entry.count })),
            items: rows.map((row, i) => this.presentItem(stash.slug, row, { preview: preview && !(fullFirst && i === 0) })),
        } };
    }

    // One item in full: the way to get the whole text of a note that a preview listing cut short
    getItem = (req, res) => {
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? this.model.getLiveItem(req.stash.id, id, this.now()) : null;
        if (!row) return res.status(404).json({ error: 'Item not found.' });
        res.json(this.presentItem(req.stash.slug, row));
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
        this.events.publish(stash.slug, 'item-added', this.withOrigin(item, req));
        this.trim(stash);
        res.status(201).json(item);
    };

    // Live events carry which page added the item (an id the page made up), so a page can tell its own notes from
    // ones that arrived from another device. It is not stored.
    withOrigin(item, req) {
        const origin = String(req.get('x-tab-id') || '').slice(0, 40);
        return { ...item, origin: /^[A-Za-z0-9_-]+$/.test(origin) ? origin : null };
    }

    // "Keep the last N": deletes the oldest unpinned items beyond N, and tells open pages
    trim(stash) {
        const fresh = this.model.getStashById(stash.id);
        const removed = fresh && fresh.keep_last ? this.model.trimToLast(stash.id, fresh.keep_last) : [];
        for (const id of removed) this.events.publish(stash.slug, 'item-deleted', { id });
        return removed;
    }

    // Optimistic concurrency for edits. The page sends `baseEditedAt`: the editedAt of the item as it last saw it (null
    // if it had never been edited). If the item has been edited since, nothing is changed and the answer is a 409 with
    // the current item in full, so the person can overwrite it or take it. A request that leaves `baseEditedAt` out
    // is not checked at all (scripts written before this existed keep working, last write wins). Sends the answer and
    // returns true when there is a conflict (or the value is malformed).
    editConflict(req, res, row) {
        const base = req.body ? req.body.baseEditedAt : undefined;
        if (base === undefined) return false;
        if (base !== null && typeof base !== 'string') {
            res.status(400).json({ error: 'baseEditedAt must be the editedAt of the item you are changing, or null.', field: 'baseEditedAt' });
            return true;
        }
        if (base === (row.edited_at || null)) return false;
        res.status(409).json({
            error: `Someone else changed this ${row.kind === 'file' ? 'file' : 'note'} while you were editing.`,
            conflict: true,
            item: this.presentItem(req.stash.slug, row),
        });
        return true;
    }

    // Edits a note's title and text in place, or a file's title. Burn notes cannot be edited: their text is not on
    // the page to change.
    editNote = (req, res) => {
        const stash = req.stash;
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? this.model.getLiveItem(stash.id, id, this.now()) : null;
        if (!row) return res.status(404).json({ error: 'Item not found.' });
        if (row.kind === 'note' && row.burn) return res.status(400).json({ error: 'A burn-after-reading note cannot be edited.' });
        if (this.editConflict(req, res, row)) return;
        if (row.kind === 'file') return this.editFileTitle(req, res, row);
        const raw = req.body && req.body.text;
        if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ error: 'A note cannot be empty.', field: 'text' });
        const title = parseTitle(req.body.title);
        if (title.error) return res.status(400).json({ error: title.error, field: 'title' });
        const text = raw.replace(/\r\n/g, '\n');
        if (Buffer.byteLength(text) > this.config.maxNoteBytes) {
            return res.status(413).json({ error: `A note can be at most ${Math.round(this.config.maxNoteBytes / 1024)} KB.`, field: 'text' });
        }
        const updated = this.model.updateNote(stash.id, id, { text, title: title.value }, this.now());
        const item = this.presentItem(stash.slug, updated);
        this.events.publish(stash.slug, 'item-updated', item);
        res.json(item);
    };

    // A file's title: { title } (empty or null goes back to the file's name). The download keeps the real name.
    editFileTitle(req, res, row) {
        const stash = req.stash;
        if (req.body && req.body.text !== undefined) return res.status(400).json({ error: "A file's content cannot be edited, only its title.", field: 'text' });
        const title = parseTitle(req.body && req.body.title);
        if (title.error) return res.status(400).json({ error: title.error, field: 'title' });
        const updated = this.model.setFileTitle(stash.id, row.id, title.value, this.now());
        const item = this.presentItem(stash.slug, updated);
        this.events.publish(stash.slug, 'item-updated', item);
        res.json(item);
    }

    setPinned = (req, res) => {
        const stash = req.stash;
        const id = Number(req.params.id);
        const pinned = req.body && req.body.pinned;
        if (typeof pinned !== 'boolean') return res.status(400).json({ error: 'Say whether to pin or unpin.' });
        const row = Number.isInteger(id) ? this.model.getLiveItem(stash.id, id, this.now()) : null;
        const updated = row ? this.model.setPinned(stash.id, id, pinned) : null;
        if (!updated) return res.status(404).json({ error: 'Item not found.' });
        const item = this.presentItem(stash.slug, updated);
        this.events.publish(stash.slug, 'item-updated', item);
        res.json(item);
    };

    // A clip's tags: { tags: [...] } replaces them (an empty list clears them). Like pinning, tagging is not an edit.
    setTags = (req, res) => {
        const stash = req.stash;
        const id = Number(req.params.id);
        const tags = parseTags(req.body && req.body.tags);
        if (tags.error) return res.status(400).json({ error: tags.error, field: 'tags' });
        const row = Number.isInteger(id) ? this.model.getLiveItem(stash.id, id, this.now()) : null;
        const updated = row ? this.model.setTags(stash.id, id, tags.value) : null;
        if (!updated) return res.status(404).json({ error: 'Item not found.' });
        const item = this.presentItem(stash.slug, updated);
        this.events.publish(stash.slug, 'item-updated', item);
        res.json(item);
    };

    // Puts clips in a new order. The body lists ids top to bottom; only those clips move, among their own places.
    reorder = (req, res) => {
        const stash = req.stash;
        const ids = req.body && req.body.ids;
        if (!Array.isArray(ids) || !ids.length || ids.length > MAX_REORDER || !ids.every(id => Number.isInteger(id) && id > 0)) {
            return res.status(400).json({ error: 'Send the clip ids in their new order.' });
        }
        if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'A clip is listed twice.' });
        const orders = this.model.reorderItems(stash.id, ids);
        if (!orders) return res.status(404).json({ error: 'Some of those clips are gone. Refresh and try again.' });
        this.events.publish(stash.slug, 'items-reordered', { orders });
        res.json({ orders });
    };

    // What the stash takes: notes and files ('all'), notes only, or files only. What is already there stays.
    setContent = (req, res) => {
        const value = req.body && req.body.content;
        if (!CONTENT_KINDS.includes(value)) return res.status(400).json({ error: 'Pick notes and files, notes only, or files only.' });
        this.model.setContent(req.stash.id, value);
        this.events.publish(req.stash.slug, 'content-changed', { content: value });
        res.json({ content: value });
    };

    // Run before the body is read, so a stash that takes no files refuses an upload without receiving it
    acceptsNotes = (req, res, next) => {
        if (contentOf(req.stash) === 'files') return res.status(403).json({ error: 'This stash only takes files.' });
        next();
    };

    acceptsFiles = (req, res, next) => {
        if (contentOf(req.stash) === 'notes') return res.status(403).json({ error: 'This stash only takes notes, not files.' });
        next();
    };

    // How many unpinned items the stash keeps (null keeps everything). Lowering it trims straight away.
    setKeepLast = (req, res) => {
        const stash = req.stash;
        const value = req.body && req.body.keepLast;
        const keep = value === null || value === undefined || value === '' || value === 0 ? null : Number(value);
        if (keep !== null && (!Number.isInteger(keep) || keep < 1 || keep > this.config.maxItemsPerStash)) {
            return res.status(400).json({ error: `Pick a number from 1 to ${this.config.maxItemsPerStash}, or keep everything.` });
        }
        this.model.setKeepLast(stash.id, keep);
        const removed = this.trim(stash);
        res.json({ keepLast: keep, removed: removed.length });
    };

    // Receives the upload's body into the file store as it arrives (never held in memory), and leaves it on req.upload.
    // Runs after the checks that can refuse an upload without reading it (role, content kind, Content-Length).
    receiveFile = async (req, res, next) => {
        try {
            req.upload = await this.model.files.receive(req, this.config.maxFileBytes);
        } catch (err) {
            if (err.code === 'TOO_LARGE') {
                // The rest of the body is not read: close the connection once this answer is sent
                res.set('Connection', 'close');
                return res.status(413).json({ error: `A file can be at most ${Math.round(this.config.maxFileBytes / 1048576)} MB.` });
            }
            // The client went away part way: there is nobody to answer, but make sure nothing is left hanging
            if (!res.headersSent && !res.destroyed) return res.status(400).json({ error: 'The upload was interrupted.' });
            return;
        }
        next();
    };

    addFile = (req, res) => {
        const upload = req.upload;
        try {
            this.storeUpload(req, res, upload);
        } finally {
            // Does nothing once the upload has been moved into the file store
            this.model.files.discard(upload.tmp);
        }
    };

    // The first stash limit that adding an item (a file of `size` bytes, or a note) would break, as { status, error }, or
    // null when it fits. Used for uploads and for bringing a deleted item back, which must obey the same limits.
    limitProblem(stash, { file, size = 0 }) {
        const usage = this.model.usage(stash.id);
        const c = this.config;
        if (usage.items >= c.maxItemsPerStash) {
            return { status: 413, error: `This stash is full (${c.maxItemsPerStash} items). Delete something first.` };
        }
        if (!file) return null;
        if (usage.files >= c.maxFilesPerStash) return { status: 413, error: `A stash can hold ${c.maxFilesPerStash} files. Delete one first.` };
        if (usage.bytes + size > c.maxStashBytes) {
            return { status: 413, error: `This stash would pass its ${Math.round(c.maxStashBytes / 1048576)} MB limit.` };
        }
        if (this.model.totalBytes() + size > c.maxTotalBytes) return { status: 507, error: 'The server is out of file space. Try again later.' };
        return null;
    }

    // The rules about what a file is called and may be, shared by the single-request upload and the start of a resumable
    // one so they cannot drift apart. With `head` (the first bytes) the type is detected from the content; without it
    // (a resumable upload that has not sent anything yet) only the extension can be judged, and the content is checked
    // when the upload completes. Returns { fileName, mime, title } or { status, error, field? }.
    fileMeta({ rawName, rawTitle, head = null, nameError }) {
        const fileName = cleanFileName(rawName);
        if (!fileName) return { status: 400, error: nameError };

        let mime = null;
        if (head) {
            // File types are recognised from the first bytes, which is all that was kept in memory
            const detected = detectFile(fileName, head, this.config.fileTypes);
            if (detected.error) return { status: 415, error: detected.error };
            mime = detected.mime;
        } else {
            const refused = extensionProblem(fileName, this.config.fileTypes);
            if (refused) return { status: 415, error: refused };
        }

        const title = parseTitle(rawTitle);
        if (title.error) return { status: 400, error: title.error, field: 'title' };
        return { fileName, mime, title: title.value };
    }

    storeUpload(req, res, { tmp, size, head }) {
        const stash = req.stash;
        if (!size) return res.status(400).json({ error: 'The file is empty.' });

        let rawName = req.get('x-file-name') || '';
        try {
            rawName = decodeURIComponent(rawName);
        } catch {
            // keep the raw header value
        }
        // An optional title, in the X-Title header (URI-encoded, like the name)
        let rawTitle = req.get('x-title');
        if (rawTitle !== undefined) {
            try {
                rawTitle = decodeURIComponent(rawTitle);
            } catch {
                // keep the raw header value
            }
        }
        const meta = this.fileMeta({ rawName, rawTitle, head, nameError: 'The file needs a name (X-File-Name header).' });
        if (meta.error) return res.status(meta.status).json({ error: meta.error, ...(meta.field ? { field: meta.field } : {}) });

        const problem = this.limitProblem(stash, { file: true, size });
        if (problem) return res.status(problem.status).json({ error: problem.error });

        this.commitFile(req, res, { fileName: meta.fileName, mime: meta.mime, title: meta.title, tmp, size });
    }

    // Makes the finished upload an item and does everything that follows a new file: the counters, the live event, "keep
    // the last N". The same for a single request and a completed resumable upload (uploadId: the upload that ends here).
    commitFile(req, res, { fileName, mime, title, tmp, size, uploadId = null }) {
        const stash = req.stash;
        const row = this.model.addFile(stash.id, { fileName, fileType: mime, tmp, size, title, uploadId }, this.now());
        this.metrics.inc('stashly_uploads_total');
        this.metrics.inc('stashly_uploaded_bytes_total', [], size);
        const item = this.presentItem(stash.slug, row);
        this.events.publish(stash.slug, 'item-added', this.withOrigin(item, req));
        this.trim(stash);
        res.status(201).json(item);
    }

    // ---- resumable (chunked) uploads ----
    // A big file survives a bad connection: it is started with POST .../uploads (all the checks that need no bytes run
    // then), sent in pieces with PATCH (each at the offset the server expects), and made an item with .../complete.
    // The bytes wait in a partial file in the file store's tmp/; the database row only records who started it.

    // The upload ids that have a piece (or the end) being handled right now: a second request for the same upload is
    // refused (409) instead of interleaving with it
    uploadLocks = new Set();

    // Finds the upload in the URL for this stash. An id of another stash is as good as unknown, and a drop-box visitor
    // only reaches uploads started with a drop-box link (so a link cannot poke at uploads of full access).
    uploadOf = (req, res, next) => {
        const id = String(req.params.id || '');
        const row = /^[A-Za-z0-9_-]{16,64}$/.test(id) ? this.model.getUpload(req.stash.id, id) : null;
        if (!row || (req.role === 'drop' && row.role !== 'drop')) return res.status(404).json({ error: 'That upload does not exist (any more).' });
        req.openUpload = row;
        next();
    };

    // How far an upload really got: the partial file is the truth (the database only copies it). While a piece is being
    // written the last whole piece counts, never the middle of one. Null when the file is gone (the upload is dropped).
    uploadOffset(row) {
        if (this.uploadLocks.has(row.id)) return row.received;
        const size = this.model.files.partSize(row.id);
        if (size === null || size > row.size) {
            this.model.dropUploads([row.id]);
            return null;
        }
        if (size !== row.received) this.model.setUploadProgress(row.id, size, new Date(row.last_activity));
        return size;
    }

    describeUpload(row, offset) {
        return { id: row.id, offset, size: row.size, chunkSize: this.config.maxChunkBytes };
    }

    createUpload = (req, res) => {
        const stash = req.stash;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (typeof body.name !== 'string') return res.status(400).json({ error: 'Send the file name as "name".', field: 'name' });
        const size = body.size;
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
            return res.status(400).json({ error: 'Send the file size in bytes as "size".', field: 'size' });
        }
        if (!size) return res.status(400).json({ error: 'The file is empty.', field: 'size' });
        if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
            return res.status(400).json({ error: 'The title must be text.', field: 'title' });
        }

        const meta = this.fileMeta({ rawName: body.name, rawTitle: body.title, nameError: 'The file needs a name.' });
        if (meta.error) return res.status(meta.status).json({ error: meta.error, ...(meta.field ? { field: meta.field } : {}) });
        if (size > this.config.maxFileBytes) {
            return res.status(413).json({ error: `A file can be at most ${Math.round(this.config.maxFileBytes / 1048576)} MB.`, field: 'size' });
        }
        // The same limits as a single upload (items, files, stash space, server space), checked against the declared size
        const problem = this.limitProblem(stash, { file: true, size });
        if (problem) return res.status(problem.status).json({ error: problem.error });
        // Many open uploads must not be able to fill the disk together: what they declared counts against the server's space
        if (this.model.totalBytes() + this.model.reservedBytes() + size > this.config.maxTotalBytes) {
            return res.status(507).json({ error: 'The server is out of file space. Try again later.' });
        }
        if (this.model.countUploads(stash.id) >= this.config.maxOpenUploads) {
            return res.status(429).json({ error: `This stash already has ${this.config.maxOpenUploads} unfinished uploads. Finish or cancel one first.` });
        }
        if (this.model.countUploads() >= this.config.maxOpenUploadsServer) {
            return res.status(429).json({ error: 'The server has too many unfinished uploads right now. Try again later.' });
        }

        const id = crypto.randomBytes(24).toString('base64url');
        const row = this.model.createUpload({ id, stashId: stash.id, role: req.role, name: meta.fileName, title: meta.title, size }, this.now());
        res.status(201)
            .set('Location', `/api/stashes/${stash.slug}/uploads/${id}`)
            .set('Upload-Offset', '0')
            .json(this.describeUpload(row, 0));
    };

    // Where the upload stands: the point a client resumes from (also the Upload-Offset header, which HEAD sends alone)
    getUpload = (req, res) => {
        const row = req.openUpload;
        const offset = this.uploadOffset(row);
        if (offset === null) return res.status(404).json({ error: 'That upload does not exist (any more).' });
        res.set({ 'Upload-Offset': String(offset), 'Upload-Length': String(row.size) });
        res.json(this.describeUpload(row, offset));
    };

    // Refuses a piece from its Content-Length before any of the body is read
    checkChunkSize = (req, res, next) => {
        const length = Number(req.headers['content-length']);
        if (Number.isFinite(length) && length > this.config.maxChunkBytes) {
            res.set('Connection', 'close');
            return res.status(413).json({ error: `A piece can be at most ${Math.round(this.config.maxChunkBytes / 1024)} KB.` });
        }
        next();
    };

    // One piece. It is received into its own tmp file (never more than one piece is held, and never in memory) and is
    // appended to the partial file only when it arrived whole, so a piece cut off half way changes nothing: the offset
    // stays at the last whole piece and the client sends that piece again.
    patchUpload = async (req, res) => {
        const row = req.openUpload;
        if (this.uploadLocks.has(row.id)) {
            return res.status(409).json({ error: 'Another piece of this upload is still being received.', busy: true, offset: row.received });
        }
        this.uploadLocks.add(row.id);
        let piece = null;
        try {
            const offset = this.uploadOffset(row);
            if (offset === null) return res.status(404).json({ error: 'That upload does not exist (any more).' });
            const given = req.get('upload-offset');
            if (given === undefined || !/^\d{1,16}$/.test(given)) {
                return res.status(400).json({ error: 'Send the Upload-Offset header: the offset this piece starts at.', offset });
            }
            if (Number(given) !== offset) {
                return res.status(409).set('Upload-Offset', String(offset)).json({ error: 'That is not where this upload stands. Continue at the offset given.', offset });
            }
            const room = row.size - offset;
            const limit = Math.min(this.config.maxChunkBytes, room);
            const length = Number(req.headers['content-length']);
            if (room <= 0 || (Number.isFinite(length) && length > room)) {
                res.set('Connection', 'close');
                return res.status(413).json({ error: 'This piece goes past the size the upload declared.', offset });
            }
            if (Number.isFinite(length) && length === 0) return res.status(400).json({ error: 'The piece is empty.', offset });

            try {
                piece = await this.model.files.receive(req, limit);
            } catch (err) {
                if (err.code === 'TOO_LARGE') {
                    res.set('Connection', 'close');
                    const error = room < this.config.maxChunkBytes ? 'This piece goes past the size the upload declared.' : `A piece can be at most ${Math.round(this.config.maxChunkBytes / 1024)} KB.`;
                    return res.status(413).json({ error, offset });
                }
                // The client went away part way: nothing was kept, and there is nobody to answer
                if (!res.headersSent && !res.destroyed) return res.status(400).json({ error: 'The piece was interrupted. Ask for the offset and send it again.', offset });
                return;
            }
            if (!piece.size) return res.status(400).json({ error: 'The piece is empty.', offset });

            let size;
            try {
                size = await this.model.files.appendPart(row.id, piece.tmp, offset);
            } catch {
                return res.status(500).json({ error: 'Could not store the piece. Try again.', offset });
            }
            this.model.setUploadProgress(row.id, size, this.now());
            res.set('Upload-Offset', String(size)).json(this.describeUpload(row, size));
        } finally {
            if (piece) this.model.files.discard(piece.tmp);
            this.uploadLocks.delete(row.id);
        }
    };

    // The end: only when every byte is there. The type is judged from the first bytes, the limits are checked once more
    // (the stash may have filled up since), and then it becomes an item exactly like a single-request upload.
    completeUpload = (req, res) => {
        const stash = req.stash;
        const row = req.openUpload;
        if (this.uploadLocks.has(row.id)) {
            return res.status(409).json({ error: 'A piece of this upload is still being received.', busy: true, offset: row.received });
        }
        this.uploadLocks.add(row.id);
        try {
            const offset = this.uploadOffset(row);
            if (offset === null) return res.status(404).json({ error: 'That upload does not exist (any more).' });
            if (offset !== row.size) {
                return res.status(409).set('Upload-Offset', String(offset)).json({ error: 'The upload is not complete yet.', offset, size: row.size });
            }
            const meta = this.fileMeta({ rawName: row.name, rawTitle: row.title, head: this.model.files.readPartHead(row.id), nameError: 'The file needs a name.' });
            if (meta.error) {
                // The bytes will never be acceptable: nothing to keep
                this.model.dropUploads([row.id]);
                return res.status(meta.status).json({ error: meta.error });
            }
            // Over a limit now: the upload is kept, so it can be completed once there is room
            const problem = this.limitProblem(stash, { file: true, size: row.size });
            if (problem) return res.status(problem.status).json({ error: problem.error });
            this.commitFile(req, res, {
                fileName: meta.fileName, mime: meta.mime, title: meta.title, tmp: this.model.files.partPath(row.id), size: row.size, uploadId: row.id,
            });
        } finally {
            this.uploadLocks.delete(row.id);
        }
    };

    // Cancels an upload and removes what it received
    abortUpload = (req, res) => {
        const row = req.openUpload;
        if (this.uploadLocks.has(row.id)) {
            return res.status(409).json({ error: 'A piece of this upload is still being received. Try again in a moment.', busy: true });
        }
        this.model.dropUploads([row.id]);
        res.status(204).end();
    };

    // Reads one file of this stash, or null
    fileRow(req) {
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? this.model.getItem(req.stash.id, id) : null;
        return row && row.kind === 'file' ? row : null;
    }

    getFile = (req, res) => {
        const row = this.fileRow(req);
        // The size on disk is what is served; a row whose file has gone missing is the same as no file
        const length = row ? this.model.files.size(row.id) : null;
        if (length === null) return res.status(404).json({ error: 'File not found.' });

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
        const range = parseRange(req.headers.range, length);
        if (range === 'invalid') {
            res.set('Content-Range', `bytes */${length}`);
            return res.status(416).end();
        }
        if (range) {
            res.status(206).set({
                'Content-Range': `bytes ${range.start}-${range.end}/${length}`,
                'Content-Length': String(range.end - range.start + 1),
            });
        } else {
            res.set('Content-Length', String(length));
        }
        // Streamed from disk: a big file never sits in memory, and the server stays free for other requests
        pipeline(this.model.files.stream(row.id, range || null), res, () => {
            // A client that goes away part way ends the stream; nothing more to do
        });
    };

    // ---- thumbnails ----
    // The server has no image library, so the page makes the thumbnail in the browser (a canvas) and sends it here.
    // The server only checks what arrives: it must be small and must really be a JPEG, PNG or WebP.

    // Run before the body is read, so a request that is not allowed is refused without receiving it. Full access may
    // attach or replace a thumbnail on any image. A drop-box link has to be able to attach the thumbnail of what it
    // just uploaded (it cannot read anything back), so it may do so only while the image has none and is under
    // THUMB_DROP_WINDOW_MS old: it cannot overwrite or tamper with thumbnails of images it did not just add.
    thumbTarget = (req, res, next) => {
        const row = this.fileRow(req);
        if (!row) return res.status(404).json({ error: 'File not found.' });
        if (!row.file_type.startsWith('image/')) return res.status(400).json({ error: 'Only images have thumbnails.' });
        if (req.role !== 'full') {
            const age = this.now().getTime() - new Date(row.created_at).getTime();
            if (row.has_thumb || age > THUMB_DROP_WINDOW_MS) {
                return res.status(403).json({ error: 'This image already has a thumbnail, or was added too long ago for this link to give it one.', role: req.role });
            }
        }
        req.fileRow = row;
        next();
    };

    putThumb = (req, res) => {
        const stash = req.stash;
        const bytes = req.body;
        if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: 'Send the thumbnail image as the request body.' });
        // express.raw has already stopped anything over the limit (413); this is the same rule for a body that slipped by
        if (bytes.length > this.config.maxThumbBytes) {
            return res.status(413).json({ error: `A thumbnail can be at most ${Math.round(this.config.maxThumbBytes / 1024)} KB.` });
        }
        // Judged by content, never by the name or the Content-Type the sender gives: an SVG called .jpg is refused
        if (!detectThumb(bytes)) return res.status(415).json({ error: 'A thumbnail must be a JPEG, PNG or WebP image.' });
        const row = this.model.setThumb(stash.id, req.fileRow.id, bytes);
        if (!row) return res.status(404).json({ error: 'File not found.' });
        const item = this.presentItem(stash.slug, row);
        // Other open pages swap the file icon (or the full image) in their list for the new thumbnail
        this.events.publish(stash.slug, 'item-updated', item);
        res.json(item);
    };

    getThumb = async (req, res) => {
        const row = this.fileRow(req);
        if (!row || !row.has_thumb) return res.status(404).json({ error: 'No thumbnail.' });
        let bytes = null;
        try {
            bytes = await this.model.files.readThumb(row.id);
        } catch {
            // the file has gone from the disk
        }
        // The type comes from the bytes (they were checked when stored); anything else is treated as no thumbnail
        const type = detectThumb(bytes);
        if (!type) return res.status(404).json({ error: 'No thumbnail.' });
        res.set({
            'Content-Type': type,
            'Content-Disposition': `inline; filename="thumb-${row.id}"`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cache-Control': 'private, no-store',
        });
        res.send(bytes);
    };

    // The whole stash as one zip: stash.json, a text file per note and every file as it was uploaded. Burn-after-reading
    // notes are left out (reading one would use it up). The zip is written entry by entry straight to the response, and
    // each file streams from disk, so even a large stash never sits in memory. Full and read-only access may export;
    // a drop-box link cannot read, so it cannot export either.
    exportZip = async (req, res) => {
        const stash = req.stash;
        const now = this.now();
        const rows = this.model.listItems(stash.id, { now });
        const plan = planExport({ stash, rows, fileSize: id => this.model.files.size(id), now });
        // Checked before a byte is sent, so the answer can still be a clean error instead of a broken download
        if (!plan.fits) {
            return res.status(413).json({ error: 'This stash is too large to export as one zip (the limit is 4 GB or 65535 entries).' });
        }
        this.metrics.inc('stashly_exports_total');
        this.audit('stash.exported', { req, stash });
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${stash.slug}.zip"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
        });
        const zip = new ZipWriter(res, { now });
        try {
            for (const entry of plan.entries) {
                if (entry.kind === 'file') {
                    // Opened first: a file that has vanished since the listing is skipped, not left as a broken entry
                    const source = this.model.files.stream(entry.id);
                    try {
                        await once(source, 'open', { signal: zip.signal });
                    } catch (err) {
                        source.destroy();
                        if (zip.signal.aborted) throw err;
                        continue;
                    }
                    await zip.addStream(entry.name, source, { method: entry.method });
                } else {
                    await zip.addBuffer(entry.name, entry.kind === 'note' ? entry.text : entry.data, { method: entry.method });
                }
            }
            await zip.finish();
        } catch {
            // Part of the zip has already gone out, so there is no way to send an error: cut the connection, which
            // the client sees as a failed download rather than a complete-looking but short zip. Any open file was
            // closed when its stream was destroyed.
            res.destroy();
        }
    };

    // The names inside a zip file, for the preview. Nothing is unpacked.
    listArchive = async (req, res) => {
        const row = this.fileRow(req);
        if (!row) return res.status(404).json({ error: 'File not found.' });
        if (row.file_type !== 'application/zip') return res.status(400).json({ error: 'Only zip files can be listed.' });
        if (!this.model.files.exists(row.id)) return res.status(404).json({ error: 'File not found.' });
        const content = await this.model.files.readAll(row.id);
        const listing = listZip(content);
        if (listing.error) return res.status(422).json({ error: listing.error });
        res.json(listing);
    };

    latest = (req, res) => {
        // Reading a burn note deletes it, so only full access gets burn notes here
        const row = this.model.latestNote(req.stash.id, this.now(), { includeBurn: req.role === 'full' });
        if (!row) return res.status(404).type('text/plain').send('No notes yet.\n');
        if (row.burn) {
            // A GET must never change anything: a link preview, a prefetch or a retried request would use the note up.
            // Using it up takes a POST.
            if (req.method !== 'POST') {
                return res
                    .status(409)
                    .type('text/plain; charset=utf-8')
                    .send('The newest note burns after reading. Fetch it with POST (curl -X POST) to read it and delete it.\n');
            }
            this.burn(req.stash, row, req);
        }
        res.type('text/plain; charset=utf-8').send(row.text);
    };

    // Deletes a note that has been read and tells every open page
    burn(stash, row, req) {
        this.audit('item.deleted', { req, stash, detail: { kind: row.kind, reason: 'burned' } });
        // The model overwrites the text and empties the write-ahead log, so it cannot be read back from the files
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
        this.burn(req.stash, row, req);
        res.set('Cache-Control', 'no-store').json({ id: row.id, text: row.text });
    };

    // A person's delete. With undo on, the item goes to the trash for UNDO_SECONDS and can be restored; the answer says
    // until when (undoUntil, or null when it is gone for good). Never kept: burn-after-reading and secret notes (their
    // point is that they cannot be read back), and a note already past its own expiry.
    deleteItem = (req, res) => {
        const stash = req.stash;
        const id = Number(req.params.id);
        const now = this.now();
        const removed = this.removeOne(stash, id, now);
        if (!removed) return res.status(404).json({ error: 'Item not found.' });
        this.audit('item.deleted', { req, stash, detail: { kind: removed.kind, undoable: removed.undoable } });
        this.events.publish(stash.slug, 'item-deleted', { id });
        res.json({ ok: true, undoUntil: removed.undoable ? this.undoUntil(now) : null });
    };

    // Takes one item out of the stash: into the trash when it can be undone, else gone for good. Returns null when
    // there is no such item, else { kind, undoable }. The caller audits and tells the open pages.
    removeOne(stash, id, now) {
        const row = Number.isInteger(id) ? this.model.getItem(stash.id, id) : null;
        if (!row) return null;
        const expired = Boolean(row.expires_at) && row.expires_at <= now.toISOString();
        const undoable = this.config.undoSeconds > 0 && !row.burn && !row.secret && !expired;
        if (undoable) this.model.trashItem(stash.id, id, now);
        else this.model.deleteItem(stash.id, id);
        return { kind: row.kind, undoable };
    }

    undoUntil(now) {
        return new Date(now.getTime() + this.config.undoSeconds * 1000).toISOString();
    }

    // Brings a deleted item back, with the same id, place in the list and pin. It must still be inside the undo window,
    // and the stash's limits are checked again, because things may have been added since.
    restore = (req, res) => {
        const stash = req.stash;
        const result = this.restoreOne(stash, Number(req.params.id), this.now());
        if (result.error) return res.status(result.status).json({ error: result.error });
        this.audit('item.restored', { req, stash, detail: { kind: result.row.kind } });
        const item = this.presentItem(stash.slug, result.row);
        this.events.publish(stash.slug, 'item-added', this.withOrigin(item, req));
        res.json(item);
    };

    // Puts one trashed item back. Returns { row } or { status, error }. The caller audits and tells the open pages.
    restoreOne(stash, id, now) {
        const gone = { status: 404, error: 'That item cannot be brought back any more.' };
        const seconds = this.config.undoSeconds;
        const row = seconds > 0 && Number.isInteger(id) ? this.model.getTrashed(stash.id, id, new Date(now.getTime() - seconds * 1000)) : null;
        if (!row) return gone;
        // Gone for good if its own expiry passed meanwhile, or its file has vanished from the disk
        if ((row.expires_at && row.expires_at <= now.toISOString()) || (row.kind === 'file' && !this.model.files.exists(id))) {
            this.model.dropTrashed(stash.id, id);
            return gone;
        }
        const problem = this.limitProblem(stash, { file: row.kind === 'file', size: row.file_size });
        if (problem) return { status: problem.status, error: problem.error };
        // "Keep the last N" is not applied here: the item would often be the oldest and vanish again at once. The next
        // new item trims the stash as usual.
        return { row: this.model.restoreItem(stash.id, id) };
    }

    // Many clips at once: delete them, bring deleted ones back (the Undo of a bulk delete), or pin or unpin them. The
    // body is { action: 'delete' | 'restore' | 'pin' | 'unpin', ids: [...] }. Each clip follows the same rules as doing
    // it one by one; clips that are no longer there are skipped, not an error, so a list that is a little out of date
    // still works. One audit line and one live event per clip.
    bulkItems = (req, res) => {
        const stash = req.stash;
        const action = req.body && req.body.action;
        const ids = req.body && req.body.ids;
        if (!['delete', 'restore', 'pin', 'unpin', 'tag', 'untag'].includes(action)) {
            return res.status(400).json({ error: 'Say what to do: delete, restore, pin, unpin, tag or untag.' });
        }
        if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BULK || !ids.every(id => Number.isInteger(id) && id > 0)) {
            return res.status(400).json({ error: `Send between 1 and ${MAX_BULK} clip ids.` });
        }
        const unique = Array.from(new Set(ids));
        const now = this.now();

        if (action === 'delete') {
            const deleted = [];
            const undoable = [];
            const missing = [];
            unique.forEach(id => {
                const removed = this.removeOne(stash, id, now);
                if (!removed) { missing.push(id); return; }
                deleted.push(id);
                if (removed.undoable) undoable.push(id);
                this.events.publish(stash.slug, 'item-deleted', { id });
            });
            if (deleted.length) this.audit('items.deleted', { req, stash, detail: { count: deleted.length, undoable: undoable.length } });
            return res.json({ deleted, undoable, missing, undoUntil: undoable.length ? this.undoUntil(now) : null });
        }

        if (action === 'restore') {
            const items = [];
            const missing = [];
            let problem = null;
            for (const id of unique) {
                const result = this.restoreOne(stash, id, now);
                if (result.error) {
                    // A limit (too many items, too much space) applies to the rest as well: stop there
                    if (result.status !== 404) { problem = result; break; }
                    missing.push(id);
                    continue;
                }
                const item = this.presentItem(stash.slug, result.row);
                items.push(item);
                this.events.publish(stash.slug, 'item-added', this.withOrigin(item, req));
            }
            if (items.length) this.audit('items.restored', { req, stash, detail: { count: items.length } });
            return res.json({ items, missing, error: problem ? problem.error : null });
        }

        if (action === 'tag' || action === 'untag') {
            // One tag added to, or removed from, every named clip. A clip already at the tag limit is reported in `full`.
            const tag = parseTag(req.body.tag);
            if (tag.error) return res.status(400).json({ error: tag.error, field: 'tag' });
            const items = [];
            const missing = [];
            const full = [];
            unique.forEach(id => {
                const live = this.model.getLiveItem(stash.id, id, now);
                const changed = live ? this.model.changeTag(stash.id, id, tag.value, action === 'tag', MAX_TAGS) : null;
                if (!changed) { missing.push(id); return; }
                if (changed.full) { full.push(id); return; }
                const item = this.presentItem(stash.slug, changed);
                items.push(item);
                this.events.publish(stash.slug, 'item-updated', item);
            });
            return res.json({ items, missing, full });
        }

        const pinned = action === 'pin';
        const items = [];
        const missing = [];
        unique.forEach(id => {
            const row = this.model.getLiveItem(stash.id, id, now);
            const updated = row ? this.model.setPinned(stash.id, id, pinned) : null;
            if (!updated) { missing.push(id); return; }
            const item = this.presentItem(stash.slug, updated);
            items.push(item);
            this.events.publish(stash.slug, 'item-updated', item);
        });
        res.json({ items, missing });
    };

    extend = (req, res) => {
        const stash = this.model.extend(req.stash.id, this.now());
        if (!stash) return res.status(400).json({ error: 'This stash never expires, so there is nothing to extend.' });
        this.events.publish(stash.slug, 'stash-extended', { expiresAt: stash.expires_at });
        res.json({ expiresAt: stash.expires_at });
    };

    remove = (req, res) => {
        const stash = req.stash;
        this.model.deleteStash(stash.id, this.now());
        this.audit('stash.deleted', { req, stash, detail: { reason: 'visitor' } });
        this.events.closeAll(stash.slug, 'stash-gone', { reason: 'deleted' });
        res.json({ ok: true });
    };

    stream = (req, res) => {
        const slug = req.stash.slug;
        // Checked on every heartbeat: an expired sign-in, a revoked link or a deleted stash ends the stream instead of
        // letting it keep receiving notes. 'view' and 'full' are the roles that may read.
        const verify = () => {
            const stash = this.model.findBySlug(slug);
            if (!stash) return 'stash-gone';
            if (stash.expires_at && stash.expires_at <= this.now().toISOString()) return 'stash-gone';
            // The signed-in user is looked up again, so a user who was disabled or signed out stops receiving
            const user = this.userAuth ? this.userAuth.resolve(req) : null;
            return ['full', 'view'].includes(this.roleOf(req, stash, user)) ? null : 'access-changed';
        };
        this.events.subscribe(slug, req, res, {
            verify,
            ip: req.ip,
            maxPerStash: this.config.maxStreamsPerStash,
            maxPerIp: this.config.maxStreamsPerIp,
        });
    };

    // Called on a timer: removes stashes whose time is up and tells anyone still looking at them
    cleanup = () => {
        const removed = this.model.purgeExpired(this.now());
        for (const slug of removed) {
            this.audit('stash.deleted', { stash: slug, actor: 'system', detail: { reason: 'expired' } });
            this.events.closeAll(slug, 'stash-gone', { reason: 'expired' });
        }
        for (const item of this.model.purgeExpiredItems(this.now())) this.events.publish(item.slug, 'item-deleted', { id: item.id });
        // Deleted items whose undo time is up are removed for good (with undo turned off, everything waiting goes)
        this.model.purgeTrash(new Date(this.now().getTime() - this.config.undoSeconds * 1000));
        // Resumable uploads that got no new piece for UPLOAD_IDLE_HOURS are given up (one with a piece arriving is left)
        const idle = this.model.idleUploads(new Date(this.now().getTime() - this.config.uploadIdleHours * HOUR));
        this.model.dropUploads(idle.filter(id => !this.uploadLocks.has(id)));
        // Names reserved long enough are free again
        if (this.config.reserveOldNamesDays) this.model.purgeRetired(new Date(this.now().getTime() - this.config.reserveOldNamesDays * DAY));
        // Forget wrong-password counts whose window has passed
        this.lockout.sweep();
        return removed;
    };
}

module.exports = StashController;
