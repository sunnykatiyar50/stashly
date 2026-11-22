const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Uses Node's built-in SQLite driver (same as Message-Sandbox), so there is no native module to compile.
// Timestamps are ISO-8601 text, which sorts and compares correctly as strings.
function connect(filePath = ':memory:') {
    const db = new DatabaseSync(filePath);
    // Incremental vacuum only takes effect on a database that is new; it lets the cleanup job give space back
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Deleted notes and files are overwritten with zeros instead of lingering in free pages, so a burned or expired
    // secret cannot be read back from the database file
    db.exec('PRAGMA secure_delete = ON');

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
    const stashColumns = db.prepare('PRAGMA table_info(stashes)').all().map(column => column.name);
    if (!stashColumns.includes('view_token_hash')) db.exec('ALTER TABLE stashes ADD COLUMN view_token_hash TEXT');
    if (!stashColumns.includes('drop_token_hash')) db.exec('ALTER TABLE stashes ADD COLUMN drop_token_hash TEXT');
    // Keep only the newest N unpinned items (null = keep everything)
    if (!stashColumns.includes('keep_last')) db.exec('ALTER TABLE stashes ADD COLUMN keep_last INTEGER');
    // What the stash takes: 'all' (notes and files), 'notes' or 'files'
    if (!stashColumns.includes('content')) db.exec("ALTER TABLE stashes ADD COLUMN content TEXT NOT NULL DEFAULT 'all'");
    // Raised by "Sign out other devices": every sign-in cookie is tied to it, so raising it ends them all
    if (!stashColumns.includes('session_version')) db.exec('ALTER TABLE stashes ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
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
    // Databases made before titles existed get the column added; old notes keep a null title
    // and show the first words of their text instead
    if (!db.prepare('PRAGMA table_info(items)').all().some(column => column.name === 'title')) {
        db.exec('ALTER TABLE items ADD COLUMN title TEXT');
    }
    // Per-note options: its own expiry, burn after reading (the text is withheld until revealed, then deleted),
    // and secret (shown masked in the page). Older rows get the defaults: no expiry, not burn, not secret.
    const itemColumns = db.prepare('PRAGMA table_info(items)').all().map(column => column.name);
    if (!itemColumns.includes('expires_at')) db.exec('ALTER TABLE items ADD COLUMN expires_at TEXT');
    if (!itemColumns.includes('burn')) db.exec('ALTER TABLE items ADD COLUMN burn INTEGER NOT NULL DEFAULT 0');
    if (!itemColumns.includes('secret')) db.exec('ALTER TABLE items ADD COLUMN secret INTEGER NOT NULL DEFAULT 0');
    // Pinned items stay at the top and are never trimmed by "keep the last N"; edited_at marks a note changed in place
    if (!itemColumns.includes('pinned')) db.exec('ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    if (!itemColumns.includes('edited_at')) db.exec('ALTER TABLE items ADD COLUMN edited_at TEXT');
    // Where an item sits in its stash's list (higher is nearer the top). New items get the stash's highest number
    // plus one; dragging a clip renumbers the moved ones. Older rows start in the order they were added.
    if (!itemColumns.includes('sort_order')) {
        db.exec('ALTER TABLE items ADD COLUMN sort_order REAL');
        db.exec('UPDATE items SET sort_order = id');
    }
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

module.exports = { connect, getOrCreateSecret };
