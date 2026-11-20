// Note titles: optional, at most 150 characters. Without one, the first five words of the note are used.
const MAX_TITLE = 150;
const AUTO_WORDS = 5;

// Control characters and line breaks become spaces; runs of spaces collapse
const tidy = text => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

// Returns { value } (null when empty) or { error } when the title is not text or is too long
function parseTitle(raw) {
    if (raw === undefined || raw === null) return { value: null };
    if (typeof raw !== 'string') return { error: 'The title must be text.' };
    const value = tidy(raw);
    if (!value) return { value: null };
    if (value.length > MAX_TITLE) return { error: `The title can be at most ${MAX_TITLE} characters.` };
    return { value };
}

// The title used when nobody gave one
function deriveTitle(text) {
    return tidy(text || '').split(' ').slice(0, AUTO_WORDS).join(' ').slice(0, MAX_TITLE);
}

module.exports = { parseTitle, deriveTitle, MAX_TITLE, AUTO_WORDS };
