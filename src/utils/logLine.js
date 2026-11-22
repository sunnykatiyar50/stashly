// Shared by the access log and the audit log: how a line is written, and how a stash is named in it.
const crypto = require('crypto');

// The default writer: one line to stdout. Tests (and anything that wants the lines elsewhere) pass their own function.
const writeLine = line => process.stdout.write(`${line}\n`);

// Stash names are the only secret of a password-less stash, so a log must never carry one. This is a short keyed hash
// of the name (HMAC-SHA-256 with the server secret, first 10 hex characters): entries about the same stash match each
// other, but the name cannot be read back or guessed from the log without the secret.
function stashTag(secret, slug) {
    if (typeof slug !== 'string' || !slug) return null;
    return crypto.createHmac('sha256', String(secret)).update(`stashly-log-tag:${slug.toLowerCase()}`).digest('hex').slice(0, 10);
}

module.exports = { writeLine, stashTag };
