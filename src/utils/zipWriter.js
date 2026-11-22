const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { once } = require('events');

// A small streaming zip writer, so a stash or a whole backup can be sent as one download without building the zip
// in memory or on disk.
//
// Each entry is written as it comes: a local header, the data, then a "data descriptor" holding the CRC and sizes.
// The descriptor (general purpose flag bit 3) is what makes streaming possible: those numbers are only known once the
// data has gone by, so they cannot sit in the header. The central directory, which lists every entry for the reader,
// is written at the very end from what was remembered along the way.
//
// This is plain zip (zip32): no entry or archive may reach 4 GB, and there can be at most 65535 entries. Nothing
// here needs more, and plain zip opens everywhere. Passing those limits throws instead of writing a broken file.
const STORE = 0;
const DEFLATE = 8;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
const FLAGS = 0x0808; // bit 3: sizes follow the data, bit 11: names are UTF-8
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
// Per entry: local header 30 + descriptor 16 + central record 46, plus the name twice
const ENTRY_OVERHEAD = 30 + 16 + 46;

// The date and time in the two 16-bit fields a zip uses (UTC; the format cannot say before 1980)
function dosDateTime(date) {
    const d = date.getUTCFullYear() < 1980 ? new Date(Date.UTC(1980, 0, 1)) : date;
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
        date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

// Whether `count` entries with these total uncompressed bytes and names can be a plain zip. Deflate can make
// incompressible data a little larger, so a margin of 1% plus a few bytes per block is kept.
function fitsInZip(count, totalBytes, nameBytes) {
    if (count > MAX_ENTRIES) return false;
    const worst = Math.ceil(totalBytes * 1.01) + count * (ENTRY_OVERHEAD + 64) + nameBytes * 2 + 22;
    return worst < MAX_BYTES;
}

// A file name that is safe to put in an archive: no folders, no control characters or characters Windows refuses,
// no "..", never empty, and at most `max` characters (the extension is kept when the name is cut).
function safeEntryName(name, max = 100, fallback = 'file') {
    let clean = String(name === undefined || name === null ? '' : name)
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f-\u009f\\/:*?"<>|]+/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+|[. ]+$/g, '');
    // nothing but filler left (for example from "..")
    if (/^[_ ]*$/.test(clean)) clean = fallback;
    const chars = Array.from(clean);
    if (chars.length > max) {
        const dot = clean.lastIndexOf('.');
        const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
        clean = chars.slice(0, max - Array.from(ext).length).join('').trimEnd() + ext;
    }
    return clean;
}

class ZipWriter {
    // output: any writable stream (a response). The zip ends it when finish() is called.
    constructor(output, { now = new Date() } = {}) {
        this.out = output;
        this.when = dosDateTime(now);
        this.offset = 0;
        this.entries = [];
        this.names = new Set();
        // Aborted as soon as the output closes, so a write that is waiting for a client that left does not hang
        this.abort = new AbortController();
        const gone = () => this.abort.abort(new Error('The connection closed before the zip was finished.'));
        output.once('close', gone);
        output.once('error', gone);
    }

    get signal() {
        return this.abort.signal;
    }

    // Writes bytes to the output and waits for it to drain, so a slow client slows the reading down instead of
    // filling memory
    async write(chunk) {
        if (this.signal.aborted || this.out.destroyed) throw this.signal.reason || new Error('The connection closed before the zip was finished.');
        this.offset += chunk.length;
        if (this.offset > MAX_BYTES) throw new Error('The zip would be larger than 4 GB.');
        if (this.out.write(chunk)) return;
        await once(this.out, 'drain', { signal: this.signal });
    }

    // Starts an entry: checks the name and writes its local header. Returns what the descriptor and central record need.
    async begin(name, method) {
        const nameBuffer = Buffer.from(name, 'utf8');
        if (this.entries.length >= MAX_ENTRIES) throw new Error('A zip can hold at most 65535 entries.');
        if (!name || nameBuffer.length > 0xffff || this.names.has(name)) throw new Error(`Bad or repeated zip entry name: ${name}`);
        this.names.add(name);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(LOCAL, 0);
        header.writeUInt16LE(20, 4); // needs zip 2.0 (deflate, data descriptors)
        header.writeUInt16LE(FLAGS, 6);
        header.writeUInt16LE(method, 8);
        header.writeUInt16LE(this.when.time, 10);
        header.writeUInt16LE(this.when.date, 12);
        // CRC and both sizes stay 0 here: they follow the data
        header.writeUInt16LE(nameBuffer.length, 26);
        const entry = { name: nameBuffer, method, offset: this.offset };
        await this.write(Buffer.concat([header, nameBuffer]));
        return entry;
    }

    // Ends an entry: the descriptor after the data, and a note for the central directory
    async end(entry, crc, compressed, size) {
        if (compressed > MAX_BYTES || size > MAX_BYTES) throw new Error('A zip entry would be larger than 4 GB.');
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(DESCRIPTOR, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        await this.write(descriptor);
        this.entries.push({ ...entry, crc: crc >>> 0, compressed, size });
    }

    // A small entry held in memory (stash.json, a note)
    async addBuffer(name, data, { method = DEFLATE } = {}) {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const body = method === DEFLATE ? zlib.deflateRawSync(bytes) : bytes;
        const entry = await this.begin(name, method);
        await this.write(body);
        await this.end(entry, zlib.crc32(bytes), body.length, bytes.length);
    }

    // A file read from a readable stream, never held whole. If the stream fails, or the client goes away, the stream
    // is destroyed (so its file handle is closed) and the error comes back: the zip is then incomplete and the caller
    // must abandon the connection rather than finish it.
    async addStream(name, source, { method = DEFLATE } = {}) {
        let entry;
        try {
            entry = await this.begin(name, method);
        } catch (err) {
            // The stream was handed over to us: close it, or its file stays open
            source.destroy();
            throw err;
        }
        let crc = 0;
        let size = 0;
        let compressed = 0;
        const count = new Transform({
            transform(chunk, encoding, done) {
                crc = zlib.crc32(chunk, crc);
                size += chunk.length;
                done(null, chunk);
            },
        });
        const stages = method === DEFLATE ? [source, count, zlib.createDeflateRaw()] : [source, count];
        await pipeline(
            ...stages,
            async chunks => {
                for await (const chunk of chunks) {
                    compressed += chunk.length;
                    await this.write(chunk);
                }
            },
            { signal: this.signal }
        );
        await this.end(entry, crc, compressed, size);
    }

    // The central directory and the end record, then closes the output
    async finish() {
        const start = this.offset;
        const parts = [];
        for (const e of this.entries) {
            const record = Buffer.alloc(46);
            record.writeUInt32LE(CENTRAL, 0);
            record.writeUInt16LE(20, 4); // made by
            record.writeUInt16LE(20, 6); // needed to read
            record.writeUInt16LE(FLAGS, 8);
            record.writeUInt16LE(e.method, 10);
            record.writeUInt16LE(this.when.time, 12);
            record.writeUInt16LE(this.when.date, 14);
            record.writeUInt32LE(e.crc, 16);
            record.writeUInt32LE(e.compressed, 20);
            record.writeUInt32LE(e.size, 24);
            record.writeUInt16LE(e.name.length, 28);
            record.writeUInt32LE(e.offset, 42);
            parts.push(record, e.name);
        }
        const directory = Buffer.concat(parts);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(END, 0);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(directory.length, 12);
        end.writeUInt32LE(start, 16);
        await this.write(Buffer.concat([directory, end]));
        this.out.end();
    }
}

module.exports = { ZipWriter, safeEntryName, fitsInZip, STORE, DEFLATE, MAX_ENTRIES, MAX_BYTES, ENTRY_OVERHEAD };
