import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DARK, LIGHT } from "../src/piper/colors";
import { DiagramView } from "../src/piper/DiagramView";
import { documentOf, emptyDrawing, readDocument, type Drawing, type Part } from "../src/piper/drawing";
import { addPart, connect, obstacles } from "../src/piper/edit";
import { findOnDrawing } from "../src/piper/find";
import { legendOf } from "../src/piper/legend";
import { CATEGORIES, presetOf, presetsBy, searchPresets, titleOf } from "../src/piper/library/index";
import { partsOf } from "../src/piper/parts";
import { pdfOf } from "../src/piper/pdf";

// Shapes: rectangles, ellipses, triangles, diamonds, lines, and arrows drawn on a drawing for how it looks, each in its
// own fill, outline, weight, and transparency; aside from the system, so its lines, lists, and simulation leave them be.

const META = { name: "Shapes", revision: "1", savedAt: null, by: "" };

/** A drawing with a library entry placed in it, set up as asked: the drawing, and the part. */
function placed(preset: string, props: Record<string, string> = {}, size?: { w: number; h: number }) {
    const added = addPart(emptyDrawing(), presetOf(preset)!, { x: 0, y: 0 });
    const parts = added.drawing.parts.map((part) =>
        part.id === added.id ? { ...part, ...size, props: { ...part.props, ...props } } : part,
    );
    const drawing: Drawing = { ...added.drawing, parts };
    return { drawing, part: parts.find((part) => part.id === added.id)! };
}

/** The paths a drawing draws its parts with, as the page shows it. */
function drawn(drawing: Drawing, palette = LIGHT): SVGPathElement[] {
    const markup = renderToStaticMarkup(
        createElement("svg", null, createElement(DiagramView, { drawing, palette, meta: META })),
    );
    const svg = new DOMParser().parseFromString(markup, "image/svg+xml");
    return Array.from(svg.querySelectorAll("g[data-kind] path"));
}

test("the library has a Shapes group: boxes, an ellipse, a triangle, a diamond, a line, and arrows", () => {
    expect(CATEGORIES.map((category) => category.name)).toContain("Shapes");
    expect(presetsBy("shapes").map((preset) => preset.name)).toEqual([
        "Rectangle",
        "Rounded rectangle",
        "Ellipse",
        "Triangle",
        "Diamond",
        "Line",
        "Arrow",
        "Double arrow",
    ]);
    // Found by what they're for, as the request called them.
    expect(searchPresets("cosmetic").map((preset) => preset.id)).toEqual(
        presetsBy("shapes").map((preset) => preset.id),
    );
    expect(titleOf(placed("ellipse").part)).toBe("Ellipse");
    expect(titleOf(placed("double-arrow").part)).toBe("Double arrow");
});

