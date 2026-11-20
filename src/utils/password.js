const crypto = require('crypto');

const KEY_LENGTH = 64;
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 200;

function scrypt(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = await scrypt(password, salt);
    return { hash: key.toString('hex'), salt };
}

async function verifyPassword(password, hash, salt) {
    if (typeof password !== 'string' || !hash || !salt) return false;
    const key = await scrypt(password, salt);
    const expected = Buffer.from(hash, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, verifyPassword, MIN_PASSWORD, MAX_PASSWORD };
