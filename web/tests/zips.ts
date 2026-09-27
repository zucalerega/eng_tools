import { crc32, deflateRawSync } from "node:zlib";

// Zip files made the way zip tools make them, for the tests: each file's header and data, then the
// directory, then the end record (and, for zip64, the records big zips use instead).

export interface InZip {
    name: string | Uint8Array; // bytes: a name in CP437, not marked as UTF-8
    contents: string;
    deflate?: boolean;
    method?: number; // instead of stored or deflated: one browsers can't open
    flags?: number; // 1: encrypted
}

export function makeZip(files: InZip[], options: { zip64?: boolean } = {}): Uint8Array<ArrayBuffer> {
    const body: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
        const name = typeof file.name === "string" ? Buffer.from(file.name, "utf8") : Buffer.from(file.name);
        const data = Buffer.from(file.contents, "utf8");
        const packed = file.deflate ? deflateRawSync(data) : data;
        const method = file.method ?? (file.deflate ? 8 : 0);
        const flags = (file.flags ?? 0) | (typeof file.name === "string" ? 0x800 : 0);
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        body.push(local, name, packed);

        const extra = Buffer.alloc(options.zip64 ? 28 : 0);
        if (options.zip64) {
            extra.writeUInt16LE(1, 0);
            extra.writeUInt16LE(24, 2);
            extra.writeBigUInt64LE(BigInt(data.length), 4);
            extra.writeBigUInt64LE(BigInt(packed.length), 12);
            extra.writeBigUInt64LE(BigInt(offset), 20);
        }
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(flags, 8);
        entry.writeUInt16LE(method, 10);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(options.zip64 ? 0xffffffff : packed.length, 20);
        entry.writeUInt32LE(options.zip64 ? 0xffffffff : data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt16LE(extra.length, 30);
        entry.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 42);
        directory.push(entry, name, extra);
        offset += local.length + name.length + packed.length;
    }
    const listed = Buffer.concat(directory);
    const records: Buffer[] = [];
    if (options.zip64) {
        const record = Buffer.alloc(56);
        record.writeUInt32LE(0x06064b50, 0);
        record.writeBigUInt64LE(44n, 4);
        record.writeUInt16LE(45, 12);
        record.writeUInt16LE(45, 14);
        record.writeBigUInt64LE(BigInt(files.length), 24);
        record.writeBigUInt64LE(BigInt(files.length), 32);
        record.writeBigUInt64LE(BigInt(listed.length), 40);
        record.writeBigUInt64LE(BigInt(offset), 48);
        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(0x07064b50, 0);
        locator.writeBigUInt64LE(BigInt(offset + listed.length), 8);
        locator.writeUInt32LE(1, 16);
        records.push(record, locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 8);
    end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 10);
    end.writeUInt32LE(options.zip64 ? 0xffffffff : listed.length, 12);
    end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
    return new Uint8Array(Buffer.concat([...body, listed, ...records, end]));
}
