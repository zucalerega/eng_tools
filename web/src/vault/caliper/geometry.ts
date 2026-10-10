// The geometry measuring needs. A mesh has only triangles, in runs that are the faces of the solid; but its vertices
// lie on the true surfaces, so fitting them gives what each face is (a plane, a cylinder, a sphere) and its sizes, to
// the precision the mesh keeps (float32). Edges are where each face's triangles end, and fitting their points says
// what each is (a line, a circle).

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => norm(sub(a, b));
export function unit(a: Vec3): Vec3 {
    const length = norm(a);
    return length > 0 ? scale(a, 1 / length) : [0, 0, 0];
}

/** The point i of a list of x, y, z. */
export const pointAt = (positions: ArrayLike<number>, i: number): Vec3 => [
    positions[3 * i] ?? 0,
    positions[3 * i + 1] ?? 0,
    positions[3 * i + 2] ?? 0,
];

/** Where a point goes under a 4 x 4 matrix by columns (three.js's order). */
export function transformPoint(m: number[], p: Vec3): Vec3 {
    const e = (i: number) => m[i] ?? 0;
    return [
        e(0) * p[0] + e(4) * p[1] + e(8) * p[2] + e(12),
        e(1) * p[0] + e(5) * p[1] + e(9) * p[2] + e(13),
        e(2) * p[0] + e(6) * p[1] + e(10) * p[2] + e(14),
    ];
}

/** Where a direction goes under a matrix: turned, not moved. */
export function transformDirection(m: number[], d: Vec3): Vec3 {
    const e = (i: number) => m[i] ?? 0;
    return unit([
        e(0) * d[0] + e(4) * d[1] + e(8) * d[2],
        e(1) * d[0] + e(5) * d[1] + e(9) * d[2],
        e(2) * d[0] + e(6) * d[1] + e(10) * d[2],
    ]);
}

// --- fitting -----------------------------------------------------------------------------------------------------

/** How far from a surface its points may be and still be on it: a few float32 steps at their size. */
function tolerance(points: Vec3[]): number {
    let largest = 0;
    let low: Vec3 = [Infinity, Infinity, Infinity];
    let high: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
        largest = Math.max(largest, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
        low = [Math.min(low[0], p[0]), Math.min(low[1], p[1]), Math.min(low[2], p[2])];
        high = [Math.max(high[0], p[0]), Math.max(high[1], p[1]), Math.max(high[2], p[2])];
    }
    return 16 * largest * 2 ** -23 + 1e-6 * distance(low, high) + 1e-9;
}

function centroid(points: Vec3[]): Vec3 {
    let sum: Vec3 = [0, 0, 0];
    points.forEach((p) => (sum = add(sum, p)));
    return scale(sum, 1 / Math.max(points.length, 1));
}

/** Eigenvalues (smallest first) and their unit eigenvectors, of a symmetric 3 x 3 matrix (Jacobi's method). */
export function eigen(matrix: number[][]): { values: number[]; vectors: Vec3[] } {
    const a = matrix.map((row) => [...row]);
    const v = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];
    const at = (m: number[][], i: number, j: number) => m[i]![j]!;
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = at(a, 0, 1) ** 2 + at(a, 0, 2) ** 2 + at(a, 1, 2) ** 2;
        if (off < 1e-30 * (at(a, 0, 0) ** 2 + at(a, 1, 1) ** 2 + at(a, 2, 2) ** 2) || off === 0) {
            break;
        }
        for (const [p, q] of [
            [0, 1],
            [0, 2],
            [1, 2],
        ] as const) {
            if (at(a, p, q) === 0) {
                continue;
            }
            const theta = (at(a, q, q) - at(a, p, p)) / (2 * at(a, p, q));
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const [akp, akq] = [at(a, k, p), at(a, k, q)];
                a[k]![p] = c * akp - s * akq;
                a[k]![q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const [apk, aqk] = [at(a, p, k), at(a, q, k)];
                a[p]![k] = c * apk - s * aqk;
                a[q]![k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const [vkp, vkq] = [at(v, k, p), at(v, k, q)];
                v[k]![p] = c * vkp - s * vkq;
                v[k]![q] = s * vkp + c * vkq;
            }
        }
    }
    const order = [0, 1, 2].sort((i, j) => at(a, i, i) - at(a, j, j));
    return {
        values: order.map((i) => at(a, i, i)),
        vectors: order.map((i) => unit([at(v, 0, i), at(v, 1, i), at(v, 2, i)])),
    };
}

