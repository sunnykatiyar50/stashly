const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

// Reads a non-negative number from the environment, falling back to a default
const num = (value, fallback) => {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const flag = value => String(value).toLowerCase() === 'true';

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
        sessionSecret: env.SESSION_SECRET || '',
        trustProxy: env.TRUST_PROXY || '',
        maxNoteBytes: num(env.MAX_NOTE_KB, 100) * 1024,
        maxFileBytes: num(env.MAX_FILE_MB, 25) * MB,
        maxStashBytes: num(env.MAX_STASH_MB, 100) * MB,
        maxTotalBytes: num(env.MAX_TOTAL_MB, 2048) * MB,
        // Notes and files share this cap, so keep it above MAX_FILES_PER_STASH
        maxItemsPerStash: num(env.MAX_ITEMS_PER_STASH, 1000),
        maxFilesPerStash: num(env.MAX_FILES_PER_STASH, 500),
        maxStashes: num(env.MAX_STASHES, 1000),
        allowNoExpiry,
        // Which files can be uploaded: 'safe', 'no-programs' or 'any' (see utils/fileType.js)
        fileTypes: ['safe', 'no-programs', 'any'].includes(env.FILE_TYPES) ? env.FILE_TYPES : 'safe',
        // The admin area is only on when a password is set
        adminPassword,
        requireAdminToCreate: Boolean(adminPassword) && flag(env.REQUIRE_ADMIN_TO_CREATE),
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
        rateUnlock: num(env.RATE_UNLOCK, 10),
        // A stash with no password is protected only by its name, so the name has to be long enough not to be guessed.
        // 0 turns the rule off. Stashes made before the rule are not affected.
        minOpenNameLength: num(env.MIN_OPEN_NAME_LENGTH, 10),
        // Shortest stash password accepted when one is set or changed. Existing passwords keep working.
        minPasswordLength: Math.max(4, Math.min(200, num(env.MIN_PASSWORD_LENGTH, 10))),
        // A name given up by a stash (deleted, expired or renamed away) cannot be taken by a new stash for this many
        // days, so a device or script still using it does not send to a stranger. 0 turns it off.
        reserveOldNamesDays: num(env.RESERVE_OLD_NAMES_DAYS, 30),
        // Wrong passwords for one stash, from anyone: after this many in the window, unlocking it is refused until
        // the window ends (a person already signed in is not affected). 0 turns it off.
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

module.exports = { loadConfig };
