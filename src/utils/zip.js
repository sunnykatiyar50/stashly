// Lists the entries of a zip file from its central directory, without unpacking anything.
// Returns { entries: [{ name, size, isDir }], total, truncated } or { error }.
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

function listZip(buffer, limit = 500) {
    // The end-of-central-directory record is in the last 64 KB (after an optional comment)
    const stop = Math.max(0, buffer.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buffer.length - 22; i >= stop; i--) {
        if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd === -1) return { error: 'This does not look like a zip file.' };

    const total = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (total === 0xffff || offset === 0xffffffff) return { error: 'This zip file is too large to list.' };

    const entries = [];
    for (let n = 0; n < total && entries.length < limit; n++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) return { error: 'The zip file is damaged.' };
        const flags = buffer.readUInt16LE(offset + 8);
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const nameStart = offset + 46;
        if (nameStart + nameLength > buffer.length) return { error: 'The zip file is damaged.' };
        // Bit 11 means UTF-8; otherwise the name is in the old DOS code page, of which latin1 is the closest simple reading
        const name = buffer.toString(flags & 0x0800 ? 'utf8' : 'latin1', nameStart, nameStart + nameLength);
        entries.push({ name, size, isDir: name.endsWith('/') });
        offset = nameStart + nameLength + extraLength + commentLength;
    }
    return { entries, total, truncated: total > entries.length };
}

module.exports = { listZip };