/** The solution of a small linear system, or null if it has none (Gaussian elimination with pivoting). */
function solve(matrix: number[][], rhs: number[]): number[] | null {
    const n = rhs.length;
    const a = matrix.map((row, i) => [...row, rhs[i]!]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) {
                pivot = row;
            }
        }
        if (Math.abs(a[pivot]![col]!) < 1e-300) {
            return null;
        }
        [a[col], a[pivot]] = [a[pivot]!, a[col]!];
        for (let row = 0; row < n; row++) {
            if (row !== col) {
                const f = a[row]![col]! / a[col]![col]!;
                for (let k = col; k <= n; k++) {
                    a[row]![k]! -= f * a[col]![k]!;
                }
            }
        }
    }
    return a.map((row, i) => row[n]! / row[i]!);
}

/** The covariance of points about their centroid. */
function covariance(points: Vec3[], center: Vec3): number[][] {
    const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    for (const p of points) {
        const d = sub(p, center);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                m[i]![j]! += d[i]! * d[j]!;
            }
        }
    }
    return m;
}

/** The plane points lie in, if they do. */
function fitPlane(points: Vec3[], tol: number): { normal: Vec3; point: Vec3 } | null {
    if (points.length < 3) {
        return null;
    }
    const center = centroid(points);
    const normal = eigen(covariance(points, center)).vectors[0]!;
    return points.every((p) => Math.abs(dot(sub(p, center), normal)) <= tol) ? { normal, point: center } : null;
}

/** Two unit vectors at right angles to a direction, and to each other. */
export function across(direction: Vec3): [Vec3, Vec3] {
    const other: Vec3 = Math.abs(direction[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = unit(cross(direction, other));
    return [u, cross(direction, u)];
}

/** The circle points lie on, around an axis (in the plane across it, wherever they are along it), if they do. */
function fitCircle(points: Vec3[], axis: Vec3, tol: number): { center: Vec3; radius: number } | null {
    if (points.length < 3) {
        return null;
    }
    const origin = centroid(points);
    const [u, v] = across(axis);
    const flat = points.map((p) => {
        const d = sub(p, origin);
        return [dot(d, u), dot(d, v)] as const;
    });
    // Kasa's fit: x² + y² + D x + E y + F = 0, by least squares. The points are exact, so it's exact.
    const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    const r = [0, 0, 0];
    for (const [x, y] of flat) {
        const row = [x, y, 1];
        const w = -(x * x + y * y);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                m[i]![j]! += row[i]! * row[j]!;
            }
            r[i]! += row[i]! * w;
        }
    }
    const solution = solve(m, r);
    if (!solution) {
        return null;
    }
    const [cx, cy] = [-solution[0]! / 2, -solution[1]! / 2];
    const radius = Math.sqrt(cx * cx + cy * cy - solution[2]!);
    if (!Number.isFinite(radius) || flat.some(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - radius) > tol)) {
        return null;
    }
    return { center: add(origin, add(scale(u, cx), scale(v, cy))), radius };
}

/** The sphere points lie on, if they do. */
function fitSphere(points: Vec3[], tol: number): { center: Vec3; radius: number } | null {
    if (points.length < 4) {
        return null;
    }
    const origin = centroid(points);
    const m = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const r = [0, 0, 0, 0];
    for (const p of points) {
        const d = sub(p, origin);
        const row = [d[0], d[1], d[2], 1];
        const w = -dot(d, d);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                m[i]![j]! += row[i]! * row[j]!;
            }
            r[i]! += row[i]! * w;
        }
    }
    const solution = solve(m, r);
    if (!solution) {
        return null;
    }
    const c: Vec3 = [-solution[0]! / 2, -solution[1]! / 2, -solution[2]! / 2];
    const radius = Math.sqrt(dot(c, c) - solution[3]!);
    const center = add(origin, c);
    if (!Number.isFinite(radius) || points.some((p) => Math.abs(distance(p, center) - radius) > tol)) {
        return null;
    }
    return { center, radius };
}

