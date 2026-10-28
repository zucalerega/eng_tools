import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LIGHT } from "../src/piper/colors";
import { DiagramView } from "../src/piper/DiagramView";
import { emptyDrawing, isPortEnd, newLine, newPart, type Part } from "../src/piper/drawing";
import { updatePart } from "../src/piper/edit";
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
import type { ValveState } from "../src/piper/testdata";

const META = { name: "Feed system", revision: "1", savedAt: null, by: "" };

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

test("a part drawn at any size keeps its ports apart: on the grid where they can be, off it only to stay apart", () => {
    for (const scale of [0.25, 0.3, 0.45, 0.5, 0.75, 1.5, 2.35, 4]) {
        for (const part of variants()) {
            const placed = portsOf({ ...part, scale });
            const name = `${part.kind} ${JSON.stringify(part.props)} at ${scale}`;
            expect(new Set(placed.map((port) => `${port.at.x},${port.at.y}`)).size, name).toBe(placed.length);
            // Drawn bigger, its ports are never close enough to meet on the grid: every one is on it.
            if (scale >= 1.5) {
                expect(
                    placed.every((port) => port.at.x % 10 === 0 && port.at.y % 10 === 0),
                    name,
                ).toBe(true);
            }
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

/** Where a symbol's flow arrows start: each arrow's line (not its head, which is filled), by its first point. */
const arrowStarts = (symbol: Document) =>
    Array.from(symbol.querySelectorAll('path[fill="none"]'), (path) => path.getAttribute("d") ?? "")
        .filter((d) => /^M-?[\d.]+ -?15 L/.test(d))
        .map((d) => d.split(" L")[0]);

/** The positions tinted in a state's color: their boxes' left edges, and the color. */
const tinted = (symbol: Document) =>
    Array.from(symbol.querySelectorAll("rect[fill-opacity]"), (rect) => [
        rect.getAttribute("x"),
        rect.getAttribute("fill"),
    ]);

test("3/2 and 5/2 solenoid valves are drawn as ISO 1219 draws them, their ports on the position they rest in", () => {
    const valve = (kind: string, props: Record<string, string> = {}) => newPart(kind, { x: 0, y: 0 }, { props });
    // A 3/2: its supply (1) and exhaust (3) below the box by its spring, what it feeds (2) above.
    const ports = (part: Part) =>
        kindOf(part.kind)
            .ports(part)
            .map((port) => [port.id, port.x, port.y, port.dir]);
    expect(ports(valve("valve32"))).toEqual([
        ["1", 10, 20, "down"],
        ["2", 10, -20, "up"],
        ["3", 30, 20, "down"],
    ]);
    // Normally closed, it rests with 2 exhausted to 3 (1 shut), and its solenoid joins 1 to 2; normally open, the
    // other way round. The position it rests in (0 to 40, by the spring) is in its normal state's color.
    const closed = drawn(valve("valve32", { normal: "NC" }));
    expect(arrowStarts(closed)).toEqual(["M-30 15", "M10 -15"]);
    expect(tinted(closed)).toEqual([["0", LIGHT.nc]]);
    const open = drawn(valve("valve32", { normal: "NO" }));
    expect(arrowStarts(open)).toEqual(["M-30 -15", "M10 15"]);
    expect(tinted(open)).toEqual([["0", LIGHT.no]]);
    expect(tinted(drawn(valve("valve32")))).toEqual([]); // no normal state, no color
    // A 5/2: 1 below the middle, 2 and 4 above, 3 and 5 below. At rest 1 feeds 2 and 4 exhausts by 5; worked, 1 feeds
    // 4 and 2 exhausts by 3. It has no normal state.
    expect(ports(valve("valve52"))).toEqual([
        ["1", 20, 20, "down"],
        ["2", 30, -20, "up"],
        ["3", 30, 20, "down"],
        ["4", 10, -20, "up"],
        ["5", 10, 20, "down"],
    ]);
    expect(arrowStarts(drawn(valve("valve52")))).toEqual(["M-20 15", "M-10 -15", "M20 15", "M10 -15"]);
    expect(kindOf("valve52").fields.map((field) => field.key)).not.toContain("normal");
    // Their tags go under their solenoids' ends, clear of the lines from their ports.
    const part = newPart("valve32", { x: 100, y: 50 }, { tag: "SV-1" });
    const box = boxOf(part, emptyDrawing());
    const place = labelPlace(part, box, 8);
    expect([place.at.x, place.at.y > box.y1, place.anchor]).toEqual([80, true, "middle"]);
});

test("a part sent to the back is drawn under the lines, its tag still over everything", () => {
    const valve = newPart("valve", { x: 0, y: 0 }, { tag: "BV-1" });
    const tank = newPart("tank", { x: 200, y: 0 }, { tag: "TK-1" });
    const pipe = newLine({ part: valve.id, port: "b" }, { part: tank.id, port: "left-upper" });
    const order = (parts: Part[]) => {
        const markup = renderToStaticMarkup(
            createElement(
                "svg",
                null,
                createElement(DiagramView, {
                    drawing: { ...emptyDrawing(), parts, lines: [pipe] },
                    palette: LIGHT,
                    meta: META,
                }),
            ),
        );
        const drawn = new DOMParser().parseFromString(markup, "image/svg+xml");
        // What's drawn, in its order: parts (each placed by its transform), lines (drawn where they are), and tags.
        return Array.from(drawn.querySelectorAll("g.piper-drawing > *"), (element) =>
            element.tagName === "text"
                ? `tag ${element.textContent}`
                : element.hasAttribute("transform")
                  ? "part"
                  : "line",
        );
    };
    expect(order([valve, tank])).toEqual(["line", "part", "part", "tag BV-1", "tag TK-1"]);
    expect(order([{ ...tank, back: true }, valve])).toEqual(["part", "line", "part", "tag TK-1", "tag BV-1"]);
});

test("a test's state tints the position it puts a directional valve in", () => {
    const valve = newPart("valve32", { x: 0, y: 0 }, { tag: "SV-1", props: { normal: "NC" } });
    const drawing = { ...emptyDrawing(), parts: [valve] };
    const shown = (state: ValveState) => {
        const live = new Map([[valve.id, { text: state, state, missing: false }]]);
        const markup = renderToStaticMarkup(
            createElement("svg", null, createElement(DiagramView, { drawing, palette: LIGHT, meta: META, live })),
        );
        return tinted(new DOMParser().parseFromString(markup, "image/svg+xml"));
    };
    // Open, a normally closed one's solenoid has it feeding (the position by it, -40 to 0); closed, it's at rest.
    expect(shown("open")).toEqual([["-40", LIGHT.no]]);
    expect(shown("closed")).toEqual([["0", LIGHT.nc]]);
    expect(shown("other")).toEqual([
        ["-40", LIGHT.other],
        ["0", LIGHT.other],
    ]);
});

test("a manifold has as many outlets as it's set to, and a line on one taken away stays, ending where it was", () => {
    const manifold = newPart("manifold", { x: 0, y: 0 }, { tag: "MAN-1", props: { outlets: "6" } });
    const ids = (part: Part) =>
        kindOf(part.kind)
            .ports(part)
            .map((port) => port.id);
    expect(ids(newPart("manifold", { x: 0, y: 0 }))).toEqual(["in", "end", "1", "2", "3", "4"]); // 4 until it's set
    expect(ids(manifold)).toEqual(["in", "end", "1", "2", "3", "4", "5", "6"]);
    // Its outlets along its top, 20 apart, on the grid; its supply at one end and its far end at the other.
    const outlets = portsOf(manifold).filter((port) => /^\d$/.test(port.id));
    expect(outlets.map((port) => [port.at.x, port.at.y, port.dir])).toEqual(
        [-50, -30, -10, 10, 30, 50].map((x) => [x, -10, "up"]),
    );
    expect(
        portsOf(manifold)
            .filter((port) => !/^\d$/.test(port.id))
            .map((port) => port.at),
    ).toEqual([
        { x: -70, y: 0 },
        { x: 70, y: 0 },
    ]);
    const first = newLine({ part: manifold.id, port: "1" }, { x: -50, y: -60 });
    const last = newLine({ part: manifold.id, port: "6" }, { x: 50, y: -60 });
    const drawing = { ...emptyDrawing(), parts: [manifold], lines: [first, last] };
    const fewer = updatePart(drawing, manifold.id, (part) => ({ ...part, props: { ...part.props, outlets: "2" } }));
    expect(fewer.lines.find((line) => line.id === first.id)!.from).toEqual({ part: manifold.id, port: "1" });
    expect(fewer.lines.find((line) => line.id === last.id)!.from).toEqual({ x: 50, y: -10 });
    // Its outlets are a choice of 2 to 8, 4 as it starts.
    const field = kindOf("manifold").fields.find((entry) => entry.key === "outlets")!;
    expect(field.options!.map((option) => option.label)).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
});

test("a pump stands on its base with its tag under it, and a vent is the spray of what it lets go", () => {
    const pump = newPart("pump", { x: 0, y: 0 }, { tag: "P-1" });
    const box = boxOf(pump, emptyDrawing());
    const place = labelPlace(pump, box, 8);
    expect([place.at.x, place.at.y > box.y1]).toEqual([0, true]);
    // Its ports where they were, so a pump on a drawing from before keeps its lines where they were.
    expect(
        kindOf("pump")
            .ports(pump)
            .map((port) => [port.id, port.x, port.y]),
    ).toEqual([
        ["in", -20, 0],
        ["out", 20, -20],
    ]);
    // The vent: three dashed rays from where its line ends, and nothing else, whether it's tagged or not.
    for (const tag of ["", "OVNT"]) {
        const vent = newPart("vent", { x: 0, y: 0 }, { tag });
        const symbol = drawn(vent);
        const paths = Array.from(symbol.querySelectorAll("*"), (element) => element.tagName).filter(
            (name) => name !== "svg",
        );
        expect(paths, tag).toEqual(["path"]);
        expect(symbol.querySelector("path")!.getAttribute("d")!.match(/M/g), tag).toHaveLength(3);
        expect(symbol.querySelector("path")!.getAttribute("stroke-dasharray"), tag).toBeTruthy();
        expect(portsOf(vent)[0]!.edge, tag).toEqual({ x: 0, y: 0 }); // its line's drawn on to the spray
    }
});

test("every part that holds pressure lists its MAWP, and a vessel its MEOP beside it", () => {
    const holds = ["valve", "angle", "valve3", "check", "relief", "regulator", "burst", "qd", "orifice", "venturi"];
    holds.push("flowmeter", "filter", "instrument", "gauge", "cap", "reducer", "hose", "engine", "pump", "exchanger");
    holds.push("valve32", "valve52", "diffuser", "manifold");
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
    expect(names("3x2")).toEqual(["3/2 solenoid valve"]);
    expect(names("5/2")).toEqual(["5/2 solenoid valve"]);
    expect(names("diffuser")).toEqual(["Diffuser"]);
    expect(names("manifold")).toEqual(["Manifold"]);
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
