const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { parseVersion, browserManifest, build } = require('../scripts/build-extension');
const { listZip } = require('../src/utils/zip');

const root = path.join(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));

// Reads every file back out of a zip by walking its local headers
function unzip(buffer) {
    const files = {};
    let at = 0;
    while (buffer.readUInt32LE(at) === 0x04034b50) {
        const method = buffer.readUInt16LE(at + 8);
        const crc = buffer.readUInt32LE(at + 14);
        const size = buffer.readUInt32LE(at + 18);
        const nameLength = buffer.readUInt16LE(at + 26);
        const extra = buffer.readUInt16LE(at + 28);
        const name = buffer.toString('utf8', at + 30, at + 30 + nameLength);
        const start = at + 30 + nameLength + extra;
        const raw = buffer.subarray(start, start + size);
        const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
        assert.equal(zlib.crc32(data), crc, `CRC of ${name}`);
        files[name] = data;
        at = start + size;
    }
    return files;
}

test('the extension version comes from package.json, so the repo manifest keeps 0.0.0', () => {
    assert.equal(source.version, '0.0.0');
});

test('versions: X.Y.Z goes into the manifest, a pre-release keeps only its X.Y.Z there', () => {
    assert.deepEqual(parseVersion('1.7.0'), { base: '1.7.0', full: '1.7.0', prerelease: false });
    assert.deepEqual(parseVersion('1.8.0-rc.1'), { base: '1.8.0', full: '1.8.0-rc.1', prerelease: true });
    assert.equal(parseVersion('2.0.0+build.5').base, '2.0.0');
    for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '01.2.3', '1.2.x', '']) assert.throws(() => parseVersion(bad), bad);
});

test('each browser gets only the manifest keys it uses', () => {
    const chromium = browserManifest(source, 'chromium', '1.8.0-rc.1');
    assert.equal(chromium.version, '1.8.0');
    assert.equal(chromium.version_name, '1.8.0-rc.1');
    assert.equal(chromium.background.service_worker, 'background.js');
    assert.equal(chromium.background.scripts, undefined);
    assert.equal(chromium.browser_specific_settings, undefined);
    assert.equal(browserManifest(source, 'chromium', '1.8.0').version_name, undefined);

    const firefox = browserManifest(source, 'firefox', '1.8.0-rc.1');
    assert.equal(firefox.version, '1.8.0');
    assert.equal(firefox.version_name, undefined);
    assert.equal(firefox.background.service_worker, undefined);
    assert.deepEqual(firefox.background.scripts, ['common.js', 'background.js']);
    assert.equal(firefox.browser_specific_settings.gecko.id, source.browser_specific_settings.gecko.id);

    // The source object is left alone
    assert.equal(source.version, '0.0.0');
    assert.ok(source.background.scripts && source.background.service_worker);
    assert.throws(() => browserManifest(source, 'safari', '1.0.0'));
});

test('the build writes both zips and unpacked folders with the version, and the same input gives the same bytes', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashly-ext-'));
    try {
        const results = build({ outDir, version: '2.0.0-rc.1' });
        assert.deepEqual(results.map(r => path.basename(r.zip)), ['stashly-extension-2.0.0-rc.1-chromium.zip', 'stashly-extension-2.0.0-rc.1-firefox.zip']);
        const expected = fs.readdirSync(path.join(root, 'extension'), { recursive: true })
            .map(name => name.split(path.sep).join('/'))
            .filter(name => name !== 'README.md' && fs.statSync(path.join(root, 'extension', name)).isFile())
            .sort();
        for (const result of results) {
            const bytes = fs.readFileSync(result.zip);
            // The server's own zip reader agrees, and manifest.json comes first
            const listed = listZip(bytes).entries.map(e => e.name);
            assert.equal(listed[0], 'manifest.json');
            assert.deepEqual([...listed].sort(), expected);

            const files = unzip(bytes);
            const manifest = JSON.parse(files['manifest.json']);
            assert.equal(manifest.version, '2.0.0');
            assert.equal(manifest.version_name, result.browser === 'chromium' ? '2.0.0-rc.1' : undefined);
            // Every other file is copied byte for byte (line endings included), and matches the unpacked folder
            for (const name of expected.filter(n => n !== 'manifest.json')) {
                assert.ok(files[name].equals(fs.readFileSync(path.join(root, 'extension', ...name.split('/')))), name);
                assert.ok(files[name].equals(fs.readFileSync(path.join(result.unpacked, ...name.split('/')))), name);
            }
        }
        const first = results.map(r => fs.readFileSync(r.zip));
        build({ outDir, version: '2.0.0-rc.1' });
        results.forEach((r, i) => assert.ok(fs.readFileSync(r.zip).equals(first[i]), `${r.browser} zip is reproducible`));
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});
