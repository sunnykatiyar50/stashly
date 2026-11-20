const test = require('node:test');
const assert = require('node:assert/strict');
// The browser script also works as a CommonJS module, so the tokenizer and detector can be tested here
const { tokenize, detect, splitLinks } = require('../src/views/highlight.js');

const types = (text, lang) => tokenize(text, lang).filter(t => t.type !== 'plain').map(t => `${t.type}:${t.text}`);
const rebuilt = (text, lang) => tokenize(text, lang).map(t => t.text).join('');

test('tokens always add up to the original text, for every language', () => {
    const sample = 'a "b" # c\n// d\nSELECT 1; <a href="x">y</a> { "k": 1 } $HOME `t` \'s\' /* c */\n';
    for (const lang of ['json', 'javascript', 'python', 'shell', 'sql', 'css', 'markup', 'yaml', 'nonsense']) {
        assert.equal(rebuilt(sample, lang), sample, lang);
    }
    assert.equal(rebuilt('', 'json'), '');
});

test('JSON keys, strings, numbers and keywords are told apart', () => {
    assert.deepEqual(types('{"name": "x", "n": -1.5e3, "ok": true, "z": null}', 'json'), [
        'key:"name"', 'string:"x"', 'key:"n"', 'number:-1.5e3', 'key:"ok"', 'keyword:true', 'key:"z"', 'keyword:null',
    ]);
});

test('JavaScript: comments and strings hide the keywords inside them', () => {
    const out = types('const a = "if x"; // return later\nlet n = 42;', 'javascript');
    assert.deepEqual(out, ['keyword:const', 'string:"if x"', 'comment:// return later', 'keyword:let', 'number:42']);
});

test('Python: triple-quoted strings, comments, keywords', () => {
    const out = types('def f(self):\n    """doc if"""  # note\n    return None', 'python');
    assert.deepEqual(out, ['keyword:def', 'keyword:self', 'string:"""doc if"""', 'comment:# note', 'keyword:return', 'keyword:None']);
});

test('shell variables and SQL are case-insensitive where they should be', () => {
    assert.deepEqual(types('echo "$HOME" $PATH ${X}', 'shell'), ['keyword:echo', 'string:"$HOME"', 'variable:$PATH', 'variable:${X}']);
    assert.deepEqual(types("select name FROM t where id = 1 -- hi", 'sql'), ['keyword:select', 'keyword:FROM', 'keyword:where', 'number:1', 'comment:-- hi']);
});

test('a note is never turned into markup: only text is handled, whatever it contains', () => {
    const evil = '<img src=x onerror=alert(1)> <script>alert(1)</script>';
    assert.equal(rebuilt(evil, 'markup'), evil);
    assert.equal(rebuilt(evil, 'javascript'), evil);
});

test('language detection: clear cases are found, prose and one-liners are left alone', () => {
    assert.equal(detect('{"a": 1, "b": [1, 2, 3]}'), 'json');
    assert.equal(detect('[1, 2, 3, 4, 5, 6, 7]'), 'json');
    assert.equal(detect('<div class="a"><p>hi</p></div>'), 'markup');
    assert.equal(detect('#!/bin/bash\necho hi'), 'shell');
    assert.equal(detect('SELECT id, name FROM users WHERE id = 1;'), 'sql');
    assert.equal(detect('const a = 1;\nconst b = () => a + 1;\nconsole.log(b());'), 'javascript');
    assert.equal(detect('def add(a, b):\n    return a + b\n\nprint(add(1, 2))'), 'python');
    assert.equal(detect('sudo apt update\nsudo apt install git\ngit clone x'), 'shell');
    assert.equal(detect('name: app\nversion: 1\nports:\n  - 80\nenv: prod'), 'yaml');
    assert.equal(detect('body {\n  color: red;\n  margin: 0;\n}'), 'css');

    for (const prose of [
        'Lunch at 1pm, bring the report.\nAlso call mum.',
        'Meeting notes: Alice said the plan is fine. Bob disagreed.',
        'ls -la',
        'hello',
        'Remember: milk, eggs, bread',
        '',
    ]) {
        assert.equal(detect(prose), null, prose);
    }
    assert.equal(detect('{not json at all'), null);
});

test('links: http and https addresses are found, sentence punctuation is not part of them', () => {
    const parts = splitLinks('See https://example.com/a?b=1, or (https://example.com/x). Done: http://a.io.');
    assert.deepEqual(parts.filter(p => p.link).map(p => p.text), ['https://example.com/a?b=1', 'https://example.com/x', 'http://a.io']);
    assert.equal(parts.map(p => p.text).join(''), 'See https://example.com/a?b=1, or (https://example.com/x). Done: http://a.io.');
});

test('links: a closing bracket stays when the address itself has an opening one', () => {
    assert.deepEqual(splitLinks('https://en.wikipedia.org/wiki/Foo_(bar)').filter(p => p.link).map(p => p.text), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});

test('links: only http(s) becomes a link, never javascript: or data: or file:', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://x.com/a', 'see example.com']) {
        assert.equal(splitLinks(text).filter(p => p.link).length, 0, text);
    }
    assert.equal(splitLinks('x https://').filter(p => p.link).length, 0);
});

test('a huge note is left alone instead of being tokenized', () => {
    const big = '"a" '.repeat(100000);
    assert.deepEqual(tokenize(big, 'json'), [{ type: 'plain', text: big }]);
    assert.equal(detect(big), null);
});
