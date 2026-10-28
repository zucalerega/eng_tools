import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { isPortEnd, newPart, type Drawing } from "../src/piper/drawing";
import { partTable } from "../src/piper/exports";
import { figureOf } from "../src/piper/library/figures";
import { kindOf } from "../src/piper/library/index";
import { LIGHT } from "../src/piper/colors";
import { portsOf } from "../src/piper/ports";
import { readVisio, tagIn, VisioError } from "../src/piper/visio";
import { readVsdx, type VisioShape } from "../src/piper/vsdx";
import {
    connector,
    FEED,
    FEED_MASTERS,
    GLUE,
    glued,
    RECTANGLE,
    shape,
    shapeXml,
    vsdx,
    vsdxOf,
    type MasterSpec,
    type ShapeSpec,
} from "./visio";
import { makeZip } from "./zips";

// Visio drawings into Piper's: a .vsdx made here as Visio makes them (a zip of XML: pages, masters, styles, and which
// connector is glued to which shape), read as an upload is.

const read = async (file: Uint8Array<ArrayBuffer>, name = "Drawing.vsdx") => readVisio(new Blob([file]), name);
const byKind = (drawing: Drawing, kind: string) => drawing.parts.filter((part) => part.kind === kind);
const tagged = (drawing: Drawing, tag: string) => drawing.parts.find((part) => part.tag === tag)!;
const everyShape = (shape: VisioShape): VisioShape[] => [shape, ...shape.members.flatMap(everyShape)];

test("a Visio page's shapes become Piper's parts, by their masters' names, tagged with their text", async () => {
    const pages = await read(vsdx(FEED, GLUE), "Feed system.vsdx");
    expect(pages.map((page) => page.name)).toEqual(["Feed system"]); // its background page left out
    const { drawing, report } = pages[0]!;
    const tank = byKind(drawing, "tank")[0]!;
    expect([tank.x, tank.y, tank.props.fluid]).toEqual([200, 350, "lox"]); // a hundred units to the inch; its text, its fluid
    const valve = byKind(drawing, "valve")[0]!;
    expect([valve.tag, valve.props.body, valve.rotation, valve.x, valve.y]).toEqual(["V-1", "gate", 270, 200, 550]);
    const sensor = byKind(drawing, "instrument")[0]!;
    expect([sensor.tag, sensor.props.type]).toEqual(["PT-101", "pressure"]);
    expect(byKind(drawing, "text").map((part) => part.text)).toEqual(["LOX feed"]);
    // A shape Piper has no part for is drawn as Visio drew it: no box of Piper's own.
    const box = byKind(drawing, "figure")[0]!;
    expect(figureOf(box).texts.map((text) => text.lines)).toEqual([["DAQ"]]);
    expect([box.x, box.y, box.w, box.h]).toEqual([800, 350, 100, 60]);
    expect(report).toEqual({ page: "Feed", parts: 3, lines: 4, notes: 1, figures: 1, drawn: [], dropped: 0 });
});

test("connectors become lines between the ports nearest where they were glued, carrying what they say", async () => {
    const { drawing, report } = (await read(vsdx(FEED, GLUE), "Feed system.vsdx"))[0]!;
    expect(report.lines).toBe(4);
    const tank = byKind(drawing, "tank")[0]!;
    const valve = byKind(drawing, "valve")[0]!;
    const sensor = byKind(drawing, "instrument")[0]!;
    const box = byKind(drawing, "figure")[0]!;
    const between = (a: string, b: string) =>
        drawing.lines.find(
            (line) =>
                isPortEnd(line.from) &&
                isPortEnd(line.to) &&
                [line.from.part, line.to.part].sort().join() === [a, b].sort().join(),
        );
    const feed = between(tank.id, valve.id)!;
    expect(feed.from).toEqual({ part: tank.id, port: "bottom" });
    expect(feed.fluid).toBe("lox"); // what the tank it's drawn from holds, before its color
    expect(between(tank.id, sensor.id)!.fluid).toBe("gn2"); // what its text says
    const signal = drawing.lines.find((line) => line.kind === "pneumatic")!;
    expect(signal.from).toEqual({ part: sensor.id, port: "bottom" });
    expect(isPortEnd(signal.to)).toBe(false); // glued to nothing: it ends where it ended
    // Glued to a figure, a line ends on a port of its own there; red, with nothing else to say what it carries, it
    // carries a fluid of the diagram's own, named for its color.
    const red = drawing.lines.find((line) => isPortEnd(line.from) && line.from.part === box.id)!;
    expect(figureOf(box).ports).toEqual([{ id: "p1", x: -50, y: 0, dir: "left" }]);
    expect(drawing.fluids.find((fluid) => fluid.id === red.fluid)).toMatchObject({
        name: "Red lines",
        color: "#ff0000",
    });
});

