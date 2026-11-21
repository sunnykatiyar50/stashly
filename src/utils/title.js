// Note titles: optional, at most 150 characters. Without one, the first 40 characters of the note are used.
const MAX_TITLE = 150;
const AUTO_CHARS = 40;

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

// The title used when nobody gave one: the first 40 characters of the note, with "…" when there is more
function deriveTitle(text) {
    let words = tidy(text || '');
    // A leading Markdown marker (# heading, > quote, - bullet) is formatting, not part of the title
    const bare = words.replace(/^(?:#{1,6}|>|[-*+])\s+/, '');
    if (bare) words = bare;
    // Counted in characters, not UTF-16 units, so an emoji is never cut in half
    const chars = Array.from(words);
    if (chars.length <= AUTO_CHARS) return words;
    return chars.slice(0, AUTO_CHARS).join('').trimEnd() + '…';
}

module.exports = { parseTitle, deriveTitle, MAX_TITLE, AUTO_CHARS };
