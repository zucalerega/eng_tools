import { describe, expect, test } from "vitest";
import { aciColor, ARC, DxfError, mtextLines, readDxf, type Drawing, type Feature } from "../src/vault/caliper/dxf";
import { measureOneOnSheet, measureTwoOnSheet } from "../src/vault/caliper/sheetMeasure";

// DXF files, read in the browser as Caliper draws them: what's drawn and what can be measured, from files written here
// as AutoCAD and SolidWorks write them (text DXF: a group code, then its value, a line each).

type Pairs = [number, string | number][];

/** A DXF file: its header's variables, tables, blocks, and entities. */
function dxf({
    header = [],
    tables = [],
    blocks = [],
    entities = [],
}: {
    header?: Pairs;
    tables?: Pairs;
    blocks?: Pairs;
    entities?: Pairs;
}): Uint8Array {
    const section = (name: string, pairs: Pairs): Pairs => [[0, "SECTION"], [2, name], ...pairs, [0, "ENDSEC"]];
    const pairs: Pairs = [
        ...section("HEADER", header),
        ...section("TABLES", tables),
        ...section("BLOCKS", blocks),
        ...section("ENTITIES", entities),
        [0, "EOF"],
    ];
    return new TextEncoder().encode(pairs.map(([code, value]) => `${code}\r\n${value}\r\n`).join(""));
}

/** An entity's own group codes, on layer 0 unless they say which: an entity has one layer (code 8). */
const onLayer = (more: Pairs): Pairs => (more.some(([code]) => code === 8) ? more : [[8, "0"], ...more]);

const line = (x1: number, y1: number, x2: number, y2: number, more: Pairs = []): Pairs => [
    [0, "LINE"],
    ...onLayer(more),
    [10, x1],
    [20, y1],
    [11, x2],
    [21, y2],
];

const circle = (x: number, y: number, r: number, more: Pairs = []): Pairs => [
    [0, "CIRCLE"],
    ...onLayer(more),
    [10, x],
    [20, y],
    [40, r],
];

const arc = (x: number, y: number, r: number, from: number, to: number, more: Pairs = []): Pairs => [
    [0, "ARC"],
    ...onLayer(more),
    [10, x],
    [20, y],
    [40, r],
    [50, from],
    [51, to],
];

const block = (name: string, base: [number, number], entities: Pairs): Pairs => [
    [0, "BLOCK"],
    [2, name],
    [70, 0],
    [10, base[0]],
    [20, base[1]],
    ...entities,
    [0, "ENDBLK"],
];

const insert = (name: string, x: number, y: number, more: Pairs = []): Pairs => [
    [0, "INSERT"],
    ...onLayer(more),
    [2, name],
    [10, x],
    [20, y],
];

const table = (name: string, entries: Pairs[]): Pairs => [[0, "TABLE"], [2, name], ...entries.flat(), [0, "ENDTAB"]];

const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

/** A feature's numbers, rounded, to compare. */
function round(feature: Feature): unknown {
    const r = (v: number) => Math.round(v * 1e9) / 1e9;
    switch (feature.kind) {
        case "line":
            return { kind: "line", a: feature.a.map(r), b: feature.b.map(r) };
        case "arc":
            return {
                kind: "arc",
                center: feature.center.map(r),
                radius: r(feature.radius),
                start: r(feature.start),
                sweep: r(feature.sweep),
            };
        case "point":
            return { kind: "point", at: feature.at.map(r) };
    }
}

