const zlib = require('node:zlib');

// A tiny zip reader for tests: finds each entry through the central directory, inflates it and checks its CRC and
// size, so a test compares the bytes that really come out of the archive. Returns a Map of name -> Buffer.
function unzip(buffer) {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no end of central directory');
    const total = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const files = new Map();
    for (let n = 0; n < total; n++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central record');
        const flags = buffer.readUInt16LE(offset + 8);
        const method = buffer.readUInt16LE(offset + 10);
        const crc = buffer.readUInt32LE(offset + 16);
        const compressed = buffer.readUInt32LE(offset + 20);
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const local = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        if (!(flags & 0x0800)) throw new Error(`${name}: UTF-8 flag missing`);
        if (!(flags & 0x0008)) throw new Error(`${name}: data descriptor flag missing`);
        if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: bad local header`);
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const raw = buffer.subarray(start, start + compressed);
        // the descriptor right after the data repeats what the central record says
        if (buffer.readUInt32LE(start + compressed) !== 0x08074b50 || buffer.readUInt32LE(start + compressed + 4) !== crc) {
            throw new Error(`${name}: bad data descriptor`);
        }
        const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
        if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(`${name}: size or CRC mismatch`);
        files.set(name, Buffer.from(data));
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

// supertest parser that keeps a binary body as a Buffer
const binary = (res, done) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
};

module.exports = { unzip, binary };
