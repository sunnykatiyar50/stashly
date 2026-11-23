const { loadConfig } = require('../../src/config');
const { connect } = require('../../src/database/sqlite');
const { StashModel } = require('../../src/models/stashModel');
const { StashEvents } = require('../../src/utils/events');
const { FileStore } = require('../../src/utils/fileStore');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../src/server');

// Each app gets its own folder for uploaded files, removed when the test run ends
const fileDirs = [];
process.on('exit', () => {
    for (const dir of fileDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function newFileStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-files-'));
    fileDirs.push(dir);
    return new FileStore(dir);
}

// An app on an in-memory database with a clock the test can move
// Pass `db` to start another app on the same database (to check that saved settings survive a restart)
// Pass `logOut` / `auditOut` (functions that take one line) to collect the access log and audit log lines
// Pass `secret` to use another server secret (saved settings that are encrypted need the same one to be read again)
function makeApp(overrides = {}, { db = connect(':memory:'), fileStore = newFileStore(), logOut, auditOut, secret = 'test-secret' } = {}) {
    // The name-length and per-stash lockout rules are off by default here so the older tests can use short names and
    // many wrong passwords; the tests for those rules switch them on.
    const config = loadConfig({}, {
        rateCreate: 1000, ratePost: 1000, rateUpload: 1000, rateUnlock: 1000, rateUserLogin: 1000,
        minOpenNameLength: 0, stashUnlockFailures: 0,
        // Short passwords and reusing a deleted stash's name keep the older tests simple; the tests for those rules
        // switch them on
        minPasswordLength: 4, reserveOldNamesDays: 0,
        ...overrides,
    });
    const model = new StashModel(db, fileStore);
    const events = new StashEvents({ heartbeatMs: 1e9 });
    const clock = { time: new Date('2026-01-15T12:00:00Z') };
    const { app, controller, settings, metrics, audit, users, userController, mailer } = createApp({
        config, model, events, secret, now: () => new Date(clock.time), logOut, auditOut,
    });
    return { app, db, model, events, controller, settings, clock, config, fileStore, metrics, audit, users, userController, mailer };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 65)]);

module.exports = { makeApp, newFileStore, PNG, PDF };
