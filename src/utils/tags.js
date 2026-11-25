// Tags on clips: short lowercase words (letters, numbers, - and _), at most MAX_TAGS per clip. They are stored as a JSON
// array on the item. Because a tag can never hold a quote or a backslash, "a tag is on this clip" can be asked of the
// stored text with a plain LIKE on the quoted word.
const MAX_TAGS = 8;
const MAX_TAG = 24;

// A tag is typed with or without a leading # and in any case; it is stored lowercase without the #
const clean = raw => String(raw).trim().replace(/^#+/, '').toLowerCase();
const VALID = /^[\p{L}\p{N}_-]+$/u;

// One tag: { value } or { error }
function parseTag(raw) {
    if (typeof raw !== 'string') return { error: 'A tag must be text.' };
    const value = clean(raw);
    if (!value) return { error: 'A tag cannot be empty.' };
    if (Array.from(value).length > MAX_TAG) return { error: `A tag can be at most ${MAX_TAG} characters.` };
    if (!VALID.test(value)) return { error: 'A tag can only have letters, numbers, - and _.' };
    return { value };
}

// A whole list: { value: [...] } (duplicates dropped, order kept; an empty list is fine) or { error }
function parseTags(raw) {
    if (raw === undefined || raw === null) return { value: [] };
    if (!Array.isArray(raw)) return { error: 'Tags must be a list.' };
    const value = [];
    for (const item of raw) {
        const tag = parseTag(item);
        if (tag.error) return tag;
        if (!value.includes(tag.value)) value.push(tag.value);
    }
    if (value.length > MAX_TAGS) return { error: `A clip can have at most ${MAX_TAGS} tags.` };
    return { value };
}

// The tags of a stored row (null or damaged text means none)
function tagsOf(row) {
    if (!row || !row.tags) return [];
    try {
        const list = JSON.parse(row.tags);
        return Array.isArray(list) ? list.filter(tag => typeof tag === 'string') : [];
    } catch (err) {
        return [];
    }
}

// What goes in the column: null for none
const serializeTags = tags => (tags.length ? JSON.stringify(tags) : null);

// Splits a search box into its #tag words and the rest: "invoice #work #2024" is { text: 'invoice', tags: ['work', '2024'] }.
// A # word that is not a valid tag stays in the text.
function splitSearch(search) {
    const tags = [];
    const rest = [];
    for (const word of String(search || '').split(/\s+/).filter(Boolean)) {
        const tag = word.startsWith('#') && word.length > 1 ? parseTag(word) : null;
        if (tag && tag.value) { if (!tags.includes(tag.value)) tags.push(tag.value); } else rest.push(word);
    }
    return { text: rest.join(' '), tags };
}

module.exports = { parseTag, parseTags, tagsOf, serializeTags, splitSearch, MAX_TAGS, MAX_TAG };
