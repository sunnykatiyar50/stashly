// All SQL lives here, so the model can be ported to another database in one place.
// What an item row holds, in the order the trash table keeps it (moving a row between the two tables copies these)
const ITEM_COLUMNS = 'id, stash_id, kind, title, text, file_name, file_type, file_size, created_at, expires_at, burn, secret, pinned, edited_at, sort_order, has_thumb';

const escapeLike = value => value.replace(/[\\%_]/g, c => `\\${c}`);

class StashModel {
    // files: the FileStore holding uploaded files' bytes (the database only keeps each file's row in `items`)
    constructor(db, files = null) {
        this.db = db;
        this.files = files;
    }

    // ---- uploaded files ----

    // Ids of the file items in one stash, trashed ones included (their bytes are still on disk), read before the stash
    // is deleted so the bytes can go with it
    fileIdsOfStash(stashId) {
        return this.db
            .prepare("SELECT id FROM items WHERE stash_id = ? AND kind = 'file' UNION SELECT id FROM trash WHERE stash_id = ? AND kind = 'file'")
            .all(stashId, stashId)
            .map(row => row.id);
    }

    // Every file item's id: what the file store should hold (anything else in its folder is left over). A trashed
    // file is still held, so a restart inside the undo window does not wipe it.
    liveFileIds() {
        return new Set(
            this.db
                .prepare("SELECT id FROM items WHERE kind = 'file' UNION SELECT id FROM trash WHERE kind = 'file'")
                .all()
                .map(row => row.id)
        );
    }

    // The ids that should have a thumbnail on disk, trashed items included (a trashed image keeps its thumbnail)
    liveThumbIds() {
        return new Set(
            this.db
                .prepare("SELECT id FROM items WHERE has_thumb = 1 AND kind = 'file' UNION SELECT id FROM trash WHERE has_thumb = 1 AND kind = 'file'")
                .all()
                .map(row => row.id)
        );
    }

    // Removes the bytes of deleted file items, and their thumbnails. Done after the rows are gone: a crash in between
    // leaves a stray file that the next startup sweep removes, never a row without its file.
    dropFiles(ids) {
        if (this.files && ids.length) this.files.remove(ids);
    }

    // Attaches (or replaces) an image's thumbnail. The thumbnail is written first and the flag set after, so a crash
    // in between leaves a stray thumbnail that the startup sweep removes, never a flag with no thumbnail. It is not an
    // edit: edited_at stays, so it cannot cause an edit conflict. Returns the item, or null when there is no such file.
    setThumb(stashId, id, bytes) {
        const row = this.getItem(stashId, id);
        if (!row || row.kind !== 'file') return null;
        this.files.writeThumb(id, bytes);
        this.db.prepare('UPDATE items SET has_thumb = 1 WHERE stash_id = ? AND id = ?').run(stashId, id);
        return this.getItem(stashId, id);
    }

    // ---- unfinished resumable uploads ----
    // A row says an upload was started; its bytes so far are the partial file in the file store (see FileStore.partName),
    // which is the truth about how far it got. Rows and partial files are always removed together (dropUploads).