describe("what's drawn and measured", () => {
    test("lines, arcs, and circles, with the box they fill", () => {
        const drawing = readDxf(dxf({ entities: [...line(0, 0, 10, 0), ...circle(5, 5, 2), ...arc(0, 0, 10, 0, 90)] }));
        expect(drawing.features.map(round)).toEqual([
            { kind: "line", a: [0, 0], b: [10, 0] },
            { kind: "arc", center: [5, 5], radius: 2, start: 0, sweep: r(2 * Math.PI) },
            { kind: "arc", center: [0, 0], radius: 10, start: 0, sweep: r(Math.PI / 2) },
        ]);
        expect(drawing.strokes).toHaveLength(3);
        expect(drawing.bounds).toEqual({ min: [0, 0], max: [10, 10] });
        expect(drawing.space).toBe("model");
        expect(drawing.layers.map((layer) => [layer.name, layer.count])).toEqual([["0", 3]]);
    });

    test("polylines' bulges are arcs", () => {
        // A 10 x 10 square whose top bulges out in a half circle.
        const polyline: Pairs = [
            [0, "LWPOLYLINE"],
            [8, "0"],
            [90, 4],
            [70, 1],
            [10, 0],
            [20, 0],
            [10, 10],
            [20, 0],
            [10, 10],
            [20, 10],
            [42, 1],
            [10, 0],
            [20, 10],
        ];
        const drawing = readDxf(dxf({ entities: polyline }));
        expect(drawing.features.map(round)).toEqual([
            { kind: "line", a: [0, 0], b: [10, 0] },
            { kind: "line", a: [10, 0], b: [10, 10] },
            { kind: "arc", center: [5, 10], radius: 5, start: 0, sweep: r(Math.PI) },
            { kind: "line", a: [0, 10], b: [0, 0] },
        ]);
        expect(drawing.strokes[0]!.path).toContain(ARC);
        near([...drawing.bounds!.min, ...drawing.bounds!.max], [0, 0, 10, 15]);
    });

    test("blocks go where they're inserted: moved, turned, scaled, and mirrored", () => {
        const blocks = [
            ...block("PIN", [1, 0], [...line(1, 0, 2, 0), ...circle(1, 0, 1)]),
            ...block("QUARTER", [0, 0], arc(0, 0, 1, 0, 90)),
        ];
        const entities = [
            ...insert("PIN", 10, 10, [
                [41, 2],
                [42, 2],
                [50, 90],
            ]),
            ...insert("QUARTER", 0, 0, [[41, -1]]),
            // An array of three columns, 5 apart, of a block inside a block.
            ...block("unused", [0, 0], []),
        ];
        const drawing = readDxf(
            dxf({
                blocks: [
                    ...blocks,
                    ...block(
                        "ROW",
                        [0, 0],
                        insert("QUARTER", 0, 0, [
                            [70, 3],
                            [44, 5],
                        ]),
                    ),
                ],
                entities: [...entities.filter((pair) => pair), ...insert("ROW", 0, 20)],
            }),
        );
        const [pin, hole, mirrored, ...row] = drawing.features.map(round);
        expect(pin).toEqual({ kind: "line", a: [10, 10], b: [10, 12] });
        expect(hole).toEqual({
            kind: "arc",
            center: [10, 10],
            radius: 2,
            start: r(Math.PI / 2),
            sweep: r(2 * Math.PI),
        });
        // Mirrored, the quarter from 0° to 90° is the one from 90° to 180°.
        expect(mirrored).toEqual({
            kind: "arc",
            center: [0, 0],
            radius: 1,
            start: r(Math.PI / 2),
            sweep: r(Math.PI / 2),
        });
        expect(row.map((feature) => (feature as { center: number[] }).center)).toEqual([
            [0, 20],
            [5, 20],
            [10, 20],
        ]);
    });

    test("a block that inserts itself stops, and says so", () => {
        const drawing = readDxf(
            dxf({
                blocks: block("LOOP", [0, 0], [...line(0, 0, 1, 0), ...insert("LOOP", 1, 0)]),
                entities: insert("LOOP", 0, 0),
            }),
        );
        expect(drawing.features).toHaveLength(1);
        expect(drawing.left).toEqual({ "INSERT of a block inside itself": 1 });
    });

    test("layers: their colors, ByLayer and ByBlock, off and frozen, and layer 0 in blocks", () => {
        const tables = table("LAYER", [
            [
                [0, "LAYER"],
                [2, "Cut"],
                [70, 0],
                [62, 1],
                [6, "CONTINUOUS"],
            ],
            [
                [0, "LAYER"],
                [2, "Hidden"],
                [70, 0],
                [62, -2],
                [6, "CONTINUOUS"],
            ],
            [
                [0, "LAYER"],
                [2, "Frozen"],
                [70, 1],
                [62, 7],
                [6, "CONTINUOUS"],
            ],
            [
                [0, "LAYER"],
                [2, "Truly"],
                [70, 0],
                [62, 3],
                [420, 0x123456],
                [6, "CONTINUOUS"],
            ],
        ]);
        const entities = [
            ...line(0, 0, 1, 0, [[8, "Cut"]]),
            ...line(0, 1, 1, 1, [
                [8, "Cut"],
                [62, 3],
            ]),
            ...line(0, 2, 1, 2, [[8, "Hidden"]]),
            ...line(0, 3, 1, 3, [[8, "Frozen"]]),
            ...line(0, 4, 1, 4, [[8, "Truly"]]),
            ...insert("PART", 0, 5, [
                [8, "Cut"],
                [62, 5],
            ]),
        ];
        const blocks = block("PART", [0, 0], [...line(0, 0, 1, 0, [[62, 0]]), ...line(0, 1, 1, 1, [[62, 7]])]);
        const drawing = readDxf(dxf({ tables, blocks, entities }));
        const layers = Object.fromEntries(drawing.layers.map((layer, i) => [layer.name, { ...layer, i }]));
        expect([layers.Cut!.shown, layers.Hidden!.shown, layers.Frozen!.shown, layers.Truly!.shown]).toEqual([
            true,
            false,
            false,
            true,
        ]);
        expect(drawing.strokes.map((stroke) => [drawing.layers[stroke.layer]!.name, stroke.color])).toEqual([
            ["Cut", "#ff0000"],
            ["Cut", "#00ff00"],
            ["Hidden", "#ffff00"], // its layer is off: color 2, as -2
            ["Frozen", null], // AutoCAD's 7: the foreground
            ["Truly", "#123456"],
            ["Cut", "#0000ff"], // in the block, on layer 0, by block: the insert's layer and color
            ["Cut", null],
        ]);
    });

    test("line types are dashes, scaled by the drawing's and the line's scales", () => {
        const tables = table("LTYPE", [
            [
                [0, "LTYPE"],
                [2, "DASHED"],
                [70, 0],
                [72, 65],
                [73, 2],
                [40, 0.75],
                [49, 0.5],
                [74, 0],
                [49, -0.25],
                [74, 0],
            ],
            [
                [0, "LTYPE"],
                [2, "DOTTED"],
                [70, 0],
                [72, 65],
                [73, 2],
                [40, 0.25],
                [49, 0],
                [74, 0],
                [49, -0.25],
                [74, 0],
            ],
        ]);
        const entities = [
            ...line(0, 0, 1, 0, [
                [6, "DASHED"],
                [48, 3],
            ]),
            ...line(0, 1, 1, 1, [[6, "DOTTED"]]),
            ...line(0, 2, 1, 2),
        ];
        const drawing = readDxf(
            dxf({
                header: [
                    [9, "$LTSCALE"],
                    [40, 2],
                ],
                tables,
                entities,
            }),
        );
        expect(drawing.strokes.map((stroke) => stroke.dash)).toEqual([[3, 1.5], [0.01, 0.5], null]);
    });

    test("text: TEXT's justification, MTEXT's formatting, and AutoCAD's codes", () => {
        const entities: Pairs = [
            [0, "TEXT"],
            [8, "0"],
            [10, 1],
            [20, 2],
            [40, 2.5],
            [1, "%%c10 THRU"],
            [0, "TEXT"],
            [8, "0"],
            [10, 0],
            [20, 0],
            [40, 2],
            [1, "MIDDLE"],
            [72, 1],
            [11, 5],
            [21, 5],
            [73, 2],
            [0, "MTEXT"],
            [8, "0"],
            [10, 10],
            [20, 10],
            [40, 2],
            [71, 5],
            [3, "{\\fArial|b1|i0;Hello}\\PWorld "],
            [1, "\\S1/2;\\~in."],
        ];
        const drawing = readDxf(dxf({ entities }));
        const [plain, centered, formatted] = drawing.labels;
        expect(plain!.lines).toEqual(["⌀10 THRU"]);
        expect([plain!.matrix[4], plain!.matrix[5], plain!.height, plain!.align, plain!.top]).toEqual([
            1,
            2,
            2.5,
            "left",
            0,
        ]);
        expect([centered!.matrix[4], centered!.matrix[5], centered!.align, centered!.top]).toEqual([
            5,
            5,
            "center",
            -1,
        ]);
        expect(formatted!.lines).toEqual(["Hello", "World 1/2\u00a0in."]);
        expect(formatted!.align).toBe("center");
        // Middle: the two lines centered on where it's put.
        expect(formatted!.top).toBeCloseTo(((5 / 3) * 2 + 2) / 2 - 2, 9);
    });

    test("dimensions are drawn by their blocks", () => {
        const blocks = block(
            "*D1",
            [0, 0],
            [...line(0, 0, 25, 0), [0, "MTEXT"], [8, "0"], [10, 12.5], [20, 1], [40, 2.5], [71, 8], [1, "25.00"]],
        );
        const entities: Pairs = [
            [0, "DIMENSION"],
            [8, "Dims"],
            [2, "*D1"],
            [10, 25],
            [20, 0],
            [11, 12.5],
            [21, 1],
            [70, 32],
        ];
        const drawing = readDxf(dxf({ blocks, entities }));
        expect(drawing.features.map(round)).toEqual([{ kind: "line", a: [0, 0], b: [25, 0] }]);
        expect(drawing.labels.map((label) => [label.lines, drawing.layers[label.layer]!.name])).toEqual([
            [["25.00"], "Dims"],
        ]);
    });

    test("hatches fill solid, or with their pattern's lines inside them", () => {
        const square = (solid: boolean): Pairs => [
            [0, "HATCH"],
            [8, "0"],
            [2, solid ? "SOLID" : "ANSI31"],
            [70, solid ? 1 : 0],
            [71, 0],
            [91, 1],
            [92, 2],
            [72, 0],
            [73, 1],
            [93, 4],
            [10, 0],
            [20, 0],
            [10, 10],
            [20, 0],
            [10, 10],
            [20, 10],
            [10, 0],
            [20, 10],
            [97, 0],
            [75, 0],
            [76, 1],
            ...(solid
                ? []
                : ([
                      [52, 0],
                      [41, 1],
                      [77, 0],
                      [78, 1],
                      [53, 45],
                      [43, 0],
                      [44, 0],
                      [45, -2],
                      [46, 2],
                      [79, 0],
                  ] as Pairs)),
            [98, 0],
        ];
        const drawing = readDxf(dxf({ entities: [...square(true), ...square(false)] }));
        const [solid, hatched] = drawing.fills;
        expect(solid!.lines).toBeNull();
        expect(hatched!.lines!.length).toBeGreaterThan(0);
        expect(hatched!.lines!.length % 4).toBe(0);
        // Lines at 45°, 2√2 apart: across the square's extent.
        const lines = hatched!.lines!;
        for (let i = 0; i < lines.length; i += 4) {
            const [dx, dy] = [lines[i + 2]! - lines[i]!, lines[i + 3]! - lines[i + 1]!];
            expect(Math.abs(Math.abs(dx) - Math.abs(dy))).toBeLessThan(1e-9);
        }
        near([...drawing.bounds!.min, ...drawing.bounds!.max], [0, 0, 10, 10]);
    });

    test("splines are their NURBS curves", () => {
        // A cubic Bézier from (0, 0) to (10, 0), pulled up by (0, 10) and (10, 10): at its middle, (5, 7.5).
        const spline: Pairs = [
            [0, "SPLINE"],
            [8, "0"],
            [70, 8],
            [71, 3],
            [72, 8],
            [73, 4],
            [74, 0],
            ...[0, 0, 0, 0, 1, 1, 1, 1].map((k): [number, number] => [40, k]),
            ...[
                [0, 0],
                [0, 10],
                [10, 10],
                [10, 0],
            ].flatMap(([x, y]): Pairs => [
                [10, x!],
                [20, y!],
                [30, 0],
            ]),
        ];
        const drawing = readDxf(dxf({ entities: spline }));
        const path = drawing.strokes[0]!.path;
        const points: number[][] = [];
        for (let i = 0; i < path.length; i += 3) {
            points.push([path[i + 1]!, path[i + 2]!]);
        }
        near(points[0]!, [0, 0]);
        near(points.at(-1)!, [10, 0]);
        expect(points.some(([x, y]) => Math.abs(x! - 5) < 1e-9 && Math.abs(y! - 7.5) < 1e-9)).toBe(true);
        expect(drawing.bounds!.max[1]).toBeCloseTo(7.5, 9);
    });

    test("what isn't read is counted, and a file that isn't DXF says so", () => {
        const entities: Pairs = [
            [0, "IMAGE"],
            [8, "0"],
            [0, "3DSOLID"],
            [8, "0"],
            [0, "IMAGE"],
            [8, "0"],
            [0, "ACAD_TABLE"],
            [8, "0"],
            [2, "*T1"],
            ...line(0, 0, 1, 1),
        ];
        expect(readDxf(dxf({ entities })).left).toEqual({ IMAGE: 2, "3DSOLID": 1, ACAD_TABLE: 1 });
        expect(() => readDxf(new TextEncoder().encode("solid part\nendsolid part\n"))).toThrow(DxfError);
        expect(() => readDxf(new TextEncoder().encode("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n"))).toThrow(DxfError);
    });

    test("paper space shows where model space is empty", () => {
        const drawing = readDxf(dxf({ entities: line(0, 0, 1, 0, [[67, 1]]) }));
        expect(drawing.space).toBe("paper");
        expect(drawing.features).toHaveLength(1);
        const both = readDxf(dxf({ entities: [...line(0, 0, 1, 0, [[67, 1]]), ...line(0, 0, 2, 0)] }));
        expect([both.space, both.features.length]).toEqual(["model", 1]);
    });

    test("a binary DXF file reads as its text does", () => {
        const pairs: Pairs = [
            [0, "SECTION"],
            [2, "ENTITIES"],
            [0, "LINE"],
            [8, "0"],
            [10, 1.5],
            [20, 2],
            [30, 0],
            [11, 4],
            [21, 6],
            [31, 0],
            [62, 1],
            [0, "ENDSEC"],
            [0, "EOF"],
        ];
        const chunks: number[] = [...new TextEncoder().encode("AutoCAD Binary DXF\r\n\u001a\u0000")];
        for (const [code, value] of pairs) {
            chunks.push(code & 255, code >> 8);
            if (code >= 10 && code < 60) {
                const bytes = new Uint8Array(8);
                new DataView(bytes.buffer).setFloat64(0, Number(value), true);
                chunks.push(...bytes);
            } else if (code >= 60 && code < 80) {
                chunks.push(Number(value) & 255, Number(value) >> 8);
            } else {
                chunks.push(...new TextEncoder().encode(String(value)), 0);
            }
        }
        const drawing = readDxf(new Uint8Array(chunks));
        expect(drawing.features.map(round)).toEqual([{ kind: "line", a: [1.5, 2], b: [4, 6] }]);
        expect(drawing.strokes[0]!.color).toBe("#ff0000");
    });
});

