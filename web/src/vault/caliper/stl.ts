import type { RGB } from "./format";
import { IDENTITY, type Body, type Model, type Node } from "./model";

// STL files: triangles and nothing else, as 3D printers take them. Caliper reads them in the browser and makes faces
// of them, so they're measured as a CAD file's are: the triangles are welded where they meet, each separate shell is a
// body, and a body splits into faces where its surface bends sharply (a cylinder's facets, at a few degrees apart, stay
// one face; a box's sides, at 90, are six). STL keeps no units: its numbers are taken as millimeters.

const DEFAULT_COLOR: RGB = [0.79, 0.82, 0.93]; // SolidWorks' blue-gray, as STEP files' solids without a color have
const SHARP = Math.cos((30 * Math.PI) / 180); // triangles further apart than this are on different faces
const LIMIT = 20_000_000; // triangles: more is a file Caliper would take too long to make faces of

export class StlError extends Error {}

/** The triangles of an STL file, binary or text: nine floats for each, its corners' x, y, z. */
export function stlTriangles(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Binary: an 80-byte header, a count, then 50 bytes for each triangle (its normal, its corners, 2 bytes more).
    // Text starts "solid", but so do some binary headers: the size says which it is.
    if (bytes.length >= 84) {
        const count = view.getUint32(80, true);
        if (84 + 50 * count === bytes.length) {
            if (count > LIMIT) {
                throw new StlError(`This STL file has ${count.toLocaleString()} triangles, more than Caliper reads.`);
            }
            const out = new Float32Array(9 * count);
            for (let t = 0; t < count; t++) {
                for (let k = 0; k < 9; k++) {
                    out[9 * t + k] = view.getFloat32(84 + 50 * t + 12 + 4 * k, true);
                }
            }
            return out;
        }
    }
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*solid/i.test(text)) {
        throw new StlError("This isn't an STL file Caliper can read: it's neither binary STL nor text.");
    }
    const corners: number[] = [];
    for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) {
        corners.push(Number(match[1]), Number(match[2]), Number(match[3]));
        if (corners.length > 9 * LIMIT) {
            throw new StlError("This STL file has more triangles than Caliper reads.");
        }
    }
    // A text file ends with endsolid: one that doesn't was cut off, maybe between two triangles, and isn't all there.
    if (!/endsolid[^\n]*\s*$/i.test(text.slice(-1024)) || corners.length % 9 !== 0) {
        throw new StlError("This STL file ends early: it was cut off, so Caliper doesn't show part of it.");
    }
    if (corners.some((value) => !Number.isFinite(value))) {
        throw new StlError("This STL file has corners that aren't numbers.");
    }
    return new Float32Array(corners);
}

/**
 * Bodies of an STL file's triangles: one for each separate shell (triangles that meet at their sides), each split into
 * faces where neighbors bend apart by more than 30 degrees. Each face has corners of its own, so it's shaded on its own.
 */
