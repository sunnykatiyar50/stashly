const { safeEntryName, fitsInZip, STORE, DEFLATE } = require('./zipWriter');
const { deriveTitle } = require('./title');

// What goes into a stash's export zip, worked out before anything is sent so the size can be checked first and
// stash.json can describe every entry.
//
//   stash.json               the stash and a list of its items, each with the path of its entry
//   notes/<id>-<title>.txt   one per note
//   files/<id>-<file name>   one per file, streamed from disk when the zip is written
//
// Burn-after-reading notes are never exported: reading one is what uses it up, and an export must not do that behind
// anyone's back. They are listed in stash.json as skipped, with no title and no text.
const NAME_CHARS = 100;

// Formats that are already compressed: deflating them again only costs time
const COMPRESSED = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/|application\/(zip|pdf|vnd\.openxmlformats-officedocument\.))/;

function planExport({ stash, rows, fileSize, now }) {
    const entries = [];
    const items = [];
    const used = new Set(['stash.json']);
    // The id in front of every name already makes it unique; this is only a guard against odd input
    const claim = name => {
        let candidate = name;
        for (let n = 2; used.has(candidate); n++) candidate = name.replace(/(\.[^./]*)?$/, `-${n}$1`);
        used.add(candidate);
        return candidate;
    };

    for (const row of rows) {
        if (row.kind === 'note' && row.burn) {
            items.push({ kind: 'note', burn: true, skipped: true });
            continue;
        }
        const base = {
            id: row.id,
            kind: row.kind,
            title: null,
            createdAt: row.created_at,
            pinned: Boolean(row.pinned),
            editedAt: row.edited_at || null,
        };
        if (row.kind === 'file') {
            const size = fileSize(row.id);
            // The row is there but its file has gone from the disk: say so instead of leaving a hole
            if (size === null) {
                items.push({ ...base, title: row.title || row.file_name, fileName: row.file_name, fileType: row.file_type, fileSize: row.file_size, skipped: true, missing: true });
                continue;
            }
            const name = claim(`files/${row.id}-${safeEntryName(row.file_name, NAME_CHARS)}`);
            entries.push({ name, kind: 'file', id: row.id, size, method: COMPRESSED.test(row.file_type) ? STORE : DEFLATE });
            items.push({ ...base, title: row.title || row.file_name, fileName: row.file_name, fileType: row.file_type, fileSize: row.file_size, path: name });
        } else {
            const title = row.title || (row.secret ? 'Secret note' : deriveTitle(row.text));
            const name = claim(`notes/${row.id}-${safeEntryName(title, NAME_CHARS, 'note')}.txt`);
            entries.push({ name, kind: 'note', text: row.text || '', size: Buffer.byteLength(row.text || '') });
            items.push({ ...base, title, secret: Boolean(row.secret), path: name });
        }
    }

    const manifest = Buffer.from(
        JSON.stringify({ slug: stash.slug, createdAt: stash.created_at, expiresAt: stash.expires_at || null, exportedAt: now.toISOString(), items }, null, 2) + '\n'
    );
    const all = [{ name: 'stash.json', kind: 'buffer', data: manifest, size: manifest.length }, ...entries];
    const bytes = all.reduce((sum, e) => sum + e.size, 0);
    const nameBytes = all.reduce((sum, e) => sum + Buffer.byteLength(e.name), 0);
    return { entries: all, fits: fitsInZip(all.length, bytes, nameBytes) };
}

module.exports = { planExport };
