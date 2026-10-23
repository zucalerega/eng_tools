// JSON packed small enough to go in a link's query: deflated (CompressionStream("deflate-raw")) and base64url-encoded,
// so it goes in an address as it is. Yorg's links to plots carry their layout this way (yorg/share.ts), and Piper
// makes those links too.

/** A value's JSON, packed. */
export async function packJson(value: unknown): Promise<string> {
    const json = new TextEncoder().encode(JSON.stringify(value));
    return toBase64Url(await through(json, new CompressionStream("deflate-raw")));
}

/** What packJson packed, if it unpacks to at most most bytes of JSON. Throws if it can't be read. */
export async function unpackJson(text: string, most: number): Promise<unknown> {
    const json = await through(fromBase64Url(text), new DecompressionStream("deflate-raw"), most);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)) as unknown;
}

/** Bytes through a (de)compression stream, up to most of them out of it (more throws). */
async function through(
    bytes: Uint8Array<ArrayBuffer>,
    stream: CompressionStream | DecompressionStream,
    most = Infinity,
): Promise<Uint8Array<ArrayBuffer>> {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const output = input.pipeThrough(stream).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let read = await output.read(); !read.done; read = await output.read()) {
        size += read.value.byteLength;
        if (size > most) {
            await output.cancel();
            throw new Error(`More than ${most} bytes`);
        }
        chunks.push(read.value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.byteLength;
    }
    return all;
}

/** Base64 with the URL's alphabet (- and _ for + and /) and no padding, so it goes in a query as it is. */
function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/")); // throws if it isn't base64
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