describe("units", () => {
    const units = (header: Pairs): [string, number | null] => {
        const drawing = readDxf(dxf({ header, entities: line(0, 0, 1, 0) }));
        return [drawing.units, drawing.mmPerUnit];
    };

    test("as the file says, in $INSUNITS, or as $MEASUREMENT has it", () => {
        expect(
            units([
                [9, "$INSUNITS"],
                [70, 1],
            ]),
        ).toEqual(["in", 25.4]);
        expect(
            units([
                [9, "$INSUNITS"],
                [70, 4],
            ]),
        ).toEqual(["mm", 1]);
        expect(
            units([
                [9, "$INSUNITS"],
                [70, 6],
            ]),
        ).toEqual(["m", 1000]);
        expect(
            units([
                [9, "$INSUNITS"],
                [70, 13],
            ]),
        ).toEqual(["mm", 0.001]); // microns: shown in mm
        expect(
            units([
                [9, "$INSUNITS"],
                [70, 0],
                [9, "$MEASUREMENT"],
                [70, 0],
            ]),
        ).toEqual(["in", 25.4]);
        expect(units([])).toEqual(["mm", null]);
    });

    test("measurements convert them", () => {
        const drawing: Drawing = readDxf(
            dxf({
                header: [
                    [9, "$INSUNITS"],
                    [70, 1],
                ],
                entities: [...line(0, 0, 3, 4), ...circle(10, 0, 0.5)],
            }),
        );
        const [edge, hole] = drawing.features;
        const one = measureOneOnSheet(edge!, "mm", drawing.mmPerUnit!);
        expect(one.title).toBe("Line");
        expect(one.readings.slice(0, 2)).toEqual([
            { label: "Length", value: "127.000 mm" },
            { label: "Angle", value: "53.13°" },
        ]);
        expect(measureOneOnSheet(hole!, "in", drawing.mmPerUnit!).readings[0]).toEqual({
            label: "Diameter",
            value: "1.0000 in",
        });
        const between = measureTwoOnSheet(hole!, edge!, "in", drawing.mmPerUnit!);
        expect(between.title).toBe("Distance to line");
        expect(between.readings[0]).toEqual({ label: "From center", value: "8.0000 in" });
    });
});

