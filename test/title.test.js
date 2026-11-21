const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveTitle } = require('../src/utils/title');

test('the derived title is the first 40 characters, with an ellipsis when there is more', () => {
    assert.equal(deriveTitle('one two three four five six seven'), 'one two three four five six seven');
    assert.equal(deriveTitle('a'.repeat(40)), 'a'.repeat(40));
    assert.equal(deriveTitle('a'.repeat(41)), 'a'.repeat(40) + '…');
    // a space at the cut is dropped before the ellipsis
    assert.equal(deriveTitle('x'.repeat(39) + ' tail'), 'x'.repeat(39) + '…');
    // emoji count as one character each and are never split
    assert.equal(deriveTitle('😀'.repeat(41)), '😀'.repeat(40) + '…');
    assert.equal(deriveTitle('  spaced \n out\ttext '), 'spaced out text');
    assert.equal(deriveTitle(''), '');
    assert.equal(deriveTitle(null), '');
});

test('a leading Markdown marker is not part of the derived title', () => {
    assert.equal(deriveTitle('# Release notes for version two'), 'Release notes for version two');
    assert.equal(deriveTitle('### Small heading here'), 'Small heading here');
    assert.equal(deriveTitle('> a quoted line of text goes here'), 'a quoted line of text goes here');
    assert.equal(deriveTitle('- milk\n- eggs'), 'milk - eggs');
    assert.equal(deriveTitle('* one'), 'one');
});

test('markers that are part of the text are kept', () => {
    assert.equal(deriveTitle('#hashtag in the text'), '#hashtag in the text');
    assert.equal(deriveTitle('-5 degrees today'), '-5 degrees today');
    assert.equal(deriveTitle('#'), '#');
    assert.equal(deriveTitle('- '), '-');
    assert.equal(deriveTitle('2 * 3 = 6'), '2 * 3 = 6');
});
