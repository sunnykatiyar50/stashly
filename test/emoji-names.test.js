const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The stash page's table and the extension's copy, so the two can be compared here
const { EMOJI, shortcodes } = require('../src/views/markdown.js');
const extension = require('../extension/emoji.js');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('the extension shows emoji names from the same table as the stash page', () => {
    // A name added on one side and missed on the other would show differently in the popup and the page
    assert.deepEqual(extension.EMOJI, EMOJI);
    for (const name of Object.keys(EMOJI)) {
        assert.equal(extension.shortcodes(`:${name}:`), EMOJI[name], name);
        assert.equal(extension.shortcodes(`:${name.toUpperCase()}:`), EMOJI[name], name);
    }
    // And the same answers on the things a title can hold
    for (const title of [':rocket: Deploy notes', 'Deploy day 🚀 — done', ':made_up: stays', ':one: and :+1:', ':1st_place_medal:', 'C:\\path\\10:30:00', '*bold* stays', '', null, undefined]) {
        assert.equal(extension.shortcodes(title), shortcodes(title), String(title));
    }
});

test('the popup loads the names and shows them in a clip title', () => {
    const html = read('extension/popup.html');
    // Before popup.js, which reads them as it draws
    assert.match(html, /<script src="emoji\.js"><\/script>\s*<script src="popup\.js"><\/script>/);
    const popup = read('extension/popup.js');
    // Both places a title is shown: the list, and the note a reveal just deleted
    assert.match(popup, /'note-title', shortcodes\(item\.title\)/);
    assert.match(popup, /'note-title', shortcodes\(isFile \? item\.title \|\| item\.fileName : item\.title\)/);
    // Only the label: Copy still sends the clip itself, and the search still goes to the server as it was typed
    assert.match(popup, /copyButton\(item\.text\)/);
    assert.match(popup, /json\.search = search;/);
});

test('a notification names an emoji instead of showing :rocket:', () => {
    const live = read('src/views/stash-live.js');
    // A title and the start of the note both go through the table (the page's own, from markdown.js)
    assert.match(live, /function emojiNames\(text\) \{\s*var markdown = window\.StashlyMarkdown;\s*return markdown && markdown\.shortcodes \? markdown\.shortcodes\(text\) : text;/);
    assert.match(live, /'New file: ' \+ emojiNames\(item\.fileName \|\| ''\)/);
    assert.match(live, /emojiNames\(item\.title\) \+ ': '/);
    assert.match(live, /clipText\(emojiNames\(oneLine\(item\.text\)\), 100\)/);
    // The 100-character cut never leaves half of an emoji behind
    assert.match(live, /function clipText\(text, limit\) \{\s*var out = text\.slice\(0, limit\);\s*return \/\[\\uD800-\\uDBFF\]\$\/\.test\(out\) \? out\.slice\(0, -1\) : out;/);
});
