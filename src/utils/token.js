const crypto = require('crypto');

// The unlock cookie: "<expiry ms>.<signed-in ms>.<hmac>" (or the older "<expiry ms>.<hmac>", which has no sign-in
// time). The HMAC covers the stash name and a salt (its password salt, plus anything else that should end every
// session when it changes), so a token only works for that stash, and not for a new stash that later reuses the
// name. The sign-in time lets the server refuse to stretch a session forever.
function mac(secret, slug, salt, expiresAt, signedInAt) {
    const signedPart = signedInAt === null ? `${slug}.${salt}.${expiresAt}` : `${slug}.${salt}.${expiresAt}.${signedInAt}`;
    return crypto.createHmac('sha256', secret).update(signedPart).digest('hex');
}

function signToken(secret, slug, salt, expiresAt, signedInAt = null) {
    const signed = Number.isFinite(signedInAt) ? signedInAt : null;
    return signed === null
        ? `${expiresAt}.${mac(secret, slug, salt, expiresAt, null)}`
        : `${expiresAt}.${signed}.${mac(secret, slug, salt, expiresAt, signed)}`;
}

// Returns { expiresAt, signedInAt } for a valid, unexpired token (signedInAt is null for the older format), or false
function verifyToken(secret, slug, salt, token, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2 && parts.length !== 3) return false;
    const expiresAt = Number(parts[0]);
    const signedInAt = parts.length === 3 ? Number(parts[1]) : null;
    if (!parts[0] || !Number.isFinite(expiresAt) || expiresAt < now) return false;
    if (signedInAt !== null && (!parts[1] || !Number.isFinite(signedInAt))) return false;
    const given = Buffer.from(parts[parts.length - 1]);
    const expected = Buffer.from(mac(secret, slug, salt, expiresAt, signedInAt));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    return { expiresAt, signedInAt };
}

// Share links ("read-only" and "drop box"): a random token goes in the link, and only its hash is stored, so the
// database never holds a working link. 24 random bytes cannot be guessed.
function generateLinkToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function hashLinkToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function linkTokenMatches(token, storedHash) {
    if (typeof token !== 'string' || !storedHash) return false;
    const given = Buffer.from(hashLinkToken(token));
    const expected = Buffer.from(storedHash);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Minimal cookie parser, so there is no extra dependency
function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 1) continue;
        const raw = part.slice(index + 1).trim();
        // A malformed value (e.g. a stray "%" from another app on the same host) must not break every request
        let value;
        try {
            value = decodeURIComponent(raw);
        } catch {
            value = raw;
        }
        cookies[part.slice(0, index).trim()] = value;
    }
    return cookies;
}

module.exports = { signToken, verifyToken, parseCookies, generateLinkToken, hashLinkToken, linkTokenMatches };
