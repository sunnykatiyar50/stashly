const path = require('path');

// Only these types can be uploaded. The extension must be on the list AND the content must match it
// (magic bytes for binary formats, valid text for text formats), so a renamed file is refused.
// SVG and HTML are deliberately not allowed: they can carry scripts.
const startsWith = (buf, bytes, offset = 0) => buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = text => [...text].map(c => c.charCodeAt(0));

const isPng = buf => startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpeg = buf => startsWith(buf, [0xff, 0xd8, 0xff]);
const isGif = buf => startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'));
const isWebp = buf => startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8);
const isPdf = buf => startsWith(buf, ascii('%PDF'));
const isZip = buf => startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]);
// Text: no NUL bytes and valid UTF-8 in the first 8 KB (a cut in the middle of a character is tolerated)
const isText = buf => {
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return false;
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(head);
    const replacements = (decoded.match(/�/g) || []).length;
    return replacements <= 1;
};

const TYPES = {
    '.png': { mime: 'image/png', image: true, check: isPng },
    '.jpg': { mime: 'image/jpeg', image: true, check: isJpeg },
    '.jpeg': { mime: 'image/jpeg', image: true, check: isJpeg },
    '.gif': { mime: 'image/gif', image: true, check: isGif },
    '.webp': { mime: 'image/webp', image: true, check: isWebp },
    '.pdf': { mime: 'application/pdf', check: isPdf },
    '.zip': { mime: 'application/zip', check: isZip },
    '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: isZip },
    '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: isZip },
    '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: isZip },
    '.txt': { mime: 'text/plain; charset=utf-8', check: isText },
    '.csv': { mime: 'text/csv; charset=utf-8', check: isText },
    '.json': { mime: 'application/json', check: isText },
    '.md': { mime: 'text/markdown; charset=utf-8', check: isText },
    '.log': { mime: 'text/plain; charset=utf-8', check: isText },
};

const ALLOWED_EXTENSIONS = Object.keys(TYPES);

// Makes a safe display name: no path parts, no control characters, bounded length
function cleanFileName(raw) {
    let name = typeof raw === 'string' ? raw : '';
    name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|?*:]/g, '').trim();
    if (name.length > 200) {
        const ext = path.extname(name);
        name = name.slice(0, 200 - ext.length) + ext;
    }
    return name;
}

// Returns { mime, image } when the file is allowed, otherwise { error }
function detectFile(fileName, buffer) {
    const ext = path.extname(fileName).toLowerCase();
    const type = TYPES[ext];
    if (!type) return { error: `This file type isn't allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` };
    if (!type.check(buffer)) return { error: `The content doesn't look like a ${ext} file.` };
    return { mime: type.mime, image: Boolean(type.image) };
}

module.exports = { detectFile, cleanFileName, ALLOWED_EXTENSIONS };