// --- faces -------------------------------------------------------------------------------------------------------

export type FaceGeometry =
    | { type: "plane"; normal: Vec3; point: Vec3; area: number }
    | { type: "cylinder"; axis: Vec3; point: Vec3; radius: number; area: number } // point: on the axis, mid-face
    | { type: "cone"; axis: Vec3; apex: Vec3; halfAngle: number; area: number } // halfAngle: from the axis
    | { type: "sphere"; center: Vec3; radius: number; area: number }
    | { type: "other"; area: number };

/** A face's distinct vertices, and its triangles' unit normals, areas, and a corner of each (slivers left out). */
export function faceTriangles(
    positions: Float32Array,
    indices: Uint32Array,
    first: number,
    count: number,
): { points: Vec3[]; normals: Vec3[]; areas: number[]; corners: Vec3[] } {
    const seen = new Set<number>();
    const points: Vec3[] = [];
    const normals: Vec3[] = [];
    const areas: number[] = [];
    const corners: Vec3[] = [];
    for (let t = first; t < first + count; t++) {
        const vertices = [indices[3 * t]!, indices[3 * t + 1]!, indices[3 * t + 2]!];
        const [a, b, c] = vertices.map((i) => pointAt(positions, i)) as [Vec3, Vec3, Vec3];
        const n = cross(sub(b, a), sub(c, a));
        const twice = norm(n);
        if (twice > 0) {
            normals.push(scale(n, 1 / twice));
            areas.push(twice / 2);
            corners.push(a);
        }
        for (const i of vertices) {
            if (!seen.has(i)) {
                seen.add(i);
                points.push(pointAt(positions, i));
            }
        }
    }
    return { points, normals, areas, corners };
}

/** What surface a face is, from its triangles: a plane, a cylinder, a sphere, or something else. */
export function analyzeFace(positions: Float32Array, indices: Uint32Array, first: number, count: number): FaceGeometry {
    const { points, normals, areas, corners } = faceTriangles(positions, indices, first, count);
    const area = areas.reduce((sum, a) => sum + a, 0);
    const tol = tolerance(points);
    const plane = fitPlane(points, tol);
    if (plane) {
        // Facing out of the solid, as its triangles do.
        let facing: Vec3 = [0, 0, 0];
        normals.forEach((n, i) => (facing = add(facing, scale(n, areas[i]!))));
        const normal = dot(facing, plane.normal) < 0 ? scale(plane.normal, -1) : plane.normal;
        return { type: "plane", normal, point: plane.point, area };
    }
    // A cylinder's normals are all across its axis: the axis is the direction they have least of.
    const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    normals.forEach((n, k) => {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                m[i]![j]! += areas[k]! * n[i]! * n[j]!;
            }
        }
    });
    const { values, vectors } = eigen(m);
    if (values[0]! <= 1e-4 * values[2]!) {
        const axis = vectors[0]!;
        const circle = fitCircle(points, axis, tol);
        if (circle) {
            const along = points.map((p) => dot(sub(p, circle.center), axis));
            const middle = (Math.min(...along) + Math.max(...along)) / 2;
            return {
                type: "cylinder",
                axis,
                point: add(circle.center, scale(axis, middle)),
                radius: circle.radius,
                area: unrolledArea(positions, indices, first, count, circle.center, axis, circle.radius),
            };
        }
    }
    // A cone's normals all lean the same way from its axis, so along it they don't vary at all; a sphere's vary every
    // way. (Two rings of vertices, as a cone's facets have, always lie on some sphere: the normals tell them apart.)
    let mean: Vec3 = [0, 0, 0];
    normals.forEach((n, i) => (mean = add(mean, scale(n, areas[i]! / area))));
    const spread = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    normals.forEach((n, k) => {
        const d = sub(n, mean);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                spread[i]![j]! += areas[k]! * d[i]! * d[j]!;
            }
        }
    });
    const lean = eigen(spread);
    if (lean.values[0]! <= 1e-4 * lean.values[2]!) {
        const axis = lean.vectors[0]!;
        // Every facet's plane goes through the apex: where they all meet.
        const m = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
        ];
        const r = [0, 0, 0];
        normals.forEach((n, k) => {
            const corner = corners[k]!;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    m[i]![j]! += n[i]! * n[j]!;
                }
                r[i]! += n[i]! * dot(n, corner);
            }
        });
        const apex = solve(m, r) as Vec3 | null;
        if (apex) {
            // The vertices are on the cone itself, where the flat facets aren't: its angle is theirs from the apex.
            const angles = points
                .map((p) => sub(p, apex))
                .filter((v) => norm(v) > tol)
                .map((v) => Math.acos(Math.min(Math.abs(dot(v, axis)) / norm(v), 1)));
            const halfAngle = angles.reduce((sum, a) => sum + a, 0) / Math.max(angles.length, 1);
            if (angles.length > 0 && halfAngle > 1e-3) {
                return { type: "cone", axis, apex, halfAngle, area };
            }
        }
        return { type: "other", area };
    }
    const sphere = fitSphere(points, tol);
    if (sphere) {
        return { type: "sphere", center: sphere.center, radius: sphere.radius, area };
    }
    return { type: "other", area };
}

