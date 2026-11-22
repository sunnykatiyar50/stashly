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

test('a new database has the trash table', () => {
    const db = connect(':memory:');
    assert.ok(columns(db, 'trash').includes('deleted_at'));
});

test('a schema 2 database gets the trash table (and then thumbnails) and keeps its data', () => {
    const { file, cleanup } = tempDb();
    try {
        // A database exactly as the previous release left it: schema 2, no trash table
        const first = connect(file);
        first.exec('DROP TABLE trash');
        first.exec("INSERT INTO stashes (slug, created_at) VALUES ('old-stash', '2026-01-01T00:00:00Z')");
        first.exec("INSERT INTO items (stash_id, kind, text, created_at, sort_order) VALUES (1, 'note', 'kept', '2026-01-01T00:00:00Z', 1)");
        first.exec("INSERT INTO items (stash_id, kind, file_name, file_type, file_size, created_at, sort_order) VALUES (1, 'file', 'a.png', 'image/png', 5, '2026-01-01T00:00:01Z', 2)");
        first.exec('PRAGMA user_version = 2');
        first.close();

        const db = connect(file);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        assert.equal(SCHEMA_VERSION, 7);
        assert.deepEqual(columns(db, 'trash'), [
            'id', 'stash_id', 'kind', 'title', 'text', 'file_name', 'file_type', 'file_size', 'created_at',
            'expires_at', 'burn', 'secret', 'pinned', 'edited_at', 'sort_order', 'deleted_at', 'has_thumb',
        ]);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trash').get().n, 0);
        assert.deepEqual(db.prepare('SELECT text FROM items ORDER BY id').all().map(r => r.text), ['kept', null]);

        // The trash is wired to its stash: deleting the stash removes its rows
        db.exec("INSERT INTO trash (id, stash_id, kind, text, created_at, deleted_at) VALUES (50, 1, 'note', 'bin', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')");
        db.exec('DELETE FROM stashes WHERE id = 1');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trash').get().n, 0);
        db.close();

        // Opening it again changes nothing
        const again = connect(file);
        assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        again.close();
    } finally {
        cleanup();
    }
});

test('a schema 3 database gets has_thumb (version 4) and then the uploads table, keeps its rows and trash, and starts with no thumbnails', () => {
    const { file, cleanup } = tempDb();
    try {
        // A database exactly as the previous release left it: schema 3, without the thumbnail flag
        const first = connect(file);
        first.exec('ALTER TABLE items DROP COLUMN has_thumb');
        first.exec('ALTER TABLE trash DROP COLUMN has_thumb');
        first.exec("INSERT INTO stashes (slug, created_at) VALUES ('three', '2026-01-01T00:00:00Z')");
        first.exec("INSERT INTO items (stash_id, kind, file_name, file_type, file_size, created_at, sort_order) VALUES (1, 'file', 'a.png', 'image/png', 5, '2026-01-01T00:00:01Z', 1)");
        first.exec("INSERT INTO items (stash_id, kind, text, created_at, sort_order) VALUES (1, 'note', 'kept', '2026-01-01T00:00:02Z', 2)");
        first.exec("INSERT INTO trash (id, stash_id, kind, text, created_at, sort_order, deleted_at) VALUES (50, 1, 'note', 'bin', '2026-01-01T00:00:00Z', 3, '2026-01-02T00:00:00Z')");
        first.exec('PRAGMA user_version = 3');
        assert.ok(!columns(first, 'items').includes('has_thumb'));
        first.close();

        const db = connect(file);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        assert.ok(columns(db, 'items').includes('has_thumb'));
        assert.ok(columns(db, 'trash').includes('has_thumb'));
        assert.deepEqual(db.prepare('SELECT id, has_thumb FROM items ORDER BY id').all().map(r => ({ ...r })), [{ id: 1, has_thumb: 0 }, { id: 2, has_thumb: 0 }]);
        assert.deepEqual(db.prepare('SELECT text, has_thumb FROM trash').all().map(r => ({ ...r })), [{ text: 'bin', has_thumb: 0 }]);
        db.close();

        // Opening it again changes nothing
        const again = connect(file);
        assert.equal(again.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
        again.close();
    } finally {
        cleanup();
    }
});

test('a schema 4 database gets the uploads table at version 5, keeps its data, and the table is wired to its stash', () => {
    const { file, cleanup } = tempDb();
    try {
        // A database exactly as the previous release left it: schema 4, without the uploads table
        const first = connect(file);
        first.exec('DROP TABLE uploads');
        first.exec("INSERT INTO stashes (slug, created_at) VALUES ('four', '2026-01-01T00:00:00Z')");
        first.exec("INSERT INTO items (stash_id, kind, text, created_at, sort_order) VALUES (1, 'note', 'kept', '2026-01-01T00:00:02Z', 1)");
        first.exec('PRAGMA user_version = 4');
        first.close();

        const db = connect(file);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        assert.deepEqual(columns(db, 'uploads'), ['id', 'stash_id', 'role', 'name', 'title', 'size', 'received', 'created_at', 'last_activity']);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, 0);
        assert.equal(db.prepare('SELECT text FROM items').get().text, 'kept');

        // Deleting the stash removes its unfinished uploads with it
        db.exec("INSERT INTO uploads (id, stash_id, role, name, size, created_at, last_activity) VALUES ('u1', 1, 'full', 'a.bin', 10, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
        db.exec('DELETE FROM stashes WHERE id = 1');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, 0);
        db.close();

        // Opening it again changes nothing
        const again = connect(file);
        assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        again.close();
    } finally {
        cleanup();
    }
});

