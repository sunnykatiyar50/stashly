const test = require('node:test');
const assert = require('node:assert/strict');
// The browser script also works as a CommonJS module, so the parser and detector can be tested here
const { parse, parseInline, looks, looksSlack, hasFence, shortcodes, EMOJI } = require('../src/views/markdown.js');

const text = nodes => nodes.map(n => (n.t === 'text' ? n.v : n.children ? text(n.children) : n.v || '')).join('');
const kinds = blocks => blocks.map(b => b.t);

test('headings, paragraphs and rules become blocks', () => {
    const blocks = parse('# Title\n\nFirst paragraph\nsecond line\n\n## Sub\n\n---\n\nEnd');
    assert.deepEqual(kinds(blocks), ['heading', 'p', 'heading', 'hr', 'p']);
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[2].level, 2);
    // A line break inside a paragraph is kept (these are notes, not articles)
    assert.deepEqual(blocks[1].children.map(n => n.t), ['text', 'br', 'text']);
});

test('inline: bold, italic, strike, code, links and escapes', () => {
    const n = parseInline('a **b** *c* ~~d~~ `e` [f](https://x.com/y) \\*g\\*');
    assert.deepEqual(n.filter(x => x.t !== 'text').map(x => x.t), ['strong', 'em', 'del', 'code', 'link']);
    assert.equal(n.find(x => x.t === 'link').href, 'https://x.com/y');
    assert.equal(text(n), 'a b c d e f *g*');
});

test('inline: snake_case and a * b * c are not emphasis', () => {
    assert.deepEqual(parseInline('call my_function_name now').map(x => x.t), ['text']);
    assert.deepEqual(parseInline('2 * 3 * 4').map(x => x.t), ['text']);
    assert.deepEqual(parseInline('a _b_ c').map(x => x.t), ['text', 'em', 'text']);
});

test('inline: nested emphasis and code spans keep their text', () => {
    const n = parseInline('**bold with `code` and *italic* text**');
    assert.equal(n[0].t, 'strong');
    assert.equal(text(n), 'bold with code and italic text');
    assert.equal(parseInline('`` a ` b ``')[0].v, 'a ` b');
});

test('lists: bullets, numbers, nesting and tasks', () => {
    const [list, numbered] = parse('- a\n- b\n  - nested\n- [x] done\n- [ ] todo\n\n3. three\n4. four');
    assert.equal(list.t, 'list');
    assert.equal(list.items.length, 4);
    assert.deepEqual(list.items.map(i => i.task), [null, null, true, false]);
    const nested = list.items[1].blocks.find(b => b.t === 'list');
    assert.equal(nested.items.length, 1);
    assert.equal(text(nested.items[0].blocks[0].children), 'nested');
    assert.equal(numbered.ordered, true);
    assert.equal(numbered.start, 3);
});

test('a list can interrupt a paragraph, as in a shopping list note', () => {
    const blocks = parse('Shopping:\n- milk\n- eggs');
    assert.deepEqual(kinds(blocks), ['p', 'list']);
});

test('fenced code keeps its text exactly and records its language', () => {
    const blocks = parse('before\n\n```js\nconst a = "<b>";\n\n  indented\n```\n\nafter');
    assert.deepEqual(kinds(blocks), ['p', 'code', 'p']);
    assert.equal(blocks[1].lang, 'js');
    assert.equal(blocks[1].text, 'const a = "<b>";\n\n  indented');
    // An unclosed fence runs to the end of the note
    assert.equal(parse('```\nopen ended\nstill code')[0].text, 'open ended\nstill code');
    // A tilde fence is not closed by backticks
    assert.equal(parse('~~~\na\n```\nb\n~~~')[0].text, 'a\n```\nb');
});

test('tables, quotes', () => {
    const [table] = parse('| a | b |\n|---|--:|\n| 1 | 2 |\n| 3 |');
    assert.equal(table.t, 'table');
    assert.deepEqual(table.aligns, [null, 'right']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[1].length, 2); // a short row is padded
    const [quote] = parse('> quoted\n> **bold**\n>\n> more');
    assert.equal(quote.t, 'quote');
    assert.ok(quote.children.some(b => b.t === 'p'));
});

