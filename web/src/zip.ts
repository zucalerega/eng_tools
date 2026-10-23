// Reading .zip files in the browser: Vault's uploads can be what's in one, and Piper reads Visio's drawings, which are
// zips of XML. The zip's directory (at its end) lists the files in it; each is read only when it's wanted, inflated by
// the browser's own DecompressionStream and checked against its CRC-32, so a big zip is never all in memory at once.

export interface ZipEntry {
    path: string; // where it is in the zip, with / between folders
    size: number;
    read: () => Promise<Uint8Array<ArrayBuffer>>;
}

export interface ZipContents {
    entries: ZipEntry[];
    skipped: { path: string; reason: string }[]; // files in it that can't be read here, and why
}

export class ZipError extends Error {}

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const ENTRY = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const FULL = 0xffffffff; // a 32-bit size or offset that doesn't fit: the real one is in the zip64 fields

// Names not marked as UTF-8 are in the original PC's code page, CP437: here are its upper 128 characters.
const CP437 =
    "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const utf8 = new TextDecoder();

async function bytesAt(blob: Blob, start: number, end: number): Promise<DataView> {
    return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** What's in a zip file. A ZipError if it isn't one, or its directory is damaged. */
export async function readZip(zip: Blob, name: string): Promise<ZipContents> {
    const damaged = () => new ZipError(`${name} isn't a zip file, or it's damaged.`);
    // The end record closes the file, followed only by the zip's comment (up to 64 KB).
    const tailStart = Math.max(0, zip.size - (22 + 0xffff));
    const tail = await bytesAt(zip, tailStart, zip.size);
    let end = tail.byteLength - 22;
    while (end >= 0 && tail.getUint32(end, true) !== END) {
        end--;
    }
    if (end < 0) {
        throw damaged();
    }
    let count = tail.getUint16(end + 10, true);
    let size = tail.getUint32(end + 12, true);
    let offset = tail.getUint32(end + 16, true);
    if (count === 0xffff || size === FULL || offset === FULL) {
        // Zip64 (a big zip, or a lot of files): a locator just before the end record says where the real one is.
        const at = tailStart + end - 20;
        const locator = at >= 0 ? await bytesAt(zip, at, at + 20) : null;
        if (!locator || locator.getUint32(0, true) !== END64_LOCATOR) {
            throw damaged();
        }
        const recordAt = Number(locator.getBigUint64(8, true));
        const record = await bytesAt(zip, recordAt, recordAt + 56);
        if (record.byteLength < 56 || record.getUint32(0, true) !== END64) {
            throw damaged();
        }
        count = Number(record.getBigUint64(32, true));
        size = Number(record.getBigUint64(40, true));
        offset = Number(record.getBigUint64(48, true));
    }
    const directory = await bytesAt(zip, offset, offset + size);
    const contents: ZipContents = { entries: [], skipped: [] };
    let at = 0;
    for (let index = 0; index < count; index++) {
        if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== ENTRY) {
            throw damaged();
        }
        const flags = directory.getUint16(at + 8, true);
        const method = directory.getUint16(at + 10, true);
        const crc = directory.getUint32(at + 16, true);
        let packed = directory.getUint32(at + 20, true);
        let unpacked = directory.getUint32(at + 24, true);
        const nameLength = directory.getUint16(at + 28, true);
        const extraLength = directory.getUint16(at + 30, true);
        const commentLength = directory.getUint16(at + 32, true);
        let local = directory.getUint32(at + 42, true);
        const raw = new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength);
        const named = flags & 0x800 ? utf8.decode(raw) : [...raw].map((byte) => decodeCp437(byte)).join("");
        // The zip64 extra field (id 1) has the sizes and offset that didn't fit, in this order.
        for (let extra = at + 46 + nameLength; extra + 4 <= at + 46 + nameLength + extraLength;) {
            const id = directory.getUint16(extra, true);
            const length = directory.getUint16(extra + 2, true);
            let field = extra + 4;
            const next = () => {
                const value = Number(directory.getBigUint64(field, true));
                field += 8;
                return value;
            };
            if (id === 1) {
                unpacked = unpacked === FULL ? next() : unpacked;
                packed = packed === FULL ? next() : packed;
                local = local === FULL ? next() : local;
            }
            extra += 4 + length;
        }
        at += 46 + nameLength + extraLength + commentLength;

        const names = named
            .replaceAll("\\", "/")
            .split("/")
            .filter((part) => part !== "" && part !== ".");
        const path = names.join("/");
        if (named.endsWith("/") || named.endsWith("\\") || names.length === 0 || names[0] === "__MACOSX") {
            continue; // folders are made from the files' paths; __MACOSX holds a Mac's notes about the files
        }
        if (names.includes("..")) {
            contents.skipped.push({ path, reason: "Its place in the zip points outside it." });
        } else if (flags & 1) {
            contents.skipped.push({ path, reason: "It's encrypted: unzip it on your computer, then upload it." });
        } else if (method !== STORED && method !== DEFLATED) {
            const reason = `It's compressed in a way browsers can't open (method ${method}): unzip it on your computer, then upload it.`;
            contents.skipped.push({ path, reason });
        } else {
            const where: Stored = { local, packed, compressed: method === DEFLATED, size: unpacked, crc };
            contents.entries.push({ path, size: unpacked, read: () => readEntry(zip, name, path, where) });
        }
    }
    return contents;
}

/** Where a file's data is in a zip, how, and what it should come to. */
interface Stored {
    local: number; // its header's offset
    packed: number;
    compressed: boolean;
    size: number;
    crc: number;
}

async function readEntry(zip: Blob, zipName: string, path: string, stored: Stored): Promise<Uint8Array<ArrayBuffer>> {
    const damaged = () => new ZipError(`${path} is damaged in ${zipName}.`);
    const header = await bytesAt(zip, stored.local, stored.local + 30);
    if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) {
        throw damaged();
    }
    // Its data follows its own header, whose name and extra field can differ in length from the directory's.
    const start = stored.local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const data = new Uint8Array(await zip.slice(start, start + stored.packed).arrayBuffer());
    let contents: Uint8Array<ArrayBuffer>;
    try {
        contents = stored.compressed ? await inflate(data) : data;
    } catch {
        throw damaged();
    }
    if (contents.length !== stored.size || crc32(contents) !== stored.crc) {
        throw damaged();
    }
    return contents;
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    });
    return new Uint8Array(await new Response(input.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

function decodeCp437(byte: number): string {
    return byte < 0x80 ? String.fromCharCode(byte) : CP437.charAt(byte - 0x80);
}

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