test('a schema 5 database gets the users and follow tables at version 6, keeps its data, and the tables are wired up', () => {
    const { file, cleanup } = tempDb();
    try {
        // A database exactly as the previous release left it: schema 5, without the account tables
        const first = connect(file);
        first.exec('DROP TABLE user_stashes');
        first.exec('DROP TABLE users');
        first.exec("INSERT INTO stashes (slug, created_at) VALUES ('five', '2026-01-01T00:00:00Z')");
        first.exec("INSERT INTO items (stash_id, kind, text, created_at, sort_order) VALUES (1, 'note', 'kept', '2026-01-01T00:00:02Z', 1)");
        first.exec('PRAGMA user_version = 5');
        first.close();

        const db = connect(file);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
        assert.equal(SCHEMA_VERSION, 7);
        assert.deepEqual(columns(db, 'users'), [
            'id', 'username', 'display_name', 'password_hash', 'password_salt', 'role', 'disabled', 'session_version',
            'created_at', 'created_by', 'last_login_at', 'managed',
        ]);
        assert.deepEqual(columns(db, 'user_stashes'), [
            'user_id', 'stash_id', 'added_at', 'last_seen_at', 'grant_role', 'grant_salt', 'grant_version', 'grant_view_hash',
        ]);
        assert.equal(db.prepare('SELECT text FROM items').get().text, 'kept');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);

        // Usernames are unique, roles are checked, and a disabled flag and session version start at 0
        db.exec("INSERT INTO users (username, password_hash, password_salt, role, created_at) VALUES ('sam', 'h', 's', 'user', '2026-01-01T00:00:00Z')");
        assert.throws(() => db.exec("INSERT INTO users (username, password_hash, password_salt, role, created_at) VALUES ('sam', 'h', 's', 'user', '2026-01-01T00:00:00Z')"), /UNIQUE/);
        assert.throws(() => db.exec("INSERT INTO users (username, password_hash, password_salt, role, created_at) VALUES ('kim', 'h', 's', 'member', '2026-01-01T00:00:00Z')"), /CHECK/);
        const row = db.prepare("SELECT disabled, session_version FROM users WHERE username = 'sam'").get();
        assert.deepEqual({ ...row }, { disabled: 0, session_version: 0 });

        // A follow goes when its user goes, and when its stash goes; the other side is never touched
        db.exec("INSERT INTO user_stashes (user_id, stash_id, added_at, last_seen_at, grant_role) VALUES (1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'full')");
        db.exec('DELETE FROM users WHERE id = 1');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_stashes').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stashes').get().n, 1);
        db.exec("INSERT INTO users (username, password_hash, password_salt, role, created_at) VALUES ('lee', 'h', 's', 'admin', '2026-01-01T00:00:00Z')");
        db.exec("INSERT INTO user_stashes (user_id, stash_id, added_at, last_seen_at, grant_role) VALUES (2, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'view')");
        db.exec('DELETE FROM stashes WHERE id = 1');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_stashes').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
        db.close();

        // Opening it again changes nothing
        const again = connect(file);
        assert.equal(again.prepare('PRAGMA user_version').get().user_version, 7);
        assert.equal(again.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
        again.close();
    } finally {
        cleanup();
    }
});

test('a schema 6 database gets users.managed at version 7: existing users are not managed, and opening it again changes nothing', () => {
    const { file, cleanup } = tempDb();
    try {
        // A database exactly as the previous release left it: schema 6, users without the managed column
        const first = connect(file);
        first.exec('ALTER TABLE users DROP COLUMN managed');
        first.exec("INSERT INTO users (username, password_hash, password_salt, role, created_at) VALUES ('sam', 'h', 's', 'admin', '2026-01-01T00:00:00Z')");
        first.exec('PRAGMA user_version = 6');
        first.close();

        const db = connect(file);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
        assert.ok(columns(db, 'users').includes('managed'));
        assert.equal(db.prepare("SELECT managed FROM users WHERE username = 'sam'").get().managed, 0);
        db.close();

        const again = connect(file);
        assert.equal(again.prepare('PRAGMA user_version').get().user_version, 7);
        assert.equal(again.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
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
