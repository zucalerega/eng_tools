import { pageOf, type Document, type Drawing } from "./drawing";
import { fluidOf } from "./fluids";
import { titleOf } from "./library/index";

// Finding what's on a drawing: a part by its tag (PUREG, PT-101), what it is (regulator), or what it holds, and a line by
// its tag or fluid. Tags match whatever their case, and then ignoring spaces, dashes, and underscores, as test channels
// do (testdata.ts): "pt101" finds PT-101. A diagram's search looks through all its pages.

export interface Found {
    id: string;
    line: boolean; // a line, not a part
    tag: string;
    what: string; // what it is: "Pressure regulator", or a line's fluid
    page: number; // which of the diagram's pages it's on
}

/** A name as a search compares it: its case, spaces, dashes, and underscores aside. */
const loose = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");

/** What a search finds on a page, the best first: a tag that's it, then tags that start with it, then the rest. */
export function findOnDrawing(drawing: Drawing, search: string, most = 30): Found[] {
    return best(scoredOn(drawing, loose(search), 0), most);
}

/** What a search finds on any of a diagram's pages, the best first: of those as good, the ones on the page being
 * worked on first. */
export function findInDocument(document: Document, search: string, page = 0, most = 30): Found[] {
    const wanted = loose(search);
    const scored = document.pages.flatMap((_, index) => scoredOn(pageOf(document, index), wanted, index));
    return best(scored, most, page);
}

function best(scored: { found: Found; score: number }[], most: number, page = 0): Found[] {
    return scored
        .sort(
            (a, b) =>
                a.score - b.score ||
                Number(b.found.page === page) - Number(a.found.page === page) ||
                a.found.tag.localeCompare(b.found.tag, undefined, { numeric: true, sensitivity: "base" }),
        )
        .slice(0, most)
        .map(({ found }) => found);
}

function scoredOn(drawing: Drawing, wanted: string, page: number): { found: Found; score: number }[] {
    if (!wanted) {
        return [];
    }
    const scored: { found: Found; score: number }[] = [];
    const rate = (found: Found, also: string[]) => {
        const tag = loose(found.tag);
        const score =
            tag === wanted
                ? 0
                : tag.startsWith(wanted)
                  ? 1
                  : tag.includes(wanted)
                    ? 2
                    : [found.what, ...also].some((text) => loose(text).includes(wanted))
                      ? 3
                      : -1;
        if (score >= 0) {
            scored.push({ found, score });
        }
    };
    for (const part of drawing.parts) {
        if (part.kind === "junction") {
            continue;
        }
        const holds = fluidOf(drawing, part.props.fluid ?? "");
        rate({ id: part.id, line: false, tag: part.tag, what: titleOf(part), page }, [
            part.text,
            holds?.label ?? "",
            holds?.name ?? "",
        ]);
    }
    for (const line of drawing.lines) {
        const fluid = fluidOf(drawing, line.fluid);
        rate({ id: line.id, line: true, tag: line.tag, what: fluid ? `${fluid.label} line` : "Line", page }, [
            fluid?.name ?? "",
        ]);
    }
    return scored;
}
