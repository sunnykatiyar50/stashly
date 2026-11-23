// Accounts: sign in and out, change your own password, follow stashes and see them on one page, and (for admins) manage
// the users. No handler ever returns a password, a hash or a salt, and none puts a username, password, token or stash
// name in the audit log (a user is named there by id, a stash by the usual keyed hash).
const { hashPassword, verifyPassword, MAX_PASSWORD } = require('../utils/password');
const { linkTokenMatches } = require('../utils/token');
const { UnlockLockout } = require('../utils/lockout');
const { noopAudit } = require('../utils/auditLog');
const { noopMetrics } = require('../utils/metrics');
const { grantRole, normalizeUsername, USERNAME_PATTERN, ROLES } = require('../models/userModel');
const MAX_PINS = 20;

const GENERIC_LOGIN_ERROR = 'That username or password is not right.';
const NOT_ENABLED = 'Accounts are not enabled on this server.';
const MAX_DISPLAY_NAME = 60;
const MANAGED_MESSAGE = 'This account is set by ADMIN_USERNAME and ADMIN_PASSWORD in the server environment.';

// Ids are numbers in the address; anything else is "no such user"
const idOf = req => {
    const id = Number(req.params.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// The optional display name: undefined stays undefined (no change), null or empty clears it
function parseDisplayName(value) {
    if (value === undefined) return { value: undefined };
    if (value === null || value === '') return { value: null };
    if (typeof value !== 'string') return { error: 'The display name must be text.' };
    const name = value.trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return { error: 'The display name cannot hold control characters.' };
    if (name.length > MAX_DISPLAY_NAME) return { error: `The display name can be at most ${MAX_DISPLAY_NAME} characters.` };
    return { value: name || null };
}

// A read-only or drop-box link as people have it: the token itself, or the whole address ".../s/NAME#view=TOKEN".
// Parsed leniently. Returns { kind: 'view' | 'drop' | null, token } (kind is null for a bare token) or null.
function parseLink(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim().slice(0, 2000);
    const tagged = /[#&?](view|drop)=([A-Za-z0-9_-]{16,128})/.exec(text);
    if (tagged) return { kind: tagged[1], token: tagged[2] };
    return /^[A-Za-z0-9_-]{16,128}$/.test(text) ? { kind: null, token: text } : null;
}

// The stash name out of a whole address (".../s/NAME#..."), or the text itself when it is already a name
function slugFrom(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    const inAddress = /\/s\/([^/?#\s]+)/.exec(text);
    let name = inAddress ? inAddress[1] : text;
    try {
        name = decodeURIComponent(name);
    } catch {
        // keep it as typed
    }
    return name.toLowerCase().slice(0, 100);
}

class UserController {
    // stashes: the StashController, so following uses its lockout counters and its rules for who may do what
    constructor({ model, users, userAuth, adminAuth, config, stashes, now = () => new Date(), audit = noopAudit, metrics = noopMetrics }) {
        this.model = model;
        this.users = users;
        this.userAuth = userAuth;
        this.adminAuth = adminAuth;
        this.config = config;
        this.stashes = stashes;
        this.now = now;
        this.audit = audit;
        this.metrics = metrics;
        // The wrong-password counts of sign-ins, in their own instance of the stash lockout (same rules, same settings).
        // Keyed "user:<username>", so a username's counts can never meet a stash's.
        this.lockout = new UnlockLockout({ config, now });
        this.dummy = null;
    }

    // A real hash to check against when the username does not exist, so an unknown username costs the same scrypt work
    // as a wrong password and the response time does not tell the two apart
    dummyCredentials() {
        if (!this.dummy) this.dummy = hashPassword('not-a-real-password-for-timing-only');
        return this.dummy;
    }

    cleanup = () => this.lockout.sweep();

    // ---- guards ----

    enabledOnly = (req, res, next) => {
        if (!this.userAuth.enabled) return res.status(404).json({ error: NOT_ENABLED });
        next();
    };

    requireUser = (req, res, next) => {
        if (!this.userAuth.enabled) return res.status(404).json({ error: NOT_ENABLED });
        if (!req.user) return res.status(401).json({ error: 'Sign in first.', signedIn: false });
        next();
    };

    refuseIfLocked(res, key, ip) {
        const wait = this.lockout.locked(key, ip);
        if (!wait) return false;
        const minutes = Math.max(1, Math.ceil(wait / 60000));
        res.status(429)
            .set('Retry-After', String(Math.ceil(wait / 1000)))
            .json({ error: `Too many wrong attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` });
        return true;
    }

    // ---- signing in ----

    login = async (req, res) => {
        const body = req.body || {};
        const username = normalizeUsername(body.username);
        if (!username || typeof body.password !== 'string' || !body.password) {
            return res.status(400).json({ error: 'Enter your username and password.' });
        }
        // Counted for the name as typed, whether or not such a user exists, so the lockout does not reveal which names exist
        const key = `user:${username.slice(0, 80)}`;
        if (this.refuseIfLocked(res, key, req.ip)) return;

        const user = this.users.findByUsername(username);
        const target = user || (await this.dummyCredentials());
        const matches = await verifyPassword(body.password, target.password_hash || target.hash, target.password_salt || target.salt);
        if (!user || user.disabled || !matches) {
            const wasLocked = this.lockout.locked(key, req.ip) > 0;
            this.lockout.note(key, req.ip);
            this.metrics.inc('stashly_user_logins_total', ['failure']);
            this.audit('user.login_failed', { req, actor: 'visitor', detail: { via: 'login' } });
            if (!wasLocked && this.lockout.locked(key, req.ip) > 0) this.audit('user.locked_out', { req, actor: 'visitor' });
            // The same answer for an unknown name, a wrong password and a disabled account
            return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
        }
        this.lockout.clear(key);
        this.users.touchLogin(user.id, this.now());
        this.userAuth.startSession(req, res, user);
        this.metrics.inc('stashly_user_logins_total', ['success']);
        this.audit('user.login_succeeded', { req, actor: 'user', detail: { user: user.id } });
        res.json({ ok: true, user: this.userAuth.present(user) });
    };

    logout = (req, res) => {
        if (req.user) this.audit('user.logout', { req, actor: 'user', detail: { user: req.user.id } });
        this.userAuth.endSession(res);
        res.json({ ok: true });
    };

    // 200 either way, so a page can ask who is signed in
    me = (req, res) => {
        if (!this.userAuth.enabled) return res.json({ enabled: false });
        res.json({ enabled: true, user: req.user || null });
    };

    // Changes your own password. The current one is asked for again (a browser someone walked away from cannot be used
    // to take the account over), wrong guesses count towards the sign-in lockout, and every other session ends while
    // this one carries on.
    changePassword = async (req, res) => {
        // The environment's admin account has the password ADMIN_PASSWORD; changing it here would be undone at the next start
        if (req.user.managed) return res.status(409).json({ error: MANAGED_MESSAGE });
        const { currentPassword, newPassword } = req.body || {};
        const min = this.config.minPasswordLength;
        if (typeof newPassword !== 'string' || newPassword.length < min || newPassword.length > MAX_PASSWORD) {
            return res.status(400).json({ error: `The new password must be ${min} to ${MAX_PASSWORD} characters.`, field: 'newPassword' });
        }
        const user = this.users.findById(req.user.id);
        const key = `user:${user.username}`;
        if (this.refuseIfLocked(res, key, req.ip)) return;
        if (!(await verifyPassword(currentPassword, user.password_hash, user.password_salt))) {
            this.lockout.note(key, req.ip);
            this.audit('user.login_failed', { req, actor: 'user', detail: { via: 'password_change', user: user.id } });
            return res.status(401).json({ error: 'That is not your current password.', field: 'currentPassword' });
        }
        if (newPassword === currentPassword) {
            return res.status(400).json({ error: 'The new password is the same as the current one.', field: 'newPassword' });
        }
        const hashed = await hashPassword(newPassword);
        const updated = this.users.setPassword(user.id, hashed.hash, hashed.salt);
        this.lockout.clear(key);
        this.userAuth.startSession(req, res, updated);
        this.audit('user.password_changed', { req, actor: 'user', detail: { user: user.id } });
        res.json({ ok: true });
    };

    // ---- following stashes ----

    // What the snapshot of a grant holds (see grantRole in models/userModel.js)
    snapshot(stash, role) {
        return {
            role,
            salt: stash.password_salt || null,
            version: stash.session_version || 0,
            viewHash: role === 'view' ? stash.view_token_hash : null,
        };
    }

    // Follow a stash, proving access the way the stash asks for it: nothing for a stash with no password (the name is the
    // proof), the password, or a read-only link. { current: true } follows with the access this browser already has
    // (the stash page's Follow button). Wrong passwords count towards the same lockout as unlocking, so this cannot be
    // used to guess a password more cheaply than the unlock form allows.
    follow = async (req, res) => {
        const body = req.body || {};
        const link = parseLink(body.link);
        const slug = slugFrom(body.slug) || slugFrom(typeof body.link === 'string' ? body.link : '');
        if (!slug) return res.status(400).json({ error: 'Enter the stash name.', field: 'slug' });
        const stash = this.stashes.liveStash(slug);
        if (!stash) return res.status(404).json({ error: 'This stash has expired or does not exist.' });
        // So the access log tags this request with the stash (as a hash) like any other stash request
        req.stash = stash;

        // A stash you made is always in your list, with full access: there is nothing to follow
        if (this.stashes.ownedBy(req.user, stash)) {
            this.users.ensureOwnerFollows(req.user.id);
            return res.json({ ok: true, slug: stash.slug, role: 'full', owned: true });
        }

        let role = null;
        if (body.current === true) {
            const access = this.stashes.access(req, stash);
            role = access.role;
            if (role === 'drop') return res.status(400).json({ error: 'A drop-box link cannot be followed: there is nothing in it to read.' });
            if (!role) return res.status(401).json({ error: 'This stash is locked. Enter the password.', locked: true });
        } else if (!stash.password_hash) {
            role = 'full';
        } else {
            const password = typeof body.password === 'string' && body.password ? body.password : null;
            if (!password && !link) return res.status(401).json({ error: 'This stash is locked. Enter the password or a read-only link.', locked: true });
            if (this.stashes.refuseIfLocked(req, res, { locked: true })) return;
            if (password) {
                if (!(await verifyPassword(password, stash.password_hash, stash.password_salt))) {
                    this.stashes.noteFailure(req, stash, 'follow');
                    return res.status(401).json({ error: 'That password is not right.', locked: true });
                }
                this.stashes.lockout.clear(stash.slug);
                role = 'full';
            } else {
                // A drop-box token is checked too, only to say that it cannot be followed
                const kinds = link.kind ? [link.kind] : ['view', 'drop'];
                const kind = kinds.find(k => linkTokenMatches(link.token, stash[`${k}_token_hash`]));
                if (!kind) {
                    this.stashes.noteFailure(req, stash, 'follow');
                    return res.status(401).json({ error: 'That link is not valid any more.', locked: true });
                }
                if (kind === 'drop') return res.status(400).json({ error: 'A drop-box link cannot be followed: there is nothing in it to read.' });
                role = 'view';
            }
        }

        req.role = role;
        this.users.follow(req.user.id, stash.id, this.snapshot(stash, role), this.now());
        this.audit('user.followed', { req, stash, actor: 'user', detail: { user: req.user.id, role } });
        res.json({ ok: true, slug: stash.slug, role });
    };

    unfollow = (req, res) => {
        const stash = this.model.findBySlug(String(req.params.slug || '').toLowerCase());
        // Your own stashes stay in your list: only stashes made by someone else (or a guest) can be unfollowed
        if (stash && this.stashes.ownedBy(req.user, stash)) {
            return res.status(409).json({ error: 'You made this stash, so it stays in your list.', owned: true });
        }
        // Unfollowing something that is not followed (or gone) is fine: the list ends up without it either way
        if (stash && this.users.unfollow(req.user.id, stash.id)) this.audit('user.unfollowed', { req, stash, actor: 'user', detail: { user: req.user.id } });
        res.json({ ok: true });
    };

    // The stash page calls this after it loads (and while it is open), so "new" counts only what arrived since the
    // user last looked
    seen = (req, res) => {
        const stash = this.model.findBySlug(String(req.params.slug || '').toLowerCase());
        if (stash) this.users.markSeen(req.user.id, stash.id, this.now());
        res.json({ ok: true });
    };

    // Pin (PUT) or unpin (DELETE) a stash in your list. Only stashes already in the list can be pinned, and only a few.
    pin = (req, res) => this.setPin(req, res, true);
    unpin = (req, res) => this.setPin(req, res, false);

    setPin(req, res, pinned) {
        const stash = this.model.findBySlug(String(req.params.slug || '').toLowerCase());
        if (stash) this.users.ensureOwnerFollows(req.user.id);
        const row = stash ? this.users.getFollow(req.user.id, stash.id) : null;
        if (!row) return res.status(404).json({ error: 'That stash is not in your list.' });
        if (pinned && !row.pinned_at && this.users.countPinned(req.user.id) >= MAX_PINS) {
            return res.status(409).json({ error: 'You can pin up to ' + MAX_PINS + ' stashes. Unpin one first.' });
        }
        this.users.setPinned(req.user.id, stash.id, pinned, this.now());
        res.json({ ok: true, pinned });
    }

    // The dashboard. A grant that no longer works shows only that the password is needed again: no counts, no times, so
    // nothing about a stash leaks to someone who can no longer open it. Working grants come first, newest activity first.
    listStashes = (req, res) => {
        // Own stashes are always listed: make sure each has its row before reading the list
        this.users.ensureOwnerFollows(req.user.id);
        const rows = this.users.listFollows(req.user.id, this.now());
        const out = rows.map(row => {
            const owned = row.owner_id === req.user.id;
            // The owner needs no password, so an owned stash never "needs the password again"
            const role = owned ? 'full' : grantRole(row, row);
            if (!role) return { slug: row.slug, role: null, needsPassword: true, owned: false, addedAt: row.added_at, pinned: Boolean(row.pinned_at) };
            return {
                slug: row.slug,
                owned,
                role,
                needsPassword: false,
                hasPassword: Boolean(row.password_hash),
                items: row.items,
                files: row.files,
                newItems: row.new_items,
                latestAt: row.latest_at || null,
                expiresAt: row.expires_at || null,
                addedAt: row.added_at,
                pinned: Boolean(row.pinned_at),
            };
        });
        const pinnedAt = new Map(rows.map(row => [row.slug, row.pinned_at || '']));
        const key = row => row.latestAt || row.addedAt;
        out.sort((a, b) => {
            // Pinned ones first (the one pinned first on top), then your own stashes, then the ones you follow that still open, then the ones that need the password
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            if (a.pinned) return pinnedAt.get(a.slug) < pinnedAt.get(b.slug) ? -1 : 1;
            if (Boolean(a.owned) !== Boolean(b.owned)) return a.owned ? -1 : 1;
            if (a.needsPassword !== b.needsPassword) return a.needsPassword ? 1 : -1;
            return key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0;
        });
        res.json({ stashes: out });
    };

    // ---- admin: manage users ----

    presentAdmin(row) {
        return {
            id: row.id,
            username: row.username,
            displayName: row.display_name || null,
            role: row.role,
            disabled: Boolean(row.disabled),
            // Set in the server's environment: the page shows no buttons for it
            managed: Boolean(row.managed),
            createdAt: row.created_at,
            lastLoginAt: row.last_login_at || null,
            stashCount: row.stash_count !== undefined ? row.stash_count : undefined,
        };
    }

    // True for the ADMIN_PASSWORD admin. A user with the admin role has no such standing: they cannot take their own
    // admin rights, access or account away.
    isRoot(req) {
        return this.adminAuth.isRoot(req);
    }

    // Finds the user in the address, or answers 404
    target(req, res) {
        const id = idOf(req);
        const user = id ? this.users.findById(id) : null;
        if (!user) res.status(404).json({ error: 'There is no such user.' });
        return user;
    }

    // Like target(), for the actions that change an account: the environment's admin account cannot be changed here
    editable(req, res) {
        const user = this.target(req, res);
        if (!user) return null;
        if (user.managed) {
            res.status(409).json({ error: MANAGED_MESSAGE });
            return null;
        }
        return user;
    }

    isSelf(req, user) {
        return Boolean(req.user) && req.user.id === user.id && !this.isRoot(req);
    }

    list = (req, res) => {
        res.json({ users: this.users.list().map(row => this.presentAdmin(row)) });
    };

    create = async (req, res) => {
        const body = req.body || {};
        const username = normalizeUsername(body.username);
        if (!USERNAME_PATTERN.test(username)) {
            return res.status(400).json({ error: 'The username must be 3 to 40 letters, numbers, dots, dashes or underscores.', field: 'username' });
        }
        const name = parseDisplayName(body.displayName);
        if (name.error) return res.status(400).json({ error: name.error, field: 'displayName' });
        const role = body.role === undefined ? 'user' : body.role;
        if (!ROLES.includes(role)) return res.status(400).json({ error: 'The role must be admin or user.', field: 'role' });
        const min = this.config.minPasswordLength;
        if (typeof body.password !== 'string' || body.password.length < min || body.password.length > MAX_PASSWORD) {
            return res.status(400).json({ error: `The password must be ${min} to ${MAX_PASSWORD} characters.`, field: 'password' });
        }
        const hashed = await hashPassword(body.password);
        try {
            const user = this.users.create({
                username,
                displayName: name.value === undefined ? null : name.value,
                hash: hashed.hash,
                salt: hashed.salt,
                role,
                createdBy: this.isRoot(req) || !req.user ? 'admin' : req.user.username,
                now: this.now(),
            });
            this.audit('user.created', { req, actor: 'admin', detail: { user: user.id, role } });
            res.status(201).json(this.presentAdmin({ ...user, stash_count: 0 }));
        } catch (err) {
            if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message, field: 'username' });
            throw err;
        }
    };

    update = (req, res) => {
        const user = this.editable(req, res);
        if (!user) return;
        const body = req.body || {};
        const changes = {};
        if (body.role !== undefined) {
            if (!ROLES.includes(body.role)) return res.status(400).json({ error: 'The role must be admin or user.', field: 'role' });
            if (body.role !== user.role) changes.role = body.role;
        }
        if (body.disabled !== undefined) {
            if (typeof body.disabled !== 'boolean') return res.status(400).json({ error: 'Say whether the account is disabled.', field: 'disabled' });
            if (body.disabled !== Boolean(user.disabled)) changes.disabled = body.disabled;
        }
        if (body.displayName !== undefined) {
            const name = parseDisplayName(body.displayName);
            if (name.error) return res.status(400).json({ error: name.error, field: 'displayName' });
            if (name.value !== (user.display_name || null)) changes.displayName = name.value;
        }
        // An admin account cannot lock itself out of admin (the ADMIN_PASSWORD admin can do anything; it is not a user)
        if (this.isSelf(req, user) && (changes.role !== undefined || changes.disabled === true)) {
            return res.status(400).json({ error: 'You cannot demote or disable your own account. Ask another admin.' });
        }
        const keys = Object.keys(changes);
        const updated = keys.length ? this.users.update(user.id, changes) : user;
        if (keys.length) this.audit('user.updated', { req, actor: 'admin', detail: { user: user.id, keys } });
        res.json(this.presentAdmin({ ...updated, stash_count: this.users.list().find(row => row.id === user.id).stash_count }));
    };

    // The admin sets a new password for the user (for a forgotten one) and tells them; every session of the user ends
    resetPassword = async (req, res) => {
        const user = this.editable(req, res);
        if (!user) return;
        const password = req.body && req.body.password;
        const min = this.config.minPasswordLength;
        if (typeof password !== 'string' || password.length < min || password.length > MAX_PASSWORD) {
            return res.status(400).json({ error: `The password must be ${min} to ${MAX_PASSWORD} characters.`, field: 'password' });
        }
        const hashed = await hashPassword(password);
        this.users.setPassword(user.id, hashed.hash, hashed.salt);
        this.lockout.clear(`user:${user.username}`);
        this.audit('user.password_reset', { req, actor: 'admin', detail: { user: user.id } });
        res.json({ ok: true });
    };

    signOut = (req, res) => {
        const user = this.editable(req, res);
        if (!user) return;
        this.users.bumpSession(user.id);
        this.audit('user.signed_out', { req, actor: 'admin', detail: { user: user.id } });
        // An admin signing out their own account everywhere ends their session too: that is what was asked
        res.json({ ok: true });
    };

    // Removes the account and its follow list. The stashes it followed are not touched.
    remove = (req, res) => {
        const user = this.editable(req, res);
        if (!user) return;
        if (this.isSelf(req, user)) return res.status(400).json({ error: 'You cannot delete your own account. Ask another admin.' });
        this.users.remove(user.id);
        this.lockout.clear(`user:${user.username}`);
        this.audit('user.deleted', { req, actor: 'admin', detail: { user: user.id } });
        res.json({ ok: true });
    };
}

module.exports = UserController;