/**
 * A cylinder face's area. Its flat facets cut across the curve, so theirs is a little short (0.3% for a hole in 24
 * facets); unrolled flat, angle times radius by length along the axis, each facet covers just what the face does.
 */
function unrolledArea(
    positions: Float32Array,
    indices: Uint32Array,
    first: number,
    count: number,
    center: Vec3,
    axis: Vec3,
    radius: number,
): number {
    const [u, v] = across(axis);
    const unroll = (i: number): [number, number] => {
        const d = sub(pointAt(positions, i), center);
        return [Math.atan2(dot(d, v), dot(d, u)), dot(d, axis)];
    };
    let area = 0;
    for (let t = first; t < first + count; t++) {
        const [a, b, c] = [unroll(indices[3 * t]!), unroll(indices[3 * t + 1]!), unroll(indices[3 * t + 2]!)];
        // Angles from the first corner's, so a facet across where the angle wraps around stays whole.
        const from = (angle: number) => Math.atan2(Math.sin(angle - a[0]), Math.cos(angle - a[0]));
        const [bx, cx] = [from(b[0]), from(c[0])];
        area += Math.abs(bx * (c[1] - a[1]) - cx * (b[1] - a[1])) / 2;
    }
    return area * radius;
}

/** Which face of a body a triangle is in: faces are runs of triangles, found by bisecting their starts. */
export function faceOf(starts: Uint32Array, triangle: number): number {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid]! <= triangle) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

// --- edges -------------------------------------------------------------------------------------------------------

/** An edge of a body: a line of points (x, y, z...), between the faces it bounds (one, where they don't meet). */
export interface Edge {
    points: Float32Array;
    faces: number[];
    closed: boolean; // a loop: it ends where it starts
}

export interface BodyEdges {
    segments: Float32Array; // each edge's segments, start and end, for drawing
    segmentEdge: Uint32Array; // the edge each segment is part of
    edges: Edge[];
}

/**
 * A body's edges: where its faces' triangles end. Each face's boundary is the sides of its triangles that only one
 * of them has; a side two faces have is an edge between them, and runs of sides between the same faces are one edge.
 * Faces don't share vertices, so they meet where their vertices have the same position.
 */
