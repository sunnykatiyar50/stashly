const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, detect, resolve, label } = require('../src/views/highlight.js');

const types = (text, lang) => tokenize(text, lang).filter(t => t.type !== 'plain').map(t => `${t.type}:${t.text}`);
const rebuilt = (text, lang) => tokenize(text, lang).map(t => t.text).join('');

const SAMPLES = {
    go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tx := 42 // answer\n\tfmt.Println("hi", x)\n}\n',
    rust: 'use std::io;\n\nfn main() {\n    let mut count = 0; // counter\n    println!("hello {}", count);\n}\n',
    java: 'public class Hello {\n    public static void main(String[] args) {\n        System.out.println("hi"); // greet\n    }\n}\n',
    csharp: 'using System;\n\nnamespace App {\n    public class Program {\n        static void Main() { Console.WriteLine("hi"); }\n    }\n}\n',
    c: '#include <stdio.h>\n\nint main(void) {\n    printf("hi\\n"); /* greet */\n    return 0;\n}\n',
    php: '<?php\n$name = "world"; // greet\necho "Hello $name";\n',
    ruby: 'require "json"\n\ndef greet(name)\n  puts "hi #{name}" # greet\nend\n',
    powershell: 'param($Name)\nGet-ChildItem -Path $env:TEMP | Where-Object { $_.Length -gt 10 }\nWrite-Host "done" # finished\n',
    ini: '[server]\nport = 8080\nhost = "localhost"\n; comment\n[db]\nenabled = true\n',
    dockerfile: 'FROM node:22\n# install\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "src/app.js"]\n',
    diff: '--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n',
};

test('every new language tokenizes and the tokens add up to the original text', () => {
    for (const [lang, sample] of Object.entries(SAMPLES)) {
        assert.equal(rebuilt(sample, lang), sample, lang);
        assert.ok(tokenize(sample, lang).some(t => t.type !== 'plain'), `${lang} has some colour`);
        assert.ok(label(lang), `${lang} has a label`);
    }
});

test('new languages colour what you would expect', () => {
    assert.ok(types(SAMPLES.go, 'go').includes('keyword:func'));
    assert.ok(types(SAMPLES.go, 'go').includes('comment:// answer'));
    assert.ok(types(SAMPLES.rust, 'rust').includes('keyword:mut'));
    assert.ok(types(SAMPLES.java, 'java').includes('keyword:static'));
    assert.ok(types(SAMPLES.csharp, 'csharp').includes('keyword:namespace'));
    assert.ok(types(SAMPLES.c, 'c').includes('keyword:#include <stdio.h>'));
    assert.ok(types(SAMPLES.c, 'c').includes('comment:/* greet */'));
    assert.ok(types(SAMPLES.php, 'php').includes('variable:$name'));
    assert.ok(types(SAMPLES.ruby, 'ruby').includes('keyword:def'));
    assert.ok(types(SAMPLES.powershell, 'powershell').includes('keyword:Get-ChildItem'));
    assert.ok(types(SAMPLES.powershell, 'powershell').includes('variable:$env:TEMP'));
    assert.ok(types(SAMPLES.ini, 'ini').includes('keyword:[server]'));
    assert.ok(types(SAMPLES.ini, 'ini').includes('key:port'));
    assert.ok(types(SAMPLES.dockerfile, 'dockerfile').includes('keyword:FROM'));
    assert.deepEqual(types('-old\n+new\n@@ -1 +1 @@', 'diff'), ['del:-old', 'add:+new', 'hunk:@@ -1 +1 @@']);
});

test('keywords inside strings and comments are not coloured as keywords', () => {
    assert.deepEqual(types('x := "func if"', 'go'), ['string:"func if"']);
    assert.deepEqual(types('# FROM later\nRUN x', 'dockerfile'), ['comment:# FROM later', 'keyword:RUN']);
});

test('names people put after a fence are understood', () => {
    for (const [name, lang] of Object.entries({
        js: 'javascript', ts: 'javascript', TSX: 'javascript', py: 'python', sh: 'shell', bash: 'shell', yml: 'yaml', html: 'markup',
        ps1: 'powershell', 'c++': 'c', cpp: 'c', cs: 'csharp', golang: 'go', rs: 'rust', rb: 'ruby', toml: 'ini', env: 'ini', patch: 'diff',
        json: 'json', sql: 'sql', css: 'css', docker: 'dockerfile',
    })) {
        assert.equal(resolve(name), lang, name);
    }
    for (const unknown of ['', 'klingon', undefined, null, '__proto__', 'constructor']) assert.equal(resolve(unknown), null, String(unknown));
});

test('detection finds the new languages in realistic snippets', () => {
    for (const [lang, sample] of Object.entries(SAMPLES)) {
        const found = detect(sample);
        assert.equal(found, lang, `${lang} was detected as ${found}`);
    }
});

test('detection does not mistake ordinary text for the new languages', () => {
    for (const prose of [
        'Meeting at 3\nBring: laptop, charger\nAsk about the budget',
        'Remember to buy [milk] and eggs\nthen call Sam',
        'Subject: Lunch\nFrom: me\nTo: you\nSee you at 1',
        'ip = 10.0.0.5 and port = 22',
        'Total = 40\nPaid = 30\nLeft = 10',
        'end\nthe end\nthat is all',
        'a := b means a is defined as b\nnothing else here',
        'He said: println! is a macro',
        '[draft]\nWrite the intro\nWrite the end',
        'diff between the two options is small\n+ cheaper\n- slower',
        'password: hunter2',
    ]) {
        assert.equal(detect(prose), null, JSON.stringify(prose) + ' was detected as ' + detect(prose));
    }
});

test('the languages that existed before are still found', () => {
    assert.equal(detect('{"a": 1, "b": [1, 2, 3]}'), 'json');
    assert.equal(detect('const a = 1;\nconst b = () => a + 1;\nconsole.log(b());'), 'javascript');
    assert.equal(detect('def add(a, b):\n    return a + b\n\nprint(add(1, 2))'), 'python');
    assert.equal(detect('SELECT id, name FROM users WHERE id = 1;'), 'sql');
    assert.equal(detect('name: app\nversion: 1\nports:\n  - 80\nenv: prod'), 'yaml');
    assert.equal(detect('sudo apt update\nsudo apt install git\ngit clone x'), 'shell');
});
