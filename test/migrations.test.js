const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { connect, SCHEMA_VERSION } = require('../src/database/sqlite');

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-migrate-'));
    return { file: path.join(dir, 'test.sqlite'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

test('a new database is created at the current schema version', () => {
    const db = connect(':memory:');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.ok(columns(db, 'items').includes('sort_order'));
    assert.ok(columns(db, 'stashes').includes('session_version'));
});

test('a database from before versions existed is upgraded and keeps its data', () => {
    const { file, cleanup } = tempDb();
    try {
        // The oldest layout: no title, options, pins, order, share links or sessions
        const old = new DatabaseSync(file);
        old.exec(`CREATE TABLE stashes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, password_hash TEXT,
                  password_salt TEXT, ttl_ms INTEGER, created_at TEXT NOT NULL, expires_at TEXT)`);
        old.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, stash_id INTEGER NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                  kind TEXT NOT NULL, text TEXT, file_name TEXT, file_type TEXT, file_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
        old.exec("INSERT INTO stashes (slug, created_at) VALUES ('legacy-stash', '2025-01-01T00:00:00Z')");
        old.exec("INSERT INTO items (stash_id, kind, text, created_at) VALUES (1, 'note', 'kept', '2025-01-01T00:00:00Z')");
        old.exec("INSERT INTO items (stash_id, kind, text, created_at) VALUES (1, 'note', 'kept too', '2025-01-01T00:00:01Z')");
        old.close();

        const db = connect(file);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        const rows = db.prepare('SELECT text, sort_order, burn, pinned FROM items ORDER BY id').all();
        assert.deepEqual(rows.map(r => r.text), ['kept', 'kept too']);
        // Old rows start in the order they were added
        assert.deepEqual(rows.map(r => r.sort_order), [1, 2]);
        assert.deepEqual(rows.map(r => r.burn), [0, 0]);
        assert.equal(db.prepare('SELECT content FROM stashes').get().content, 'all');
        db.close();

        // Opening it again changes nothing
        const again = connect(file);
        assert.equal(again.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
        again.close();
    } finally {
        cleanup();
    }
});

test('a database from a newer release is refused instead of being damaged', () => {
    const { file, cleanup } = tempDb();
    try {
        const db = connect(file);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        db.close();
        assert.throws(() => connect(file), /newer Stashly/);
    } finally {
        cleanup();
    }
});
