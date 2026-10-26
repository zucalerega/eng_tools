import { expect, test } from "vitest";
import { emptyDrawing, type Drawing } from "../src/piper/drawing";
import { addPart, connect, updatePart } from "../src/piper/edit";
import { findOnDrawing } from "../src/piper/find";
import { presetOf } from "../src/piper/library/index";

// Finding what's on a drawing by its tag, or what it is: the best match first.

function drawingWith(): { drawing: Drawing; ids: Record<string, string> } {
    let drawing = emptyDrawing();
    const ids: Record<string, string> = {};
    for (const [preset, tag, x] of [
        ["regulator", "PUREG", 0],
        ["pressure-transducer", "PT-101", 100],
        ["pressure-transducer", "PT-1010", 200],
        ["tank", "TK-1", 300],
    ] as const) {
        const added = addPart(drawing, presetOf(preset)!, { x, y: 0 });
        drawing = updatePart(added.drawing, added.id, (part) => ({ ...part, tag }));
        ids[tag] = added.id;
    }
    drawing = updatePart(drawing, ids["TK-1"]!, (part) => ({ ...part, props: { ...part.props, fluid: "lox" } }));
    const line = connect(drawing, { part: ids.PUREG!, port: "b" }, { x: 0, y: 200 })!;
    drawing = { ...line.drawing, lines: line.drawing.lines.map((entry) => ({ ...entry, tag: "L-7", fluid: "rp1" })) };
    ids["L-7"] = line.id;
    return { drawing, ids };
}

test("a tag's found whatever its case, and with or without its dashes and spaces", () => {
    const { drawing, ids } = drawingWith();
    for (const search of ["PUREG", "pureg", " Pu Reg "]) {
        expect(findOnDrawing(drawing, search)[0]?.id, search).toBe(ids.PUREG);
    }
    // The tag that's it first, then those it begins.
    expect(findOnDrawing(drawing, "pt101").map((found) => found.tag)).toEqual(["PT-101", "PT-1010"]);
    expect(findOnDrawing(drawing, "")).toEqual([]);
});

test("a part's found by what it is or what it holds, and a line by its tag or fluid", () => {
    const { drawing, ids } = drawingWith();
    expect(findOnDrawing(drawing, "regulator").map((found) => found.id)).toEqual([ids.PUREG]);
    expect(findOnDrawing(drawing, "liquid oxygen").map((found) => found.id)).toEqual([ids["TK-1"]]);
    const line = findOnDrawing(drawing, "L-7")[0]!;
    expect([line.id, line.line, line.what]).toEqual([ids["L-7"], true, "RP-1 line"]);
    expect(findOnDrawing(drawing, "rp-1").some((found) => found.id === ids["L-7"])).toBe(true);
});