describe("measuring", () => {
    test("between corners, lines, and circles", () => {
        const a: Feature = { kind: "point", at: [0, 0], layer: 0 };
        const b: Feature = { kind: "point", at: [3, 4], layer: 0 };
        expect(measureTwoOnSheet(a, b, "mm", 1).readings[0]).toEqual({
            label: "Distance",
            value: "5.000 mm",
        });
        const across = measureTwoOnSheet(
            { kind: "line", a: [0, 0], b: [10, 0] },
            { kind: "line", a: [0, 2], b: [10, 2] },
            "mm",
            1,
        );
        expect([across.title, across.readings[0]!.value]).toEqual(["Distance", "2.000 mm"]);
        const corner = measureTwoOnSheet(
            { kind: "line", a: [0, 0], b: [10, 0] },
            { kind: "line", a: [0, 0], b: [10, 10] },
            "mm",
            1,
        );
        expect(corner.readings).toEqual([
            { label: "Angle", value: "45.00°" },
            { label: "Or", value: "135.00°" },
        ]);
        const holes = measureTwoOnSheet(
            { kind: "arc", center: [0, 0], radius: 1, start: 0, sweep: 2 * Math.PI },
            { kind: "arc", center: [6, 8], radius: 1, start: 0, sweep: 2 * Math.PI },
            "mm",
            1,
        );
        expect([holes.title, holes.readings[0]!.value]).toEqual(["Center distance", "10.000 mm"]);
        const quarter = measureOneOnSheet(
            { kind: "arc", center: [0, 0], radius: 2, start: 0, sweep: Math.PI / 2 },
            "mm",
            1,
        );
        expect(quarter.title).toBe("Arc");
        expect(quarter.readings.find((reading) => reading.label === "Length")!.value).toBe(`${Math.PI.toFixed(3)} mm`);
    });
});

describe("colors and formatting", () => {
    test("AutoCAD's colors", () => {
        expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(aciColor)).toEqual([
            "#ff0000",
            "#ffff00",
            "#00ff00",
            "#00ffff",
            "#0000ff",
            "#ff00ff",
            null,
            "#808080",
            "#c0c0c0",
        ]);
        expect([10, 11, 12, 13, 14, 19, 20, 21, 30, 50, 250, 255].map(aciColor)).toEqual([
            "#ff0000",
            "#ff7f7f",
            "#a50000",
            "#a55252",
            "#7f0000",
            "#261313",
            "#ff3f00",
            "#ff9f7f",
            "#ff7f00",
            "#ffff00",
            "#333333",
            "#ffffff",
        ]);
    });

    test("MTEXT's codes", () => {
        expect(mtextLines("\\A1;{\\H1.5x;\\C1;Note:}\\Pone\\\\two")).toEqual(["Note:", "one\\two"]);
        expect(mtextLines("%%p0.05 \\S+0.1^-0.2; \\U+2205 %%d")).toEqual(["±0.05 +0.1/-0.2 ∅ °"]);
        expect(mtextLines("\\Lunder\\l and \\Oover\\o")).toEqual(["under and over"]);
    });
});

function r(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}