test("a shape's outlined in ink and not filled, until it's given a fill, an outline, a weight, and a transparency", () => {
    const [plain] = drawn(placed("rectangle").drawing);
    expect(plain!.getAttribute("fill")).toBe("none");
    expect(plain!.getAttribute("stroke")).toBe(LIGHT.ink);
    expect(plain!.getAttribute("stroke-width")).toBe("1.6");
    expect(plain!.hasAttribute("fill-opacity")).toBe(false);

    const [set] = drawn(
        placed("ellipse", { fill: "#ff8800", outline: "#0055cc", weight: "thick", dash: "dashed", transparency: "25" })
            .drawing,
    );
    expect(set!.getAttribute("d")).toMatch(/A/); // an ellipse's arcs
    expect(set!.getAttribute("fill")).toBe("#ff8800");
    expect(set!.getAttribute("stroke")).toBe("#0055cc");
    expect(set!.getAttribute("stroke-width")).toBe("3");
    expect(set!.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(set!.getAttribute("fill-opacity")).toBe("0.75");
    expect(set!.getAttribute("stroke-opacity")).toBe("0.75");

    // No outline: only its fill. And black and white are the page's ink and paper, so it reads on a dark page too.
    const [bare] = drawn(placed("triangle", { fill: "#ffffff", dash: "none" }).drawing, DARK);
    expect(bare!.getAttribute("stroke")).toBe("none");
    expect(bare!.getAttribute("fill")).toBe(DARK.paper);

    // Sized as it's dragged: its outline fills its box.
    const [big] = drawn(placed("diamond", {}, { w: 200, h: 60 }).drawing);
    expect(big!.getAttribute("d")).toBe("M0 -30 L100 0 L0 30 L-100 0 Z");
});

test("a line runs level or corner to corner across its box, with heads at its end, its start, or both", () => {
    const line = drawn(placed("drawn-line", {}, { w: 100, h: 40 }).drawing);
    expect(line.map((path) => path.getAttribute("d"))).toEqual(["M-50 0 L50 0"]);

    const down = drawn(placed("arrow", { slant: "down", outline: "#cc0000" }, { w: 100, h: 40 }).drawing);
    expect(down).toHaveLength(2); // the line, and its head
    expect(down[0]!.getAttribute("d")).toMatch(/^M-50 -20 L/);
    expect(down[1]!.getAttribute("d")).toMatch(/^M50 20 L/); // its head's tip at the end
    expect(down[1]!.getAttribute("fill")).toBe("#cc0000");

    const both = drawn(placed("double-arrow", { slant: "up", transparency: "50" }, { w: 100, h: 40 }).drawing);
    const heads = both[1]!.getAttribute("d")!;
    expect(heads).toMatch(/^M-50 20 L.* Z M50 -20 L.* Z$/);
    expect(both[0]!.getAttribute("stroke-opacity")).toBe("0.5");
    expect(both[1]!.getAttribute("fill-opacity")).toBe("0.5");
});

test("shapes are aside from the system: lines route through them; the lists, the legend, and Find leave them out", () => {
    let drawing = emptyDrawing();
    const add = (preset: string, x: number, y: number) => {
        const added = addPart(drawing, presetOf(preset)!, { x, y });
        drawing = added.drawing;
        return added.id;
    };
    const left = add("ball-valve", 0, 0);
    const right = add("ball-valve", 300, 0);
    add("rectangle", 150, 0);
    add("arrow", 150, 100);
    expect(obstacles(drawing)).toHaveLength(2); // the valves only
    drawing = connect(drawing, { part: left, port: "b" }, { part: right, port: "a" })!.drawing;
    // Straight through the rectangle, as if it weren't there.
    expect(drawing.lines[0]!.points).toEqual([]);

    expect(partsOf(documentOf(drawing)).map((row) => row.cells.tag)).toEqual(["BV-1", "BV-2"]);
    expect(legendOf(drawing).parts.map((entry) => entry.name)).toEqual(["Ball valve"]);
    expect(findOnDrawing(drawing, "rectangle")).toEqual([]);
    expect(findOnDrawing(drawing, "arrow")).toEqual([]);
});

test("a drawing with shapes reads back as it was saved, in the same format as before", () => {
    const { drawing, part } = placed("ellipse", { fill: "#22aa44", transparency: "50" }, { w: 160, h: 90 });
    const saved = JSON.parse(JSON.stringify(documentOf(drawing))) as unknown;
    const read = readDocument(saved);
    expect(read.format).toBe(4);
    const back = read.pages[0]!.parts[0] as Part;
    expect(back).toMatchObject({ kind: "shape", w: 160, h: 90, props: part.props });
});

test("a PDF prints a see-through shape see-through, in its colors", async () => {
    const { drawing } = placed("rectangle", { fill: "#ff0000", outline: "#0000ff", transparency: "50" });
    const bytes = new Uint8Array(await (await pdfOf(drawing, META, "fit")).arrayBuffer());
    const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    expect(text).toMatch(/\/Type \/ExtGState \/ca 0.5 \/CA 0.5 /); // its graphics state
    const start = text.indexOf("stream\n") + "stream\n".length;
    const end = text.indexOf("\nendstream");
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(Uint8Array.from(text.slice(start, end), (char) => char.charCodeAt(0)));
            controller.close();
        },
    });
    const reader = input.pipeThrough(new DecompressionStream("deflate")).getReader();
    let content = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        content += Array.from(chunk.value, (byte) => String.fromCharCode(byte)).join("");
    }
    expect(content).toMatch(/\/GS\d+ gs/);
    expect(content).toContain("1 0 0 rg");
    expect(content).toContain("0 0 1 RG");
});
