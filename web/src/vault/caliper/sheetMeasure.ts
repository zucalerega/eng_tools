import type { Geometry, Point } from "./dxf";
import { formatAngle, formatLength, type Reading } from "./measure";
import type { Units } from "./model";

// Measuring a drawing: what one picked line, arc, circle, or corner is (a line's length, a hole's diameter, a corner's
// coordinates), and what two are to each other (the distance between them, or the angle). Lengths are in the drawing's
// own units, mm of a unit being how long one is, until they're shown in the units chosen.

export interface SheetMeasurement {
    title: string;
    readings: Reading[];
    line?: [Point, Point]; // what to draw for it: from one to the other
}

const PARALLEL = 1e-6; // 1 - |cos| below this: parallel (about 0.08°)
const FULL = 2 * Math.PI - 1e-9;

type Line = Extract<Geometry, { kind: "line" }>;

const angleOf = (line: Line): number => Math.atan2(line.b[1] - line.a[1], line.b[0] - line.a[0]);

/** Where a point lands on a line through a segment. */
function onto(p: Point, line: Line): Point {
    const [dx, dy] = [line.b[0] - line.a[0], line.b[1] - line.a[1]];
    const length = dx * dx + dy * dy;
    const t = length > 0 ? ((p[0] - line.a[0]) * dx + (p[1] - line.a[1]) * dy) / length : 0;
    return [line.a[0] + t * dx, line.a[1] + t * dy];
}

const apart = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** One picked thing, on its own. */
export function measureOneOnSheet(geometry: Geometry, units: Units, mm: number): SheetMeasurement {
    const length = (value: number) => formatLength(value * mm, units);
    switch (geometry.kind) {
        case "point":
            return {
                title: "Point",
                readings: [
                    { label: "X", value: length(geometry.at[0]) },
                    { label: "Y", value: length(geometry.at[1]) },
                ],
            };
        case "line": {
            // Its direction, from +X, as a line has two: the one from 0° up to 180°.
            const angle = ((angleOf(geometry) % Math.PI) + Math.PI) % Math.PI;
            return {
                title: "Line",
                readings: [
                    { label: "Length", value: length(apart(geometry.a, geometry.b)) },
                    { label: "Angle", value: formatAngle(angle) },
                    { label: "ΔX", value: length(Math.abs(geometry.b[0] - geometry.a[0])) },
                    { label: "ΔY", value: length(Math.abs(geometry.b[1] - geometry.a[1])) },
                ],
                line: [geometry.a, geometry.b],
            };
        }
        case "arc": {
            const circle = geometry.sweep >= FULL;
            const size = [
                { label: "Diameter", value: length(2 * geometry.radius) },
                { label: "Radius", value: length(geometry.radius) },
            ];
            const center = { label: "Center", value: `${length(geometry.center[0])}, ${length(geometry.center[1])}` };
            return circle
                ? { title: "Circle", readings: [...size, center] }
                : {
                      title: "Arc",
                      readings: [
                          ...size,
                          { label: "Angle", value: formatAngle(geometry.sweep) },
                          { label: "Length", value: length(geometry.radius * geometry.sweep) },
                          center,
                      ],
                  };
        }
    }
}

/** Two picked things, to each other: the distance between them, or the angle. */
export function measureTwoOnSheet(first: Geometry, second: Geometry, units: Units, mm: number): SheetMeasurement {
    const length = (value: number) => formatLength(value * mm, units);
    const between = (a: Point, b: Point, title: string): SheetMeasurement => ({
        title,
        readings: [
            { label: title, value: length(apart(a, b)) },
            { label: "ΔX", value: length(Math.abs(b[0] - a[0])) },
            { label: "ΔY", value: length(Math.abs(b[1] - a[1])) },
        ],
        line: [a, b],
    });
    // Put them in order, so each pair of kinds is worked out once: points, then arcs, then lines.
    const rank = { point: 0, arc: 1, line: 2 };
    const [p, q] = rank[first.kind] <= rank[second.kind] ? [first, second] : [second, first];
    if (p.kind === "point" && q.kind === "point") {
        return between(p.at, q.at, "Distance");
    }
    if (p.kind === "point" && q.kind === "arc") {
        const away = apart(p.at, q.center);
        return {
            title: "Distance to center",
            readings: [
                { label: "To center", value: length(away) },
                { label: q.sweep >= FULL ? "To circle" : "To arc's circle", value: length(Math.abs(away - q.radius)) },
            ],
            line: [p.at, q.center],
        };
    }
    if (p.kind === "point" && q.kind === "line") {
        const foot = onto(p.at, q);
        return {
            title: "Distance to line",
            readings: [{ label: "Distance", value: length(apart(p.at, foot)) }],
            line: [p.at, foot],
        };
    }
    if (p.kind === "arc" && q.kind === "arc") {
        return between(p.center, q.center, "Center distance");
    }
    if (p.kind === "arc" && q.kind === "line") {
        const foot = onto(p.center, q);
        const away = apart(p.center, foot);
        return {
            title: "Distance to line",
            readings: [
                { label: "From center", value: length(away) },
                { label: "From edge", value: length(Math.abs(away - p.radius)) },
            ],
            line: [p.center, foot],
        };
    }
    if (p.kind === "line" && q.kind === "line") {
        const turn = Math.abs(angleOf(p) - angleOf(q)) % Math.PI;
        const cos = Math.abs(Math.cos(turn));
        if (1 - cos < PARALLEL) {
            const foot = onto(q.a, p);
            return {
                title: "Distance",
                readings: [{ label: "Distance", value: length(apart(foot, q.a)) }],
                line: [foot, q.a],
            };
        }
        const acute = Math.acos(Math.min(cos, 1));
        return {
            title: "Angle",
            readings: [
                { label: "Angle", value: formatAngle(acute) },
                { label: "Or", value: formatAngle(Math.PI - acute) },
            ],
        };
    }
    return { title: "Distance", readings: [] }; // every pair of kinds is above
}
