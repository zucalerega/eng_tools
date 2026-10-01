import { sitePath } from "../preview";
import type { Layout } from "./layout";

// A link to a page's plots, to send someone what's on screen without saving a view: the page's address with its layout
// in the query, as the JSON a saved view keeps, deflated and base64url-encoded. In the query, not after a #: someone
// who isn't signed in yet comes back from signing in to the page's path and query, and loses what's after a #. Whoever
// opens it reads that JSON as a saved view's is read (readLayout), so a link made before the layout grew still opens.

/** The query parameter a link's plots are in: /yorg/datasets/5?plots=... */
export const PLOTS = "plots";

// A link's plots are anyone's to write, and a few KB of deflate can inflate to many MB: they may hold as much as a saved
// view may (MAX_VIEW_BYTES, on the server), and no more.
const MOST_JSON = 512 * 1024;

/** A link to this page with these plots, on the site's path (the preview's, /yorg/dev/..., are only for admins). */
export async function plotsLink(layout: Layout): Promise<string> {
    const json = new TextEncoder().encode(JSON.stringify(layout));
    const link = new URL(sitePath(window.location.pathname), window.location.origin);
    link.searchParams.set(PLOTS, toBase64Url(await through(json, new CompressionStream("deflate-raw"))));
    return link.toString();
}

/** What a link's plots hold: a layout's JSON, to read as a saved view's is. Throws if it can't be read. */
export async function readPlots(text: string): Promise<unknown> {
    const json = await through(fromBase64Url(text), new DecompressionStream("deflate-raw"), MOST_JSON);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)) as unknown;
}

/** The plots in this page's address, if it has any. */
export function plotsInAddress(): string | null {
    return new URLSearchParams(window.location.search).get(PLOTS);
}

/** This page's address without its plots, once they're read: a reload then shows the page as it is. */
export function dropPlotsFromAddress(): void {
    const address = new URL(window.location.href);
    if (address.searchParams.has(PLOTS)) {
        address.searchParams.delete(PLOTS);
        window.history.replaceState(window.history.state, "", address.pathname + address.search + address.hash);
    }
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