test("an imported drawing's parts list has its parts, and what's drawn only where it's tagged", async () => {
    const { drawing } = (await read(vsdx(FEED, GLUE)))[0]!;
    const drawn = JSON.stringify({ w: 10, h: 10, paths: [], texts: [], ports: [] });
    const diffuser = newPart("figure", { x: 0, y: 0 }, { tag: "ODIFF", w: 10, h: 10, props: { figure: drawn } });
    const { head, rows } = partTable({ ...drawing, parts: [...drawing.parts, diffuser] });
    // The tank, the valve, the sensor, and the diffuser Piper has no part for: not the box drawn around the DAQ.
    expect(rows.filter((row) => !row.line).map((row) => [row.cells[1], row.cells[2]])).toEqual([
        ["", "Tank"],
        ["V-1", "Gate valve"],
        ["PT-101", "Pressure transducer"],
        ["ODIFF", "Figure"],
    ]);
    expect(head).not.toContain("figure"); // what it draws is no property of it
});

test("connectors glued to a connector tee into it, each at its own junction, and keep their routes", async () => {
    const shapes = [
        valve(1, [1, 5]),
        valve(3, [7, 5]),
        shapeXml(connector(10, [1.2, 5.2], [6.8, 5.2])),
        // Three branches off the main line, the last on the piece of it the second made, one with a bend.
        shapeXml(connector(11, [2.5, 3], [2.5, 5.2])),
        shapeXml(connector(13, [3.5, 3], [3.5, 5.2])),
        shapeXml(
            connector(12, [4, 3.5], [5, 5.2], {
                route: [
                    [4, 4.5],
                    [5, 4.5],
                ],
            }),
        ),
    ].join("");
    const glue = [
        glued(10, "Begin", 1),
        glued(10, "End", 3),
        glued(11, "End", 10),
        glued(12, "End", 10),
        glued(13, "End", 10),
    ].join("");
    const file = vsdxOf({ pages: [{ name: "P", shapes, connects: glue }], masters: [POWERED, ...FEED_MASTERS] });
    const { drawing, report } = (await read(file))[0]!;
    const junctions = byKind(drawing, "junction");
    expect(junctions).toHaveLength(3);
    expect(report.lines).toBe(4); // as Visio has them: the main line, split three times, is still one connector
    expect(drawing.lines).toHaveLength(7);
    for (const junction of junctions) {
        const on = drawing.lines.filter((line) =>
            [line.from, line.to].some((end) => isPortEnd(end) && end.part === junction.id),
        );
        expect(on).toHaveLength(3);
    }
    // The bent branch keeps its bends, on to its junction.
    const bent = drawing.lines.find((line) => !isPortEnd(line.from) && (line.from as { x: number }).x === 400)!;
    expect(bent.points).toEqual([
        { x: 400, y: 400 },
        { x: 500, y: 400 },
    ]);
    expect(bent.auto).toBe(false);
});

test("tags are read as P&IDs write them", () => {
    expect(tagIn("PT 101")).toBe("PT-101");
    expect(tagIn("pt\n101")).toBe("PT-101");
    expect(tagIn("V-12A")).toBe("V-12A");
    expect(tagIn("MOV-OX")).toBe("MOV-OX");
    expect(tagIn("LOX")).toBeNull();
    expect(tagIn("Main oxidizer valve")).toBeNull();
});

test("a drawing Piper can't read says what to do instead", async () => {
    const old = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(readVisio(new Blob([old]), "Stand.vsd")).rejects.toThrow(/save it as a \.vsdx/);
    await expect(readVisio(new Blob(["not a drawing at all"]), "notes.vsdx")).rejects.toBeInstanceOf(VisioError);
    await expect(readVisio(new Blob([makeZip([{ name: "a.txt", contents: "hi" }])]), "a.vsdx")).rejects.toThrow(
        /no pages/,
    );
});

// --- drawn as Visio drew it ------------------------------------------------------------------------------------------

