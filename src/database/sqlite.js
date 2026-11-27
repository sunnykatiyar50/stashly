const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Adds a column unless the table already has it. Returns true when it was added.
function addColumn(db, table, column, definition) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (has) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
}

// The schema is versioned with SQLite's `user_version`. Each entry takes the database from version N to N + 1 and runs
// once, in order, inside a transaction. To change the schema, append a new function here: never edit an old one.
const MIGRATIONS = [
    // 1: everything up to v2.2.x. Written to be safe on a database made by an older release that has some of the
    // columns already (those had no version number, so they start at 0), and on a brand new one.
    db => {
        db.exec(
            `CREATE TABLE IF NOT EXISTS stashes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT NOT NULL UNIQUE,
                password_hash TEXT,
                password_salt TEXT,
                ttl_ms INTEGER,
                created_at TEXT NOT NULL,
                expires_at TEXT
            )`
        );
        // Share links for a password-protected stash: only the hash of each link's token is kept
        addColumn(db, 'stashes', 'view_token_hash', 'TEXT');
        addColumn(db, 'stashes', 'drop_token_hash', 'TEXT');
        // Keep only the newest N unpinned items (null = keep everything)
        addColumn(db, 'stashes', 'keep_last', 'INTEGER');
        // What the stash takes: 'all' (notes and files), 'notes' or 'files'
        addColumn(db, 'stashes', 'content', "TEXT NOT NULL DEFAULT 'all'");
        // Raised by "Sign out other devices": every sign-in cookie is tied to it, so raising it ends them all
        addColumn(db, 'stashes', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
        db.exec('CREATE INDEX IF NOT EXISTS idx_stashes_expires ON stashes (expires_at)');
        db.exec(
            `CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stash_id INTEGER NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                text TEXT,
                file_name TEXT,
                file_type TEXT,
                file_size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )`
        );
        // Old notes keep a null title and show the first words of their text instead
        addColumn(db, 'items', 'title', 'TEXT');
        // Per-note options: its own expiry, burn after reading (the text is withheld until revealed, then deleted),
        // and secret (shown masked in the page). Older rows get the defaults: no expiry, not burn, not secret.
        addColumn(db, 'items', 'expires_at', 'TEXT');
        addColumn(db, 'items', 'burn', 'INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'items', 'secret', 'INTEGER NOT NULL DEFAULT 0');
        // Pinned items stay at the top and are never trimmed by "keep the last N"; edited_at marks a note changed in place
        addColumn(db, 'items', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'items', 'edited_at', 'TEXT');
        // Where an item sits in its stash's list (higher is nearer the top). New items get the stash's highest number
        // plus one; dragging a clip renumbers the moved ones. Older rows start in the order they were added.
        if (addColumn(db, 'items', 'sort_order', 'REAL')) db.exec('UPDATE items SET sort_order = id');
        db.exec('CREATE INDEX IF NOT EXISTS idx_items_order ON items (stash_id, pinned, sort_order)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_items_stash ON items (stash_id, created_at)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_items_expires ON items (expires_at)');
        db.exec(
            `CREATE TABLE IF NOT EXISTS files (
                item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
                content BLOB NOT NULL
            )`
        );
        db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        // Names of stashes that were deleted, expired or renamed away. They stay reserved for a while, so a device or
        // script still using the old name cannot end up sending to a stranger's new stash of the same name.
        db.exec('CREATE TABLE IF NOT EXISTS retired_slugs (slug TEXT PRIMARY KEY, retired_at TEXT NOT NULL)');
    },

    // 2: uploaded files move out of the database into one plain file each in the files folder (see utils/fileStore.js),
    // so downloads stream from disk and the database stays small. Existing files are copied across in batches and
    // the old table is dropped. If the server stops part way, nothing is committed and the next start redoes it.
    (db, context) => {
        const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'").get();
        if (!hasTable) return;
        const total = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
        if (total) {
            if (!context.fileStore) throw new Error('Cannot move the stored files out of the database: no files folder was given.');
            const next = db.prepare('SELECT item_id, content FROM files WHERE item_id > ? ORDER BY item_id LIMIT 10');
            let last = 0;
            for (;;) {
                const rows = next.all(last);
                if (!rows.length) break;
                for (const row of rows) context.fileStore.write(row.item_id, row.content);
                last = rows[rows.length - 1].item_id;
            }
            context.movedFiles = total;
        }
        db.exec('DROP TABLE files');
    },

    // 3: a trash for items a person deleted, so the delete can be undone for a short while (UNDO_SECONDS). A row is the
    // item exactly as it was, plus when it was deleted. It keeps the item's id (ids are never reused, because items
    // is AUTOINCREMENT) and its file, if any, stays in the files folder until the row is purged or restored. Deleting
    // the stash deletes its trash with it.
    db => {
        db.exec(
            `CREATE TABLE IF NOT EXISTS trash (
                id INTEGER PRIMARY KEY,
                stash_id INTEGER NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                title TEXT,
                text TEXT,
                file_name TEXT,
                file_type TEXT,
                file_size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                expires_at TEXT,
                burn INTEGER NOT NULL DEFAULT 0,
                secret INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                edited_at TEXT,
                sort_order REAL,
                deleted_at TEXT NOT NULL
            )`
        );
        db.exec('CREATE INDEX IF NOT EXISTS idx_trash_stash ON trash (stash_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash (deleted_at)');
    },

    // 4: image thumbnails. A thumbnail is a small file stored next to the item's file (`<id>.thumb`, see
    // utils/fileStore.js); has_thumb says whether one exists, so listing items never has to look at the disk. The
    // trash keeps the flag, because a trashed image keeps its thumbnail until it is purged or restored.
    db => {
        addColumn(db, 'items', 'has_thumb', 'INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'trash', 'has_thumb', 'INTEGER NOT NULL DEFAULT 0');
    },

    // 5: resumable (chunked) uploads. A row is an upload that has been started and not finished; its bytes so far sit in
    // a partial file in the files folder's tmp/ (see utils/fileStore.js), which is the source of truth for how far it
    // got (`received` is only a copy of that, for listing). The id is the random secret the uploader holds. Deleting the
    // stash deletes its unfinished uploads with it (the model removes their partial files first).
    db => {
        db.exec(
            `CREATE TABLE IF NOT EXISTS uploads (
                id TEXT PRIMARY KEY,
                stash_id INTEGER NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                name TEXT NOT NULL,
                title TEXT,
                size INTEGER NOT NULL,
                received INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                last_activity TEXT NOT NULL
            )`
        );
        db.exec('CREATE INDEX IF NOT EXISTS idx_uploads_stash ON uploads (stash_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_uploads_activity ON uploads (last_activity)');
    },

    // 6: optional user accounts. Accounts are created by the admin; a user can follow stashes to watch them in one place.
    // `username` is stored lowercase (case-insensitive unique). `session_version` is raised to end every session of that
    // user at once (a password change, a role change, a disable, "sign out everywhere"). A role is 'admin' or 'user'.
    // `user_stashes` is the follow list. The grant_* columns are a snapshot of the access the user proved when they
    // followed (the stash's password salt and session version, and for a read-only link the hash of its token): the
    // snapshot stops matching the moment the password changes, sessions are signed out or the link is replaced, which
    // ends the grant exactly like it ends a cookie. Deleting a user or a stash deletes the follow rows, never the stash.
    db => {
        db.exec(
            `CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
                disabled INTEGER NOT NULL DEFAULT 0,
                session_version INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                created_by TEXT,
                last_login_at TEXT
            )`
        );
        db.exec(
            `CREATE TABLE IF NOT EXISTS user_stashes (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                stash_id INTEGER NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                added_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                grant_role TEXT NOT NULL CHECK (grant_role IN ('full', 'view')),
                grant_salt TEXT,
                grant_version INTEGER NOT NULL DEFAULT 0,
                grant_view_hash TEXT,
                PRIMARY KEY (user_id, stash_id)
            )`
        );
        db.exec('CREATE INDEX IF NOT EXISTS idx_user_stashes_stash ON user_stashes (stash_id)');
    },

    // 7: one sign-in for everyone. The admin account named by ADMIN_USERNAME is a real user row whose password is
    // ADMIN_PASSWORD; `managed` marks it (and only it), so the admin area and the account page refuse to edit it
    // (the server's environment is the one place it is changed). Every existing user is not managed.
    db => {
        // (skipped when the column is already there, so running the migration again does no harm)
        if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'managed')) {
            db.exec('ALTER TABLE users ADD COLUMN managed INTEGER NOT NULL DEFAULT 0');
        }
    },

    // 8: who made a stash (a signed-in user; no owner means a guest made it), and when an admin last reset its
    // password. Existing stashes have no owner. If a user is deleted their stashes become guest stashes, not deleted.
    db => {
        const columns = db.prepare('PRAGMA table_info(stashes)').all().map(column => column.name);
        if (!columns.includes('owner_id')) {
            db.exec('ALTER TABLE stashes ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
        }
        if (!columns.includes('password_reset_at')) db.exec('ALTER TABLE stashes ADD COLUMN password_reset_at TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS idx_stashes_owner ON stashes (owner_id)');
    },

    // 9: pinned stashes. A user can pin stashes in their list; pinned ones sit first in My stashes and in the left menu.
    // `pinned_at` is when it was pinned (null = not pinned). It lives on the follow row, so unfollowing or deleting the
    // user or the stash drops the pin with it.
    db => {
        const columns = db.prepare('PRAGMA table_info(user_stashes)').all().map(column => column.name);
        if (!columns.includes('pinned_at')) db.exec('ALTER TABLE user_stashes ADD COLUMN pinned_at TEXT');
    },

    // 10: an optional email address on a user, lowercase, used only to send them password reset links and notices.
    // Not unique: two accounts may share one address (a family inbox).
    db => {
        const columns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
        if (!columns.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    },

    // 11: tags on clips. A clip's tags are a JSON array of short lowercase words (null = none), kept on the item and
    // carried through the trash so an undone delete brings them back (see utils/tags.js for what a tag may be).
    db => {
        addColumn(db, 'items', 'tags', 'TEXT');
        addColumn(db, 'trash', 'tags', 'TEXT');
    },

    // 12: a link to one clip. A row is the share link of one note or file: only the hash of its random token is kept (the
    // link itself is shown once), it may expire, and it counts how often it was opened. There is at most one per clip
    // (making a new one replaces the old). The link dies with its clip (a delete, even an undoable one, removes the row),
    // with its stash, and when the stash's password is changed.
    db => {
        db.exec(
            `CREATE TABLE IF NOT EXISTS item_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT NOT NULL UNIQUE,
                stash_id INTEGER NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                expires_at TEXT,
                views INTEGER NOT NULL DEFAULT 0,
                last_viewed_at TEXT
            )`
        );
        db.exec('CREATE INDEX IF NOT EXISTS idx_item_shares_stash ON item_shares (stash_id)');
    },

    // 13: which files a stash takes: 'safe', 'no-programs' or 'any' (null = the safe list). It used to be one setting for
    // the whole server; a stash that has not chosen takes the safe list.
    db => {
        addColumn(db, 'stashes', 'file_types', 'TEXT');
    },

    // 14: a private stash. Its owner (a signed-in account) can turn it on: from then on only that account opens the
    // stash, whatever the password, share links or follows say, and they work again when it is turned off.
    db => {
        addColumn(db, 'stashes', 'is_private', 'INTEGER NOT NULL DEFAULT 0');
    },

    // 15: the stash a user's copied text is saved to (their "Clipboard" stash, made for them when they ask for it). It is
    // only a pointer: the stash is an ordinary private stash they own, and if it is deleted the pointer clears itself.
    db => {
        addColumn(db, 'users', 'clipboard_stash_id', 'INTEGER REFERENCES stashes(id) ON DELETE SET NULL');
    },

    // 16: a display name for a stash (null = show its name). The name is the unique key people open it by; the display name
    // is free text that need not be unique. The owner sets it after the stash is made; a user's Clipboard stash is
    // always called "Clipboard" and its key is never shown.
    db => {
        addColumn(db, 'stashes', 'label', 'TEXT');
        db.exec("UPDATE stashes SET label = 'Clipboard' WHERE id IN (SELECT clipboard_stash_id FROM users WHERE clipboard_stash_id IS NOT NULL)");
    },
];

const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db, context = {}) {
    const current = db.prepare('PRAGMA user_version').get().user_version;
    if (current > SCHEMA_VERSION) {
        // Opened by an older release after a newer one changed the schema: stop rather than risk the data
        throw new Error(`This database is from a newer Stashly (schema ${current}); this version only knows schema ${SCHEMA_VERSION}. Update Stashly.`);
    }
    for (let version = current; version < SCHEMA_VERSION; version++) {
        db.exec('BEGIN');
        try {
            MIGRATIONS[version](db, context);
            // PRAGMA cannot take a bound value; the number comes from this file
            db.exec(`PRAGMA user_version = ${version + 1}`);
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }
}

// Uses Node's built-in SQLite driver so there is no native module to compile.
// Timestamps are ISO-8601 text, which sorts and compares correctly as strings.
// options.fileStore: where uploaded files live (needed only to move files out of an older database)
function connect(filePath = ':memory:', { fileStore = null } = {}) {
    const db = new DatabaseSync(filePath);
    // Incremental vacuum only takes effect on a database that is new; it lets the cleanup job give space back
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Deleted notes and files are overwritten with zeros instead of lingering in free pages, so a burned or expired
    // secret cannot be read back from the database file
    db.exec('PRAGMA secure_delete = ON');
    const context = { fileStore, movedFiles: 0 };
    try {
        migrate(db, context);
    } catch (err) {
        db.close();
        throw err;
    }
    // The old table's pages are free now: give them back to the file system
    if (context.movedFiles) db.exec('VACUUM');
    return db;
}

// A secret for signing unlock cookies, generated once and kept so cookies survive restarts
function getOrCreateSecret(db) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'session_secret'").get();
    if (row) return row.value;
    const value = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO meta (key, value) VALUES ('session_secret', ?)").run(value);
    return value;
}

module.exports = { connect, getOrCreateSecret, SCHEMA_VERSION };
