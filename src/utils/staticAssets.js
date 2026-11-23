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
            'Cache-Control': 'no-cache',
            ETag: entry.etag,
        });
        if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
        res.set('Content-Length', String(entry.gz.length));
        return res.end(req.method === 'HEAD' ? undefined : entry.gz);
    };
}

// For express.static: revalidate instead of "no-store" for the assets above
function revalidate(res, file) {
    if (!REVALIDATED.has(path.extname(file).toLowerCase())) return;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
}

module.exports = { gzipAssets, revalidate };
