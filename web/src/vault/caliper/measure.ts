import {
    add,
    cross,
    distance,
    dot,
    norm,
    scale,
    sub,
    unit,
    type EdgeGeometry,
    type FaceGeometry,
    type Vec3,
} from "./geometry";
import type { Units } from "./model";

// Measuring: what one picked face, edge, or point is (a plane's area, a hole's diameter, a point's coordinates), and
// what two are to each other (the distance between them, or the angle). Everything is in the model's coordinates, in
// millimeters, until it's shown in the units chosen.

/** Something picked to measure. */
export type Entity =
    | { kind: "point"; point: Vec3 }
    | { kind: "face"; face: FaceGeometry; points: Vec3[] } // points: some of its vertices, for distances to it
    | { kind: "edge"; edge: EdgeGeometry; points: Vec3[] };

export interface Reading {
    label: string;
    value: string;
}

export interface Measurement {
    title: string;
    readings: Reading[];
    line?: [Vec3, Vec3]; // what to draw for it: from one to the other
}

export const UNITS: Units[] = ["mm", "cm", "m", "in", "ft"];
const MM_PER: Record<Units, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const DIGITS: Record<Units, number> = { mm: 3, cm: 4, m: 6, in: 4, ft: 5 };

export const formatLength = (mm: number, units: Units): string =>
    `${(mm / MM_PER[units]).toFixed(DIGITS[units])} ${units}`;

export const formatArea = (mm2: number, units: Units): string =>
    `${(mm2 / MM_PER[units] ** 2).toFixed(DIGITS[units])} ${units}²`;

export const formatAngle = (radians: number): string => `${((radians * 180) / Math.PI).toFixed(2)}°`;

const coordinates = (p: Vec3, units: Units): Reading[] =>
    (["X", "Y", "Z"] as const).map((label, i) => ({ label, value: formatLength(p[i]!, units) }));

/** One picked thing, on its own. */
export function measureOne(entity: Entity, units: Units): Measurement {
    if (entity.kind === "point") {
        return { title: "Point", readings: coordinates(entity.point, units) };
    }
    if (entity.kind === "face") {
        const face = entity.face;
        const area = { label: "Area", value: formatArea(face.area, units) };
        switch (face.type) {
            case "plane":
                return { title: "Plane", readings: [area] };
            case "cylinder":
                return {
                    title: "Cylinder",
                    readings: [
                        { label: "Diameter", value: formatLength(2 * face.radius, units) },
                        { label: "Radius", value: formatLength(face.radius, units) },
                        area,
                    ],
                };
            case "cone":
                return {
                    title: "Cone",
                    readings: [{ label: "Angle", value: formatAngle(2 * face.halfAngle) }, area],
                };
            case "sphere":
                return {
                    title: "Sphere",
                    readings: [
                        { label: "Diameter", value: formatLength(2 * face.radius, units) },
                        { label: "Radius", value: formatLength(face.radius, units) },
                        area,
                    ],
                };
            default:
                return { title: "Face", readings: [area] };
        }
    }
    const edge = entity.edge;
    const length = { label: "Length", value: formatLength(edge.length, units) };
    switch (edge.type) {
        case "line":
            return { title: "Line", readings: [length], line: [edge.start, edge.end] };
        case "circle":
            return {
                title: edge.closed ? "Circle" : "Arc",
                readings: [
                    { label: "Diameter", value: formatLength(2 * edge.radius, units) },
                    { label: "Radius", value: formatLength(edge.radius, units) },
                    edge.closed ? { label: "Circumference", value: length.value } : length,
                    ...(edge.closed ? [] : [{ label: "Angle", value: formatAngle(edge.length / edge.radius) }]),
                ],
            };
        default:
            return { title: "Edge", readings: [length] };
    }
}

// What a picked thing is for distances and angles: a point (a point, a circle's or sphere's center), a line (a
// straight edge, a cylinder's axis), or a plane.
type Feature =
    | { kind: "point"; point: Vec3; center: boolean }
    | { kind: "line"; point: Vec3; direction: Vec3; axis: boolean; radius?: number }
    | { kind: "plane"; point: Vec3; normal: Vec3 };

function feature(entity: Entity): Feature | null {
    if (entity.kind === "point") {
        return { kind: "point", point: entity.point, center: false };
    }
    if (entity.kind === "face") {
        const face = entity.face;
        switch (face.type) {
            case "plane":
                return { kind: "plane", point: face.point, normal: face.normal };
            case "cylinder":
                return { kind: "line", point: face.point, direction: face.axis, axis: true, radius: face.radius };
            case "cone":
                return { kind: "line", point: face.apex, direction: face.axis, axis: true };
            case "sphere":
                return { kind: "point", point: face.center, center: true };
            default:
                return null;
        }
    }
    const edge = entity.edge;
    switch (edge.type) {
        case "line":
            return { kind: "line", point: edge.start, direction: unit(sub(edge.end, edge.start)), axis: false };
        case "circle":
            return { kind: "point", point: edge.center, center: true };
        default:
            return null;
    }
}

const PARALLEL = 1e-6; // 1 - |cos| below this: parallel (about 0.08°)

/** Where a point lands on a line, or on a plane. */
const ontoLine = (p: Vec3, point: Vec3, direction: Vec3): Vec3 =>
    add(point, scale(direction, dot(sub(p, point), direction)));
