const crypto = require('crypto');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const MIN_LENGTH = 4;
const MAX_LENGTH = 64;
const GENERATED_LENGTH = 12;
// Names that would collide with fixed routes
const RESERVED = new Set(['suggest', 'config']);

// 12 random base32 characters: about 60 bits, not guessable
function generateSlug(length = GENERATED_LENGTH) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
}

// Returns { slug } or { error }
function parseSlug(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { error: 'A stash name is required.' };
    const slug = raw.trim().toLowerCase();
    if (slug.length < MIN_LENGTH) return { error: `The name must be at least ${MIN_LENGTH} characters.` };
    if (slug.length > MAX_LENGTH) return { error: `The name can be at most ${MAX_LENGTH} characters.` };
    if (!/^[a-z0-9_-]+$/.test(slug)) return { error: 'Use only letters, numbers, dashes and underscores.' };
    if (RESERVED.has(slug)) return { error: 'That name is reserved. Pick another.' };
    return { slug };
}

module.exports = { generateSlug, parseSlug, MIN_LENGTH, MAX_LENGTH, GENERATED_LENGTH };
