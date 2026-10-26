import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LIGHT } from "../src/piper/colors";
import { emptyDrawing, isPortEnd, newLine, newPart, type Part } from "../src/piper/drawing";
import { example } from "../src/piper/example";
import { svgOf } from "../src/piper/exports";
import { fluidsOf, fluidsUsed, STANDARD_FLUIDS, withFluid } from "../src/piper/fluids";
import { OPPOSITE } from "../src/piper/geometry";
import { PartIcon, presetPart } from "../src/piper/icons";
import { labelPlace, partLabel } from "../src/piper/labels";
import { ALL_KINDS, boxOf, kindOf, PRESETS, searchPresets, titleOf } from "../src/piper/library/index";
import { BODY } from "../src/piper/library/valves";
import { textWidth } from "../src/piper/pdf";
import { partsById, pathOf, portsOf } from "../src/piper/ports";

// The parts library, held to what the editor relies on: ports on the grid, at a part's edge, with ids of their own,
// inline parts' two ports facing apart, and every entry's kind known.

/** Each kind as it can be set up: a valve with each body and actuation, and each library entry. */
function variants() {
    const parts = PRESETS.map(presetPart);
    for (const body of BODY.options!) {
        for (const actuation of ["", "manual", "solenoid", "pneumatic", "motor"]) {
            parts.push(newPart("valve", { x: 0, y: 0 }, { props: { body: body.value, actuation } }));
        }
    }
    return parts;
}

test("every library entry is of a kind the library has", () => {
    for (const preset of PRESETS) {
        expect(kindOf(preset.kind).id, preset.id).toBe(preset.kind);
    }
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length);
    expect(new Set(ALL_KINDS.map((kind) => kind.id)).size).toBe(ALL_KINDS.length);
});

test("ports sit on the grid, at their part's edge, each with an id of its own", () => {
    const drawing = example();
    for (const part of variants()) {
        const kind = kindOf(part.kind);
        const ports = kind.ports(part);
        const [x0, y0, x1, y1] = kind.box(part, drawing);
        const name = `${part.kind} ${JSON.stringify(part.props)}`;
        expect(new Set(ports.map((port) => port.id)).size, name).toBe(ports.length);
        for (const port of ports) {
            expect(port.x % 10 === 0 && port.y % 10 === 0, `${name} ${port.id} is off the grid`).toBe(true);
            expect(port.inset, `${name} ${port.id}`).toBeGreaterThanOrEqual(0);
            // Not inside its box (a route leaves it from there), but for a junction's, which is its middle.
            const inside = port.x > x0 && port.x < x1 && port.y > y0 && port.y < y1;
            expect(inside && !port.many, `${name} ${port.id} is inside its box`).toBe(false);
        }
    }
});

/** A part as the library draws it: its symbol's markup. */
function drawn(part: Part): Document {
    const markup = renderToStaticMarkup(createElement(PartIcon, { part, palette: LIGHT }));
    return new DOMParser().parseFromString(markup, "image/svg+xml");
}

const words = (symbol: Document) => Array.from(symbol.querySelectorAll("text"), (text) => text.textContent);

