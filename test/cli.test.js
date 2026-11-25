const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { makeApp, PNG } = require('./helpers/app');
const { unzip } = require('./helpers/unzip');

const CLI = path.join(__dirname, '..', 'bin', 'stashly.js');

// Starts the app on a free port and gives back a runner for the command line tool, plus a scratch folder to work in
async function setup(overrides = {}) {
    const ctx = makeApp(overrides);
    const server = ctx.app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-cli-'));
    const run = (args, { env = {}, input } = {}) =>
        new Promise(resolve => {
            const child = execFile(
                process.execPath,
                [CLI, ...args],
                { cwd: dir, env: { PATH: process.env.PATH, STASHLY_URL: url, ...env } },
                (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })
            );
            child.stdin.end(input === undefined ? undefined : input);
        });
    const done = () => {
        server.close();
        server.closeAllConnections();
        fs.rmSync(dir, { recursive: true, force: true });
    };
    return { ...ctx, url, dir, run, done };
}

test('new, send, get and list work against a stash', async () => {
    const t = await setup();
    try {
        const made = await t.run(['new', 'cli-stash', '--ttl', '7d']);
        assert.equal(made.code, 0, made.stderr);
        assert.match(made.stdout, new RegExp(`Created ${t.url}/s/cli-stash`));
        assert.equal(t.model.findBySlug('cli-stash').ttl_ms, 7 * 24 * 3600 * 1000);

        const sent = await t.run(['send', 'cli-stash', 'hello from the cli', '--title', 'Greeting']);
        assert.equal(sent.code, 0, sent.stderr);
        assert.match(sent.stdout, /^Sent note \d+/);

        const got = await t.run(['get', 'cli-stash']);
        assert.equal(got.code, 0, got.stderr);
        assert.equal(got.stdout, 'hello from the cli');

        const listed = await t.run(['list', 'cli-stash']);
        assert.equal(listed.code, 0);
        const [id, kind, size, , title] = listed.stdout.trim().split('\t');
        assert.equal(kind, 'note');
        assert.equal(title, 'Greeting');
        assert.equal(size, `${'hello from the cli'.length}c`);
        assert.match(id, /^\d+$/);
    } finally {
        t.done();
    }
});

test('send reads the text from stdin when there is none (or "-")', async () => {
    const t = await setup();
    try {
        await t.run(['new', 'piped']);
        assert.equal((await t.run(['send', 'piped'], { input: 'line one\nline two\n' })).code, 0);
        assert.equal((await t.run(['get', 'piped'])).stdout, 'line one\nline two');
        assert.equal((await t.run(['send', 'piped', '-'], { input: 'via dash' })).code, 0);
        assert.equal((await t.run(['get', 'piped'])).stdout, 'via dash');
        const empty = await t.run(['send', 'piped'], { input: '  \n' });
        assert.equal(empty.code, 1);
        assert.match(empty.stderr, /empty/);
    } finally {
        t.done();
    }
});

test('send --file uploads from disk, pull downloads it and export makes a zip', async () => {
    const t = await setup();
    try {
        await t.run(['new', 'filey']);
        const original = Buffer.concat([PNG, Buffer.alloc(300000, 3)]);
        const source = path.join(t.dir, 'my picture.png');
        fs.writeFileSync(source, original);

        const sent = await t.run(['send', 'filey', '--file', source, '--title', 'Pic é']);
        assert.equal(sent.code, 0, sent.stderr);
        assert.match(sent.stdout, /Sent file my picture\.png \(id (\d+), 300040 bytes\)/);
        const id = /id (\d+)/.exec(sent.stdout)[1];
        const item = t.model.getItem(t.model.findBySlug('filey').id, Number(id));
        assert.equal(item.file_name, 'my picture.png');
        assert.equal(item.title, 'Pic é');
        assert.equal(item.file_type, 'image/png');

        // default name: the file's own name, in the current folder
        fs.rmSync(source);
        const pulled = await t.run(['pull', 'filey', id]);
        assert.equal(pulled.code, 0, pulled.stderr);
        assert.ok(fs.readFileSync(path.join(t.dir, 'my picture.png')).equals(original));

        // it does not overwrite what is there
        const again = await t.run(['pull', 'filey', id]);
        assert.equal(again.code, 1);
        assert.match(again.stderr, /already exists/);

        const out = path.join(t.dir, 'copy.bin');
        assert.equal((await t.run(['pull', 'filey', id, '--out', out])).code, 0);
        assert.ok(fs.readFileSync(out).equals(original));

        await t.run(['send', 'filey', 'a note too']);
        const exported = await t.run(['export', 'filey', '--out', 'all.zip']);
        assert.equal(exported.code, 0, exported.stderr);
        const files = unzip(fs.readFileSync(path.join(t.dir, 'all.zip')));
        assert.ok(files.get(`files/${id}-my picture.png`).equals(original));
        assert.ok([...files.keys()].some(n => n.startsWith('notes/')));

        // default name is NAME.zip
        assert.equal((await t.run(['export', 'filey'])).code, 0);
        assert.ok(fs.existsSync(path.join(t.dir, 'filey.zip')));
    } finally {
        t.done();
    }
});

