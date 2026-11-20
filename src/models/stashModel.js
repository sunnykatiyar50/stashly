// All SQL lives here, so the model can be ported to another database (or merged into Message-Sandbox) in one place.
const escapeLike = value => value.replace(/[\\%_]/g, c => `\\${c}`);

class StashModel {
    constructor(db) {
        this.db = db;
    }

    // ---- stashes ----

    createStash({ slug, passwordHash = null, passwordSalt = null, ttlMs = null, now = new Date() }) {
        const createdAt = now.toISOString();
        const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs).toISOString() : null;
        try {
            const result = this.db
                .prepare(
                    `INSERT INTO stashes (slug, password_hash, password_salt, ttl_ms, created_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run(slug, passwordHash, passwordSalt, ttlMs, createdAt, expiresAt);
            return this.getStashById(Number(result.lastInsertRowid));
        } catch (err) {
            if (/UNIQUE/i.test(String(err.message))) {
                const duplicate = new Error('A stash with that name already exists.');
                duplicate.code = 'DUPLICATE';
                throw duplicate;
            }
            throw err;
        }
    }

    getStashById(id) {
        return this.db.prepare('SELECT * FROM stashes WHERE id = ?').get(id) || null;
    }

    findBySlug(slug) {
        return this.db.prepare('SELECT * FROM stashes WHERE slug = ?').get(slug) || null;
    }

    // A new password (a new salt too, which signs everyone out). The read-only and drop-box links are cancelled
    // with it, since they were given out under the old password.
    setPassword(id, hash, salt) {
        this.db
            .prepare('UPDATE stashes SET password_hash = ?, password_salt = ?, view_token_hash = NULL, drop_token_hash = NULL WHERE id = ?')
            .run(hash, salt, id);
        return this.getStashById(id);
    }

    // kind is 'view' or 'drop'; a null hash revokes the link
    setShareToken(id, kind, hash) {
        const column = kind === 'view' ? 'view_token_hash' : 'drop_token_hash';
        this.db.prepare(`UPDATE stashes SET ${column} = ? WHERE id = ?`).run(hash, id);
        return this.getStashById(id);
    }

    countStashes() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM stashes').get().n;
    }

    extend(id, now = new Date()) {
        const stash = this.getStashById(id);
        if (!stash || !stash.ttl_ms) return null;
        const expiresAt = new Date(now.getTime() + stash.ttl_ms).toISOString();
        this.db.prepare('UPDATE stashes SET expires_at = ? WHERE id = ?').run(expiresAt, id);
        return this.getStashById(id);
    }

    deleteStash(id) {
        return this.db.prepare('DELETE FROM stashes WHERE id = ?').run(id).changes > 0;
    }

    // Deletes every stash whose time is up (with its items and files). Returns the removed names.
    purgeExpired(now = new Date()) {
        const rows = this.db
            .prepare('SELECT id, slug FROM stashes WHERE expires_at IS NOT NULL AND expires_at <= ?')
            .all(now.toISOString());
        if (!rows.length) return [];
        const remove = this.db.prepare('DELETE FROM stashes WHERE id = ?');
        for (const row of rows) remove.run(row.id);
        // Gives the freed pages back to the file system (needs auto_vacuum = INCREMENTAL)
        this.db.exec('PRAGMA incremental_vacuum');
        return rows.map(row => row.slug);
    }

    // ---- items ----

    // options: expiresAt (ISO, the note goes at that time), burn (text withheld until revealed, then deleted), secret (masked)
    addNote(stashId, text, now = new Date(), title = null, { expiresAt = null, burn = false, secret = false } = {}) {
        const result = this.db
            .prepare(
                `INSERT INTO items (stash_id, kind, title, text, created_at, expires_at, burn, secret)
                 VALUES (?, 'note', ?, ?, ?, ?, ?, ?)`
            )
            .run(stashId, title, text, now.toISOString(), expiresAt, burn ? 1 : 0, secret ? 1 : 0);
        return this.getItem(stashId, Number(result.lastInsertRowid));
    }

    // Deletes notes whose own expiry has passed. Returns { id, slug } for each, so pages can be told.
    purgeExpiredItems(now = new Date()) {
        const rows = this.db
            .prepare(
                `SELECT i.id, s.slug FROM items i JOIN stashes s ON s.id = i.stash_id
                 WHERE i.expires_at IS NOT NULL AND i.expires_at <= ?`
            )
            .all(now.toISOString());
        if (!rows.length) return [];
        const remove = this.db.prepare('DELETE FROM items WHERE id = ?');
        for (const row of rows) remove.run(row.id);
        return rows;
    }

    // An item past its own expiry counts as gone, even before the cleanup job removes it
    getLiveItem(stashId, id, now = new Date()) {
        return (
            this.db
                .prepare('SELECT * FROM items WHERE stash_id = ? AND id = ? AND (expires_at IS NULL OR expires_at > ?)')
                .get(stashId, id, now.toISOString()) || null
        );
    }

    addFile(stashId, { fileName, fileType, content }, now = new Date()) {
        this.db.exec('BEGIN');
        try {
            const result = this.db
                .prepare(
                    `INSERT INTO items (stash_id, kind, file_name, file_type, file_size, created_at)
                     VALUES (?, 'file', ?, ?, ?, ?)`
                )
                .run(stashId, fileName, fileType, content.length, now.toISOString());
            const id = Number(result.lastInsertRowid);
            this.db.prepare('INSERT INTO files (item_id, content) VALUES (?, ?)').run(id, content);
            this.db.exec('COMMIT');
            return this.getItem(stashId, id);
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    getItem(stashId, id) {
        return this.db.prepare('SELECT * FROM items WHERE stash_id = ? AND id = ?').get(stashId, id) || null;
    }

    // Newest first. Filters: search (note text or file name), from/to (ISO instants, to is exclusive)
    // Items past their own expiry are left out, and the text of a burn-after-reading note is never searched.
    listItems(stashId, { search, from, to, now = new Date() } = {}) {
        const where = ['stash_id = ?', '(expires_at IS NULL OR expires_at > ?)'];
        const params = [stashId, now.toISOString()];
        if (search) {
            where.push(`((burn = 0 AND text LIKE ? ESCAPE '\\') OR file_name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`);
            const pattern = `%${escapeLike(search)}%`;
            params.push(pattern, pattern, pattern);
        }
        if (from) {
            where.push('created_at >= ?');
            params.push(from);
        }
        if (to) {
            where.push('created_at < ?');
            params.push(to);
        }
        return this.db
            // Pinned items first, then newest first
            .prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC, id DESC`)
            .all(...params);
    }

    // includeBurn false leaves out burn-after-reading notes (a reader with a read-only link must not use one up)
    latestNote(stashId, now = new Date(), { includeBurn = true } = {}) {
        return (
            this.db
                .prepare(
                    `SELECT * FROM items WHERE stash_id = ? AND kind = 'note' AND (expires_at IS NULL OR expires_at > ?)
                     ${includeBurn ? '' : 'AND burn = 0'}
                     ORDER BY created_at DESC, id DESC LIMIT 1`
                )
                .get(stashId, now.toISOString()) || null
        );
    }

    getFileContent(itemId) {
        const row = this.db.prepare('SELECT content FROM files WHERE item_id = ?').get(itemId);
        return row ? Buffer.from(row.content) : null;
    }

    deleteItem(stashId, id) {
        return this.db.prepare('DELETE FROM items WHERE stash_id = ? AND id = ?').run(stashId, id).changes > 0;
    }

    setPinned(stashId, id, pinned) {
        const changed = this.db.prepare('UPDATE items SET pinned = ? WHERE stash_id = ? AND id = ?').run(pinned ? 1 : 0, stashId, id).changes;
        return changed ? this.getItem(stashId, id) : null;
    }

    // Changes a note's text and title in place. Its options (burn, secret, expiry) and its date stay as they were.
    updateNote(stashId, id, { text, title }, now = new Date()) {
        const changed = this.db
            .prepare(`UPDATE items SET text = ?, title = ?, edited_at = ? WHERE stash_id = ? AND id = ? AND kind = 'note'`)
            .run(text, title, now.toISOString(), stashId, id).changes;
        return changed ? this.getItem(stashId, id) : null;
    }

    setKeepLast(id, keepLast) {
        this.db.prepare('UPDATE stashes SET keep_last = ? WHERE id = ?').run(keepLast, id);
        return this.getStashById(id);
    }

    // Deletes the oldest unpinned items beyond the newest `keep`. Returns the ids removed.
    trimToLast(stashId, keep) {
        if (!keep || keep < 1) return [];
        const rows = this.db
            .prepare('SELECT id FROM items WHERE stash_id = ? AND pinned = 0 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?')
            .all(stashId, keep);
        const remove = this.db.prepare('DELETE FROM items WHERE id = ?');
        for (const row of rows) remove.run(row.id);
        return rows.map(row => row.id);
    }

    // Counts and bytes in one stash, and bytes over the whole database (for the quotas)
    usage(stashId) {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS items,
                        COALESCE(SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END), 0) AS files,
                        COALESCE(SUM(file_size), 0) AS bytes
                 FROM items WHERE stash_id = ?`
            )
            .get(stashId);
        return { items: row.items, files: row.files, bytes: row.bytes };
    }

    totalBytes() {
        return this.db.prepare('SELECT COALESCE(SUM(file_size), 0) AS bytes FROM items').get().bytes;
    }

    // ---- admin: overview and settings ----

    // Every stash with its size, newest first. Never returns note text or file content.
    listStashes({ search } = {}) {
        const where = search ? `WHERE s.slug LIKE ? ESCAPE '\\'` : '';
        const params = search ? [`%${escapeLike(search.toLowerCase())}%`] : [];
        return this.db
            .prepare(
                `SELECT s.id, s.slug, s.ttl_ms, s.created_at, s.expires_at,
                        CASE WHEN s.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
                        COUNT(i.id) AS items,
                        COALESCE(SUM(CASE WHEN i.kind = 'file' THEN 1 ELSE 0 END), 0) AS files,
                        COALESCE(SUM(i.file_size), 0) AS bytes
                 FROM stashes s LEFT JOIN items i ON i.stash_id = s.id
                 ${where}
                 GROUP BY s.id
                 ORDER BY s.created_at DESC, s.id DESC`
            )
            .all(...params);
    }

    totals() {
        const row = this.db
            .prepare(
                `SELECT (SELECT COUNT(*) FROM stashes) AS stashes,
                        COUNT(*) AS items,
                        COALESCE(SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END), 0) AS files,
                        COALESCE(SUM(file_size), 0) AS bytes
                 FROM items`
            )
            .get();
        return { stashes: row.stashes, items: row.items, files: row.files, bytes: row.bytes };
    }

    loadSettings() {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'settings'").get();
        if (!row) return {};
        try {
            const parsed = JSON.parse(row.value);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    saveSettings(overrides) {
        this.db
            .prepare(`INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(JSON.stringify(overrides));
    }

    ping() {
        this.db.prepare('SELECT 1').get();
    }
}

module.exports = { StashModel };