test('safety: raw HTML is only ever text', () => {
    const [p] = parse('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    assert.equal(p.t, 'p');
    assert.ok(p.children.every(n => n.t === 'text'));
    assert.match(text(p.children), /<script>alert\(1\)<\/script>/);
});

test('safety: only http and https links are links', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'vbscript:x', '//evil.com', 'ftp://x.com']) {
        // Either it is not a link at all, or it is one with no address: never a working link to that address
        const link = parseInline(`[click](${url})`).find(n => n.t === 'link');
        assert.ok(!link || link.href === null, url);
    }
    assert.equal(parseInline('[ok](http://a.com)').find(n => n.t === 'link').href, 'http://a.com');
    assert.equal(parseInline('<javascript:alert(1)>').find(n => n.t === 'link'), undefined);
    assert.equal(parseInline('<https://a.com/x>').find(n => n.t === 'link').href, 'https://a.com/x');
});

test('safety: an image is shown as a link, never fetched', () => {
    const link = parseInline('![a cat](https://x.com/cat.png)')[0];
    assert.equal(link.t, 'link');
    assert.equal(link.image, true);
    assert.equal(parseInline('![bad](javascript:alert(1))')[0].href, null);
});

test('bare addresses become links without the punctuation after them', () => {
    const links = parseInline('see https://example.com/a, and (https://b.org/c). Not xhttps://nope.com').filter(n => n.t === 'link').map(n => n.href);
    assert.deepEqual(links, ['https://example.com/a', 'https://b.org/c']);
});

test('detection: fences, mixed signals and lists count; prose, code comments and one-offs do not', () => {
    assert.equal(hasFence('text\n```\ncode\n```'), true);
    assert.equal(hasFence('text\n```\nunclosed'), false);
    assert.equal(looks('# Title\n\nSome **bold** text'), true);
    assert.equal(looks('Notes\n\n- one\n- two\n- three'), true);
    assert.equal(looks('Read [the docs](https://example.com/docs) and **do** it'), true);
    assert.equal(looks('| a | b |\n|---|---|\n| 1 | 2 |'), true);
    assert.equal(looks('> a quote\n\n# And a heading'), true);

    for (const plain of [
        'Lunch at 1pm, bring the report.',
        'Just one **word** bold',
        '# install deps\nnpm install\nnpm test',
        'Call mum - she asked for a favour',
        '- one thing only',
        'a_b_c and 2 * 3 * 4',
        '',
    ]) {
        assert.equal(looks(plain), false, plain);
    }
});

