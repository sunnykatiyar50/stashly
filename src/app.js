const { loadConfig } = require('./config');
const { connect, getOrCreateSecret } = require('./database/sqlite');
const { StashModel } = require('./models/stashModel');
const { StashEvents } = require('./utils/events');
const { createApp } = require('./server');

const config = loadConfig();
const db = connect(config.sqlitePath);
const model = new StashModel(db);
const events = new StashEvents();
const secret = config.sessionSecret || getOrCreateSecret(db);

const { app, controller } = createApp({ config, model, events, secret });

// Remove stashes whose time is up (they are also removed the moment someone opens them)
const timer = setInterval(() => {
    try {
        const removed = controller.cleanup();
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
