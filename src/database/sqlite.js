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

// Uses Node's built-in SQLite driver (same as Message-Sandbox), so there is no native module to compile.
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
