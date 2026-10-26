// Pictures on a drawing, for its exports: each one's bytes as a data: URI, so an SVG or a PNG of the drawing has them
// in it (an SVG drawn as an image can't fetch anything), and decoded for a PDF, which has images of its own: a JPEG as
// it is (PDF reads JPEG's compression, DCTDecode), a PNG as its pixels and its transparency, each deflated.

/** A picture's bytes, by its SHA-256: the server's, unless something else has them (a test). */
export type PictureSource = (sha256: string) => Promise<ArrayBuffer>;

/** A picture for a PDF: its size in pixels, and what it's written as. */
export interface PdfPicture {
    width: number;
    height: number;
    colorSpace: "DeviceGray" | "DeviceRGB" | "DeviceCMYK";
    filter: "DCTDecode" | "FlateDecode";
    data: Uint8Array<ArrayBuffer>; // as the filter reads it: a JPEG's own bytes, or the pixels deflated
    alpha: Uint8Array<ArrayBuffer> | null; // its transparency, deflated, a byte for each pixel; null if it has none
    decode?: string; // how a color's numbers read, if not as they are (an Adobe CMYK JPEG's are inverted)
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (bytes: Uint8Array) => PNG.every((byte, index) => bytes[index] === byte);
const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8;

/** A picture's bytes as a data: URI, to draw it with no request. */
export function dataUri(bytes: Uint8Array): string {
    const type = isPng(bytes) ? "image/png" : isJpeg(bytes) ? "image/jpeg" : "application/octet-stream";
    let text = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return `data:${type};base64,${btoa(text)}`;
}

/** A data: URI's bytes, if it's one written as base64. */
export function bytesOf(uri: string): Uint8Array<ArrayBuffer> | null {
    const match = /^data:[^;,]*;base64,(.*)$/s.exec(uri);
    if (!match) {
        return null;
    }
    const text = atob(match[1]!);
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/** A picture, a PNG or a JPEG, as a PDF writes it. */
export async function pdfPicture(bytes: Uint8Array<ArrayBuffer>): Promise<PdfPicture> {
    if (isJpeg(bytes)) {
        return jpegPicture(bytes);
    }
    if (isPng(bytes)) {
        const decoded = (await decodePng(bytes)) ?? (await decodeWithCanvas(bytes));
        return {
            width: decoded.width,
            height: decoded.height,
            colorSpace: decoded.gray ? "DeviceGray" : "DeviceRGB",
            filter: "FlateDecode",
            data: await deflate(decoded.color),
            alpha: decoded.alpha ? await deflate(decoded.alpha) : null,
        };
    }
    throw new Error("A picture on the drawing isn't a PNG or a JPEG");
}

/** A JPEG as it is, with the size and colors its frame's header says. */
function jpegPicture(bytes: Uint8Array<ArrayBuffer>): PdfPicture {
    let at = 2;
    let adobe = false;
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1]!;
        if (marker === 0xff) {
            at += 1;
            continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2;
            continue;
        }
        const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
        if (marker === 0xee) {
            adobe = true; // Adobe's marker: its CMYK is written inverted
        }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            const height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
            const width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
            const components = bytes[at + 9]!;
            const colorSpace = components === 1 ? "DeviceGray" : components === 4 ? "DeviceCMYK" : "DeviceRGB";
            return {
                width,
                height,
                colorSpace,
                filter: "DCTDecode",
                data: bytes,
                alpha: null,
                decode: colorSpace === "DeviceCMYK" && adobe ? "[1 0 1 0 1 0 1 0]" : undefined,
            };
        }
        at += 2 + length;
    }
    throw new Error("A JPEG on the drawing doesn't say its size");
}

interface Pixels {
    width: number;
    height: number;
    gray: boolean;
    color: Uint8Array<ArrayBuffer>; // a byte for each channel of each pixel: one if gray, else three
    alpha: Uint8Array<ArrayBuffer> | null; // a byte for each pixel, if any of them isn't opaque
}

/**
 * A PNG's pixels, as its chunks say (IHDR, PLTE, tRNS, IDAT): any color type and depth, its rows unfiltered. Null
 * for an interlaced one, which a canvas decodes instead.
 */
