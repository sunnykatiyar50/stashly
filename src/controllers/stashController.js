const { generateSlug, parseSlug } = require('../utils/slug');
const { hashPassword, verifyPassword, MAX_PASSWORD } = require('../utils/password');
const { signToken, verifyToken, parseCookies, generateLinkToken, hashLinkToken, linkTokenMatches } = require('../utils/token');
const { detectFile, cleanFileName } = require('../utils/fileType');
const { dateRange } = require('../utils/time');
const { parseTitle, deriveTitle } = require('../utils/title');
const { listZip } = require('../utils/zip');

// Three cookies per stash: full access (the password), or one of the two share links. The names cannot collide,
// because the prefixes differ before the stash name starts.
const cookieName = slug => `stashly_${slug}`;
const ROLE_COOKIES = { view: slug => `stashlyv_${slug}`, drop: slug => `stashlyd_${slug}` };
// What a share link signs: its own label plus the hash of its token, so a new link voids cookies from the old one
const roleSubject = (slug, kind) => `${slug}:${kind}`;
const DAY = 24 * 60 * 60 * 1000;
// The most clips one reorder may move (a stash holds at most a few thousand; a page shows them all)
const MAX_REORDER = 5000;
// The most items one listing can be asked for with `limit` (the extension asks for a few; without a limit, all come)
const MAX_LIST_LIMIT = 200;