/** A tank as P&IDs draw one with basic shapes: a rounded rectangle, filled, its words in it. */
const TANK = shapeXml({
    id: 1,
    cells: { PinX: 3, PinY: 5, Width: 2, Height: 1, FillForegnd: "#00b050", LineWeight: 0.02 },
    geometry: [
        {
            rows: [
                ["MoveTo", { X: 0.2, Y: 0 }],
                ["LineTo", { X: 1.8, Y: 0 }],
                ["ArcTo", { X: 2, Y: 0.2, A: 0.0586 }],
                ["LineTo", { X: 2, Y: 0.8 }],
                ["ArcTo", { X: 1.8, Y: 1, A: 0.0586 }],
                ["LineTo", { X: 0.2, Y: 1 }],
                ["ArcTo", { X: 0, Y: 0.8, A: 0.0586 }],
                ["LineTo", { X: 0, Y: 0.2 }],
                ["ArcTo", { X: 0.2, Y: 0, A: 0.0586 }],
            ],
        },
    ],
    character: [{ Color: "#ffff00", Style: 1, Size: 0.25 }],
    text: '<cp IX="0"/>COPV\n6000 psi',
});

test("shapes Piper has no part for are drawn as Visio drew them: outlines, fills, dashes, and words", async () => {
    const outline = shapeXml(connector(2, [1, 2], [5, 3], { master: undefined, cells: { LinePattern: 2 } }));
    const dot = shapeXml({
        id: 3,
        cells: { PinX: 8, PinY: 5, Width: 0.5, Height: 0.5, FillForegnd: "#ff0000" },
        geometry: [{ rows: [["Ellipse", { X: 0.25, Y: 0.25, A: 0.5, B: 0.25, C: 0.25, D: 0.5 }]] }],
    });
    const { drawing, report } = (
        await read(vsdxOf({ pages: [{ name: "Vehicle", shapes: TANK + outline + dot }] }))
    )[0]!;
    expect(report).toMatchObject({ parts: 0, lines: 0, figures: 3 });
    const [tank, line, circle] = byKind(drawing, "figure").map((part) => ({ part, figure: figureOf(part) }));
    // A hundred units to the inch, with no valves to go by: the tank's 2 by 1 inches, its corners rounded (curves).
    expect([tank!.part.x, tank!.part.y, tank!.part.w, tank!.part.h]).toEqual([300, 350, 200, 100]);
    expect(tank!.figure.paths).toEqual([
        expect.objectContaining({ fill: "#00b050", stroke: "#000000", width: 2, d: expect.stringMatching(/C.*Z$/) }),
    ]);
    expect(tank!.figure.texts).toEqual([
        expect.objectContaining({ lines: ["COPV", "6000 psi"], size: 25, color: "#ffff00", bold: true }),
    ]);
    // A line joined to nothing and slanted, as a vehicle's outline is: drawn, dashed as it was.
    expect(line!.figure.paths).toEqual([expect.objectContaining({ dash: "6.2 3.1", d: "M-200 50L200 -50" })]);
    expect(circle!.figure.paths[0]!.d.match(/C/g)).toHaveLength(4); // an ellipse, as four curves
    expect(circle!.figure.paths[0]!.fill).toBe("#ff0000");
});

test("a figure draws what it was given, sized as its part is, and nothing a drawing shouldn't have", () => {
    const figure = {
        w: 100,
        h: 50,
        paths: [{ d: "M-50 -25L50 25", stroke: "#000000", width: 2 }, { d: "M0 0 javascript:alert(1)" }],
        texts: [{ x: 0, y: 0, lines: ["COPV"], size: 10, color: "#ffff00" }],
        ports: [{ id: "p1", x: 50, y: 0, dir: "right" }],
    };
    const part = newPart("figure", { x: 0, y: 0 }, { w: 200, h: 50, props: { figure: JSON.stringify(figure) } });
    expect(figureOf(part).paths).toHaveLength(1); // only an outline's own letters and numbers
    const context = {
        ink: LIGHT.ink,
        paper: LIGHT.paper,
        muted: LIGHT.muted,
        fill: null,
        fluid: null,
        fluidLabel: "",
        gas: false,
        pipe: null,
        states: { no: "", nc: "", fip: "" },
        lines: 0,
        drawing: { format: 1, parts: [part], lines: [], fluids: [], style: {} } as unknown as Drawing,
        meta: { name: "", revision: "", savedAt: null, by: "" },
    };
    const svg = renderToStaticMarkup(createElement("svg", null, kindOf("figure").draw(part, context)));
    expect(svg).toContain('transform="scale(2 1)"'); // twice as wide as it was drawn
    expect(svg).toContain(`stroke="${LIGHT.ink}"`); // black drawn in the page's ink
    expect(svg).toContain('fill="#ffff00"');
    // Its port where a line was glued to it, as far out as it now is.
    expect(portsOf(part).map((port) => [port.id, port.at])).toEqual([["p1", { x: 100, y: 0 }]]);
    const garbage = newPart("figure", { x: 0, y: 0 }, { props: { figure: "{not json" } });
    expect(figureOf(garbage)).toEqual({ w: 0, h: 0, paths: [], texts: [], ports: [] });
});

