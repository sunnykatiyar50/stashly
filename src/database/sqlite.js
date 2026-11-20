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
    db.exec('CREATE INDEX IF NOT EXISTS idx_items_stash ON items (stash_id, created_at)');
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