// The optional `limit` of a listing: undefined for none, a whole number from 1 to MAX_LIST_LIMIT, or an error
function parseLimit(value) {
    if (value === undefined || value === null || value === '') return { value: undefined };
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return { error: `limit must be a whole number from 1 to ${MAX_LIST_LIMIT}.` };
    return { value: Math.min(n, MAX_LIST_LIMIT) };
}
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
    constructor({ model, events, config, secret, now = () => new Date(), isAdmin = () => false }) {
        this.isAdmin = isAdmin;
        this.model = model;
        this.events = events;
        this.config = config;
        this.secret = secret;
        this.now = now;
        this.failures = new Map(); // slug -> { start, count } of wrong passwords
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
            // Notes: the given title, or the first words of the text when there is none.
            // Files: the given title, or the file's name.
            title: isFile ? row.title || row.file_name : row.title || generic || deriveTitle(row.text),
            hasTitle: Boolean(row.title),
            text: isFile || burn ? null : row.text,
            burn,
            secret,
            pinned: Boolean(row.pinned),
            // The item's place in the list (higher is nearer the top); the page sorts by it
            order: row.sort_order,
            editedAt: row.edited_at || null,
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
            this.model.deleteStash(stash.id, this.now());
            this.events.closeAll(stash.slug, 'stash-gone', { reason: 'expired' });
            return res.status(404).json({ error: 'This stash has expired or does not exist.' });
        }
        if (!stash) return res.status(404).json({ error: 'This stash has expired or does not exist.' });
        req.stash = stash;
        next();
    };

    // What this visitor may do in this stash: 'full' (no password, or unlocked), 'view' (a read-only link),
    // 'drop' (a drop-box link: can add, cannot read) or null (locked out).
    roleOf(req, stash) {
        return this.access(req, stash).role;
    }

    // The role, plus the valid sign-in token it came from ({ expiresAt, signedInAt }; none for a stash with no password)
    access(req, stash) {
        if (!stash.password_hash) return { role: 'full', token: null };
        const cookies = parseCookies(req.headers.cookie);
        const now = this.now().getTime();
        const full = verifyToken(this.secret, stash.slug, this.saltFor(stash, 'full'), cookies[cookieName(stash.slug)], now);
        if (full) return { role: 'full', token: full };
        for (const kind of ['view', 'drop']) {
            if (!stash[`${kind}_token_hash`]) continue;
            const token = verifyToken(this.secret, roleSubject(stash.slug, kind), this.saltFor(stash, kind), cookies[ROLE_COOKIES[kind](stash.slug)], now);
            if (token) return { role: kind, token };
        }
        return { role: null, token: null };
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
            // false when only the admin may create stashes and the visitor is not signed in as admin
            canCreate: this.canCreate(req),
            adminEnabled: Boolean(this.config.adminPassword),
        });
    };

    canCreate(req) {
        return !this.config.requireAdminToCreate || this.isAdmin(req);
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

    // Wrong passwords for one stash, counted across every visitor. Held in memory, so a restart clears it.
    lockedFor(slug) {
        const max = this.config.stashUnlockFailures;
        const entry = this.failures.get(slug);
        if (!max || !entry) return 0;
        const now = this.now().getTime();
        if (now - entry.start >= this.config.stashUnlockWindowMs) {
            this.failures.delete(slug);
            return 0;
        }
        return entry.count >= max ? entry.start + this.config.stashUnlockWindowMs - now : 0;
    }

    noteFailure(slug) {
        const now = this.now().getTime();
        const entry = this.failures.get(slug);
        if (!entry || now - entry.start >= this.config.stashUnlockWindowMs) this.failures.set(slug, { start: now, count: 1 });
        else entry.count += 1;
    }

    unlock = async (req, res) => {
        const stash = req.stash;
        if (!stash.password_hash) return res.json({ ok: true, hasPassword: false });
        // Too many wrong passwords for this stash: refuse before even checking, so guessing gets nowhere
        const wait = this.lockedFor(stash.slug);
        if (wait) {
            const minutes = Math.max(1, Math.ceil(wait / 60000));
            return res
                .status(429)
                .set('Retry-After', String(Math.ceil(wait / 1000)))
                .json({ error: `Too many wrong passwords for this stash. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`, locked: true });
        }
        const password = req.body && req.body.password;
        const session = this.sessionOptionFor(req.body && req.body.session);
        if (!session) return res.status(400).json({ error: 'Pick one of the listed session lengths.', field: 'session' });
        if (!(await verifyPassword(password, stash.password_hash, stash.password_salt))) {
            this.noteFailure(stash.slug);
            return res.status(401).json({ error: 'That password is not right.', locked: true });
        }
        this.failures.delete(stash.slug);
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

        const end = this.sessionEnd(req, stash, 'full');
        const remaining = end ? Math.max(0, new Date(end).getTime() - this.now().getTime()) : this.sessionMs(null);
        let updated;
        try {
            updated = this.model.renameStash(stash.id, parsed.slug, this.now());
        } catch (err) {
            if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message, field: 'slug' });
            throw err;
        }

        // A wrong-password count belongs to the stash, not the name
        const failures = this.failures.get(stash.slug);
        if (failures) {
            this.failures.delete(stash.slug);
            this.failures.set(updated.slug, failures);
        }
        for (const kind of ['full', 'view', 'drop']) res.clearCookie(this.cookieFor(stash.slug, kind), { path: '/' });
        if (updated.password_hash) this.setAccessCookie(req, res, updated, 'full', remaining, this.signedInAt(req));
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
        const wait = this.lockedFor(stash.slug);
        if (wait) {
            const minutes = Math.max(1, Math.ceil(wait / 60000));
            return res
                .status(429)
                .set('Retry-After', String(Math.ceil(wait / 1000)))
                .json({ error: `Too many wrong passwords for this stash. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` });
        }
        if (!(await verifyPassword(currentPassword, stash.password_hash, stash.password_salt))) {
            this.noteFailure(stash.slug);
            return res.status(401).json({ error: 'That is not the current password.', field: 'currentPassword' });
        }
        if (newPassword === currentPassword) {
            return res.status(400).json({ error: 'The new password is the same as the current one.', field: 'newPassword' });
        }

        // This browser stays signed in for as long as it had left; everyone else is signed out (a new password means a
        // new salt, which the sign-in cookies are tied to), and the read-only and drop-box links are cancelled
        const end = this.sessionEnd(req, stash, 'full');
        const remaining = end ? Math.max(0, new Date(end).getTime() - this.now().getTime()) : this.sessionMs(null);
        const hashed = await hashPassword(newPassword);
        const updated = this.model.setPassword(stash.id, hashed.hash, hashed.salt);
        this.failures.delete(stash.slug);
        const ends = this.setAccessCookie(req, res, updated, 'full', remaining, this.signedInAt(req));
        this.events.closeAll(stash.slug, 'access-changed', { origin: this.withOrigin({}, req).origin });
        res.json({ ok: true, sessionEndsAt: new Date(ends).toISOString() });
    };

    // Ends every other sign-in to this stash (other browsers, a forgotten shared computer, a copied cookie), and the
    // sessions opened from read-only and drop-box links. This browser stays signed in for the time it had left. The
    // links themselves still work; cancel them under Share links to stop new visits.
    signOutOthers = (req, res) => {
        const stash = req.stash;
        if (!stash.password_hash) return res.status(400).json({ error: 'This stash has no password, so nobody is signed in to it.' });
        const end = this.sessionEnd(req, stash, 'full');
        const remaining = end ? Math.max(0, new Date(end).getTime() - this.now().getTime()) : this.sessionMs(null);
        const updated = this.model.bumpSessionVersion(stash.id);
        const ends = this.setAccessCookie(req, res, updated, 'full', remaining, this.signedInAt(req));
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
        // The token is shown once. It is in the fragment (#), which browsers never send to the server.
        res.status(201).json({ kind, token, path: `/s/${stash.slug}#${kind}=${token}` });
    };

    revokeShareLink = (req, res) => {
        const kind = req.params.kind;
        if (!['view', 'drop'].includes(kind)) return res.status(404).json({ error: 'No such link.' });
        this.model.setShareToken(req.stash.id, kind, null);
        res.json({ ok: true });
    };

    get = (req, res) => {
        const stash = req.stash;
        // The page sends its search in the body (POST .../query), so the words never appear in an address that a
        // proxy logs; GET with ?search= still works for scripts
        const input = req.method === 'POST' ? req.body || {} : req.query;
        const range = dateRange(input);
        if (range.error) return res.status(400).json({ error: range.error });
        const search = typeof input.search === 'string' ? input.search.trim().slice(0, 200) : '';
        // Optional: only the first `limit` items (pinned, then newest), with `total` still counting every match
        const limit = parseLimit(input.limit);
        if (limit.error) return res.status(400).json({ error: limit.error, field: 'limit' });

        // A drop-box visitor can add but not read: they get the stash's shape and no items or counts
        const dropOnly = req.role === 'drop';
        const filters = { search, from: range.from, to: range.to, now: this.now() };
        const rows = dropOnly ? [] : this.model.listItems(stash.id, { ...filters, limit: limit.value });
        const total = dropOnly ? 0 : limit.value && rows.length === limit.value ? this.model.countItems(stash.id, filters) : rows.length;
        res.json({
            slug: stash.slug,
            role: req.role,
            hasPassword: Boolean(stash.password_hash),
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
            total,
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

    // Edits a note's title and text in place, or a file's title. Burn notes cannot be edited: their text is not on
    // the page to change.
    editNote = (req, res) => {
        const stash = req.stash;
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? this.model.getLiveItem(stash.id, id, this.now()) : null;
        if (!row) return res.status(404).json({ error: 'Item not found.' });
        if (row.kind === 'file') return this.editFileTitle(req, res, row);
        if (row.burn) return res.status(400).json({ error: 'A burn-after-reading note cannot be edited.' });
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

        // An optional title, in the X-Title header (URI-encoded, like the name)
        let rawTitle = req.get('x-title');
        if (rawTitle !== undefined) {
            try {
                rawTitle = decodeURIComponent(rawTitle);
            } catch {
                // keep the raw header value
            }
        }
        const title = parseTitle(rawTitle);
        if (title.error) return res.status(400).json({ error: title.error, field: 'title' });

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

        const row = this.model.addFile(stash.id, { fileName, fileType: detected.mime, content, title: title.value }, this.now());
        const item = this.presentItem(stash.slug, row);
        this.events.publish(stash.slug, 'item-added', this.withOrigin(item, req));
        this.trim(stash);
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
        // Reading a burn note this way deletes it, so only full access gets burn notes here
        const row = this.model.latestNote(req.stash.id, this.now(), { includeBurn: req.role === 'full' });
        if (!row) return res.status(404).type('text/plain').send('No notes yet.\n');
        // Reading a burn-after-reading note this way uses it up
        if (row.burn) this.burn(req.stash, row);
        res.type('text/plain; charset=utf-8').send(row.text);
    };

    // Deletes a note that has been read and tells every open page
    burn(stash, row) {
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
        this.model.deleteStash(stash.id, this.now());
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
        // Names reserved long enough are free again
        if (this.config.reserveOldNamesDays) this.model.purgeRetired(new Date(this.now().getTime() - this.config.reserveOldNamesDays * DAY));
        // Forget wrong-password counts whose window has passed
        const window = this.config.stashUnlockWindowMs;
        for (const [slug, entry] of this.failures) if (this.now().getTime() - entry.start >= window) this.failures.delete(slug);
        return removed;
    };
}

module.exports = StashController;