export function bodyEdges(body: {
    positions: Float32Array;
    indices: Uint32Array;
    faces: { first: number; count: number }[];
}): BodyEdges {
    const { positions, indices, faces } = body;
    // One id for every position, across faces.
    const ids = new Map<string, number>();
    const where: number[] = [];
    const idOf = (vertex: number) => {
        const key = `${positions[3 * vertex]},${positions[3 * vertex + 1]},${positions[3 * vertex + 2]}`;
        let id = ids.get(key);
        if (id === undefined) {
            id = ids.size;
            ids.set(key, id);
            where.push(vertex);
        }
        return id;
    };
    // The boundary sides of each face, and the faces each side is a boundary of.
    const sides = new Map<string, { a: number; b: number; faces: number[] }>();
    faces.forEach((face, f) => {
        const counts = new Map<string, [number, number, number]>();
        for (let t = face.first; t < face.first + face.count; t++) {
            const [a, b, c] = [idOf(indices[3 * t]!), idOf(indices[3 * t + 1]!), idOf(indices[3 * t + 2]!)];
            if (a === b || b === c || c === a) {
                continue; // a sliver with no area
            }
            for (const [p, q] of [
                [a, b],
                [b, c],
                [c, a],
            ] as const) {
                const key = p < q ? `${p}|${q}` : `${q}|${p}`;
                const found = counts.get(key);
                counts.set(key, found ? [found[0], found[1], found[2] + 1] : [Math.min(p, q), Math.max(p, q), 1]);
            }
        }
        for (const [key, [a, b, uses]] of counts) {
            if (uses === 1) {
                const side = sides.get(key);
                if (side) {
                    side.faces.push(f);
                } else {
                    sides.set(key, { a, b, faces: [f] });
                }
            }
        }
    });

    // Chain sides into edges: from vertex to vertex, while one side goes on between the same faces.
    const at = new Map<number, string[]>();
    for (const [key, side] of sides) {
        for (const v of [side.a, side.b]) {
            const list = at.get(v);
            if (list) {
                list.push(key);
            } else {
                at.set(v, [key]);
            }
        }
    }
    const sameFaces = (x: number[], y: number[]) => x.length === y.length && x.every((f) => y.includes(f));
    const used = new Set<string>();
    const edges: Edge[] = [];
    const segments: number[] = [];
    const segmentEdge: number[] = [];
    for (const [start, side] of sides) {
        if (used.has(start)) {
            continue;
        }
        used.add(start);
        const chain = [side.a, side.b];
        const grow = (forward: boolean) => {
            for (;;) {
                const end = forward ? chain[chain.length - 1]! : chain[0]!;
                const next = at.get(end) ?? [];
                if (next.length !== 2) {
                    return; // where three or more edges meet, or one ends
                }
                const key = next.find((k) => !used.has(k));
                const nextSide = key === undefined ? undefined : sides.get(key);
                if (key === undefined || !nextSide || !sameFaces(nextSide.faces, side.faces)) {
                    return;
                }
                used.add(key);
                const other = nextSide.a === end ? nextSide.b : nextSide.a;
                if (forward) {
                    chain.push(other);
                } else {
                    chain.unshift(other);
                }
            }
        };
        grow(true);
        grow(false);
        const points = new Float32Array(chain.length * 3);
        chain.forEach((id, i) => points.set(pointAt(positions, where[id]!), 3 * i));
        for (let i = 0; i + 1 < chain.length; i++) {
            segments.push(...pointAt(positions, where[chain[i]!]!), ...pointAt(positions, where[chain[i + 1]!]!));
            segmentEdge.push(edges.length);
        }
        edges.push({ points, faces: side.faces, closed: chain.length > 2 && chain[0] === chain[chain.length - 1] });
    }
    return { segments: new Float32Array(segments), segmentEdge: new Uint32Array(segmentEdge), edges };
}

export type EdgeGeometry =
    | { type: "line"; start: Vec3; end: Vec3; length: number }
    | { type: "circle"; center: Vec3; axis: Vec3; radius: number; length: number; closed: boolean } // or an arc
    | { type: "curve"; length: number };

/** What curve an edge is, from its points: a line, a circle or an arc of one, or another curve. */
export function analyzeEdge(points: Vec3[], closed: boolean): EdgeGeometry {
    let length = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        length += distance(points[i]!, points[i + 1]!);
    }
    const tol = tolerance(points);
    const [start, end] = [points[0]!, points[points.length - 1]!];
    const direction = unit(sub(end, start));
    if (!closed && norm(direction) > 0) {
        const offLine = (p: Vec3) => norm(cross(sub(p, start), direction));
        if (points.every((p) => offLine(p) <= tol)) {
            return { type: "line", start, end, length };
        }
    }
    // Three points make a circle whatever curve they're on: it takes four to know.
    const distinct = closed ? points.slice(0, -1) : points;
    if (distinct.length >= 4) {
        const plane = fitPlane(distinct, tol);
        const circle = plane && fitCircle(distinct, plane.normal, tol);
        if (plane && circle) {
            return { type: "circle", center: circle.center, axis: plane.normal, radius: circle.radius, length, closed };
        }
    }
    return { type: "curve", length };
}
