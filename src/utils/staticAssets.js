const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// The page's own scripts, styles and icons are public and identical for everyone (nothing in them is private), but the
// server marks every response "no-store" because stashes are. That made each click re-download all of them, uncompressed:
// about 150 KB a page. These files are sent with "no-cache" instead (the browser keeps a copy and asks the server whether
// it changed, which costs a 304 and no body), and compressed with gzip when the browser accepts it. A new release changes
// the files, so the next check fetches them again: nothing stale is ever shown.
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.webmanifest', '.json']);
const TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json; charset=utf-8',
};

// Files kept revalidating rather than "no-store" by express.static (see setHeaders below)
const REVALIDATED = new Set([...COMPRESSIBLE, '.png', '.ico', '.webp']);

// Serves a gzip copy of a text asset from the views folder when the browser accepts one. The copy is made once and kept
// until the file changes. Anything else (other types, no gzip support, a path outside the folder) falls through to
// express.static.
function gzipAssets(dir) {
    const root = path.resolve(dir) + path.sep;
    const cache = new Map(); // file -> { stamp, gz, etag }

    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const ext = path.extname(req.path).toLowerCase();
        if (!COMPRESSIBLE.has(ext)) return next();
        if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

        let relative;
        try {
            relative = decodeURIComponent(req.path);
        } catch {
            return next();
        }
        const file = path.resolve(root, '.' + relative);
        // Never anything outside the views folder
        if (!file.startsWith(root)) return next();

        let stat;
        try {
            stat = fs.statSync(file);
        } catch {
            return next();
        }
        if (!stat.isFile()) return next();

        const stamp = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
        let entry = cache.get(file);
        if (!entry || entry.stamp !== stamp) {
            const gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
            entry = { stamp, gz, etag: `W/"gz-${stamp}"` };
            cache.set(file, entry);
        }

        res.set({
            'Content-Type': TYPES[ext],
            'Content-Encoding': 'gzip',
            Vary: 'Accept-Encoding',
            'Cache-Control': cacheControlFor(req),
            ETag: entry.etag,
        });
        if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
        res.set('Content-Length', String(entry.gz.length));
        return res.end(req.method === 'HEAD' ? undefined : entry.gz);
    };
}

// An asset asked for with ?v=<its content hash> (the address a page gives it, see pages() below) never changes: a new
// version of the file gets a new address. So the browser keeps it and does not ask again, which saves a round trip per
// file on every page. A proxy that rewrites cache times (Cloudflare's "Browser Cache TTL") cannot leave an old script
// running next to a new page either, since the new page names new addresses.
const IMMUTABLE = 'public, max-age=31536000, immutable';
function cacheControlFor(req) {
    return req && req.query && typeof req.query.v === 'string' && req.query.v ? IMMUTABLE : 'no-cache';
}

// For express.static: revalidate instead of "no-store" for the assets above (or keep for good, for a versioned address)
function revalidate(res, file) {
    if (!REVALIDATED.has(path.extname(file).toLowerCase())) return;
    res.setHeader('Cache-Control', cacheControlFor(res.req));
    res.setHeader('Vary', 'Accept-Encoding');
}

// The HTML pages, sent with every script, style and icon address carrying ?v=<a hash of that file>. The hash follows the
// file (re-read when its size or time changes), so a changed file gets a new address at once, in development too.
// `extra` maps an address that is not in the views folder to its file (the QR code library from node_modules).
function pages(dir, extra = {}) {
    const root = path.resolve(dir) + path.sep;
    const hashes = new Map(); // file -> { stamp, hash }
    const texts = new Map(); // file -> { stamp, text }

    function stampOf(file) {
        const stat = fs.statSync(file);
        return stat.isFile() ? `${stat.size}-${Math.floor(stat.mtimeMs)}` : null;
    }

    function hashOf(file) {
        let stamp;
        try {
            stamp = stampOf(file);
        } catch {
            return null;
        }
        if (!stamp) return null;
        const known = hashes.get(file);
        if (known && known.stamp === stamp) return known.hash;
        const hash = require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
        hashes.set(file, { stamp, hash });
        return hash;
    }

    function fileFor(url) {
        if (extra[url]) return extra[url];
        const file = path.resolve(root, '.' + url);
        return file.startsWith(root) ? file : null;
    }

    function read(name) {
        const file = path.join(root, name);
        const stamp = stampOf(file);
        const known = texts.get(file);
        if (known && known.stamp === stamp) return known.text;
        const text = fs.readFileSync(file, 'utf8');
        texts.set(file, { stamp, text });
        return text;
    }

    // Adds ?v= to each local asset address in src="..." and href="..."; anything it cannot find is left as it was
    function version(html) {
        return html.replace(/(\s(?:src|href)=")(\/[^"?#]+\.(?:js|css|svg|png|ico|webp|webmanifest))(")/g, (match, before, url, after) => {
            const file = fileFor(url);
            const hash = file && hashOf(file);
            return hash ? `${before}${url}?v=${hash}${after}` : match;
        });
    }

    // The page as HTML text, versioned; `transform` (optional) changes it before it is sent
    function render(name, transform) {
        const html = version(read(name));
        return transform ? transform(html) : html;
    }

    // A route handler that sends the page
    function send(name, transform) {
        return (req, res, next) => {
            let html;
            try {
                html = render(name, transform && (text => transform(text, req)));
            } catch (err) {
                return next(err);
            }
            res.type('html').send(html);
        };
    }

    return { render, send, version };
}

// JSON that is safe inside a <script type="application/json"> element: nothing in it can close the element or start a
// comment. (It is never run as a script, only read with JSON.parse.)
function inlineJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}

module.exports = { gzipAssets, revalidate, pages, inlineJson, cacheControlFor, IMMUTABLE };
