#!/usr/bin/env node
// Builds the browser extension for release, with the version from package.json:
//
//   npm run build:extension
//
//   dist/chromium/                                  unpacked, for Chrome and Edge ("Load unpacked")
//   dist/firefox/                                   unpacked, for Firefox and Zen (and for web-ext sign)
//   dist/stashly-extension-<version>-chromium.zip
//   dist/stashly-extension-<version>-firefox.zip
//
// The manifest in extension/ keeps version 0.0.0: package.json is the only place the version lives, and this
// build writes it into each copy. Plain Node with no dependencies (the zip is written with zlib), so it runs the
// same on Windows and Linux.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const BROWSERS = ['chromium', 'firefox'];
// Files in extension/ that are for people, not the browser
const SKIP = new Set(['README.md']);

// "1.8.0-rc.1" -> { base: '1.8.0', full: '1.8.0-rc.1', prerelease: true }.
// A manifest version is digits and dots only, so a pre-release keeps only its X.Y.Z there.
function parseVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version));
    if (!match) throw new Error(`"${version}" is not a version like 1.2.3 or 1.2.3-rc.1`);
    const [, major, minor, patch, pre] = match;
    for (const part of [major, minor, patch]) {
        if (part.length > 1 && part.startsWith('0')) throw new Error(`"${version}": a version part cannot start with 0`);
    }
    return { base: `${major}.${minor}.${patch}`, full: String(version), prerelease: Boolean(pre) };
}

// The manifest for one browser. Chromium does not know background.scripts or browser_specific_settings (and warns);
// Firefox runs background.scripts and ignores the service worker, so each build keeps only what its browser uses.
function browserManifest(source, browser, version) {
    const { base, full, prerelease } = parseVersion(version);
    const manifest = JSON.parse(JSON.stringify(source));
    manifest.version = base;
    delete manifest.version_name;
    if (browser === 'chromium') {
        delete manifest.background.scripts;
        delete manifest.browser_specific_settings;
        // Shown on chrome://extensions instead of the bare number
        if (prerelease) manifest.version_name = full;
    } else if (browser === 'firefox') {
        delete manifest.background.service_worker;
        // Firefox has no version_name: a pre-release is the bare X.Y.Z (see extension/README.md)
    } else {
        throw new Error(`Unknown browser "${browser}"`);
    }
    return manifest;
}

// A plain zip (deflate), with a fixed date so the same files always give the same bytes.
// entries: [{ name: 'a/b.js', data: Buffer }]
function makeZip(entries) {
    const DOS_TIME = 0;
    const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const stored = deflated.length >= data.length;
        const body = stored ? data : deflated;
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(stored ? 0 : 8, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(stored ? 0 : 8, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + body.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

// Every file under dir, as paths with forward slashes, sorted (manifest.json first)
function listFiles(dir, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
        else if (!SKIP.has(rel)) out.push(rel);
    }
    return out.sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a.localeCompare(b)));
}

function build({ sourceDir = path.join(root, 'extension'), outDir = path.join(root, 'dist'), version } = {}) {
    version = version || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const source = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
    const files = listFiles(sourceDir).filter(name => name !== 'manifest.json');
    const results = [];
    for (const browser of BROWSERS) {
        const manifest = browserManifest(source, browser, version);
        const unpacked = path.join(outDir, browser);
        fs.rmSync(unpacked, { recursive: true, force: true });
        const entries = [{ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 4)}\n`) }];
        for (const name of files) entries.push({ name, data: fs.readFileSync(path.join(sourceDir, ...name.split('/'))) });
        for (const { name, data } of entries) {
            const target = path.join(unpacked, ...name.split('/'));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
        }
        const zip = path.join(outDir, `stashly-extension-${version}-${browser}.zip`);
        fs.writeFileSync(zip, makeZip(entries));
        results.push({ browser, version: manifest.version, versionName: manifest.version_name, unpacked, zip });
    }
    return results;
}

module.exports = { parseVersion, browserManifest, makeZip, build };

if (require.main === module) {
    try {
        for (const r of build()) {
            const shown = r.versionName ? `${r.version} (${r.versionName})` : r.version;
            console.log(`${r.browser.padEnd(8)} ${shown}  ${path.relative(root, r.zip)}`);
        }
    } catch (err) {
        console.error(`Could not build the extension: ${err.message}`);
        process.exit(1);
    }
}
