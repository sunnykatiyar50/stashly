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

    addNote(stashId, text, now = new Date()) {
        const result = this.db
            .prepare(`INSERT INTO items (stash_id, kind, text, created_at) VALUES (?, 'note', ?, ?)`)
            .run(stashId, text, now.toISOString());
        return this.getItem(stashId, Number(result.lastInsertRowid));
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
    listItems(stashId, { search, from, to } = {}) {
        const where = ['stash_id = ?'];
        const params = [stashId];
        if (search) {
            where.push(`(text LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\')`);
            const pattern = `%${escapeLike(search)}%`;
            params.push(pattern, pattern);
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
            .prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`)
            .all(...params);
    }

    latestNote(stashId) {
        return (
            this.db
                .prepare(`SELECT * FROM items WHERE stash_id = ? AND kind = 'note' ORDER BY created_at DESC, id DESC LIMIT 1`)
                .get(stashId) || null
        );
    }

    getFileContent(itemId) {
        const row = this.db.prepare('SELECT content FROM files WHERE item_id = ?').get(itemId);
        return row ? Buffer.from(row.content) : null;
    }

    deleteItem(stashId, id) {
        return this.db.prepare('DELETE FROM items WHERE stash_id = ? AND id = ?').run(stashId, id).changes > 0;
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
