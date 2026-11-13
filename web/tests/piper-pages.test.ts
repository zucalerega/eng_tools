import { expect, test } from "vitest";
import {
    documentOf,
    emptyDrawing,
    newPart,
    pageOf,
    readDocument,
    readDrawing,
    withPage,
    type Document,
    type Drawing,
} from "../src/piper/drawing";
import { addPart, copyItems, drawingBox, listParts, pasteClip, sharedTags, updatePart } from "../src/piper/edit";
import { example } from "../src/piper/example";
import { columnsOf, leftOutOf, partsList, partsOf } from "../src/piper/parts";
import { findInDocument } from "../src/piper/find";
import { presetOf } from "../src/piper/library/index";
import { fitSheet, paperSize, pdfOfPages, sheetOutline } from "../src/piper/pdf";
import { EditorStore } from "../src/piper/store";
import { visioDocument, type ImportedPage } from "../src/piper/visio";

// A diagram's pages: a drawing of them (format 2), read whatever its age; the editor working on one at a time, with
// undo going through pages added and deleted; and the pages found in, listed, and printed, each on its own sheet.

const META = { name: "Feed system", revision: "3", savedAt: "2026-10-24T12:00:00Z", by: "Chief" };

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

function tagged(drawing: Drawing, preset: string, tag: string, x = 0): { drawing: Drawing; id: string } {
    const added = addPart(drawing, presetOf(preset)!, { x, y: 0 });
    return { drawing: updatePart(added.drawing, added.id, (part) => ({ ...part, tag })), id: added.id };
}

/** Two pages: the vehicle's, with a regulator; the ground's, with a valve. */
function twoPages(): { document: Document; regulator: string; valve: string } {
    const vehicle = tagged(emptyDrawing(), "regulator", "PUREG");
    const ground = tagged(emptyDrawing(), "ball-valve", "BV-201", 300);
    const document = documentOf(vehicle.drawing, "Vehicle");
    const second = documentOf(ground.drawing, "GSE").pages[0]!;
    return { document: { ...document, pages: [...document.pages, second] }, regulator: vehicle.id, valve: ground.id };
}

test("a drawing from before pages is one page; a drawing of pages, each of them, with what they lack filled in", () => {
    const old = { format: 1, parts: [newPart("tank", { x: 0, y: 0 })], lines: [], fluids: [], style: {} };
    const one = readDocument(old);
    expect([one.format, one.pages.length, one.pages[0]!.name, one.pages[0]!.parts.length]).toEqual([4, 1, "Page 1", 1]);
    expect(one.pages[0]!.sheet).toBeNull();

    const sheet = { paper: "letter", landscape: false, x: -10, y: -20, scale: 0.5 };
    const read = readDocument({
        format: 2,
        pages: [
            { id: "g1", name: "Vehicle", parts: old.parts, lines: [], sheet },
            { parts: [], lines: [], sheet: { paper: 3 } },
        ],
        fluids: [{ id: "mix", name: "Mix", label: "MIX", color: "#123456" }],
        style: { labels: "large" },
    });
    expect(read.pages.map((page) => page.name)).toEqual(["Vehicle", "Page 2"]);
    expect(read.pages[1]!.id).not.toBe(""); // made up, as a page's id has to be
    expect(read.pages[0]!.sheet).toEqual(sheet);
    expect(read.pages[1]!.sheet).toBeNull(); // a sheet that can't be read: none
    expect([read.fluids[0]!.id, read.style.labels]).toEqual(["mix", 1.3]);
    // A page to work on has the fluids and style all of them share, and its own sheet.
    const page = pageOf(read, 0);
    expect([page.parts.length, page.fluids[0]!.id, page.style.labels, page.sheet]).toEqual([1, "mix", 1.3, sheet]);
    // A reader from before pages reads the first.
    expect(readDrawing({ format: 2, pages: read.pages }).parts.length).toBe(1);
});

