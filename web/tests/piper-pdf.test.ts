import { expect, test } from "vitest";
import { emptyDrawing, newPart } from "../src/piper/drawing";
import { example } from "../src/piper/example";
import { pageFor, pathOperators, pdfOf } from "../src/piper/pdf";

// The PDF export: a whole file (its objects where its cross-reference table says, the page the paper chosen, turned
// the drawing's way), the drawing in PDF's own operators, and its words as text.

const META = { name: "Feed system", revision: "12 (after B)", savedAt: "2026-10-23T12:00:00Z", by: "Chief" };

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

test("a PDF of a drawing is a whole file: each object where its cross-reference table says", async () => {
    const bytes = new Uint8Array(await (await pdfOf(example(), META, "tabloid")).arrayBuffer());
    const text = latin1(bytes);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(offsets.length).toBeGreaterThan(5);
    offsets.forEach((offset, index) =>
        expect(text.slice(offset, offset + 12)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`)),
    );
    // On tabloid paper, landscape (the drawing's about as tall as it's wide), with Helvetica.
    expect(text).toMatch(/\/MediaBox \[0 0 1224 792\]/);
    expect(text).toContain("/BaseFont /Helvetica-Bold");
    expect(text).toMatch(/\/Title <FEFF0046006500650064/); // "Feed..." in UTF-16
});

test("the drawing's in PDF's own operators, its words as text", async () => {
    const text = latin1(new Uint8Array(await (await pdfOf(example(), META, "fit")).arrayBuffer()));
    const start = text.indexOf("stream\n") + "stream\n".length;
    const end = text.indexOf("\nendstream");
    const content = await inflate(Uint8Array.from(text.slice(start, end), (char) => char.charCodeAt(0)));
    expect(content).toContain("(P) Tj"); // a sensor's letter, in its box
    expect(content).toContain("(PT-1) Tj"); // and its tag, beside it
    expect(content).toContain("(BV-1) Tj"); // a tag
    expect(content).toContain("(Feed system) Tj"); // the title block's title
    expect(content).toMatch(/ c\n/); // curves: arcs and circles as Béziers
    expect(content).toMatch(/\/GS\d+ gs/); // tanks' contents, see-through
    const lines = content.split("\n");
    expect(lines.filter((line) => line === "BT").length).toBe(lines.filter((line) => line === "ET").length);
});

test("on a drawing sheet: a border with its zones, the releases, and a title block", async () => {
    const drawing = example();
    const sheet = {
        project: "Vespula/Prop",
        diagram: 2,
        revisions: [{ rev: "B", note: "Vent valve for HF-3", date: "2026-10-20", by: "Bob, Cy" }],
        titleBlock: true,
    };
    const text = latin1(new Uint8Array(await (await pdfOf(drawing, META, "tabloid", sheet)).arrayBuffer()));
    const start = text.indexOf("stream\n") + "stream\n".length;
    const content = await inflate(
        Uint8Array.from(text.slice(start, text.indexOf("\nendstream")), (char) => char.charCodeAt(0)),
    );
    for (const words of [
        "(YELLOW JACKET SPACE PROGRAM) Tj",
        "(Vent valve for HF-3) Tj",
        "(Bob, Cy) Tj", // who approved it
        "(12 \\(after B\\)) Tj", // the revision printed, after Rev B
        "(Vespula/Prop) Tj",
        "(No. 2) Tj",
    ]) {
        expect(content).toContain(words);
    }
    // Zones numbered across from the right, lettered from the foot: tabloid, landscape, has four by two.
    for (const zone of ["(1) Tj", "(4) Tj", "(A) Tj", "(B) Tj"]) {
        expect(content).toContain(zone);
    }
    // The drawing's kept clear of the corner the title block and revisions take.
    const page = pageFor(800, 800, "tabloid", sheet);
    expect(page.x + 800 * page.scale <= 1224 - 36 - 288 || page.y + 800 * page.scale <= 792 - 36 - (86 + 3 * 12)).toBe(
        true,
    );
});

test("SVG's paths come out as PDF's: relative made absolute, arcs and quadratics as Béziers", () => {
    expect(pathOperators("M10 20 h5 v-5 L0 0 Z")).toBe("10 20 m\n15 20 l\n15 15 l\n0 0 l\nh");
    expect(pathOperators("M0 0 Q10 0 10 10")).toBe("0 0 m\n6.667 0 10 3.333 10 10 c");
    // A half circle of radius 10, from (-10, 0) over the top to (10, 0): two quarter arcs.
    const arc = pathOperators("M-10 0 A10 10 0 0 1 10 0").split("\n");
    expect(arc).toHaveLength(3);
    expect(arc[1]).toMatch(/ -?0 -10 c$/); // the top of the circle
    expect(arc[2]).toMatch(/ 10 0 c$/);
});

test("a drawing goes on its paper turned its way, as big as fits in the margins", () => {
    expect(pageFor(1000, 500, "letter")).toMatchObject({ width: 792, height: 612, scale: 0.72 });
    expect(pageFor(400, 800, "letter")).toMatchObject({ width: 612, height: 792, scale: 0.9 });
    expect(pageFor(500, 550, "letter")).toMatchObject({ width: 792, height: 612 }); // a little taller: still landscape
    expect(pageFor(300, 200, "fit")).toEqual({ width: 372, height: 272, scale: 1, x: 36, y: 36 });
});

test("a text block prints in its font: Times, Courier, bold, italic, as PDF's standard fonts", async () => {
    const block = (font: string, weight: string, slant: string, words: string) =>
        newPart("text", { x: 0, y: 0 }, { text: words, w: 160, h: 40, props: { font, weight, slant } });
    const drawing = {
        ...emptyDrawing(),
        parts: [block("serif", "bold", "italic", "Times words"), block("mono", "", "", "Courier words")],
    };
    const text = latin1(new Uint8Array(await (await pdfOf(drawing, META, "fit")).arrayBuffer()));
    for (const name of ["Helvetica", "Times-BoldItalic", "Courier"]) {
        expect(text).toContain(`/BaseFont /${name} `);
    }
    const start = text.indexOf("stream\n") + "stream\n".length;
    const content = await inflate(
        Uint8Array.from(text.slice(start, text.indexOf("\nendstream")), (char) => char.charCodeAt(0)),
    );
    expect(content).toMatch(/\/F8 [\d.]+ Tf[\s\S]*?\(Times words\) Tj/); // Times-BoldItalic
    expect(content).toMatch(/\/F9 [\d.]+ Tf[\s\S]*?\(Courier words\) Tj/); // Courier
});
