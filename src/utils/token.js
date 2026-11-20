const crypto = require('crypto');

// The unlock cookie: "<expiry ms>.<hmac>". The HMAC covers the stash name and its password salt, so a token
// only works for that stash, and not for a new stash that later reuses the name.
function mac(secret, slug, salt, expiresAt) {
    return crypto.createHmac('sha256', secret).update(`${slug}.${salt}.${expiresAt}`).digest('hex');
}

function signToken(secret, slug, salt, expiresAt) {
    return `${expiresAt}.${mac(secret, slug, salt, expiresAt)}`;
}

function verifyToken(secret, slug, salt, token, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    const expiresAt = Number(token.slice(0, dot));
    if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(mac(secret, slug, salt, expiresAt));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Minimal cookie parser, so there is no extra dependency
function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 1) continue;
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}

module.exports = { signToken, verifyToken, parseCookies };