test("the editor works on a page at a time, and undo goes back through pages added", () => {
    const { document, regulator, valve } = twoPages();
    const store = new EditorStore(document);
    expect(store.getState().drawing.parts.map((part) => part.id)).toEqual([regulator]);
    store.select([regulator]);
    store.setPage(1);
    expect([store.getState().page, store.getState().selection]).toEqual([1, []]);
    expect(store.getState().drawing.parts.map((part) => part.id)).toEqual([valve]);

    // A change on the second page leaves the first as it was.
    const moved = updatePart(store.getState().drawing, valve, (part) => ({ ...part, x: 500 }));
    store.commit(moved);
    expect(store.getState().document.pages[1]!.parts[0]!.x).toBe(500);
    expect(store.getState().document.pages[0]!.parts[0]!.id).toBe(regulator);

    // A page added is undone as any change is, back to the page it was at.
    const now = store.getState().document;
    const blank = { id: "g-new", name: "Page 3", parts: [], lines: [], sheet: null };
    store.commitDocument({ ...now, pages: [...now.pages, blank] }, 2);
    expect([store.getState().page, store.getState().document.pages.length]).toEqual([2, 3]);
    store.undo();
    expect([store.getState().page, store.getState().document.pages.length]).toEqual([1, 2]);
    store.undo(); // and the move before it, on its page
    expect(store.getState().document.pages[1]!.parts[0]!.x).toBe(300);
    store.redo();
    store.redo();
    expect(store.getState().document.pages.length).toBe(3);

    // Loaded again (as saved, or theirs), it stays at its page, or the last if it has fewer.
    store.load(document);
    expect(store.getState().page).toBe(1);
});

test("find looks through every page, and says which one what it found is on", () => {
    const { document, regulator, valve } = twoPages();
    expect(findInDocument(document, "bv201").map((found) => [found.id, found.page])).toEqual([[valve, 1]]);
    expect(findInDocument(document, "pureg")[0]).toMatchObject({ id: regulator, page: 0 });
    // Of those as good, the ones on the page being worked on come first.
    const both = withPage(document, 1, tagged(pageOf(document, 1), "regulator", "PUREG-2", 600).drawing);
    expect(findInDocument(both, "regulator", 1).map((found) => found.page)).toEqual([1, 0]);
});

test("the parts list covers every page, with each part's page when there's more than one", () => {
    const { document } = twoPages();
    const withConnector = withPage(
        document,
        0,
        addPart(pageOf(document, 0), presetOf("offpage")!, { x: 100, y: 0 }).drawing,
    );
    const rows = partsOf(withConnector);
    expect(
        columnsOf(withConnector, rows, rows)
            .map((column) => column.label)
            .slice(0, 4),
    ).toEqual(["Tag", "What", "Page", "Fluid"]);
    // By what they are (a ball valve, a regulator), not by page; an off-page connector isn't a part to list.
    expect(rows.map((row) => [row.cells.tag, row.page, row.cells.page])).toEqual([
        ["BV-201", 1, "GSE"],
        ["PUREG", 0, "Vehicle"],
    ]);
    expect(partsList(withConnector).split("\r\n")[0]).toMatch(/^Tag,What,Page,Fluid/);
    // One page: no column for it.
    const one = documentOf(example());
    expect(columnsOf(one, partsOf(one), partsOf(one)).map((column) => column.key)).not.toContain("page");
});

