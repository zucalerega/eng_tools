import { packJson, unpackJson } from "../packed";
import type { Layout } from "./layout";

// A link to a page's plots, to send someone what's on screen without saving a view: the page's address with its layout
// in the query, as the JSON a saved view keeps, deflated and base64url-encoded (packed.ts). In the query, not after a
// #: someone who isn't signed in yet comes back from signing in to the page's path and query, and loses what's after a
// #. Whoever opens it reads that JSON as a saved view's is read (readLayout), so a link made before the layout grew
// still opens.

/** The query parameter a link's plots are in: /yorg/datasets/5?plots=... */
export const PLOTS = "plots";

// A link's plots are anyone's to write, and a few KB of deflate can inflate to many MB: they may hold as much as a saved
// view may (MAX_VIEW_BYTES, on the server), and no more.
const MOST_JSON = 512 * 1024;

/** A link to this page with these plots. */
export async function plotsLink(layout: Layout): Promise<string> {
    const link = new URL(window.location.pathname, window.location.origin);
    link.searchParams.set(PLOTS, await packJson(layout));
    return link.toString();
}

/** What a link's plots hold: a layout's JSON, to read as a saved view's is. Throws if it can't be read. */
export function readPlots(text: string): Promise<unknown> {
    return unpackJson(text, MOST_JSON);
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
