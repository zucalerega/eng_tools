import { expect, test } from "vitest";
import { drawingBox } from "../src/piper/edit";
import { newLine, type Drawing } from "../src/piper/drawing";
import { example } from "../src/piper/example";
import { legendBeside, svgOf } from "../src/piper/exports";
import { monochrome } from "../src/piper/fluids";
import { legendOf } from "../src/piper/legend";
import { fitSheet, legendSheet, pdfOfPages } from "../src/piper/pdf";

// The legend an export can have: every kind of part on the page with its symbol and name, its types of line, its
// fluids, and its valves' states; beside the drawing in an image or a PDF, or on a sheet of its own after a page whose
// printed sheet is set.

const META = { name: "Feed system", revision: "1", savedAt: null, by: "" };
const NO_PICTURES = async () => new ArrayBuffer(0);

/** The example feed system, with a pneumatic signal line drawn on it too. */
function feed(): Drawing {
    const drawing = example();
    return {
        ...drawing,
        lines: [...drawing.lines, newLine({ x: -300, y: -200 }, { x: -200, y: -200 }, { kind: "pneumatic" })],
    };
}

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const reader = input.pipeThrough(new DecompressionStream("deflate")).getReader();
    let text = "";
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        text += latin1(read.value);
    }
    return text;
}

/** A PDF's pages: each one's size, and what its content draws. */
async function pagesOf(pdf: Blob): Promise<{ size: string; content: string }[]> {
    const text = latin1(new Uint8Array(await pdf.arrayBuffer()));
    const sizes = [...text.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((match) => match[1]!);
    const contents = [...text.matchAll(/\/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)].map((match) =>
        text.slice(match.index + match[0].length, match.index + match[0].length + Number(match[1])),
    );
    return Promise.all(
        contents.map(async (content, index) => ({
            size: sizes[index]!,
            content: await inflate(Uint8Array.from(content, (char) => char.charCodeAt(0))),
        })),
    );
}

test("a page's legend lists its parts by what they're called, in the library's order, its lines, fluids, and states", () => {
    const entries = legendOf(feed());
    expect(entries.parts.map((entry) => [entry.category, entry.name])).toEqual([
        ["Valves", "Ball valve"],
        ["Valves", "Solenoid valve"],
        ["Valves", "Pneumatic ball valve"],
        ["Valves", "Check valve"],
        ["Valves", "Pressure regulator"],
        ["Tanks and vessels", "Tank"],
        ["Tanks and vessels", "Gas bottle"],
        ["Flow elements", "Orifice"],
        ["Flow elements", "Cavitating venturi"],
        ["Instruments", "Pressure transducer"],
        ["Equipment", "Engine"],
        ["Equipment", "Vent"],
    ]); // each once, and not what's only written on it (its legend, its title block) or a tee
    expect(entries.lines).toEqual(["pipe", "pneumatic"]);
    expect(entries.fluids.map((fluid) => fluid.id)).toEqual(["gn2", "gox", "rp1", "lox"]);
    expect(entries.states).toEqual(["NO", "NC"]);
    // In black and white, every line's in ink: its fluids aren't told apart, so they aren't listed.
    expect(legendOf(feed(), false).fluids).toEqual([]);
});

test("an image's legend is beside the drawing, to its right: each row its symbol, or its line, and its name", async () => {
    const drawing = feed();
    const { svg } = await svgOf(drawing, META, NO_PICTURES, legendBeside(drawing));
    const root = new DOMParser().parseFromString(svg, "image/svg+xml");
    const legend = root.querySelector(".piper-legend")!;
    const [x] = /translate\(([-\d.]+) /.exec(legend.getAttribute("transform")!)!.slice(1).map(Number);
    expect(x).toBeGreaterThanOrEqual(drawingBox(drawing)!.x1);
    const rows = Array.from(legend.querySelectorAll("[data-legend]"), (row) => row.getAttribute("data-legend"));
    expect(rows).toContain("Pressure transducer");
    expect(rows).toContain("Pneumatic signal");
    expect(rows).toContain("LOX: Liquid oxygen");
    expect(rows.slice(-2)).toEqual(["Normally open", "Normally closed"]);
    // A part's row draws its symbol, as the library does (a transducer's bubble says P); a line's, its line.
    const transducer = legend.querySelector('[data-legend="Pressure transducer"]')!;
    expect(transducer.querySelector("circle")).not.toBeNull();
    expect(Array.from(transducer.querySelectorAll("text"), (text) => text.textContent)).toEqual([
        "P",
        "Pressure transducer",
    ]);
    // And the image is wide enough to hold it.
    const [, , width] = root.documentElement.getAttribute("viewBox")!.split(" ").map(Number);
    const box = drawingBox(drawing)!;
    expect(width!).toBeGreaterThan(box.x1 - box.x0 + 150);
    // Without one, there's none.
    expect((await svgOf(drawing, META, NO_PICTURES)).svg).not.toContain("piper-legend");
});

test("a PDF's legend is beside each page, fitted on with it, its names as text", async () => {
    const drawing = feed();
    const [page] = await pagesOf(
        await pdfOfPages([{ drawing, meta: META, sheet: null, legend: legendBeside(drawing) }], "tabloid", NO_PICTURES),
    );
    for (const words of [
        "(LEGEND) Tj",
        "(VALVES) Tj",
        "(Ball valve) Tj",
        "(Pneumatic signal) Tj",
        "(Normally closed) Tj",
    ]) {
        expect(page!.content).toContain(words);
    }
    // In black and white: its valves' states, but not its fluids.
    const mono = monochrome(drawing);
    const [black] = await pagesOf(
        await pdfOfPages(
            [{ drawing: mono, meta: META, sheet: null, legend: { of: mono, fluids: false } }],
            "tabloid",
            NO_PICTURES,
        ),
    );
    expect(black!.content).toContain("(Normally closed) Tj");
    expect(black!.content).not.toContain("(FLUIDS) Tj");
});

test("a page whose printed sheet is set keeps it: its legend is on a sheet of its own after it, on its paper", async () => {
    const plain = feed();
    const page = { ...plain, sheet: fitSheet(drawingBox(plain)!, "letter", true) };
    const alone = legendSheet(page);
    const pages = await pagesOf(
        await pdfOfPages(
            [
                { drawing: page, meta: META, sheet: null, legend: null },
                { drawing: alone.drawing, meta: META, sheet: null, legend: alone.legend },
            ],
            "tabloid",
            NO_PICTURES,
        ),
    );
    expect(pages.map((one) => one.size)).toEqual(["0 0 792 612", "0 0 792 612"]); // its printed sheet's letter, twice
    // (The example has a legend part of its own, of its fluids and states: the export's is the one with categories.)
    expect(pages[0]!.content).not.toContain("(VALVES) Tj");
    expect(pages[1]!.content).toContain("(VALVES) Tj");
    expect(pages[1]!.content).toContain("(Ball valve) Tj");
    expect(pages[1]!.content).not.toContain("(BV-1) Tj"); // only the legend: the page itself is the sheet before
    // At the page's scale, from the top left of the sheet's border.
    expect(alone.drawing.sheet).toEqual(page.sheet);
    expect(alone.legend.at!.x).toBeGreaterThan(page.sheet.x);
    expect(alone.legend.at!.y).toBeGreaterThan(page.sheet.y);
});