// --- symbols -------------------------------------------------------------------------------------------------------

/**
 * A "Powered valve" as P&ID stencils have it: a group, its own outline a bowtie, its member (6) the actuator's box with
 * its letter (P, unless an instance says otherwise).
 */
const POWERED: MasterSpec = {
    id: 7,
    name: "Powered valve",
    shape: {
        id: 5,
        type: "Group",
        cells: { Width: 0.4, Height: 0.4 },
        geometry: [
            {
                rows: [
                    ["MoveTo", { X: 0, Y: 0.1 }],
                    ["LineTo", { X: 0, Y: 0.3 }],
                    ["LineTo", { X: 0.4, Y: 0.1 }],
                    ["LineTo", { X: 0.4, Y: 0.3 }],
                    ["LineTo", { X: 0, Y: 0.1 }],
                ],
            },
        ],
        connections: [
            [0, 0.2],
            [0.4, 0.2],
        ],
        members: [
            {
                id: 6,
                cells: { PinX: 0.2, PinY: 0.35, Width: 0.1, Height: 0.1 },
                geometry: [RECTANGLE],
                text: '<cp IX="0"/>P',
            },
        ],
    },
};

const valveSpec = (
    id: number,
    at: [number, number],
    options: { letter?: string; cells?: Record<string, string | number> } = {},
): ShapeSpec => ({
    id,
    master: 7,
    cells: { PinX: at[0], PinY: at[1], Width: 0.4, Height: 0.4, ...options.cells },
    members: [{ id: id + 1, masterShape: 6, text: options.letter ? `<cp IX="0"/>${options.letter}` : undefined }],
});

const valve = (
    id: number,
    at: [number, number],
    options: { letter?: string; cells?: Record<string, string | number> } = {},
) => shapeXml(valveSpec(id, at, options));

test("a stencil's group is one part, its members its master's, worked as its actuator's letter says", async () => {
    const shapes = [
        valve(10, [2, 4], { letter: "S" }),
        // Flipped upside down (its actuator under it), in a group with its tag.
        shapeXml({
            id: 20,
            cells: { PinX: 4, PinY: 4, Width: 0.6, Height: 0.6 },
            members: [
                valveSpec(21, [0.3, 0.35], { cells: { FlipY: 1 } }),
                {
                    id: 23,
                    cells: { PinX: 0.3, PinY: 0.05, Width: 0.6, Height: 0.1, LinePattern: 0, FillPattern: 0 },
                    geometry: [RECTANGLE],
                    text: '<cp IX="0"/>OVNT',
                },
            ],
        }),
    ].join("");
    const pages = await readVsdx(new Blob([vsdxOf({ pages: [{ name: "P", shapes }], masters: [POWERED] })]), "p");
    // An instance draws its master's outline (it says nothing of its own), and its member its master's member's.
    const first = pages[0]!.shapes[0]!;
    expect(first.outlines).toHaveLength(1);
    expect(first.members[0]!.outlines).toHaveLength(1);
    expect(first.members[0]!.words?.lines).toEqual(["S"]);
    expect(pages[0]!.shapes[1]!.members[0]!.members[0]!.words?.lines).toEqual(["P"]); // its master's letter
    // Flipped, its letter still reads upright.
    expect(pages[0]!.shapes[1]!.members[0]!.members[0]!.words?.angle).toBe(0);

    const { drawing } = (await read(vsdxOf({ pages: [{ name: "P", shapes }], masters: [POWERED] })))[0]!;
    const [solenoid, vent] = byKind(drawing, "valve");
    expect(solenoid!.props).toMatchObject({ actuation: "solenoid", body: "gate", normal: "" });
    expect([vent!.tag, vent!.props.actuation, vent!.rotation]).toEqual(["OVNT", "pneumatic", 180]);
    expect(byKind(drawing, "text")).toEqual([]); // its tag is its, not words beside it
});

/**
 * An ISO 1219 directional valve as Visio's stencils draw one: its two boxes (0.4 by 0.3 inches each, a hundred of
 * Piper's units to the inch on a page with no bowtie valves), without its solenoid and spring, with the same ports in
 * each box: bottom and top, each a quarter, a half, or three quarters of the way across it.
 */