test('a pulled file goes to stdout with --out -', async () => {
    const t = await setup();
    try {
        await t.run(['new', 'stdout-test']);
        const source = path.join(t.dir, 'words.txt');
        fs.writeFileSync(source, 'plain words');
        const id = /id (\d+)/.exec((await t.run(['send', 'stdout-test', '--file', source])).stdout)[1];
        const res = await t.run(['pull', 'stdout-test', id, '--out', '-']);
        assert.equal(res.code, 0, res.stderr);
        assert.equal(res.stdout, 'plain words');
    } finally {
        t.done();
    }
});

test('a password-protected stash is unlocked with --password or STASHLY_PASSWORD', async () => {
    const t = await setup();
    try {
        const made = await t.run(['new', 'locked-up', '--password', 'swordfish-9']);
        assert.equal(made.code, 0, made.stderr);
        assert.match(made.stdout, /password protected/);
        assert.ok(t.model.findBySlug('locked-up').password_hash);

        const noPassword = await t.run(['send', 'locked-up', 'nope']);
        assert.equal(noPassword.code, 1);
        assert.match(noPassword.stderr, /locked/i);

        const wrong = await t.run(['send', 'locked-up', 'nope', '--password', 'wrong-guess']);
        assert.equal(wrong.code, 1);
        assert.match(wrong.stderr, /not right/);

        const viaFlag = await t.run(['send', 'locked-up', 'secret text', '--password', 'swordfish-9']);
        assert.equal(viaFlag.code, 0, viaFlag.stderr);
        const viaEnv = await t.run(['get', 'locked-up'], { env: { STASHLY_PASSWORD: 'swordfish-9' } });
        assert.equal(viaEnv.stdout, 'secret text');
        assert.equal((await t.run(['list', 'locked-up'], { env: { STASHLY_PASSWORD: 'swordfish-9' } })).code, 0);

        // a stash without a password is fine with a password set in the environment
        await t.run(['new', 'open-stash']);
        assert.equal((await t.run(['send', 'open-stash', 'x'], { env: { STASHLY_PASSWORD: 'swordfish-9' } })).code, 0);
    } finally {
        t.done();
    }
});

test('errors give exit status 1 and the server\'s own message on one line', async () => {
    const t = await setup();
    try {
        const missing = await t.run(['get', 'no-such-stash']);
        assert.equal(missing.code, 1);
        assert.equal(missing.stdout, '');
        assert.match(missing.stderr, /^stashly: This stash has expired or does not exist\.\n$/);

        const dup = await t.run(['new', 'twice']);
        assert.equal(dup.code, 0);
        const again = await t.run(['new', 'twice']);
        assert.equal(again.code, 1);
        assert.equal(again.stderr.trim().split('\n').length, 1);

        const empty = await t.run(['get', 'twice']);
        assert.equal(empty.code, 1);
        assert.match(empty.stderr, /No notes yet/);

        const noFile = await t.run(['send', 'twice', '--file', path.join(t.dir, 'missing.bin')]);
        assert.equal(noFile.code, 1);
        assert.match(noFile.stderr, /not a file/);

        const badTtl = await t.run(['new', 'another', '--ttl', '3y']);
        assert.equal(badTtl.code, 1);
        assert.match(badTtl.stderr, /listed expiry times/);

        const unknown = await t.run(['frobnicate', 'x']);
        assert.equal(unknown.code, 1);
        assert.match(unknown.stderr, /Unknown command/);
        assert.equal((await t.run(['send'])).code, 1);
        assert.equal((await t.run(['send', 'x', '--nope', '1'])).code, 1);
    } finally {
        t.done();
    }
});

test('a server that cannot be reached is a clear error, and --url beats STASHLY_URL', async () => {
    const t = await setup();
    try {
        const dead = await t.run(['get', 'x'], { env: { STASHLY_URL: 'http://127.0.0.1:1' } });
        assert.equal(dead.code, 1);
        assert.match(dead.stderr, /^stashly: Cannot reach http:\/\/127\.0\.0\.1:1/);
        await t.run(['new', 'urltest']);
        const flag = await t.run(['list', 'urltest', '--url', t.url], { env: { STASHLY_URL: 'http://127.0.0.1:1' } });
        assert.equal(flag.code, 0, flag.stderr);
        assert.equal(flag.stdout.trim(), 'No items yet.');
    } finally {
        t.done();
    }
});