const ontoPlane = (p: Vec3, point: Vec3, normal: Vec3): Vec3 => sub(p, scale(normal, dot(sub(p, point), normal)));

/** How far apart two points are, and along each axis. */
function between(a: Vec3, b: Vec3, units: Units, label: string): Measurement {
    return {
        title: label,
        readings: [
            { label, value: formatLength(distance(a, b), units) },
            { label: "ΔX", value: formatLength(Math.abs(b[0] - a[0]), units) },
            { label: "ΔY", value: formatLength(Math.abs(b[1] - a[1]), units) },
            { label: "ΔZ", value: formatLength(Math.abs(b[2] - a[2]), units) },
        ],
        line: [a, b],
    };
}

/** Two picked things, to each other: the distance between them, or the angle. */
export function measureTwo(first: Entity, second: Entity, units: Units): Measurement {
    const a = feature(first);
    const b = feature(second);
    if (!a || !b) {
        return closest(first, second, units);
    }
    // Put them in order, so each pair of kinds is worked out once: points, then lines, then planes.
    const rank = { point: 0, line: 1, plane: 2 };
    const [p, q] = rank[a.kind] <= rank[b.kind] ? [a, b] : [b, a];
    if (p.kind === "point" && q.kind === "point") {
        return between(p.point, q.point, units, p.center || q.center ? "Center distance" : "Distance");
    }
    if (p.kind === "point" && q.kind === "line") {
        const foot = ontoLine(p.point, q.point, q.direction);
        const measurement = between(p.point, foot, units, q.axis ? "Distance to axis" : "Distance to line");
        return { ...measurement, readings: measurement.readings.slice(0, 1) };
    }
    if (p.kind === "point" && q.kind === "plane") {
        const foot = ontoPlane(p.point, q.point, q.normal);
        return {
            title: "Distance to plane",
            readings: [{ label: "Distance", value: formatLength(distance(p.point, foot), units) }],
            line: [p.point, foot],
        };
    }
    if (p.kind === "line" && q.kind === "line") {
        const cos = Math.abs(dot(p.direction, q.direction));
        const label = p.axis && q.axis ? "Center distance" : "Distance";
        if (1 - cos < PARALLEL) {
            const foot = ontoLine(q.point, p.point, p.direction);
            return {
                title: label,
                readings: [{ label, value: formatLength(distance(foot, q.point), units) }],
                line: [foot, q.point],
            };
        }
        // Skew or crossing: the angle between them, and how close they come.
        const n = unit(cross(p.direction, q.direction));
        const gap = Math.abs(dot(sub(q.point, p.point), n));
        return {
            title: "Angle",
            readings: [
                { label: "Angle", value: formatAngle(Math.acos(Math.min(cos, 1))) },
                { label: "Closest", value: formatLength(gap, units) },
            ],
        };
    }
    if (p.kind === "line" && q.kind === "plane") {
        const sin = Math.abs(dot(p.direction, q.normal));
        if (sin < 1e-3) {
            const foot = ontoPlane(p.point, q.point, q.normal);
            const away = distance(p.point, foot);
            return {
                title: p.axis ? "Distance to axis" : "Distance",
                readings: [
                    { label: p.axis ? "To axis" : "Distance", value: formatLength(away, units) },
                    ...(p.radius !== undefined
                        ? [{ label: "To surface", value: formatLength(Math.abs(away - p.radius), units) }]
                        : []),
                ],
                line: [p.point, foot],
            };
        }
        return { title: "Angle", readings: [{ label: "Angle", value: formatAngle(Math.asin(Math.min(sin, 1))) }] };
    }
    if (p.kind === "plane" && q.kind === "plane") {
        const cos = Math.abs(dot(p.normal, q.normal));
        if (1 - cos < PARALLEL) {
            const foot = ontoPlane(p.point, q.point, q.normal);
            return {
                title: "Distance",
                readings: [{ label: "Distance", value: formatLength(distance(p.point, foot), units) }],
                line: [p.point, foot],
            };
        }
        return { title: "Angle", readings: [{ label: "Angle", value: formatAngle(Math.acos(Math.min(cos, 1))) }] };
    }
    return closest(first, second, units);
}

// Faces and edges that are none of those (a fillet's blend, a spline): the closest their vertices come. The true
// closest points may be between vertices, so it's marked as about.
const SAMPLE = 1500;

function sample(points: Vec3[]): Vec3[] {
    if (points.length <= SAMPLE) {
        return points;
    }
    const step = points.length / SAMPLE;
    return Array.from({ length: SAMPLE }, (_, i) => points[Math.floor(i * step)]!);
}

const pointsOf = (entity: Entity): Vec3[] => (entity.kind === "point" ? [entity.point] : sample(entity.points));

function closest(first: Entity, second: Entity, units: Units): Measurement {
    let best = Infinity;
    let pair: [Vec3, Vec3] | undefined;
    for (const a of pointsOf(first)) {
        for (const b of pointsOf(second)) {
            const d = norm(sub(a, b));
            if (d < best) {
                best = d;
                pair = [a, b];
            }
        }
    }
    const exact = first.kind === "point" && second.kind === "point";
    return {
        title: "Distance",
        readings: [{ label: exact ? "Distance" : "Closest, about", value: formatLength(best, units) }],
        line: pair,
    };
}