const isoValve = (id: number, name: string, ports: { bottom: number[]; top: number[] }): MasterSpec => ({
    id,
    name,
    shape: {
        id: 1,
        cells: { Width: 0.8, Height: 0.3 },
        geometry: [
            RECTANGLE,
            {
                rows: [
                    ["MoveTo", { X: 0.4, Y: 0 }],
                    ["LineTo", { X: 0.4, Y: 0.3 }],
                ],
            },
        ],
        connections: [0, 0.4].flatMap((box): [number, number][] => [
            ...ports.bottom.map((x): [number, number] => [box + x, 0]),
            ...ports.top.map((x): [number, number] => [box + x, 0.3]),
        ]),
    },
});

test("ISO 1219's 3/2 and 5/2 valves become Piper's, their lines on their ports; a diffuser goes into its line", async () => {
    const masters: MasterSpec[] = [
        FEED_MASTERS.find((master) => master.name === "Dynamic connector")!,
        isoValve(8, "3/2 valve", { bottom: [0.1, 0.3], top: [0.1] }),
        isoValve(9, "5/2 valve", { bottom: [0.1, 0.2, 0.3], top: [0.1, 0.3] }),
        {
            id: 10,
            name: "Grille diffuser",
            shape: {
                id: 1,
                cells: { Width: 0.14, Height: 0.2 },
                geometry: [RECTANGLE],
                connections: [
                    [0, 0.1],
                    [0.14, 0.1],
                ],
            },
        },
        { id: 11, name: "Manifold", shape: { id: 1, cells: { Width: 1.2, Height: 0.2 }, geometry: [RECTANGLE] } },
    ];
    const iso = (id: number, master: number, at: [number, number]) =>
        shape(id, { master, cells: { PinX: at[0], PinY: at[1], Width: 0.8, Height: 0.3 } });
    const pipe = (id: number, from: [number, number], to: [number, number]) => shapeXml(connector(id, from, to));
    const shapes = [
        // A 3/2 valve, its supply (1) and exhaust (3) glued below its right box, and what it feeds (2) above.
        iso(1, 8, [2, 4]),
        pipe(10, [2.1, 3], [2.1, 3.85]),
        pipe(11, [2.1, 5], [2.1, 4.15]),
        pipe(12, [2.3, 3], [2.3, 3.85]),
        // Another, its lines glued to its left box: that's the box it rests in.
        iso(2, 8, [5, 4]),
        pipe(13, [4.7, 3], [4.7, 3.85]),
        pipe(14, [4.7, 5], [4.7, 4.15]),
        // A 5/2 valve: its supply (1) below its right box's middle, and what it feeds (4 and 2) above it.
        iso(3, 9, [8, 4]),
        pipe(15, [8.2, 3], [8.2, 3.85]),
        pipe(16, [8.1, 5], [8.1, 4.15]),
        pipe(17, [8.3, 5], [8.3, 4.15]),
        // A grille diffuser on a line going down (its frame's x down the page, as the Hopper P&ID's is).
        shape(4, { master: 10, cells: { PinX: 2, PinY: 6.5, Width: 0.14, Height: 0.2, Angle: -Math.PI / 2 } }),
        pipe(18, [2, 7.5], [2, 6.57]),
        pipe(19, [2, 6.43], [2, 5.5]),
        // A manifold, with a line glued to it; and a diffuser drawn by hand, tagged.
        shape(5, { master: 11, cells: { PinX: 8, PinY: 6.5, Width: 1.2, Height: 0.2 } }),
        pipe(20, [8, 7.5], [8, 6.6]),
        shapeXml({
            id: 30,
            cells: { PinX: 5, PinY: 6.5, Width: 0.6, Height: 0.3 },
            members: [
                { id: 31, cells: { PinX: 0.1, PinY: 0.15, Width: 0.14, Height: 0.2 }, geometry: [RECTANGLE] },
                {
                    id: 32,
                    cells: { PinX: 0.45, PinY: 0.15, Width: 0.3, Height: 0.15, LinePattern: 0, FillPattern: 0 },
                    geometry: [RECTANGLE],
                    character: [{ Size: 0.1 }],
                    text: '<cp IX="0"/>FDIFF',
                },
            ],
        }),
    ].join("");
    const connects = [
        glued(10, "End", 1),
        glued(11, "End", 1),
        glued(12, "End", 1),
        glued(13, "End", 2),
        glued(14, "End", 2),
        glued(15, "End", 3),
        glued(16, "End", 3),
        glued(17, "End", 3),
        glued(18, "End", 4),
        glued(19, "Begin", 4),
        glued(20, "End", 5),
    ].join("");
    const { drawing } = (await read(vsdxOf({ pages: [{ name: "P", shapes, connects }], masters })))[0]!;
    const portsOn = (part: string) =>
        drawing.lines
            .flatMap((line) => [line.from, line.to])
            .flatMap((end) => (isPortEnd(end) && end.part === part ? [end.port] : []))
            .sort();
    const [first, second] = byKind(drawing, "valve32");
    expect([first!.x, first!.y, first!.rotation, first!.flip, first!.scale]).toEqual([200, 450, 0, false, 1]);
    expect(portsOn(first!.id)).toEqual(["1", "2", "3"]);
    expect(first!.props.normal).toBe(""); // only a key says what its fill means
    // The other's moved over by a box, so the box it rests in (its ports') is the one its lines met.
    expect([second!.x, second!.y, second!.flip]).toEqual([460, 450, false]);
    expect(portsOn(second!.id)).toEqual(["1", "2"]);
    const five = byKind(drawing, "valve52")[0]!;
    expect([five.x, five.y]).toEqual([800, 450]);
    expect(portsOn(five.id)).toEqual(["1", "2", "4"]);
    // The diffuser's in its line, turned to it, flow coming in at its top and leaving at its foot, toward its arrows.
    const [diffuser, drawnByHand] = byKind(drawing, "diffuser");
    expect([diffuser!.x, diffuser!.y, diffuser!.rotation]).toEqual([200, 200, 90]);
    const into = drawing.lines.find((line) => isPortEnd(line.to) && line.to.part === diffuser!.id)!;
    expect(into.to).toEqual({ part: diffuser!.id, port: "a" });
    const out = drawing.lines.find((line) => isPortEnd(line.from) && line.from.part === diffuser!.id)!;
    expect(out.from).toEqual({ part: diffuser!.id, port: "b" });
    expect(drawnByHand!.tag).toBe("FDIFF");
    // A manifold stays drawn as Visio drew it, its line on a port of its own where it was glued.
    expect(byKind(drawing, "manifold")).toEqual([]);
    const manifold = byKind(drawing, "figure")[0]!;
    expect(portsOn(manifold.id)).toEqual(["p1"]);
});

