// Draws the app icons (a clipboard on the blue brand colour) into src/views/icons/ with no dependencies.
// Run: node scripts/make-icons.js   (the PNGs are committed, so this is only needed to change the design)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

// Shapes in a 0..1 square, kept inside the middle 80% so a circular or rounded "maskable" crop never cuts them
const shapes = [
    { type: 'round', x0: 0.3, y0: 0.28, x1: 0.7, y1: 0.78, r: 0.05, color: WHITE },      // the board
    { type: 'round', x0: 0.4, y0: 0.22, x1: 0.6, y1: 0.31, r: 0.03, color: WHITE },      // the clip
    { type: 'round', x0: 0.37, y0: 0.45, x1: 0.63, y1: 0.49, r: 0.02, color: BLUE },     // text lines
    { type: 'round', x0: 0.37, y0: 0.55, x1: 0.63, y1: 0.59, r: 0.02, color: BLUE },
    { type: 'round', x0: 0.37, y0: 0.65, x1: 0.55, y1: 0.69, r: 0.02, color: BLUE },
];

function inside(shape, x, y) {
    if (x < shape.x0 || x > shape.x1 || y < shape.y0 || y > shape.y1) return false;
    const r = shape.r;
    const cx = Math.min(Math.max(x, shape.x0 + r), shape.x1 - r);
    const cy = Math.min(Math.max(y, shape.y0 + r), shape.y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function pixel(x, y) {
    let color = BLUE;
    for (const shape of shapes) if (inside(shape, x, y)) color = shape.color;
    return color;
}

function crc32(buffer) {
    let crc = ~0;
    for (const byte of buffer) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function png(size) {
    const samples = 3; // 3x3 samples per pixel smooths the edges
    const rows = [];
    for (let py = 0; py < size; py++) {
        const row = Buffer.alloc(1 + size * 3);
        for (let px = 0; px < size; px++) {
            let r = 0, g = 0, b = 0;
            for (let sy = 0; sy < samples; sy++) {
                for (let sx = 0; sx < samples; sx++) {
                    const c = pixel((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size);
                    r += c[0]; g += c[1]; b += c[2];
                }
            }
            const n = samples * samples;
            row[1 + px * 3] = Math.round(r / n);
            row[2 + px * 3] = Math.round(g / n);
            row[3 + px * 3] = Math.round(b / n);
        }
        rows.push(row);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const outDir = path.join(__dirname, '..', 'src', 'views', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
    fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size));
    console.log(`icon-${size}.png`);
}
