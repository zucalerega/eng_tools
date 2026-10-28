import { expect, test } from "vitest";
import { documentOf, emptyDrawing, type Drawing, type Part } from "../src/piper/drawing";
import { addPart, connect, updatePart } from "../src/piper/edit";
import { presetOf } from "../src/piper/library/index";
import { columnsOf, csvOf, partsList, partsOf, sortRows } from "../src/piper/parts";

// A diagram's parts list (parts.ts): what's a part to list, the fluids on each, its columns, its order, and its CSV.

function drawingOf(): { drawing: Drawing; ids: Record<string, string> } {
    let drawing = emptyDrawing();
    const ids: Record<string, string> = {};
    const place = (name: string, preset: string, x: number, y: number, change: Partial<Part> = {}) => {
        const added = addPart(drawing, presetOf(preset)!, { x, y });
        drawing = updatePart(added.drawing, added.id, (part) => ({
            ...part,
            ...change,
            props: { ...part.props, ...change.props },
        }));
        ids[name] = added.id;
    };
    place("tank", "tank", 0, 0, { props: { fluid: "lox", mawp: "500 psi" } });
    place("valve", "ball-valve", 200, -30, { props: { mawp: "3000 psi", notes: "Hand, at the stand" } });
    place("sensor", "pressure-transducer", 200, 200, { props: { channel: "P_OX", range: "0-1000 psi" } });
    place("note", "text", 400, 400);
    const pipe = connect(drawing, { part: ids.tank!, port: "right-upper" }, { part: ids.valve!, port: "a" })!;
    drawing = { ...pipe.drawing, lines: pipe.drawing.lines.map((line) => ({ ...line, fluid: "gn2", tag: "L-1" })) };
    return { drawing, ids };
}

test("the parts list has each part, with the fluids on it, and not its lines or what's only written on it", () => {
    const { drawing } = drawingOf();
    const document = documentOf(drawing);
    const rows = partsOf(document);
    expect(rows.map((row) => [row.cells.tag, row.category, row.cells.fluids])).toEqual([
        ["BV-1", "valves", "GN2"], // what its line carries
        ["TK-1", "vessels", "LOX, GN2"], // what it holds, and what its line does
        ["PT-1", "instruments", ""],
    ]);
    const columns = columnsOf(document, rows, rows);
    expect(columns.map((column) => column.label)).toEqual([
        "Tag",
        "What",
        "Fluid",
        // Not its body, nor what an instrument measures: that's in what each is (a ball valve, a pressure transducer).
        "Actuation",
        "MAWP",
        "Model", // said of none, but every part has one
        "Range",
        "Test channel", // one's been given that isn't its tag
        "Notes",
    ]);
    // Narrowed to the sensor: its own columns, and the specs every part has.
    const sensor = rows.filter((row) => row.category === "instruments");
    expect(columnsOf(document, rows, sensor).map((column) => column.label)).toEqual([
        "Tag",
        "What",
        "Fluid",
        "MAWP",
        "Model",
        "Range",
        "Test channel",
    ]);
});

test("sorted by a column, numbers sort as numbers, and what has nothing in it is last either way", () => {
    const { drawing } = drawingOf();
    const rows = partsOf(documentOf(drawing));
    const order = (key: string, descending: boolean) => sortRows(rows, { key, descending }).map((row) => row.cells.tag);
    expect(order("mawp", false)).toEqual(["TK-1", "BV-1", "PT-1"]); // 500 psi, then 3000 psi; the sensor says none
    expect(order("mawp", true)).toEqual(["BV-1", "TK-1", "PT-1"]);
    expect(sortRows(rows, null).map((row) => row.cells.tag)).toEqual(["BV-1", "TK-1", "PT-1"]);
});

test("the parts list's CSV has its columns, quoted where a cell has to be", () => {
    const { drawing } = drawingOf();
    const document = documentOf(drawing);
    const text = partsList(document);
    const [head, ...lines] = text.trimEnd().split("\r\n");
    expect(head).toBe("Tag,What,Fluid,Actuation,MAWP,Model,Range,Test channel,Notes");
    expect(lines[1]).toBe('TK-1,Tank,"LOX, GN2",,500 psi,,,,');
    expect(lines).toHaveLength(3); // no line, nor the note
    const rows = partsOf(document);
    expect(csvOf([{ key: "notes", label: "Notes" }], rows.slice(0, 1))).toBe('Notes\r\n"Hand, at the stand"\r\n');
});