test("symbols drawn by hand are what their tags say, and tags written beside a symbol are its", async () => {
    const lines = (id: number, at: [number, number]) =>
        shapeXml({
            id,
            cells: { PinX: at[0], PinY: at[1], Width: 0.3, Height: 0.3 },
            members: [0, 1, 2].map((index) => ({
                id: id + 1 + index,
                cells: { PinX: 0.15, PinY: 0.1 * index + 0.05, Width: 0.3, Height: 0.01 },
                geometry: [RECTANGLE],
            })),
        });
    const words = (id: number, at: [number, number], text: string, width = 0.6) =>
        shapeXml({
            id,
            cells: { PinX: at[0], PinY: at[1], Width: width, Height: 0.15, LinePattern: 0, FillPattern: 0 },
            geometry: [RECTANGLE],
            character: [{ Size: 0.1 }],
            text: `<cp IX="0"/>${text}`,
        });
    const shapes = [
        // A relief valve drawn by hand, grouped with its tag and set pressure, on one label of two lines.
        shapeXml({
            id: 1,
            cells: { PinX: 2, PinY: 5, Width: 0.8, Height: 0.6 },
            members: [
                {
                    id: 2,
                    cells: { PinX: 0.4, PinY: 0.4, Width: 0.3, Height: 0.3 },
                    geometry: [
                        {
                            rows: [
                                ["MoveTo", { X: 0, Y: 0 }],
                                ["LineTo", { X: 0.3, Y: 0.15 }],
                                ["LineTo", { X: 0, Y: 0.3 }],
                                ["LineTo", { X: 0, Y: 0 }],
                            ],
                        },
                    ],
                },
                {
                    id: 3,
                    cells: { PinX: 0.4, PinY: 0.1, Width: 0.8, Height: 0.2, LinePattern: 0, FillPattern: 0 },
                    geometry: [RECTANGLE],
                    character: [{ Size: 0.1 }],
                    text: '<cp IX="0"/>PRV\nR.P. 450 PSI',
                },
            ],
        }),
        // A quick disconnect drawn by hand, its tag beside it; a valve, untagged, its tag beside it.
        lines(10, [5, 5]),
        words(14, [5, 5.3], "PNQD", 0.4),
        valve(20, [7, 5]),
        words(22, [7.35, 5.2], "FBB", 0.4),
        // A title, too big to be a tag, and words that aren't one.
        shapeXml({
            id: 30,
            cells: { PinX: 5, PinY: 7, Width: 2, Height: 0.5, LinePattern: 0, FillPattern: 0 },
            geometry: [RECTANGLE],
            character: [{ Size: 0.4 }],
            text: '<cp IX="0"/>IT1',
        }),
        words(31, [2, 2], "Regulated\nBang-Bang", 1.5),
    ].join("");
    const { drawing, report } = (await read(vsdxOf({ pages: [{ name: "P", shapes }], masters: [POWERED] })))[0]!;
    expect(tagged(drawing, "PRV")).toMatchObject({ kind: "relief", props: { set: "450 psi" }, shown: ["set"] });
    expect(tagged(drawing, "PNQD").kind).toBe("qd");
    const fbb = tagged(drawing, "FBB");
    expect([fbb.kind, fbb.label]).toEqual(["valve", { x: 35, y: -17.2 }]); // its tag where it was written
    expect(byKind(drawing, "text").map((part) => part.text)).toEqual(["IT1", "Regulated\nBang-Bang"]);
    expect(report).toMatchObject({ parts: 3, notes: 2 });
});