test("an instrument is a bubble with the letter of what it measures in it, whatever its tag, its tag at its side", () => {
    const drawing = emptyDrawing();
    const sensor = (props: Record<string, string>, tag = "PT-101") =>
        newPart("instrument", { x: 0, y: 0 }, { tag, props });
    const one = drawn(sensor({ type: "pressure" }));
    expect(Array.from(one.querySelectorAll("circle"), (circle) => circle.getAttribute("r"))).toEqual(["15"]);
    expect(one.querySelector("rect")).toBeNull();
    expect(words(one)).toEqual(["P"]); // what it measures: its tag is beside it
    // Whatever its tag says: a name, another sensor's letters, or none.
    for (const [type, tag, letter] of [
        ["pressure", "CHAMBER-1", "P"],
        ["temperature", "PT-5", "T"],
        ["temperature", "TC-OX-1", "T"],
        ["rtd", "RTD-2", "T"],
        ["force", "LC-1", "W"],
        ["flow", "Fuel flow", "F"],
        ["dp", "DPT-1", "PD"],
        ["pressure", "101", "P"],
        ["other", "XV-1", "X"], // no kind of its own: its tag's first letter
        ["other", "101", "?"],
    ] as const) {
        expect(words(drawn(sensor({ type }, tag))), `${type} tagged ${tag}`).toEqual([letter]);
    }
    // Its whole tag is its label, at its right, level with its middle.
    const part = sensor({ type: "pressure" });
    const box = boxOf(part, drawing);
    expect(partLabel(drawing, part)).toEqual([{ text: "PT-101", tag: true }]);
    const place = labelPlace(part, box, 8, { ...drawing, parts: [part] });
    expect(place.anchor).toBe("start");
    expect(place.at.x).toBeGreaterThan(box.x1);
    expect(Math.abs(place.at.y - part.y)).toBeLessThan(5);
    // Tapped from its right, as beside a tank to its right: its tag's at its left, off the line.
    const tapped = { ...drawing, parts: [part], lines: [newLine({ part: part.id, port: "right" }, { x: 100, y: 0 })] };
    const left = labelPlace(part, box, 8, tapped);
    expect(left.anchor).toBe("end");
    expect(left.at.x).toBeLessThan(box.x0);
    // Two or three on one tap: bubbles side by side, A, B, and C, their side taps still on the grid.
    const three = drawn(sensor({ type: "pressure", count: "3" }));
    expect(three.querySelectorAll("circle")).toHaveLength(3);
    expect(words(three)).toEqual(["P", "A", "P", "B", "P", "C"]);
    for (const [count, side] of [
        ["2", 40],
        ["3", 50],
    ] as const) {
        const ports = kindOf("instrument").ports(sensor({ type: "pressure", count }));
        expect(ports.find((port) => port.id === "right")?.x).toBe(side);
        expect(ports.find((port) => port.id === "left")?.x).toBe(-side);
    }
    expect(titleOf(sensor({ type: "pressure", count: "3" }))).toBe("Triplicated pressure transducer");
});

test("solenoid, pneumatic, and motorized valves have the same box on their stems, with S, P, or M in it", () => {
    for (const [actuation, letter] of [
        ["solenoid", "S"],
        ["pneumatic", "P"],
        ["motor", "M"],
    ] as const) {
        const valve = newPart("valve", { x: 0, y: 0 }, { props: { body: "ball", actuation } });
        const symbol = drawn(valve);
        const boxes = Array.from(symbol.querySelectorAll("rect"), (rect) =>
            ["x", "y", "width", "height"].map((key) => rect.getAttribute(key)),
        );
        expect(boxes, actuation).toEqual([["-6", "-26", "12", "12"]]);
        expect(words(symbol), actuation).toEqual([letter]);
        expect(kindOf("valve").box(valve, emptyDrawing())[1], actuation).toBe(-26);
    }
});

test("valves come without their state written beside them: their color says it", () => {
    for (const preset of PRESETS.filter((entry) => kindOf(entry.kind).state)) {
        expect(preset.shown ?? [], preset.id).not.toContain("normal");
    }
});

test("every part that holds pressure lists its MAWP, and a vessel its MEOP beside it", () => {
    const holds = ["valve", "angle", "valve3", "check", "relief", "regulator", "burst", "qd", "orifice", "venturi"];
    holds.push("flowmeter", "filter", "instrument", "gauge", "cap", "reducer", "hose", "engine", "pump", "exchanger");
    for (const id of [...holds, "tank", "sphere", "bottle", "dewar"]) {
        expect(
            kindOf(id).fields.map((field) => field.key),
            id,
        ).toContain("mawp");
    }
    for (const id of ["tank", "sphere", "bottle", "dewar"]) {
        expect(
            kindOf(id).fields.map((field) => field.key),
            id,
        ).toContain("meop");
    }
});

test("parts that go into a line have two ports facing apart across their middle", () => {
    for (const kind of ALL_KINDS.filter((entry) => entry.inline)) {
        const part = newPart(kind.id, { x: 0, y: 0 });
        const [a, b] = kind.inline!.map((id) => kind.ports(part).find((port) => port.id === id)!);
        expect(a && b, kind.id).toBeTruthy();
        expect([a!.y, b!.y], kind.id).toEqual([0, 0]);
        expect(a!.dir && b!.dir && OPPOSITE[a!.dir] === b!.dir, kind.id).toBe(true);
        expect(a!.x, kind.id).toBe(-b!.x);
    }
});

