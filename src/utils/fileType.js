const path = require('path');

// What can be uploaded:
//   - images, PDF, zip and Office files, whose content must match the extension (magic bytes), so a
//     renamed file is refused;
//   - any text file: the content must be valid text, whatever the extension (yaml, conf, py, html, ...).
// Stored text files are served as plain text and always as attachments with a sandboxing CSP, so even
// HTML or a script is never rendered or run by the server's pages.
// Refused outright: SVG (an image format browsers render), programs and Windows script launchers,
// and macro-enabled Office files.
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
// A DER certificate is an ASN.1 SEQUENCE with a long-form length
const isDer = buf => buf.length > 4 && buf[0] === 0x30 && buf[1] >= 0x81 && buf[1] <= 0x84;

const PLAIN = 'text/plain; charset=utf-8';

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
    '.csv': { mime: 'text/csv; charset=utf-8', check: isText },
    '.json': { mime: 'application/json', check: isText },
    '.md': { mime: 'text/markdown; charset=utf-8', check: isText },
    // Certificates are PEM text, or binary DER
    '.pem': { mime: buf => (isText(buf) ? PLAIN : 'application/x-x509-ca-cert'), check: buf => isText(buf) || isDer(buf) },
    '.cer': { mime: buf => (isText(buf) ? PLAIN : 'application/x-x509-ca-cert'), check: buf => isText(buf) || isDer(buf) },
    '.crt': { mime: buf => (isText(buf) ? PLAIN : 'application/x-x509-ca-cert'), check: buf => isText(buf) || isDer(buf) },
};

// Never accepted, whatever the content
const BLOCKED = new Set([
    '.svg', '.svgz',
    '.exe', '.dll', '.msi', '.scr', '.com', '.pif', '.hta', '.vbs', '.vbe', '.wsf', '.wsh', '.lnk', '.jar',
    '.docm', '.xlsm', '.pptm', '.dotm', '.xlam',
]);

const ALLOWED_SUMMARY = 'images (png, jpg, gif, webp), pdf, zip, docx, xlsx, pptx, certificates, and any text file';

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
    if (BLOCKED.has(ext)) return { error: `${ext} files aren't allowed.` };

    const type = TYPES[ext];
    if (type) {
        if (!type.check(buffer)) return { error: `The content doesn't look like a ${ext} file.` };
        return { mime: typeof type.mime === 'function' ? type.mime(buffer) : type.mime, image: Boolean(type.image) };
    }

    // Any other extension (or none): fine when the content is text
    if (isText(buffer)) return { mime: PLAIN, image: false };
    return { error: `This file type isn't allowed. Allowed: ${ALLOWED_SUMMARY}.` };
}

module.exports = { detectFile, cleanFileName };