// --- the key -------------------------------------------------------------------------------------------------------

test("a drawing's key says what its lines carry, how big they are, and which fill is which normal state", async () => {
    const words = (id: number, at: [number, number], text: string, valign = 1) =>
        shapeXml({
            id,
            cells: {
                PinX: at[0],
                PinY: at[1],
                Width: 1.6,
                Height: 0.2,
                LinePattern: 0,
                FillPattern: 0,
                VerticalAlign: valign,
            },
            geometry: [RECTANGLE],
            character: [{ Size: 0.12 }],
            paragraph: [{ HorzAlign: 0 }],
            text: `<cp IX="0"/><pp IX="0"/>${text}`,
        });
    const sample = (id: number, y: number, cells: Record<string, string | number>) =>
        shapeXml(connector(id, [1, y], [1.8, y], { cells }));
    const key = [
        words(100, [1.8, 3.2], "Line KEY"),
        sample(101, 3, { LineColor: "#ff0000" }),
        words(102, [2.8, 3], "Kerosene (Jet-A)"),
        sample(103, 2.7, { LineColor: "#00b0f0" }),
        words(104, [2.8, 2.7], "Liquid Oxygen (LOX)"),
        sample(105, 2.4, { LinePattern: 2 }),
        words(106, [2.8, 2.4], "3/8” Line"),
        words(110, [5, 3.2], "Valve State KEY"),
        valve(111, [4.5, 2.9], { cells: { FillForegnd: "#00b050" } }),
        words(113, [5.6, 2.9], "Normally Open"),
    ];
    const drawn = [
        valve(1, [4, 6], { cells: { FillForegnd: "#00b050" } }),
        valve(3, [7, 6]),
        shapeXml(connector(5, [4.2, 6.2], [6.8, 6.2], { cells: { LineColor: "#c00000", LinePattern: 2 } })),
        shapeXml(connector(6, [3.8, 6.2], [2, 6.2], { cells: { LineColor: "#0070c0" } })),
    ];
    const glue = [glued(5, "Begin", 1), glued(5, "End", 3), glued(6, "Begin", 1)].join("");
    const file = vsdxOf({
        pages: [{ name: "P", shapes: [...key, ...drawn].join(""), connects: glue }],
        masters: [POWERED, ...FEED_MASTERS],
    });
    const { drawing, report } = (await read(file))[0]!;
    // The key's own shapes are drawn as it was, all together: its valve's no part, its lines none.
    expect(report).toMatchObject({ parts: 2, lines: 2, figures: 1 });
    const kerosene = drawing.lines.find((line) => line.fluid === "kerosene-jet-a")!;
    expect(kerosene.props).toEqual({ size: "3/8 in" }); // dashed as the key's 3/8" line is
    expect(drawing.fluids).toEqual([
        { id: "kerosene-jet-a", name: "Kerosene (Jet-A)", label: "Jet-A", color: "#ff0000" }, // a darker red: the key's
        { id: "lox", name: "Liquid oxygen", label: "LOX", color: "#00b0f0", gas: false }, // a standard fluid, the key's color
    ]);
    expect(drawing.lines.map((line) => line.fluid).sort()).toEqual(["kerosene-jet-a", "lox"]);
    expect(byKind(drawing, "valve").map((part) => part.props.normal)).toEqual(["NO", ""]); // white: not said
});