test("each kind's fields have keys of their own", () => {
    for (const kind of ALL_KINDS) {
        expect(new Set(kind.fields.map((field) => field.key)).size, kind.id).toBe(kind.fields.length);
    }
});

test("a library entry's part is called what the library calls it", () => {
    for (const preset of PRESETS.filter((entry) => entry.kind !== "junction")) {
        expect(titleOf(presetPart(preset)), preset.id).toBe(preset.name);
    }
});

test("the library finds parts by any of their names", () => {
    const names = (text: string) => searchPresets(text).map((preset) => preset.name);
    expect(names("copv")).toEqual(["COPV"]);
    expect(names("prv")).toEqual(["Relief valve"]);
    expect(names("MOV")).toContain("Motorized ball valve");
    expect(names("cav")).toContain("Cavitating venturi");
    expect(names("thermo")).toEqual(["Thermocouple"]);
    expect(names("rupture disk")).toEqual(["Burst disc"]);
    expect(names("")).toHaveLength(PRESETS.length);
    expect(names("nothing by this name")).toEqual([]);
});

test("the standard fluids each have an id, a label, and a color of their own", () => {
    expect(new Set(STANDARD_FLUIDS.map((fluid) => fluid.id)).size).toBe(STANDARD_FLUIDS.length);
    for (const fluid of STANDARD_FLUIDS) {
        expect(fluid.color, fluid.id).toMatch(/^#[0-9a-f]{6}$/);
        expect(fluid.label, fluid.id).not.toBe("");
    }
});

test("a diagram keeps only the fluids it changed, and its own", () => {
    const drawing = example();
    const lox = fluidsOf(drawing).find((fluid) => fluid.id === "lox")!;
    const changed = withFluid(drawing, { ...lox, color: "#0000ff" });
    expect(changed).toEqual([{ ...lox, color: "#0000ff" }]);
    expect(withFluid({ ...drawing, fluids: changed }, lox)).toEqual([]); // back to the standard one: nothing kept
});

test("the example is a whole system: every line's ends on ports, every part tagged once, every line orthogonal", () => {
    const drawing = example();
    const parts = partsById(drawing);
    for (const line of drawing.lines) {
        for (const end of [line.from, line.to]) {
            expect(isPortEnd(end), line.id).toBe(true);
            if (isPortEnd(end)) {
                const port = portsOf(parts.get(end.part)!).find((entry) => entry.id === end.port);
                expect(port, `${line.id} ${end.part}.${end.port}`).toBeTruthy();
            }
        }
        const path = pathOf(parts, line);
        expect(
            path.every(
                (point, index) => index === 0 || point.x === path[index - 1]!.x || point.y === path[index - 1]!.y,
            ),
            line.id,
        ).toBe(true);
    }
    const tags = drawing.parts.map((part) => part.tag).filter(Boolean);
    expect(new Set(tags).size).toBe(tags.length);
    expect(fluidsUsed(drawing).map((fluid) => fluid.id)).toEqual(["gn2", "gox", "rp1", "lox"]);
});

test("an off-page connector's words fit inside it, however long the page's name it goes to", async () => {
    const meta = { name: "Feed system", revision: "1", savedAt: null, by: "" };
    for (const words of ["TO GSE", "TO PAGE 1", "TO GROUND", "TO VEHICLE STAND"]) {
        const part = newPart("offpage", { x: 0, y: 0 }, { text: words });
        const { svg } = await svgOf({ ...emptyDrawing(), parts: [part] }, meta);
        const size = Number(new RegExp(`font-size="([\\d.]+)"[^>]*>${words}<`).exec(svg)![1]);
        // Inside its box, to its point (12 across), clear of its ink; and as big as a short one's.
        const [, , right] = kindOf("offpage").box(part, emptyDrawing());
        expect(textWidth(words, true) * size, words).toBeLessThanOrEqual(right - 12 + 30 - 4);
        expect(size, words).toBe(9);
    }
});