    createUpload({ id, stashId, role, name, title = null, size }, now = new Date()) {
        const stamp = now.toISOString();
        this.db
            .prepare('INSERT INTO uploads (id, stash_id, role, name, title, size, received, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
            .run(id, stashId, role, name, title, size, stamp, stamp);
        this.files.createPart(id);
        return this.getUpload(stashId, id);
    }

    // Only an upload of this stash (an id from another stash is no upload at all)
    getUpload(stashId, id) {
        return this.db.prepare('SELECT * FROM uploads WHERE stash_id = ? AND id = ?').get(stashId, id) || null;
    }

    // Records progress (and that the upload is still in use, so it is not expired)
    setUploadProgress(id, received, now = new Date()) {
        this.db.prepare('UPDATE uploads SET received = ?, last_activity = ? WHERE id = ?').run(received, now.toISOString(), id);
    }

    uploadsOfStash(stashId) {
        return this.db.prepare('SELECT id FROM uploads WHERE stash_id = ?').all(stashId).map(row => row.id);
    }

    countUploads(stashId = null) {
        return stashId === null
            ? this.db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n
            : this.db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE stash_id = ?').get(stashId).n;
    }

    // The sizes the open uploads declared: space they may still take, which new uploads must leave room for
    reservedBytes() {
        return this.db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM uploads').get().bytes;
    }

    // Uploads with no new piece since `before`
    idleUploads(before) {
        return this.db.prepare('SELECT id FROM uploads WHERE last_activity < ?').all(before.toISOString()).map(row => row.id);
    }

    // Removes unfinished uploads: the rows, then the partial files. A crash in between leaves a stray file that the
    // startup sweep removes, never a row pointing at nothing.
    dropUploads(ids) {
        if (!ids.length) return 0;
        const remove = this.db.prepare('DELETE FROM uploads WHERE id = ?');
        for (const id of ids) remove.run(id);
        if (this.files) for (const id of ids) this.files.removePart(id);
        return ids.length;
    }

    // At startup: an upload whose partial file is gone cannot be resumed, so it is dropped; the others get their
    // recorded progress set to what the file really holds. Returns how many were dropped.
    reconcileUploads() {
        const rows = this.db.prepare('SELECT id, size, received FROM uploads').all();
        const gone = [];
        for (const row of rows) {
            const size = this.files.partSize(row.id);
            if (size === null || size > row.size) gone.push(row.id);
            else if (size !== row.received) this.db.prepare('UPDATE uploads SET received = ? WHERE id = ?').run(size, row.id);
        }
        this.dropUploads(gone);
        return gone.length;
    }

    // The tmp/ names of the partial files that must survive the startup sweep
    livePartNames() {
        return new Set(this.db.prepare('SELECT id FROM uploads').all().map(row => this.files.partName(row.id)));
    }

    // ---- stashes ----

    // ownerId: the signed-in user who made it, or null for a guest
    createStash({ slug, passwordHash = null, passwordSalt = null, ttlMs = null, ownerId = null, now = new Date() }) {
        const createdAt = now.toISOString();
        const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs).toISOString() : null;
        try {
            const result = this.db
                .prepare(
                    `INSERT INTO stashes (slug, password_hash, password_salt, ttl_ms, created_at, expires_at, owner_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(slug, passwordHash, passwordSalt, ttlMs, createdAt, expiresAt, ownerId);
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

    // Gives the stash a new name. Its items, password, expiry and settings stay. The read-only and drop-box links are
    // cancelled, because they point at the old name.
    renameStash(id, slug, now = new Date()) {
        const before = this.getStashById(id);
        // An unfinished upload belongs to the address it was started under, so renaming ends it
        this.dropUploads(this.uploadsOfStash(id));
        try {
            this.db.prepare('UPDATE stashes SET slug = ?, view_token_hash = NULL, drop_token_hash = NULL WHERE id = ?').run(slug, id);
            if (before) this.retireSlug(before.slug, now);
        } catch (err) {
            if (/UNIQUE/i.test(String(err.message))) {
                const duplicate = new Error('A stash with that name already exists.');
                duplicate.code = 'DUPLICATE';
                throw duplicate;
            }
            throw err;
        }
        return this.getStashById(id);
    }

    getStashById(id) {
        return this.db.prepare('SELECT * FROM stashes WHERE id = ?').get(id) || null;
    }

    findBySlug(slug) {
        return this.db.prepare('SELECT * FROM stashes WHERE slug = ?').get(slug) || null;
    }

    // A new password (a new salt too, which signs everyone out). The read-only and drop-box links are cancelled
    // with it, since they were given out under the old password.
    // resetAt: set (an ISO time) only when an admin chose the password, so the stash can say so. Anyone who knows the
    // password changing it clears the mark.
    setPassword(id, hash, salt, resetAt = null) {
        this.db
            .prepare('UPDATE stashes SET password_hash = ?, password_salt = ?, view_token_hash = NULL, drop_token_hash = NULL, password_reset_at = ? WHERE id = ?')
            .run(hash, salt, resetAt, id);
        return this.getStashById(id);
    }

    // Ends every sign-in to the stash (the cookies are tied to this number)
    bumpSessionVersion(id) {
        this.db.prepare('UPDATE stashes SET session_version = session_version + 1 WHERE id = ?').run(id);
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

    deleteStash(id, now = new Date()) {
        const stash = this.getStashById(id);
        if (!stash) return false;
        const fileIds = this.fileIdsOfStash(id);
        this.dropUploads(this.uploadsOfStash(id));
        this.db.prepare('DELETE FROM stashes WHERE id = ?').run(id);
        this.dropFiles(fileIds);
        this.retireSlug(stash.slug, now);
        this.checkpoint();
        return true;
    }

    // Deletes every stash whose time is up (with its items and files). Returns the removed names.
    purgeExpired(now = new Date()) {
        const rows = this.db
            .prepare('SELECT id, slug FROM stashes WHERE expires_at IS NOT NULL AND expires_at <= ?')
            .all(now.toISOString());
        if (!rows.length) return [];
        const remove = this.db.prepare('DELETE FROM stashes WHERE id = ?');
        for (const row of rows) {
            const fileIds = this.fileIdsOfStash(row.id);
            this.dropUploads(this.uploadsOfStash(row.id));
            remove.run(row.id);
            this.dropFiles(fileIds);
            this.retireSlug(row.slug, now);
        }
        // Gives the freed pages back to the file system (needs auto_vacuum = INCREMENTAL)
        this.db.exec('PRAGMA incremental_vacuum');
        this.checkpoint();
        return rows.map(row => row.slug);
    }

    // ---- retired names ----

    // Remembers that a name was given up (deleted, expired or renamed away), so it can be kept from new stashes
    retireSlug(slug, now = new Date()) {
        this.db
            .prepare('INSERT INTO retired_slugs (slug, retired_at) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET retired_at = excluded.retired_at')
            .run(slug, now.toISOString());
    }

    // True when the name was given up at or after `since`
    isRetired(slug, since) {
        return Boolean(this.db.prepare('SELECT 1 FROM retired_slugs WHERE slug = ? AND retired_at >= ?').get(slug, since.toISOString()));
    }

    // Forgets names given up before `before`, which are free again
    purgeRetired(before) {
        return this.db.prepare('DELETE FROM retired_slugs WHERE retired_at < ?').run(before.toISOString()).changes;
    }

    // Moves what the write-ahead log holds into the database file and empties the log, so deleted text does not
    // linger there either (secure_delete only covers the main file). Does nothing for an in-memory database.
    checkpoint() {
        try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
            // busy (a reader is open): the next checkpoint will catch up
        }
    }

    // ---- items ----

    // options: expiresAt (ISO, the note goes at that time), burn (text withheld until revealed, then deleted), secret (masked)
    addNote(stashId, text, now = new Date(), title = null, { expiresAt = null, burn = false, secret = false } = {}) {
        const result = this.db
            .prepare(
                `INSERT INTO items (stash_id, kind, title, text, created_at, expires_at, burn, secret, sort_order)
                 VALUES (?, 'note', ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(stashId, title, text, now.toISOString(), expiresAt, burn ? 1 : 0, secret ? 1 : 0, this.nextOrder(stashId));
        return this.getItem(stashId, Number(result.lastInsertRowid));
    }

    // Deletes notes whose own expiry has passed. Returns { id, slug } for each, so pages can be told.
    purgeExpiredItems(now = new Date()) {
        const rows = this.db
            .prepare(
                `SELECT i.id, i.kind, s.slug FROM items i JOIN stashes s ON s.id = i.stash_id
                 WHERE i.expires_at IS NOT NULL AND i.expires_at <= ?`
            )
            .all(now.toISOString());
        if (!rows.length) return [];
        const remove = this.db.prepare('DELETE FROM items WHERE id = ?');
        for (const row of rows) remove.run(row.id);
        this.dropFiles(rows.filter(row => row.kind === 'file').map(row => row.id));
        this.checkpoint();
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

    // `tmp` is the received upload (see FileStore.receive) and `size` its length. The row is made first, then the
    // upload is moved to the file store under the row's id; if anything fails, neither is left behind.
    addFile(stashId, { fileName, fileType, tmp, size, title = null, uploadId = null }, now = new Date()) {
        this.db.exec('BEGIN');
        let id = null;
        try {
            const result = this.db
                .prepare(
                    `INSERT INTO items (stash_id, kind, file_name, file_type, file_size, created_at, sort_order, title)
                     VALUES (?, 'file', ?, ?, ?, ?, ?, ?)`
                )
                .run(stashId, fileName, fileType, size, now.toISOString(), this.nextOrder(stashId), title);
            id = Number(result.lastInsertRowid);
            this.files.adopt(tmp, id);
            // A finished resumable upload stops being one in the same step that makes it an item
            if (uploadId) this.db.prepare('DELETE FROM uploads WHERE id = ?').run(uploadId);
            this.db.exec('COMMIT');
            return this.getItem(stashId, id);
        } catch (err) {
            this.db.exec('ROLLBACK');
            if (id !== null) this.files.remove([id]);
            throw err;
        }
    }

    getItem(stashId, id) {
        return this.db.prepare('SELECT * FROM items WHERE stash_id = ? AND id = ?').get(stashId, id) || null;
    }

    // In list order: pinned first, then by place (new items go on top, dragging moves them). Filters: search (note text or file name), from/to (ISO instants, to is exclusive)
    // Items past their own expiry are left out, and the text of a burn-after-reading note is never searched.
    // limit (optional) returns only the first that many; offset (optional) skips that many first, to read a long list
    // in pages. Without a limit, an offset returns everything after it.
    listItems(stashId, { limit, offset, ...filters } = {}) {
        const { where, params } = this.itemFilter(stashId, filters);
        const skip = offset || 0;
        const paging = limit ? ' LIMIT ? OFFSET ?' : skip ? ' LIMIT -1 OFFSET ?' : '';
        const values = limit ? [limit, skip] : skip ? [skip] : [];
        return this.db
            .prepare(`SELECT * FROM items WHERE ${where} ORDER BY pinned DESC, sort_order DESC, id DESC${paging}`)
            .all(...params, ...values);
    }

    // How many items the same filters match, for a listing cut short by a limit
    countItems(stashId, filters = {}) {
        const { where, params } = this.itemFilter(stashId, filters);
        return this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${where}`).get(...params).n;
    }

    itemFilter(stashId, { search, from, to, now = new Date() }) {
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
        return { where: where.join(' AND '), params };
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

    deleteItem(stashId, id) {
        const row = this.getItem(stashId, id);
        const deleted = this.db.prepare('DELETE FROM items WHERE stash_id = ? AND id = ?').run(stashId, id).changes > 0;
        if (deleted) {
            if (row && row.kind === 'file') this.dropFiles([id]);
            this.checkpoint();
        }
        return deleted;
    }

    // ---- trash (undo for a person's delete) ----

    // Moves an item to the trash instead of destroying it: the row (and, for a file, its bytes on disk) stay until
    // purgeTrash removes them or restoreItem brings them back. Returns false when there is no such item.
    trashItem(stashId, id, now = new Date()) {
        this.db.exec('BEGIN');
        try {
            const copied = this.db
                .prepare(`INSERT INTO trash (${ITEM_COLUMNS}, deleted_at) SELECT ${ITEM_COLUMNS}, ? FROM items WHERE stash_id = ? AND id = ?`)
                .run(now.toISOString(), stashId, id).changes;
            if (copied) this.db.prepare('DELETE FROM items WHERE stash_id = ? AND id = ?').run(stashId, id);
            this.db.exec('COMMIT');
            return copied > 0;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    // A trashed item that can still be brought back: deleted after `since` (now minus the undo window)
    getTrashed(stashId, id, since) {
        return this.db.prepare('SELECT * FROM trash WHERE stash_id = ? AND id = ? AND deleted_at > ?').get(stashId, id, since.toISOString()) || null;
    }

    // Puts a trashed item back in the list with the same id, place and pin. The caller has checked the limits.
    restoreItem(stashId, id) {
        this.db.exec('BEGIN');
        try {
            this.db.prepare(`INSERT INTO items (${ITEM_COLUMNS}) SELECT ${ITEM_COLUMNS} FROM trash WHERE stash_id = ? AND id = ?`).run(stashId, id);
            this.db.prepare('DELETE FROM trash WHERE stash_id = ? AND id = ?').run(stashId, id);
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        return this.getItem(stashId, id);
    }

    // Removes one trashed item for good (its file too), for example one that cannot be restored any more
    dropTrashed(stashId, id) {
        const row = this.db.prepare('SELECT kind FROM trash WHERE stash_id = ? AND id = ?').get(stashId, id);
        if (!row) return false;
        this.db.prepare('DELETE FROM trash WHERE stash_id = ? AND id = ?').run(stashId, id);
        if (row.kind === 'file') this.dropFiles([id]);
        this.checkpoint();
        return true;
    }

    // Removes trash deleted at or before `before` for good: the row is overwritten (secure_delete) and the file zeroed.
    // Returns how many items were removed.
    purgeTrash(before) {
        const rows = this.db.prepare('SELECT id, kind FROM trash WHERE deleted_at <= ?').all(before.toISOString());
        if (!rows.length) return 0;
        this.db.prepare('DELETE FROM trash WHERE deleted_at <= ?').run(before.toISOString());
        this.dropFiles(rows.filter(row => row.kind === 'file').map(row => row.id));
        this.checkpoint();
        return rows.length;
    }

    countTrash() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM trash').get().n;
    }

    // The place a new item takes: above everything already in the stash
    nextOrder(stashId) {
        return this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM items WHERE stash_id = ?').get(stashId).n;
    }

    // Puts the given items in the given order (first = top). Only their places are swapped among themselves, so
    // items left out (a search that matched only some, the pinned group) keep theirs. Returns [{ id, order }], or
    // null if any id is not in the stash or is listed twice, in which case nothing changes.
    reorderItems(stashId, ids) {
        if (!ids.length) return [];
        const marks = ids.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT id, sort_order FROM items WHERE stash_id = ? AND id IN (${marks})`).all(stashId, ...ids);
        if (rows.length !== ids.length) return null;
        const places = rows.map(row => row.sort_order).sort((a, b) => b - a);
        const set = this.db.prepare('UPDATE items SET sort_order = ? WHERE stash_id = ? AND id = ?');
        this.db.exec('BEGIN');
        try {
            ids.forEach((id, index) => set.run(places[index], stashId, id));
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        return ids.map((id, index) => ({ id, order: places[index] }));
    }

    setPinned(stashId, id, pinned) {
        const changed = this.db.prepare('UPDATE items SET pinned = ? WHERE stash_id = ? AND id = ?').run(pinned ? 1 : 0, stashId, id).changes;
        return changed ? this.getItem(stashId, id) : null;
    }

    // Gives a file a title of its own (null goes back to its name). The file and its name stay as they were.
    setFileTitle(stashId, id, title, now = new Date()) {
        const before = this.getItem(stashId, id);
        const changed = this.db
            .prepare(`UPDATE items SET title = ?, edited_at = ? WHERE stash_id = ? AND id = ? AND kind = 'file'`)
            .run(title, this.editStamp(before && before.edited_at, now), stashId, id).changes;
        return changed ? this.getItem(stashId, id) : null;
    }

    // The time to stamp an edit with: now, but always later than the item's last edit, so two edits can never share a
    // value (the edit-conflict check compares them)
    editStamp(current, now) {
        const stamp = now.toISOString();
        if (!current || stamp > current) return stamp;
        return new Date(new Date(current).getTime() + 1).toISOString();
    }

    // Changes a note's text and title in place. Its options (burn, secret, expiry) and its date stay as they were.
    updateNote(stashId, id, { text, title }, now = new Date()) {
        const before = this.getItem(stashId, id);
        const changed = this.db
            .prepare(`UPDATE items SET text = ?, title = ?, edited_at = ? WHERE stash_id = ? AND id = ? AND kind = 'note'`)
            .run(text, title, this.editStamp(before && before.edited_at, now), stashId, id).changes;
        // The old text is overwritten in the file (secure_delete); this clears it from the log as well
        if (changed) this.checkpoint();
        return changed ? this.getItem(stashId, id) : null;
    }

    setContent(id, content) {
        this.db.prepare('UPDATE stashes SET content = ? WHERE id = ?').run(content, id);
        return this.getStashById(id);
    }

    setKeepLast(id, keepLast) {
        this.db.prepare('UPDATE stashes SET keep_last = ? WHERE id = ?').run(keepLast, id);
        return this.getStashById(id);
    }

    // Deletes the oldest unpinned items beyond the newest `keep`. Returns the ids removed.
    trimToLast(stashId, keep) {
        if (!keep || keep < 1) return [];
        const rows = this.db
            .prepare('SELECT id, kind FROM items WHERE stash_id = ? AND pinned = 0 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?')
            .all(stashId, keep);
        const remove = this.db.prepare('DELETE FROM items WHERE id = ?');
        for (const row of rows) remove.run(row.id);
        this.dropFiles(rows.filter(row => row.kind === 'file').map(row => row.id));
        if (rows.length) this.checkpoint();
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
                `SELECT s.id, s.slug, s.ttl_ms, s.created_at, s.expires_at, s.owner_id,
                        (SELECT username FROM users WHERE id = s.owner_id) AS owner,
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