// --- words, styles, and what's inherited ---------------------------------------------------------------------------

test("words are set as Visio sets them: their runs, their spacing, and upright however their shape's flipped", async () => {
    const shapes = shapeXml({
        id: 1,
        cells: { PinX: 3, PinY: 3, Width: 3, Height: 2, FlipY: 1, Angle: Math.PI, VerticalAlign: 0 },
        geometry: [RECTANGLE],
        character: [
            { Size: 0.2, Style: 1 },
            { Size: 0.2, Color: "#c00000" },
        ],
        paragraph: [{ SpLine: -2, HorzAlign: 0 }],
        text: '<cp IX="0"/><pp IX="0"/>Naming KEY\nExample: <cp IX="1"/>SV<cp IX="0"/>-OVNT\n',
    });
    const page = (await readVsdx(new Blob([vsdxOf({ pages: [{ name: "P", shapes }] })]), "p"))[0]!;
    const words = page.shapes[0]!.words!;
    expect(words.lines).toEqual(["Naming KEY", "Example: SV-OVNT"]);
    expect(words.runs[1]!.map((run) => [run.text, run.lettering.color])).toEqual([
        ["Example: ", "#000000"],
        ["SV", "#c00000"],
        ["-OVNT", "#000000"],
    ]);
    expect(words.pitch).toBeCloseTo(0.4); // double spacing: twice its letters' size
    expect([words.align, words.valign]).toEqual(["left", "top"]);
    expect(words.angle).toBeCloseTo(Math.PI); // turned a half turn, and flipped: upside down, as Visio shows it
    const { drawing } = (await read(vsdxOf({ pages: [{ name: "P", shapes }] })))[0]!;
    const text = figureOf(byKind(drawing, "figure")[0]!).texts[0]!;
    expect(text.runs?.[1]).toEqual([
        { text: "Example: " },
        { text: "SV", color: "#c00000", bold: false },
        { text: "-OVNT" },
    ]);
    expect(text.pitch).toBe(40);
    expect(text.anchor).toBe("start");
});

test("a cell a shape doesn't set is its master's, else its style's, and a row it changes is its own", async () => {
    const styles =
        '<StyleSheet ID="0" NameU="No Style"><Cell N="LineColor" V="0"/><Cell N="LineWeight" V="0.01"/><Cell N="FillPattern" V="1"/><Cell N="FillForegnd" V="1"/></StyleSheet>' +
        '<StyleSheet ID="3" NameU="Pipe" LineStyle="0" FillStyle="0" TextStyle="0"><Cell N="LineColor" V="24"/><Cell N="LineWeight" V="Themed"/></StyleSheet>';
    const master: MasterSpec = {
        id: 9,
        name: "Bracket",
        shape: {
            id: 5,
            styles: { line: 3, fill: 3, text: 3 },
            cells: { Width: 1, Height: 1 },
            geometry: [
                {
                    rows: [
                        ["MoveTo", { X: 0, Y: 0 }],
                        ["LineTo", { X: 1, Y: 0 }],
                        ["LineTo", { X: 1, Y: 1 }],
                    ],
                },
            ],
        },
    };
    const shapes = shapeXml({
        id: 1,
        master: 9,
        cells: { PinX: 2, PinY: 2, Width: 1, Height: 1 },
        // Its second row moved, and a third added: the rest as its master's.
        geometry: [
            {
                rows: [
                    ["LineTo", { X: 0.5, Y: 0 }, 2],
                    ["LineTo", { X: 0, Y: 1 }, 4],
                ],
            },
        ],
    });
    const page = (
        await readVsdx(
            new Blob([vsdxOf({ pages: [{ name: "P", shapes }], masters: [master], styles, colors: ["#7030A0"] })]),
            "p",
        )
    )[0]!;
    const bracket = page.shapes[0]!;
    expect(bracket.pen).toMatchObject({ color: "#7030a0", weight: 0.01 }); // its style's color, its style's style's weight
    expect(bracket.brush).toEqual({ color: "#ffffff", opacity: 1 });
    const steps = bracket.outlines.flatMap((outline) => outline.steps);
    expect(steps.map((step) => (step.kind === "close" ? "Z" : `${step.to.x},${step.to.y}`))).toEqual([
        "1.5,1.5",
        "2,1.5",
        "2.5,2.5",
        "1.5,2.5",
    ]);
    expect(everyShape(bracket)).toHaveLength(1);
});