test('--help prints the usage and exits 0', async () => {
    const t = await setup();
    try {
        for (const args of [['--help'], ['-h'], []]) {
            const res = await t.run(args);
            assert.equal(res.code, 0);
            assert.match(res.stdout, /Usage: stashly/);
            assert.match(res.stdout, /export NAME/);
        }
    } finally {
        t.done();
    }
});

test('the package exposes the command and the script is under 300 lines', () => {
    const pkg = require('../package.json');
    assert.deepEqual(pkg.bin, { stashly: 'bin/stashly.js', 'stashly-mcp': 'bin/stashly-mcp.js' });
    const source = fs.readFileSync(CLI, 'utf8');
    assert.ok(source.startsWith('#!/usr/bin/env node'));
    assert.ok(source.split('\n').length < 300);
});

// ---- big files go up as a resumable upload ----

// Recognisable bytes behind a PNG header, so a misplaced piece cannot go unnoticed
const bigPng = size => Buffer.concat([PNG, Buffer.from(Array.from({ length: size - PNG.length }, (_, i) => (i * 31 + (i >> 8) * 7 + (i >> 16)) & 255))]);

test('send --file uploads a file over 8 MB in pieces, byte for byte, and prints progress only on a terminal', async () => {
    const t = await setup({ maxFileBytes: 30 * 1048576 });
    try {
        await t.run(['new', 'big-stash']);
        const original = bigPng(9 * 1048576 + 12345);
        const source = path.join(t.dir, 'big picture.png');
        fs.writeFileSync(source, original);

        const sent = await t.run(['send', 'big-stash', '--file', source, '--title', 'Big one']);
        assert.equal(sent.code, 0, sent.stderr);
        assert.ok(sent.stdout.startsWith(`Sent file big picture.png (id `) && sent.stdout.includes(`, ${original.length} bytes)`), sent.stdout);
        // Not a terminal here, so nothing is written to stderr
        assert.equal(sent.stderr, '');

        const item = t.model.listItems(1)[0];
        assert.equal(item.title, 'Big one');
        assert.equal(item.file_type, 'image/png');
        assert.ok(fs.readFileSync(t.fileStore.pathOf(item.id)).equals(original));
        // It went through the resumable protocol: nothing is left behind in tmp or in the table
        assert.equal(t.model.countUploads(), 0);
        assert.deepEqual(fs.readdirSync(t.fileStore.tmpDir), []);
    } finally {
        t.done();
    }
});

test('a piece that fails with a server error is tried again, and the file still arrives intact', async () => {
    const t = await setup({ maxFileBytes: 30 * 1048576 });
    // A go-between that answers the first two PATCH requests with a 503 and passes everything else on
    const http = require('node:http');
    let patches = 0;
    const proxy = http.createServer((req, res) => {
        if (req.method === 'PATCH' && ++patches <= 2) {
            req.resume();
            req.on('end', () => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"busy"}'); });
            return;
        }
        const upstream = http.request({ port: t.url.split(':').pop(), host: '127.0.0.1', path: req.url, method: req.method, headers: req.headers }, answer => {
            res.writeHead(answer.statusCode, answer.headers);
            answer.pipe(res);
        });
        req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, resolve));
    try {
        await t.run(['new', 'flaky-stash']);
        const original = bigPng(9 * 1048576);
        const source = path.join(t.dir, 'flaky.png');
        fs.writeFileSync(source, original);
        const via = `http://127.0.0.1:${proxy.address().port}`;
        const sent = await t.run(['--url', via, 'send', 'flaky-stash', '--file', source], { env: { STASHLY_RETRY_DELAY_MS: '10' } });
        assert.equal(sent.code, 0, sent.stderr);
        assert.ok(patches > 2);
        const item = t.model.listItems(1)[0];
        assert.ok(fs.readFileSync(t.fileStore.pathOf(item.id)).equals(original));

        // A piece that keeps failing ends the upload with the server's message, and the upload is cancelled
        patches = -1000;
        const broken = await t.run(['--url', via, 'send', 'flaky-stash', '--file', source], { env: { STASHLY_RETRY_DELAY_MS: '1' } });
        assert.equal(broken.code, 1);
        assert.match(broken.stderr, /busy/);
        assert.equal(t.model.countUploads(), 0);
    } finally {
        proxy.closeAllConnections();
        proxy.close();
        t.done();
    }
});

test('a refusal at the start of a big upload is reported at once (the file is too big for the server)', async () => {
    const t = await setup({ maxFileBytes: 9 * 1048576 });
    try {
        await t.run(['new', 'limit-stash']);
        const source = path.join(t.dir, 'toobig.png');
        fs.writeFileSync(source, bigPng(10 * 1048576));
        const sent = await t.run(['send', 'limit-stash', '--file', source]);
        assert.equal(sent.code, 1);
        assert.match(sent.stderr, /at most 9 MB/);
        assert.equal(t.model.countUploads(), 0);
    } finally {
        t.done();
    }
});