export async function decodePng(bytes: Uint8Array<ArrayBuffer>): Promise<Pixels | null> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let [width, height, depth, type, interlaced] = [0, 0, 8, 0, false];
    let palette: Uint8Array | null = null;
    let transparency: Uint8Array | null = null;
    const data: Uint8Array[] = [];
    for (let at = 8; at + 8 <= bytes.length;) {
        const length = view.getUint32(at);
        const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const body = bytes.subarray(at + 8, at + 8 + length);
        if (kind === "IHDR") {
            width = view.getUint32(at + 8);
            height = view.getUint32(at + 12);
            depth = body[8]!;
            type = body[9]!;
            interlaced = body[12] === 1;
        } else if (kind === "PLTE") {
            palette = body;
        } else if (kind === "tRNS") {
            transparency = body;
        } else if (kind === "IDAT") {
            data.push(body);
        } else if (kind === "IEND") {
            break;
        }
        at += 12 + length;
    }
    if (interlaced) {
        return null;
    }
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
    if (!channels || width === 0 || height === 0) {
        throw new Error("A PNG on the drawing can't be read");
    }
    const raw = await inflate(concat(data));
    const bits = channels * depth;
    const step = Math.max(1, bits >> 3); // bytes to the same channel of the pixel before
    const stride = Math.ceil((width * bits) / 8);
    const rows = new Uint8Array(stride * height);
    let prior = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)] ?? 0;
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = rows.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x++) {
            const left = x >= step ? out[x - step]! : 0;
            const up = prior[x]!;
            const corner = x >= step ? prior[x - step]! : 0;
            let value = line[x] ?? 0;
            if (filter === 1) {
                value += left;
            } else if (filter === 2) {
                value += up;
            } else if (filter === 3) {
                value += (left + up) >> 1;
            } else if (filter === 4) {
                value += paeth(left, up, corner);
            }
            out[x] = value & 0xff;
        }
        prior = out;
    }
    // Each sample, to 8 bits: a 16-bit one's high byte, a smaller one's scaled up (a palette's index as it is).
    const sample = (y: number, index: number): number => {
        const row = y * stride;
        if (depth === 8) {
            return rows[row + index]!;
        }
        if (depth === 16) {
            return rows[row + index * 2]!;
        }
        const bit = index * depth;
        const value = (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        return type === 3 ? value : Math.round((value * 255) / ((1 << depth) - 1));
    };
    const gray = type === 0 || type === 4;
    const color = new Uint8Array(width * height * (gray ? 1 : 3));
    const alpha = new Uint8Array(width * height).fill(255);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const first = x * channels;
            if (type === 3) {
                const index = sample(y, first);
                color.set(palette?.subarray(index * 3, index * 3 + 3) ?? [0, 0, 0], pixel * 3);
                alpha[pixel] = transparency?.[index] ?? 255;
            } else if (gray) {
                color[pixel] = sample(y, first);
                if (type === 4) {
                    alpha[pixel] = sample(y, first + 1);
                }
            } else {
                color[pixel * 3] = sample(y, first);
                color[pixel * 3 + 1] = sample(y, first + 1);
                color[pixel * 3 + 2] = sample(y, first + 2);
                if (type === 6) {
                    alpha[pixel] = sample(y, first + 3);
                }
            }
        }
    }
    return { width, height, gray, color, alpha: alpha.some((value) => value < 255) ? alpha : null };
}

function paeth(left: number, up: number, corner: number): number {
    const guess = left + up - corner;
    const [toLeft, toUp, toCorner] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - corner)];
    return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
}

/** A picture's pixels as a browser's canvas draws it: for a PNG the reader above doesn't read (an interlaced one). */
async function decodeWithCanvas(bytes: Uint8Array<ArrayBuffer>): Promise<Pixels> {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
        throw new Error("A picture on the drawing can't be read here: save it as a PNG that isn't interlaced");
    }
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("A picture on the drawing can't be read here");
    }
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const color = new Uint8Array(bitmap.width * bitmap.height * 3);
    const alpha = new Uint8Array(bitmap.width * bitmap.height);
    for (let pixel = 0; pixel < alpha.length; pixel++) {
        color.set(data.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
        alpha[pixel] = data[pixel * 4 + 3]!;
    }
    return {
        width: bitmap.width,
        height: bitmap.height,
        gray: false,
        color,
        alpha: alpha.some((value) => value < 255) ? alpha : null,
    };
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
    }
    return all;
}

async function through(
    bytes: Uint8Array<ArrayBuffer>,
    stream: GenericTransformStream,
): Promise<Uint8Array<ArrayBuffer>> {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const reader = input.pipeThrough(stream as TransformStream<Uint8Array, Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value);
    }
    return concat(chunks);
}

/** Bytes compressed as zlib's deflate, which a PNG's pictures and PDF's FlateDecode are. */
export const deflate = (bytes: Uint8Array<ArrayBuffer>) => through(bytes, new CompressionStream("deflate"));
const inflate = (bytes: Uint8Array<ArrayBuffer>) => through(bytes, new DecompressionStream("deflate"));
