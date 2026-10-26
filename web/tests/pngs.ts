// PNGs made for tests, as a program saves them: chunks with their CRCs, rows each with a filter, deflated.

const TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const reader = input.pipeThrough(new CompressionStream("deflate")).getReader();
    const chunks: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value);
    }
    const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
    }
    return all;
}

function chunk(kind: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(
        Array.from(kind, (char) => char.charCodeAt(0)),
        4,
    );
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/**
 * An RGBA PNG of these pixels (a row each, [r, g, b, a] each pixel), its rows filtered in turn with each of PNG's
 * filters (none, sub, up, average, Paeth), as a program might.
 */
export async function rgbaPng(rows: number[][][]): Promise<Uint8Array<ArrayBuffer>> {
    const height = rows.length;
    const width = rows[0]!.length;
    const stride = width * 4;
    const raw = new Uint8Array(height * (stride + 1));
    let prior = new Uint8Array(stride);
    rows.forEach((row, y) => {
        const line = Uint8Array.from(row.flat());
        const filter = y % 5;
        raw[y * (stride + 1)] = filter;
        for (let x = 0; x < stride; x++) {
            const left = x >= 4 ? line[x - 4]! : 0;
            const up = prior[x]!;
            const corner = x >= 4 ? prior[x - 4]! : 0;
            const guess = left + up - corner;
            const paeth =
                Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner)
                    ? left
                    : Math.abs(guess - up) <= Math.abs(guess - corner)
                      ? up
                      : corner;
            const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!;
            raw[y * (stride + 1) + 1 + x] = (line[x]! - predicted) & 0xff;
        }
        prior = line;
    });
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header.set([8, 6, 0, 0, 0], 8);
    const parts = [
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", await deflate(raw)),
        chunk("IEND", new Uint8Array()),
    ];
    const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
        all.set(part, at);
        at += part.length;
    }
    return all;
}

/** The start of a JPEG, as far as its size: JFIF's marker, and its frame's header (three components). */
export function jpegHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    return Uint8Array.from([
        0xff,
        0xd8,
        0xff,
        0xe0,
        0,
        16,
        0x4a,
        0x46,
        0x49,
        0x46,
        0,
        1,
        1,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0xff,
        0xc0,
        0,
        17,
        8,
        height >> 8,
        height & 0xff,
        width >> 8,
        width & 0xff,
        3,
        1,
        0x22,
        0,
        2,
        0x11,
        1,
        3,
        0x11,
        1,
        0xff,
        0xd9,
    ]);
}
