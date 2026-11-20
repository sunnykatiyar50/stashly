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
    db.exec('CREATE INDEX IF NOT EXISTS idx_items_stash ON items (stash_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_items_expires ON items (expires_at)');
    db.exec(
        `CREATE TABLE IF NOT EXISTS files (
            item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
            content BLOB NOT NULL
        )`
    );
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
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