test("a page's sheet fits what's on it inside the border, clear of the title block's corner", () => {
    const drawing = example();
    const box = drawingBox(drawing)!;
    const sheet = fitSheet(box, "tabloid", true);
    expect([sheet.paper, sheet.landscape]).toEqual(["tabloid", true]);
    const { paper, frame, corner } = sheetOutline(sheet);
    const { width, height } = paperSize("tabloid", true);
    expect([width, height]).toEqual([1224, 792]);
    expect((paper.x1 - paper.x0) * sheet.scale).toBeCloseTo(1224);
    const inside = (outer: typeof box, inner: typeof box) =>
        inner.x0 >= outer.x0 - 1e-6 &&
        inner.y0 >= outer.y0 - 1e-6 &&
        inner.x1 <= outer.x1 + 1e-6 &&
        inner.y1 <= outer.y1 + 1e-6;
    expect(inside(frame, box)).toBe(true);
    const overlaps = box.x1 > corner.x0 && box.x0 < corner.x1 && box.y1 > corner.y0 && box.y0 < corner.y1;
    expect(overlaps).toBe(false);
});

test("a PDF of the pages has a page for each: on its own sheet's paper where it has one, sheet n of m", async () => {
    const { document } = twoPages();
    const first = pageOf(document, 0);
    const fixed = { paper: "letter", landscape: false, x: -300, y: -400, scale: 0.75 };
    const sheet = { project: "Vespula", diagram: 4, revisions: [], titleBlock: true };
    const blob = await pdfOfPages(
        [
            { drawing: first, meta: { ...META, sheet: "1 OF 2" }, sheet },
            { drawing: { ...pageOf(document, 1), sheet: fixed }, meta: { ...META, sheet: "2 OF 2" }, sheet },
        ],
        "tabloid",
    );
    const text = latin1(new Uint8Array(await blob.arrayBuffer()));
    expect(text).toMatch(/\/Type \/Pages \/Kids \[\d+ 0 R \d+ 0 R\] \/Count 2/);
    // The first fitted on the paper chosen; the second on its own, letter, upright.
    expect([...text.matchAll(/\/MediaBox \[0 0 (\d+) (\d+)\]/g)].map((match) => `${match[1]}x${match[2]}`)).toEqual([
        "1224x792",
        "612x792",
    ]);
    const contents = await Promise.all(
        [...text.matchAll(/FlateDecode >>\nstream\n/g)].map(async (match) => {
            const start = match.index + match[0].length;
            const bytes = Uint8Array.from(text.slice(start, text.indexOf("\nendstream", start)), (char) =>
                char.charCodeAt(0),
            );
            return inflate(bytes);
        }),
    );
    expect(contents[0]).toContain("(1 OF 2) Tj");
    expect(contents[1]).toContain("(2 OF 2) Tj");
    // Where its sheet says: at its scale, its paper's corner at the sheet's point.
    expect(contents[1]).toContain("0.75 0 0 0.75 225 300 cm");
});

test("a Visio drawing's pages are one diagram's, their fluids shared, one for each color", () => {
    const page = (name: string, color: string): ImportedPage => {
        const added = addPart(emptyDrawing(), presetOf("tank")!, { x: 0, y: 0 });
        const drawing = updatePart(
            { ...added.drawing, fluids: [{ id: "red-lines", name: "Red lines", label: "", color }] },
            added.id,
            (part) => ({ ...part, props: { ...part.props, fluid: "red-lines" } }),
        );
        return {
            name,
            page: name,
            drawing,
            report: { page: name, parts: 1, lines: 0, notes: 0, figures: 0, drawn: [], dropped: 0 },
        };
    };
    const document = visioDocument([page("Vehicle", "#ff0000"), page("Stand", "#ff0000"), page("GSE", "#cc0000")]);
    expect(document.pages.map((entry) => entry.name)).toEqual(["Vehicle", "Stand", "GSE"]);
    expect(document.fluids.map((fluid) => [fluid.id, fluid.color])).toEqual([
        ["red-lines", "#ff0000"],
        ["red-lines-2", "#cc0000"],
    ]);
    expect(document.pages.map((entry) => entry.parts[0]!.props.fluid)).toEqual([
        "red-lines",
        "red-lines",
        "red-lines-2",
    ]);
});

