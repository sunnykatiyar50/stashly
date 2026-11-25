// All SQL for user accounts and the follow list. Like stashModel.js it never returns a password or a stash's content:
// the password hash and salt only come out of findById / findByUsername, for the code that checks a password.

// Usernames are stored lowercase, so "Sunny" and "sunny" are one account. 3 to 40 letters, digits, dots, dashes, underscores.
const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;
const ROLES = ['admin', 'user'];

// Returns the lowercase username, or '' when the value is not a string
function normalizeUsername(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// What a follow row lets its user do in a stash right now: 'full', 'view' or null (the grant no longer works).
// A stash with no password gives full access to anyone who has its name, so a follow is always 'full' there. Otherwise
// the snapshot taken when the user followed must still match the stash: the same password (salt), the same sign-in
// version ("sign out other devices" raises it) and, for a read-only grant, the same read-only link. A changed password,
// a signed-out stash or a replaced or revoked link therefore ends the grant the way it ends a cookie.
function grantRole(follow, stash) {
    if (!follow || !stash) return null;
    if (!stash.password_hash) return 'full';
    if ((follow.grant_salt || null) !== (stash.password_salt || null)) return null;
    if (Number(follow.grant_version) !== Number(stash.session_version || 0)) return null;
    if (follow.grant_role === 'view') {
        return stash.view_token_hash && follow.grant_view_hash === stash.view_token_hash ? 'view' : null;
    }
    return follow.grant_role === 'full' ? 'full' : null;
}

class UserModel {
    constructor(db) {
        this.db = db;
    }

    // ---- users ----

    findById(id) {
        return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    }

    findByUsername(username) {
        return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
    }

    // Accounts that have this address (lowercase), enabled ones only, at most 3
    findByEmail(email) {
        return this.db.prepare('SELECT * FROM users WHERE email = ? AND disabled = 0 AND managed = 0 ORDER BY id LIMIT 3').all(email);
    }

    count() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    }

    // { admin: n, user: n }, for the metrics
    countByRole() {
        const out = { admin: 0, user: 0 };
        for (const row of this.db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all()) out[row.role] = row.n;
        return out;
    }

    // Every user with how many stashes they follow. Never the password hash or salt.
    list() {
        return this.db
            .prepare(
                `SELECT u.id, u.username, u.display_name, u.email, u.role, u.disabled, u.managed, u.created_at, u.created_by, u.last_login_at,
                        (SELECT COUNT(*) FROM user_stashes us WHERE us.user_id = u.id) AS stash_count
                 FROM users u ORDER BY u.username`
            )
            .all();
    }

    // Throws an error with code DUPLICATE when the username is taken
    create({ username, displayName = null, email = null, hash, salt, role, createdBy = null, managed = false, now = new Date() }) {
        try {
            const result = this.db
                .prepare(
                    `INSERT INTO users (username, display_name, email, password_hash, password_salt, role, managed, created_at, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(username, displayName, email, hash, salt, role, managed ? 1 : 0, now.toISOString(), createdBy);
            return this.findById(Number(result.lastInsertRowid));
        } catch (err) {
            if (/UNIQUE/i.test(String(err.message))) {
                const duplicate = new Error('That username is taken.');
                duplicate.code = 'DUPLICATE';
                throw duplicate;
            }
            throw err;
        }
    }

    // changes: any of { username, email, role, disabled, displayName }. A new role or a disable also ends the user's
    // sessions; a new username does not (sessions follow the user's id). Throws an error with code DUPLICATE when the
    // new username is taken.
    update(id, changes) {
        const sets = [];
        const params = [];
        if (changes.username !== undefined) {
            sets.push('username = ?');
            params.push(changes.username);
        }
        if (changes.role !== undefined) {
            sets.push('role = ?', 'session_version = session_version + 1');
            params.push(changes.role);
        }
        if (changes.disabled !== undefined) {
            sets.push('disabled = ?');
            params.push(changes.disabled ? 1 : 0);
            if (changes.disabled && changes.role === undefined) sets.push('session_version = session_version + 1');
        }
        if (changes.email !== undefined) {
            sets.push('email = ?');
            params.push(changes.email);
        }
        if (changes.displayName !== undefined) {
            sets.push('display_name = ?');
            params.push(changes.displayName);
        }
        if (sets.length) {
            try {
                this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
            } catch (err) {
                if (/UNIQUE/i.test(String(err.message))) {
                    const duplicate = new Error('That username is taken.');
                    duplicate.code = 'DUPLICATE';
                    throw duplicate;
                }
                throw err;
            }
        }
        return this.findById(id);
    }

    // A new password (a new salt too) and an end to every session
    setPassword(id, hash, salt) {
        this.db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, session_version = session_version + 1 WHERE id = ?').run(hash, salt, id);
        return this.findById(id);
    }

    bumpSession(id) {
        this.db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(id);
        return this.findById(id);
    }

    touchLogin(id, now = new Date()) {
        this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now.toISOString(), id);
    }

    // Puts the managed admin account back to what the environment says: an admin, not disabled, and (when `hashed` is
    // given) with that password. Raising the session version signs out whoever was signed in with the old state.
    resetManaged(id, hashed) {
        if (hashed) {
            this.db
                .prepare("UPDATE users SET password_hash = ?, password_salt = ?, role = 'admin', disabled = 0, session_version = session_version + 1 WHERE id = ?")
                .run(hashed.hash, hashed.salt, id);
        } else {
            this.db.prepare("UPDATE users SET role = 'admin', disabled = 0, session_version = session_version + 1 WHERE id = ?").run(id);
        }
        return this.findById(id);
    }

    // The account no longer belongs to the environment (ADMIN_USERNAME was changed): an ordinary user again, disabled
    // and signed out, for the admin to delete or keep
    releaseManaged(id) {
        this.db.prepare('UPDATE users SET managed = 0, disabled = 1, session_version = session_version + 1 WHERE id = ?').run(id);
        return this.findById(id);
    }

    managedUsers() {
        return this.db.prepare('SELECT * FROM users WHERE managed = 1').all();
    }

    // The follow rows go with the user (foreign key); the stashes themselves are not touched
    remove(id) {
        return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
    }

    // ---- the follow list ----

    getFollow(userId, stashId) {
        return this.db.prepare('SELECT * FROM user_stashes WHERE user_id = ? AND stash_id = ?').get(userId, stashId) || null;
    }

    // Follows a stash, or updates the grant of a stash already followed (an upgrade or a downgrade), without
    // duplicating the row and without resetting when it was added or last seen. grant: { role, salt, version, viewHash }
    follow(userId, stashId, grant, now = new Date()) {
        const at = now.toISOString();
        this.db
            .prepare(
                `INSERT INTO user_stashes (user_id, stash_id, added_at, last_seen_at, grant_role, grant_salt, grant_version, grant_view_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, stash_id) DO UPDATE SET
                     grant_role = excluded.grant_role, grant_salt = excluded.grant_salt,
                     grant_version = excluded.grant_version, grant_view_hash = excluded.grant_view_hash`
            )
            .run(userId, stashId, at, at, grant.role, grant.salt || null, grant.version || 0, grant.viewHash || null);
    }

    // A user's own stashes are always in their list: this adds a row for any that has none (created before the list
    // existed, or whose row was lost), so the new-items counts work the same for them as for followed stashes
    ensureOwnerFollows(userId) {
        this.db
            .prepare(
                `INSERT OR IGNORE INTO user_stashes (user_id, stash_id, added_at, last_seen_at, grant_role)
                 SELECT s.owner_id, s.id, s.created_at, s.created_at, 'full' FROM stashes s WHERE s.owner_id = ?`
            )
            .run(userId);
    }

    // Makes toUserId the owner of the stash (a stash row as read from the database). Both people are put in each other's
    // position in one step: the new owner gets a follow row (an owner needs none to open the stash, but the dashboard and the
    // new-items counts work from it), and the previous owner, when there was one, stays on as a follower with the access they
    // had, so a transfer does not lock them out. That access ends the way any follower's does: when the password changes or
    // the stash signs everyone out, which the new owner can do. Returns false when the stash or the user is gone.
    setStashOwner(stash, toUserId, previousOwnerId = null, now = new Date()) {
        const grant = { role: 'full', salt: stash.password_salt || null, version: stash.session_version || 0 };
        this.db.exec('BEGIN');
        try {
            const changed = this.db.prepare('UPDATE stashes SET owner_id = ? WHERE id = ?').run(toUserId, stash.id).changes;
            if (!changed) { this.db.exec('ROLLBACK'); return false; }
            this.follow(toUserId, stash.id, grant, now);
            if (previousOwnerId && previousOwnerId !== toUserId) this.follow(previousOwnerId, stash.id, grant, now);
            this.db.exec('COMMIT');
            return true;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    unfollow(userId, stashId) {
        return this.db.prepare('DELETE FROM user_stashes WHERE user_id = ? AND stash_id = ?').run(userId, stashId).changes > 0;
    }

    markSeen(userId, stashId, now = new Date()) {
        return this.db.prepare('UPDATE user_stashes SET last_seen_at = ? WHERE user_id = ? AND stash_id = ?').run(now.toISOString(), userId, stashId).changes > 0;
    }

    countPinned(userId) {
        return this.db.prepare('SELECT COUNT(*) AS n FROM user_stashes WHERE user_id = ? AND pinned_at IS NOT NULL').get(userId).n;
    }

    // Pins or unpins a stash that is in the user's list. False when it is not in the list.
    setPinned(userId, stashId, pinned, now = new Date()) {
        return this.db
            .prepare('UPDATE user_stashes SET pinned_at = ? WHERE user_id = ? AND stash_id = ?')
            .run(pinned ? now.toISOString() : null, userId, stashId).changes > 0;
    }

    // The user's followed stashes with their counts, for the dashboard. A stash whose time is up is left out (the cleanup
    // job removes it within a minute). Counts follow the same rule as the stash listing: an item past its own expiry is
    // not counted. Burn-after-reading notes count as items (only that they exist, never their text).
    listFollows(userId, now = new Date()) {
        const at = now.toISOString();
        return this.db
            .prepare(
                `SELECT us.stash_id, us.pinned_at, us.added_at, us.last_seen_at, us.grant_role, us.grant_salt, us.grant_version, us.grant_view_hash,
                        s.slug, s.owner_id, s.password_hash, s.password_salt, s.session_version, s.view_token_hash, s.expires_at,
                        (SELECT COUNT(*) FROM items i WHERE i.stash_id = s.id AND (i.expires_at IS NULL OR i.expires_at > ?)) AS items,
                        (SELECT COUNT(*) FROM items i WHERE i.stash_id = s.id AND i.kind = 'file' AND (i.expires_at IS NULL OR i.expires_at > ?)) AS files,
                        (SELECT COUNT(*) FROM items i WHERE i.stash_id = s.id AND i.created_at > us.last_seen_at AND (i.expires_at IS NULL OR i.expires_at > ?)) AS new_items,
                        (SELECT MAX(i.created_at) FROM items i WHERE i.stash_id = s.id AND (i.expires_at IS NULL OR i.expires_at > ?)) AS latest_at
                 FROM user_stashes us JOIN stashes s ON s.id = us.stash_id
                 WHERE us.user_id = ? AND (s.expires_at IS NULL OR s.expires_at > ?)`
            )
            .all(at, at, at, at, userId, at);
    }
}

module.exports = { UserModel, grantRole, normalizeUsername, USERNAME_PATTERN, ROLES };