test('weird and hostile notes parse fast and never throw', () => {
    const started = Date.now();
    for (const nasty of [
        '*a '.repeat(40000),
        '`a '.repeat(40000),
        '~~a '.repeat(30000),
        '[a'.repeat(50000),
        '> '.repeat(5000) + 'x',
        Array.from({ length: 2000 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\n'),
        '**'.repeat(5000),
        '|'.repeat(20000) + '\n' + '|-'.repeat(5000),
        '\u0000\u0001\ud800 [x](',
    ]) {
        assert.doesNotThrow(() => parse(nasty));
    }
    assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
});

test('nesting is cut off at a sensible depth', () => {
    const deep = Array.from({ length: 200 }, (_, i) => ' '.repeat(i * 2) + '- level ' + i).join('\n');
    let depth = 0;
    let blocks = parse(deep);
    while (blocks[0] && blocks[0].t === 'list') { blocks = blocks[0].items[0].blocks.filter(b => b.t === 'list'); depth++; if (!blocks.length) break; }
    assert.ok(depth <= 14, 'depth ' + depth);
});

// ---- chat style: what a note pasted from Slack, Teams or Discord looks like ----

const chat = [
    ':rocket: *New fleet standards in 5.5.0*',
    '',
    'CIS-21755 is merging into *5.5.0*.',
    '',
    '*:one:  PII masking in logs*',
    ' • Any class that can reach a log gets `@PiiMasked` — *never* `@Data`.',
    ' • *Annotate every field* — `@Pii` to mask, `@PiiSafe` for the rest.',
].join('\n');

test('chat style: one asterisk is bold, and a dot is a bullet', () => {
    // The note as a whole still is not Markdown: that is why it used to stay plain text
    assert.equal(looks(chat), false);
    assert.equal(looksSlack(chat), true);

    const blocks = parse(chat, 'slack');
    assert.deepEqual(kinds(blocks), ['p', 'p', 'p', 'list']);
    // ":rocket: *...*" is the emoji, a space, then a bold line
    assert.deepEqual(blocks[0].children.map(n => n.t), ['text', 'text', 'strong']);
    assert.equal(blocks[0].children[0].v, '🚀');
    assert.equal(text(blocks[0].children), '🚀 New fleet standards in 5.5.0');
    assert.equal(text(blocks[2].children), '1️⃣  PII masking in logs');
    assert.equal(blocks[2].children[0].t, 'strong');

    const list = blocks[3];
    assert.equal(list.ordered, false);
    assert.equal(list.items.length, 2);
    // Inline code inside a bullet stays code, and the bold in it stays bold
    assert.deepEqual(list.items[0].blocks[0].children.map(n => n.t), ['text', 'code', 'text', 'strong', 'text', 'code', 'text']);
    assert.equal(text(list.items[1].blocks[0].children), 'Annotate every field — @Pii to mask, @PiiSafe for the rest.');
});

test('chat style: bullets nest and numbered items still work', () => {
    const [list] = parse(' • one\n   • nested\n • two\n\n1. first\n2. second', 'slack');
    assert.equal(list.t, 'list');
    assert.equal(list.items.length, 2);
    assert.equal(list.items[0].blocks.find(b => b.t === 'list').items.length, 1);
    const numbered = parse('1. first\n2. second', 'slack')[0];
    assert.equal(numbered.ordered, true);
    assert.equal(text(numbered.items[1].blocks[0].children), 'second');
});

test('chat style: Markdown still works, because chat style only adds rules', () => {
    const blocks = parse('# Heading\n\n**bold** ~~strike~~ [link](https://a.com)\n\n```js\nconst a = 1;\n```', 'slack');
    assert.deepEqual(kinds(blocks), ['heading', 'p', 'code']);
    assert.deepEqual(blocks[1].children.map(n => n.t).filter(t => t !== 'text'), ['strong', 'del', 'link']);
    assert.equal(blocks[2].text, 'const a = 1;');
});

test('chat style: a line that starts with * still reads as a bullet, not as bold', () => {
    assert.deepEqual(parse('* item one\n* item two', 'slack').map(b => b.t), ['list']);
    // Markdown keeps a single asterisk as italic, and a single tilde as text
    assert.equal(parseInline('*italic*')[0].t, 'em');
    assert.equal(parseInline('~tilde~').map(n => n.t).join(','), 'text');
    assert.equal(parseInline('*bold*', 0, 'slack')[0].t, 'strong');
    assert.equal(parseInline('~strike~', 0, 'slack')[0].t, 'del');
    assert.equal(parseInline('a * b * c', 0, 'slack').map(n => n.t).join(','), 'text');
});

test('emoji names: known ones become the emoji, unknown ones stay as typed', () => {
    assert.equal(text(parseInline(':rocket: ship it', 0, 'slack')), '🚀 ship it');
    assert.equal(text(parseInline(':one: first', 0, 'slack')), '1️⃣ first');
    assert.equal(text(parseInline(':+1: and :-1:', 0, 'slack')), '👍 and 👎');
    // Case does not matter, and a name is only ever text, never markup
    assert.equal(text(parseInline(':ROCKET:', 0, 'slack')), '🚀');
    assert.equal(text(parseInline(':made_up: name', 0, 'slack')), ':made_up: name');
    // A time or a path is not an emoji name
    assert.equal(text(parseInline('at 10:30:00', 0, 'slack')), 'at 10:30:00');
    assert.equal(text(parseInline('C:\\temp', 0, 'slack')), 'C:\\temp');
    // Emoji are turned on in Markdown notes too, but never inside code
    const inline = parseInline('`:rocket:` and :rocket:');
    assert.equal(inline[0].t, 'code');
    assert.equal(inline[0].v, ':rocket:');
    assert.equal(inline[inline.length - 1].v, '🚀');
    assert.deepEqual(parse('```\n:rocket: *x* ~y~\n```', 'slack')[0].text, ':rocket: *x* ~y~');
    // A fence inside a bullet is left exactly as it is
    const [list] = parse(' • point\n   ```\n   :rocket: *keep*\n   ```', 'slack');
    assert.equal(list.items[0].blocks.find(b => b.t === 'code').text.trim(), ':rocket: *keep*');
});

test('the emoji table is sane: lowercase names and real emoji values', () => {
    const names = Object.keys(EMOJI);
    assert.ok(names.length >= 100, 'names: ' + names.length);
    for (const name of names) {
        assert.match(name, /^[a-z0-9_+-]+$/, name);
        const value = EMOJI[name];
        assert.equal(typeof value, 'string');
        assert.ok(value.length > 0, name);
        assert.doesNotMatch(value, /[\s<>&"']/, name);
        assert.equal(Array.from(value).some(ch => ch.codePointAt(0) > 0x2000), true, name + ' is not an emoji');
    }
    assert.equal(EMOJI.rocket, '🚀');
    assert.equal(EMOJI.one, '1️⃣');
});

test('shortcodes: a title shows the emoji, and anything already typed stays', () => {
    assert.equal(shortcodes(':rocket: Deploy notes'), '🚀 Deploy notes');
    assert.equal(shortcodes('Deploy day 🚀 — done'), 'Deploy day 🚀 — done');
    assert.equal(shortcodes(':one: and :two:'), '1️⃣ and 2️⃣');
    assert.equal(shortcodes(':made_up: stays'), ':made_up: stays');
    assert.equal(shortcodes('10:30:00 to 11:00:00'), '10:30:00 to 11:00:00');
    assert.equal(shortcodes(null), '');
    assert.equal(shortcodes(''), '');
    // A title is plain text: no Markdown is applied to it, only the names are replaced
    assert.equal(shortcodes('*bold* stays'), '*bold* stays');
});

test('detection: a chat paste counts, and the near misses do not', () => {
    assert.equal(looksSlack(':rocket: shipping it'), true);
    assert.equal(looksSlack('Notes\n • one\n • two'), true);
    assert.equal(looksSlack('*Done* — deploy is live.\n*Also* — build is green.'), true);

    for (const plain of [
        'I left the keys on the desk.\nCall me when you get in.',
        'files: *.log *.tmp',
        'Shopping:\n • milk',
        'meeting 10:30:00 to 11:00:00',
        'SELECT id FROM users WHERE name = :name;',
        'use :made_up: here',
        'a_b_c and 2 * 3 * 4',
        '',
    ]) {
        assert.equal(looksSlack(plain), false, plain);
    }
    // Markdown is not chat style, and the other way round
    assert.equal(looksSlack('# Title\n\n- one\n- two\n- three'), false);
    assert.equal(looks('*bold* with • bullets\n*second* line'), false);
});

test('chat style parses hostile notes fast too', () => {
    const started = Date.now();
    for (const nasty of [
        '*a '.repeat(40000),
        '• a\n'.repeat(20000),
        ':a'.repeat(50000),
        '~a '.repeat(30000),
        ' • '.repeat(20000),
    ]) {
        assert.doesNotThrow(() => parse(nasty, 'slack'));
        assert.doesNotThrow(() => looksSlack(nasty));
        assert.doesNotThrow(() => shortcodes(nasty));
    }
    assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
});
