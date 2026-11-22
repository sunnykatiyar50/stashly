const { loadConfig } = require('./config');
const { connect, getOrCreateSecret } = require('./database/sqlite');
const { StashModel } = require('./models/stashModel');
const { StashEvents } = require('./utils/events');
const { FileStore } = require('./utils/fileStore');
const { createApp } = require('./server');

const config = loadConfig();
const fileStore = new FileStore(config.filesDir);
const db = connect(config.sqlitePath, { fileStore });
const model = new StashModel(db, fileStore);
// Unfinished resumable uploads survive a restart (that is the point), unless their partial file is gone
model.reconcileUploads();
// Files left behind by a crash (no matching item, or an upload that never finished) are removed; the partial files
// of the resumable uploads that are still open are kept
const stray = fileStore.sweep(model.liveFileIds(), model.liveThumbIds(), model.livePartNames());
if (stray) console.log(`Removed ${stray} stray file(s) from ${config.filesDir}.`);
const events = new StashEvents();
const secret = config.sessionSecret || getOrCreateSecret(db);

if (config.adminPassword && config.adminPassword.length < 12) {
    console.warn('WARNING: ADMIN_PASSWORD is shorter than 12 characters. The admin can reset any stash password, so use a long random one.');
}

if (config.metricsToken && config.metricsToken.length < 16) {
    console.warn('WARNING: METRICS_TOKEN is shorter than 16 characters. Use a long random one.');
}

// A setting that cannot work (an unknown LOG_FORMAT...) stops here with one clear line instead of a stack trace
let created;
try {
    created = createApp({ config, model, events, secret });
} catch (err) {
    console.error(`Stashly cannot start: ${err.message}`);
    process.exit(1);
}
const { app, controller, userController } = created;

// Remove stashes whose time is up (they are also removed the moment someone opens them)
const timer = setInterval(() => {
    try {
        const removed = controller.cleanup();
        // Forget sign-in counts whose window has passed
        userController.cleanup();
        if (removed.length) console.log(`Removed ${removed.length} expired stash(es).`);
    } catch (err) {
        console.error('Cleanup failed:', err);
    }
}, config.cleanupIntervalMs);
timer.unref();
controller.cleanup();

const server = app.listen(config.port, config.host, () => {
    console.log(`Stashly is running at http://localhost:${config.port}`);
});

function shutdown() {
    clearInterval(timer);
    server.close(() => {
        db.close();
        process.exit(0);
    });
    // Open event streams would keep the server alive
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
