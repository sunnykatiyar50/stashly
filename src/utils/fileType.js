const path = require('path');

// What can be uploaded depends on the stash's "file types" mode (Options > Organize); the safe list until it is changed:
//
//   safe         images, audio and video, PDF, zip and Office files (content must match the extension),
//                certificates, and any text file. The default.
//   no-programs  everything above, plus any other file: archives, media, binaries. Programs and Windows
//                script launchers, SVG and macro-enabled Office files are still refused, and so is any
//                file whose content is a program (Windows, Linux or macOS executable), whatever its name.
//   any          every file, with nothing refused.
//
// Whatever the mode, stored files are served as attachments with a sandboxing CSP and nosniff, and a file
// whose type is not recognised is stored as application/octet-stream (or text/plain for text), so nothing
// uploaded is ever rendered or run by this server's pages.
const MODES = ['safe', 'no-programs', 'any'];

const startsWith = (buf, bytes, offset = 0) => buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = text => [...text].map(c => c.charCodeAt(0));

const isPng = buf => startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpeg = buf => startsWith(buf, [0xff, 0xd8, 0xff]);
const isGif = buf => startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'));
const isWebp = buf => startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8);
const isPdf = buf => startsWith(buf, ascii('%PDF'));
const isZip = buf => startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]);
// Audio and video containers
const isIsoMedia = buf => startsWith(buf, ascii('ftyp'), 4); // mp4, m4a, m4v, mov
const isWebm = buf => startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3]);
const isOgg = buf => startsWith(buf, ascii('OggS'));
const isWav = buf => startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WAVE'), 8);
const isFlac = buf => startsWith(buf, ascii('fLaC'));
const isMp3 = buf => startsWith(buf, ascii('ID3')) || (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
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
// Windows (MZ), Linux (ELF) and macOS (Mach-O) executables, whatever the file is called
const isProgram = buf =>
    startsWith(buf, [0x4d, 0x5a]) ||
    startsWith(buf, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(buf, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(buf, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(buf, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(buf, [0xfe, 0xed, 0xfa, 0xcf]);

const PLAIN = 'text/plain; charset=utf-8';
const OCTET = 'application/octet-stream';
const certMime = buf => (isText(buf) ? PLAIN : 'application/x-x509-ca-cert');
const certCheck = buf => isText(buf) || isDer(buf);

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
    '.mp4': { mime: 'video/mp4', check: isIsoMedia },
    '.m4v': { mime: 'video/mp4', check: isIsoMedia },
    '.mov': { mime: 'video/quicktime', check: isIsoMedia },
    '.webm': { mime: 'video/webm', check: isWebm },
    '.ogv': { mime: 'video/ogg', check: isOgg },
    '.mp3': { mime: 'audio/mpeg', check: isMp3 },
    '.m4a': { mime: 'audio/mp4', check: isIsoMedia },
    '.wav': { mime: 'audio/wav', check: isWav },
    '.ogg': { mime: 'audio/ogg', check: isOgg },
    '.oga': { mime: 'audio/ogg', check: isOgg },
    '.opus': { mime: 'audio/ogg', check: isOgg },
    '.flac': { mime: 'audio/flac', check: isFlac },
    '.csv': { mime: 'text/csv; charset=utf-8', check: isText },
    '.json': { mime: 'application/json', check: isText },
    '.md': { mime: 'text/markdown; charset=utf-8', check: isText },
    // Certificates are PEM text, or binary DER
    '.pem': { mime: certMime, check: certCheck },
    '.cer': { mime: certMime, check: certCheck },
    '.crt': { mime: certMime, check: certCheck },
};

// Refused in "safe" and "no-programs"
const BLOCKED = new Set([
    '.svg', '.svgz',
    '.exe', '.dll', '.msi', '.scr', '.com', '.pif', '.hta', '.vbs', '.vbe', '.wsf', '.wsh', '.lnk', '.jar',
    '.docm', '.xlsm', '.pptm', '.dotm', '.xlam',
]);

const ALLOWED_SUMMARY = 'images, audio and video, pdf, zip, docx, xlsx, pptx, certificates, and any text file';

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

// The part of detectFile that needs no content: a refused extension is known before any byte arrives (a resumable
// upload is refused when it is created). Returns an error message, or null when the name does not rule it out.
function extensionProblem(fileName, mode = 'safe') {
    const ext = path.extname(fileName).toLowerCase();
    if (BLOCKED.has(ext) && (MODES.includes(mode) ? mode : 'safe') !== 'any') return `${ext} files aren't allowed.`;
    return null;
}

// Returns { mime, image } when the file is allowed, otherwise { error }
function detectFile(fileName, buffer, mode = 'safe') {
    if (!MODES.includes(mode)) mode = 'safe';
    const ext = path.extname(fileName).toLowerCase();

    if (BLOCKED.has(ext)) {
        if (mode !== 'any') return { error: `${ext} files aren't allowed.` };
        return { mime: OCTET, image: false };
    }

    const type = TYPES[ext];
    if (type) {
        if (type.check(buffer)) {
            return { mime: typeof type.mime === 'function' ? type.mime(buffer) : type.mime, image: Boolean(type.image) };
        }
        // A known extension with the wrong content: the safe list refuses it, the others store it as an unknown file
        if (mode === 'safe') return { error: `The content doesn't look like a ${ext} file.` };
    }

    // Any other file: text is always fine; other content depends on the mode
    if (isText(buffer)) return { mime: PLAIN, image: false };
    if (mode === 'safe') return { error: `This file type isn't allowed. Allowed: ${ALLOWED_SUMMARY}. Whoever manages the stash can allow more in its Options.` };
    if (mode === 'no-programs' && isProgram(buffer)) return { error: "Programs aren't allowed." };
    return { mime: OCTET, image: false };
}

// What a thumbnail may be: JPEG, PNG or WebP, judged by its first bytes and nothing else (not the name, and not the
// Content-Type the sender claims). SVG is never accepted: it is markup and can carry script. Returns the type or null.
function detectThumb(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    if (isJpeg(buffer)) return 'image/jpeg';
    if (isPng(buffer)) return 'image/png';
    if (isWebp(buffer)) return 'image/webp';
    return null;
}

module.exports = { detectFile, detectThumb, cleanFileName, extensionProblem, MODES };