test("a part placed on a page is numbered after the tags on the others, and warned of one it shares", () => {
    const { document } = twoPages();
    const vehicle = pageOf(document, 0);
    expect(vehicle.elsewhere).toEqual(["BV-201"]);
    const added = addPart(vehicle, presetOf("ball-valve")!, { x: 0, y: 200 });
    expect(added.drawing.parts.find((part) => part.id === added.id)!.tag).toBe("BV-202");
    const clash = updatePart(added.drawing, added.id, (part) => ({ ...part, tag: "bv-201" }));
    expect(sharedTags(clash).has("BV-201")).toBe(true);
    // What's on the other pages isn't saved with the page.
    expect(JSON.stringify(withPage(document, 0, clash))).not.toContain("elsewhere");
});

test("a part drawn again on a combined page is pasted as a copy: its tag kept, and listed once", () => {
    const { document, regulator, valve } = twoPages();
    // The two pages drawn again on a third, the combined schematic: what's copied from each pasted onto it.
    let combined = withPage(
        { ...document, pages: [...document.pages, { ...documentOf(emptyDrawing(), "Combined").pages[0]! }] },
        2,
        emptyDrawing(),
    );
    for (const [index, id] of [
        [0, regulator],
        [1, valve],
    ] as const) {
        const clip = copyItems(pageOf(combined, index), new Set([id]))!;
        combined = withPage(combined, 2, pasteClip(pageOf(combined, 2), clip, { x: 0, y: 200 }).drawing);
    }
    const copies = combined.pages[2]!.parts;
    expect(copies.map((part) => [part.tag, part.unlisted])).toEqual([
        ["PUREG", true],
        ["BV-201", true],
    ]);
    // Listed once each, from the pages they print on; the copies counted as left out, and not warned of.
    expect(partsOf(combined).map((row) => [row.cells.tag, row.cells.page])).toEqual([
        ["BV-201", "GSE"],
        ["PUREG", "Vehicle"],
    ]);
    expect(leftOutOf(combined)).toBe(2);
    expect(sharedTags(pageOf(combined, 2)).size).toBe(0);
    expect(sharedTags(pageOf(combined, 0)).size).toBe(0);
    expect(partsList(combined).split("\r\n").filter(Boolean)).toHaveLength(3);

    // Kept as saved, and read back.
    expect(readDocument(JSON.parse(JSON.stringify(combined))).pages[2]!.parts.every((part) => part.unlisted)).toBe(
        true,
    );

    // Pasted again on the page that has it, it's a part of its own: numbered anew, and listed.
    const page = pageOf(combined, 2);
    const again = pasteClip(page, copyItems(page, new Set([copies[1]!.id]))!, { x: 0, y: 400 });
    const pasted = again.drawing.parts.find((part) => part.id === again.ids[0])!;
    expect([pasted.tag, pasted.unlisted]).toEqual(["BV-202", undefined]);

    // Put back in the list, a copy is a part listed twice, and warned of; left out again, it's not.
    const both = listParts(page, new Set([copies[1]!.id]), true);
    expect(both.parts[1]!.unlisted).toBeUndefined();
    expect(sharedTags(both).has("BV-201")).toBe(true);
    expect(partsOf(withPage(combined, 2, both)).map((row) => row.cells.tag)).toEqual(["BV-201", "BV-201", "PUREG"]);
    expect(listParts(both, new Set([copies[1]!.id]), false).parts[1]!.unlisted).toBe(true);
});

test("a part pasted onto another page whose tag that page has already is numbered anew, as before", () => {
    const { document, valve } = twoPages();
    const vehicle = tagged(pageOf(document, 0), "ball-valve", "BV-201", 300).drawing;
    const clip = copyItems(pageOf(document, 1), new Set([valve]))!;
    const pasted = pasteClip(vehicle, clip, { x: 0, y: 200 });
    const part = pasted.drawing.parts.find((each) => each.id === pasted.ids[0])!;
    expect([part.tag, part.unlisted]).toEqual(["BV-202", undefined]);
});
