const path = require('path');

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

// Reads a non-negative number from the environment, falling back to a default
const num = (value, fallback) => {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const flag = value => String(value).toLowerCase() === 'true';

// Refuses settings that cannot work, with a message fit to show at startup
function checkConfig(config) {
    if (!['off', 'json'].includes(config.logFormat)) throw new Error('LOG_FORMAT must be "off" or "json".');
    if (!['off', 'stdout'].includes(config.auditLog)) throw new Error('AUDIT_LOG must be "off" or "stdout".');
}

function loadConfig(env = process.env, overrides = {}) {
    const allowNoExpiry = flag(env.ALLOW_NO_EXPIRY);
    const adminPassword = env.ADMIN_PASSWORD || '';
    const ttlOptions = [
        { key: '1h', label: '1 hour', ms: HOUR },
        { key: '8h', label: '8 hours', ms: 8 * HOUR },
        { key: '1d', label: '1 day', ms: 24 * HOUR },
        { key: '7d', label: '7 days', ms: 7 * 24 * HOUR },
        { key: '30d', label: '30 days', ms: 30 * 24 * HOUR },
    ];
    if (allowNoExpiry) ttlOptions.push({ key: 'never', label: 'Never', ms: null });

    return {
        port: num(env.PORT, 3000),
        host: env.HOST || '0.0.0.0',
        sqlitePath: env.SQLITE_PATH || './stashly.sqlite',
        // Uploaded files, one plain file each. Next to the database unless FILES_DIR says otherwise, so a volume
        // mounted on the database's folder keeps both. Back up the database and this folder together.
        filesDir: env.FILES_DIR || path.join(path.dirname(path.resolve(env.SQLITE_PATH || './stashly.sqlite')), 'files'),
        sessionSecret: env.SESSION_SECRET || '',
        trustProxy: env.TRUST_PROXY || '',
        maxNoteBytes: num(env.MAX_NOTE_KB, 100) * 1024,
        maxFileBytes: num(env.MAX_FILE_MB, 25) * MB,
        // The largest thumbnail: the small preview the page makes of an uploaded image and sends along with it
        maxThumbBytes: num(env.MAX_THUMB_KB, 200) * 1024,
        maxStashBytes: num(env.MAX_STASH_MB, 100) * MB,
        maxTotalBytes: num(env.MAX_TOTAL_MB, 2048) * MB,
        // Notes and files share this cap, so keep it above MAX_FILES_PER_STASH
        maxItemsPerStash: num(env.MAX_ITEMS_PER_STASH, 1000),
        maxFilesPerStash: num(env.MAX_FILES_PER_STASH, 500),
        maxStashes: num(env.MAX_STASHES, 1000),
        // Resumable uploads: the biggest piece one request may carry (never more than this is buffered or written per
        // request), how many unfinished uploads one stash and the whole server may hold, and how long an upload that
        // gets no new piece is kept before the cleanup job removes it
        maxChunkBytes: Math.max(64 * 1024, Math.floor(num(env.MAX_CHUNK_MB, 4) * MB)),
        maxOpenUploads: Math.max(1, Math.floor(num(env.MAX_OPEN_UPLOADS, 5))),
        maxOpenUploadsServer: Math.max(1, Math.floor(num(env.MAX_OPEN_UPLOADS_SERVER, 50))),
        uploadIdleHours: num(env.UPLOAD_IDLE_HOURS, 24) || 24,
        allowNoExpiry,
        // Which files can be uploaded: 'safe', 'no-programs' or 'any' (see utils/fileType.js)
        fileTypes: ['safe', 'no-programs', 'any'].includes(env.FILE_TYPES) ? env.FILE_TYPES : 'safe',
        // The admin area is only on when a password is set
        adminPassword,
        requireAdminToCreate: Boolean(adminPassword) && flag(env.REQUIRE_ADMIN_TO_CREATE),
        // Accounts exist only when the admin area is on (ADMIN_PASSWORD set). With this on, only a signed-in user (any
        // role) or the admin may create stashes; visitors can still open any stash they have the link to.
        requireLoginToCreate: Boolean(adminPassword) && flag(env.REQUIRE_LOGIN_TO_CREATE),
        // How long a user stays signed in on one browser (1 to 90 days)
        userSessionDays: Math.max(1, Math.min(90, Math.floor(num(env.USER_SESSION_DAYS, 7)))),
        // Wrong account passwords per address per 15 minutes (the per-username lockout uses the STASH_UNLOCK_* settings)
        rateUserLogin: num(env.RATE_USER_LOGIN, 10),
        // Operating: access log (off | json), audit log (off | stdout) and the /metrics token (empty = no /metrics)
        logFormat: (env.LOG_FORMAT || 'off').trim().toLowerCase(),
        auditLog: (env.AUDIT_LOG || 'off').trim().toLowerCase(),
        metricsToken: env.METRICS_TOKEN || '',
        rateAdminLogin: num(env.RATE_ADMIN_LOGIN, 10),
        ttlOptions,
        defaultTtl: '1d',
        // How long a single note can live (shorter than its stash); a note with none lives as long as the stash
        itemTtlOptions: [
            { key: '5m', label: '5 minutes', ms: 5 * 60 * 1000 },
            { key: '1h', label: '1 hour', ms: HOUR },
            { key: '8h', label: '8 hours', ms: 8 * HOUR },
            { key: '1d', label: '1 day', ms: 24 * HOUR },
        ],
        rateCreate: num(env.RATE_CREATE, 20),
        ratePost: num(env.RATE_POST, 120),
        rateUpload: num(env.RATE_UPLOAD, 40),
        // Pieces of resumable uploads (many per file, so far more generous than starting an upload)
        rateChunk: num(env.RATE_CHUNK, 6000),
        rateUnlock: num(env.RATE_UNLOCK, 10),
        // Reading is limited too (per IP, per minute). Requests for a stash that does not exist are counted
        // separately and tighter, so names cannot be guessed quickly.
        rateRead: num(env.RATE_READ, 600),
        rateNotFound: num(env.RATE_NOT_FOUND, 60),
        // Open live streams (Server-Sent Events): at most this many per stash and per IP (0 = no limit)
        maxStreamsPerStash: num(env.MAX_STREAMS_PER_STASH, 100),
        maxStreamsPerIp: num(env.MAX_STREAMS_PER_IP, 30),
        // A stash with no password is protected only by its name, so the name has to be long enough not to be guessed.
        // 0 turns the rule off. Stashes made before the rule are not affected.
        minOpenNameLength: num(env.MIN_OPEN_NAME_LENGTH, 10),
        // Shortest stash password accepted when one is set or changed. Existing passwords keep working.
        minPasswordLength: Math.max(4, Math.min(200, num(env.MIN_PASSWORD_LENGTH, 10))),
        // A name given up by a stash (deleted, expired or renamed away) cannot be taken by a new stash for this many
        // days, so a device or script still using it does not send to a stranger. 0 turns it off.
        reserveOldNamesDays: num(env.RESERVE_OLD_NAMES_DAYS, 30),
        // How long a person's delete of an item can be undone. The item waits in the trash that long (and is then
        // removed for good). 0 turns undo off: deletes are immediate and secure, as before.
        undoSeconds: Math.min(3600, Math.floor(num(env.UNDO_SECONDS, 120))),
        // Wrong passwords for one stash, from anyone: after this many in the window, unlocking it is refused until
        // the window ends (a person already signed in is not affected). 0 turns it off.
        // Counted per visitor (IP) for each stash, so a stranger cannot lock the owner out. A looser limit
        // (STASH_UNLOCK_FAILURES x 5) still applies to the stash as a whole, against guessing from many addresses.
        stashUnlockFailures: num(env.STASH_UNLOCK_FAILURES, 10),
        stashUnlockWindowMs: num(env.STASH_UNLOCK_WINDOW_MIN, 15) * 60 * 1000,
        // How long a password-protected stash stays unlocked in a browser. The person chooses when they unlock (and can
        // shorten it later); never longer than the stash itself.
        sessionOptions: [
            { key: '30m', label: '30 minutes', ms: 30 * 60 * 1000 },
            { key: '2h', label: '2 hours', ms: 2 * HOUR },
            { key: '12h', label: '12 hours', ms: 12 * HOUR },
            { key: '24h', label: '24 hours', ms: 24 * HOUR },
            { key: '7d', label: '7 days', ms: 7 * 24 * HOUR },
            { key: '30d', label: '30 days', ms: 30 * 24 * HOUR },
        ],
        defaultSession: '24h',
        // Mark cookies Secure: "auto" follows the connection (needs TRUST_PROXY behind a proxy), "true" always
        cookieSecure: ['auto', 'true', 'false'].includes(String(env.COOKIE_SECURE).toLowerCase()) ? String(env.COOKIE_SECURE).toLowerCase() : 'auto',
        cleanupIntervalMs: 60 * 1000,
        ...overrides,
    };
}

module.exports = { loadConfig, checkConfig };