export function bodiesOfTriangles(corners: Float32Array): Body[] {
    const count = corners.length / 9;
    // Weld: corners at the same place (to a ten-millionth of the part's size) are one vertex.
    let size = 0;
    for (let i = 0; i < corners.length; i++) {
        size = Math.max(size, Math.abs(corners[i]!));
    }
    const step = Math.max(size, 1e-9) * 1e-7;
    const vertexOf = new Map<string, number>();
    const vertices: number[] = [];
    const corner = new Uint32Array(3 * count);
    for (let c = 0; c < 3 * count; c++) {
        const [x, y, z] = [corners[3 * c]!, corners[3 * c + 1]!, corners[3 * c + 2]!];
        const key = `${Math.round(x / step)},${Math.round(y / step)},${Math.round(z / step)}`;
        let vertex = vertexOf.get(key);
        if (vertex === undefined) {
            vertex = vertices.length / 3;
            vertexOf.set(key, vertex);
            vertices.push(x, y, z);
        }
        corner[c] = vertex;
    }

    // Each triangle's normal (none for a sliver), and the triangles on each side.
    const normals = new Float32Array(3 * count);
    for (let t = 0; t < count; t++) {
        const p = (k: number) => [corners[9 * t + 3 * k]!, corners[9 * t + 3 * k + 1]!, corners[9 * t + 3 * k + 2]!];
        const [a, b, c] = [p(0), p(1), p(2)];
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const length = Math.hypot(n[0]!, n[1]!, n[2]!);
        if (length > 0) {
            normals.set([n[0]! / length, n[1]! / length, n[2]! / length], 3 * t);
        }
    }
    const sides = new Map<number, number[]>();
    const vertexCount = vertices.length / 3;
    const sideKey = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);
    for (let t = 0; t < count; t++) {
        for (let k = 0; k < 3; k++) {
            const [a, b] = [corner[3 * t + k]!, corner[3 * t + ((k + 1) % 3)]!];
            if (a === b) {
                continue;
            }
            const key = sideKey(a, b);
            const found = sides.get(key);
            if (found) {
                found.push(t);
            } else {
                sides.set(key, [t]);
            }
        }
    }
    const neighbors = (t: number): number[] => {
        const out: number[] = [];
        for (let k = 0; k < 3; k++) {
            const [a, b] = [corner[3 * t + k]!, corner[3 * t + ((k + 1) % 3)]!];
            for (const other of a === b ? [] : (sides.get(sideKey(a, b)) ?? [])) {
                if (other !== t) {
                    out.push(other);
                }
            }
        }
        return out;
    };
    const smooth = (a: number, b: number) => {
        const dot =
            normals[3 * a]! * normals[3 * b]! +
            normals[3 * a + 1]! * normals[3 * b + 1]! +
            normals[3 * a + 2]! * normals[3 * b + 2]!;
        const sliver = (t: number) => normals[3 * t] === 0 && normals[3 * t + 1] === 0 && normals[3 * t + 2] === 0;
        return dot >= SHARP || sliver(a) || sliver(b);
    };

    // Shells, then faces in each: triangles reached from one another, across any side, then across smooth ones.
    const spread = (seeds: number[], label: Int32Array, join: (a: number, b: number) => boolean) => {
        let next = 0;
        for (const seed of seeds) {
            if (label[seed] !== -1) {
                continue;
            }
            const pending = [seed];
            label[seed] = next;
            while (pending.length > 0) {
                const t = pending.pop()!;
                for (const other of neighbors(t)) {
                    if (label[other] === -1 && join(t, other)) {
                        label[other] = next;
                        pending.push(other);
                    }
                }
            }
            next++;
        }
        return next;
    };
    const all = Array.from({ length: count }, (_, t) => t);
    const shell = new Int32Array(count).fill(-1);
    const shells = spread(all, shell, () => true);
    const byShell: number[][] = Array.from({ length: shells }, () => []);
    all.forEach((t) => byShell[shell[t]!]!.push(t));
    const face = new Int32Array(count).fill(-1);

    return byShell.map((triangles, s): Body => {
        const faceCount = spread(triangles, face, smooth);
        const byFace: number[][] = Array.from({ length: faceCount }, () => []);
        triangles.forEach((t) => byFace[face[t]!]!.push(t));
        const positions: number[] = [];
        const indices: number[] = [];
        const faces = byFace.map((own) => {
            const first = indices.length / 3;
            const mine = new Map<number, number>(); // the face's own copy of each vertex
            for (const t of own) {
                for (let k = 0; k < 3; k++) {
                    const vertex = corner[3 * t + k]!;
                    let index = mine.get(vertex);
                    if (index === undefined) {
                        index = positions.length / 3;
                        mine.set(vertex, index);
                        positions.push(vertices[3 * vertex]!, vertices[3 * vertex + 1]!, vertices[3 * vertex + 2]!);
                    }
                    indices.push(index);
                }
            }
            return { first, count: own.length };
        });
        // A closed shell, every side of which two of its triangles share, is a solid that sections fill.
        const closed = triangles.every((t) =>
            [0, 1, 2].every((k) => {
                const [a, b] = [corner[3 * t + k]!, corner[3 * t + ((k + 1) % 3)]!];
                return a !== b && sides.get(sideKey(a, b))?.length === 2;
            }),
        );
        return {
            name: shells === 1 ? "Body" : `Body ${s + 1}`,
            solid: closed,
            color: DEFAULT_COLOR,
            opacity: 1,
            faces,
            positions: new Float32Array(positions),
            indices: new Uint32Array(indices),
        };
    });
}

/** Caliper's model of an STL file: its bodies, each a node of the tree, in millimeters. */
export function modelFromStl(bytes: Uint8Array, key: string): Model {
    const bodies = bodiesOfTriangles(stlTriangles(bytes));
    if (bodies.length === 0) {
        throw new StlError("This STL file has no triangles.");
    }
    const nodes = bodies.map((body, i): Node => ({
        id: String(i),
        name: body.name,
        kind: "body",
        matrix: IDENTITY,
        shape: { key: `${key}#${i}`, bodies: [body] },
        hidden: false,
        children: [],
    }));
    return { units: "mm", nodes };
}
