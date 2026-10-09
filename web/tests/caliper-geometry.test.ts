import { describe, expect, test } from "vitest";
import { readMesh, writeMesh, type Mesh } from "../src/vault/caliper/format";
import { analyzeEdge, analyzeFace, bodyEdges, eigen, faceOf, type Vec3 } from "../src/vault/caliper/geometry";
import { bodiesOf } from "../src/vault/caliper/load";
import { formatLength, measureOne, measureTwo, type Entity } from "../src/vault/caliper/measure";
import { fromRows, shownNodes, type Model, type Node } from "../src/vault/caliper/model";

// Caliper's geometry, worked out from meshes as Vault for SolidWorks makes them: faces don't share vertices, and each
// face is a run of triangles.

/** A mesh made face by face: each face its own vertices and triangles. */
function meshOf(faces: { points: Vec3[]; triangles: [number, number, number][] }[]): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const runs = faces.map(({ points, triangles }) => {
        const base = positions.length / 3;
        const first = indices.length / 3;
        points.forEach((p) => positions.push(...p));
        triangles.forEach((t) => indices.push(...t.map((i) => i + base)));
        return { first, count: triangles.length };
    });
    return {
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
        bodies: [{ name: "Body", solid: true, color: [0.8, 0.8, 0.8], opacity: 1, faces: runs }],
    };
}

const square = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => ({
    points: [a, b, c, d],
    triangles: [
        [0, 1, 2],
        [0, 2, 3],
    ] as [number, number, number][],
});

/** A box from the origin to (x, y, z), each face facing out. */
function box(x: number, y: number, z: number): Mesh {
    const p = (i: number, j: number, k: number): Vec3 => [i * x, j * y, k * z];
    return meshOf([
        square(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)), // z = 0, facing -z
        square(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)), // z = z, facing +z
        square(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)), // y = 0
        square(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)), // y = y
        square(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)), // x = 0
        square(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)), // x = x
    ]);
}

/** A cylinder's side, radius r around an axis through center along z, height h, in n facets. */
function cylinder(r: number, h: number, n: number, center: Vec3 = [0, 0, 0], span = 2 * Math.PI) {
    const points: Vec3[] = [];
    const triangles: [number, number, number][] = [];
    const steps = span < 2 * Math.PI ? n : n - 1;
    for (let i = 0; i <= steps; i++) {
        const angle = (span * i) / n;
        const [x, y] = [center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)];
        points.push([x, y, center[2]], [x, y, center[2] + h]);
    }
    for (let i = 0; i < steps; i++) {
        triangles.push([2 * i, 2 * i + 2, 2 * i + 3], [2 * i, 2 * i + 3, 2 * i + 1]);
    }
    if (span >= 2 * Math.PI) {
        const last = 2 * steps;
        triangles.push([last, 0, 1], [last, 1, last + 1]);
    }
    return { points, triangles };
}

/** A sphere's surface, in rings. */
function sphere(r: number, center: Vec3) {
    const points: Vec3[] = [];
    const triangles: [number, number, number][] = [];
    const [rings, around] = [12, 16];
    for (let i = 0; i <= rings; i++) {
        const polar = (Math.PI * i) / rings;
        for (let j = 0; j < around; j++) {
            const azimuth = (2 * Math.PI * j) / around;
            points.push([
                center[0] + r * Math.sin(polar) * Math.cos(azimuth),
                center[1] + r * Math.sin(polar) * Math.sin(azimuth),
                center[2] + r * Math.cos(polar),
            ]);
        }
    }
    for (let i = 0; i < rings; i++) {
        for (let j = 0; j < around; j++) {
            const [a, b] = [i * around + j, i * around + ((j + 1) % around)];
            triangles.push([a, a + around, b + around], [a, b + around, b]);
        }
    }
    return { points, triangles };
}

const faceOfMesh = (mesh: Mesh, i: number) => {
    const face = mesh.bodies[0]!.faces[i]!;
    return analyzeFace(mesh.positions, mesh.indices, face.first, face.count);
};

describe("meshes", () => {
    test("read what Vault for SolidWorks writes", () => {
        const mesh = box(40, 30, 5);
        mesh.bodies[0]!.faces[1]!.color = [1, 0, 0];
        const read = readMesh(writeMesh(mesh).buffer);
        expect([...read.positions]).toEqual([...mesh.positions]);
        expect([...read.indices]).toEqual([...mesh.indices]);
        expect(read.bodies).toEqual(mesh.bodies);
        expect(() => readMesh(new TextEncoder().encode("ISO-10303-21;").buffer)).toThrow("isn't a Caliper mesh");
    });

    test("split into bodies, each with only its own vertices", () => {
        const two = box(1, 1, 1);
        const faces = two.bodies[0]!.faces;
        two.bodies = [
            { name: "Lid", solid: true, color: [1, 1, 1], opacity: 1, faces: faces.slice(0, 2) },
            { name: "Sides", solid: true, color: [1, 1, 1], opacity: 0.5, faces: faces.slice(2) },
        ];
        const [lid, sides] = bodiesOf(two);
        expect(lid!.positions.length / 3).toBe(8);
        expect(lid!.faces).toEqual([
            { first: 0, count: 2 },
            { first: 2, count: 2 },
        ]);
        expect(sides!.indices.length / 3).toBe(8);
        expect(Math.max(...sides!.indices)).toBe(15);
        expect(sides!.opacity).toBe(0.5);
    });
});

describe("faces", () => {
    test("a plane: which way it faces, and its area", () => {
        const plate = box(40, 30, 5);
        expect(faceOfMesh(plate, 1)).toMatchObject({ type: "plane", normal: [0, 0, 1], area: 1200 });
        const bottom = faceOfMesh(plate, 0);
        expect(bottom.type === "plane" && bottom.normal[2]).toBeCloseTo(-1, 9);
    });

    test("a cylinder: its radius and axis, exactly, however coarse its facets", () => {
        const hole = meshOf([cylinder(3.175, 5, 24, [30, 15, 0])]);
        const face = faceOfMesh(hole, 0);
        expect(face.type).toBe("cylinder");
        if (face.type === "cylinder") {
            expect(face.radius).toBeCloseTo(3.175, 5);
            expect(face.area).toBeCloseTo(2 * Math.PI * 3.175 * 5, 3); // the cylinder's, not its facets' (0.3% less)
            expect(Math.abs(face.axis[2])).toBeCloseTo(1, 6);
            expect(face.point[0]).toBeCloseTo(30, 4);
            expect(face.point[1]).toBeCloseTo(15, 4);
            expect(face.point[2]).toBeCloseTo(2.5, 4);
        }
        // A quarter of one, as a fillet is.
        const fillet = faceOfMesh(meshOf([cylinder(2, 10, 6, [0, 0, 0], Math.PI / 2)]), 0);
        expect(fillet.type === "cylinder" && fillet.radius).toBeCloseTo(2, 5);
        expect(fillet.area).toBeCloseTo((Math.PI / 2) * 2 * 10, 4);
    });

    test("a sphere, a cone (a countersink's angle), and a surface that's none of them", () => {
        const ball = faceOfMesh(meshOf([sphere(12.7, [1, 2, 3])]), 0);
        expect(ball.type).toBe("sphere");
        expect(ball.type === "sphere" && ball.radius).toBeCloseTo(12.7, 4);
        // A cone's normals aren't all across its axis.
        const cone = meshOf([
            {
                points: Array.from({ length: 16 }, (_, i): Vec3[] => {
                    const a = (2 * Math.PI * i) / 16;
                    return [
                        [10 * Math.cos(a), 10 * Math.sin(a), 0],
                        [5 * Math.cos(a), 5 * Math.sin(a), 8],
                    ];
                }).flat(),
                triangles: Array.from({ length: 15 }, (_, i): [number, number, number][] => [
                    [2 * i, 2 * i + 2, 2 * i + 3],
                    [2 * i, 2 * i + 3, 2 * i + 1],
                ]).flat(),
            },
        ]);
        const countersink = faceOfMesh(cone, 0);
        expect(countersink.type).toBe("cone");
        if (countersink.type === "cone") {
            expect((countersink.halfAngle * 180) / Math.PI).toBeCloseTo((Math.atan(5 / 8) * 180) / Math.PI, 6);
            expect(countersink.apex[2]).toBeCloseTo(16, 4); // r goes 10, 5, 0 at z 0, 8, 16
            expect(Math.abs(countersink.apex[0]) + Math.abs(countersink.apex[1])).toBeLessThan(1e-6);
        }
        // A torus: neither a sphere nor a cone.
        const ring = meshOf([
            {
                points: Array.from({ length: 16 * 12 }, (_, k): Vec3 => {
                    const [u, v] = [(2 * Math.PI * Math.floor(k / 12)) / 16, (2 * Math.PI * (k % 12)) / 12];
                    return [
                        (10 + 3 * Math.cos(v)) * Math.cos(u),
                        (10 + 3 * Math.cos(v)) * Math.sin(u),
                        3 * Math.sin(v),
                    ];
                }),
                triangles: Array.from({ length: 16 * 12 }, (_, k): [number, number, number][] => {
                    const [i, j] = [Math.floor(k / 12), k % 12];
                    const at = (a: number, b: number) => ((a % 16) * 12 + (b % 12)) as number;
                    return [
                        [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
                        [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
                    ];
                }).flat(),
            },
        ]);
        expect(faceOfMesh(ring, 0).type).toBe("other");
    });

    test("a triangle's face, by bisecting the faces' starts", () => {
        const starts = new Uint32Array([0, 2, 4, 9]);
        expect([0, 1, 2, 3, 8, 9, 20].map((t) => faceOf(starts, t))).toEqual([0, 0, 1, 1, 2, 3, 3]);
    });

    test("eigenvectors of a symmetric matrix, smallest first", () => {
        const { values, vectors } = eigen([
            [2, 1, 0],
            [1, 2, 0],
            [0, 0, 5],
        ]);
        expect(values.map((v) => Number(v.toFixed(9)))).toEqual([1, 3, 5]);
        expect(Math.abs(vectors[0]![0]! + vectors[0]![1]!)).toBeLessThan(1e-9); // (1, -1, 0)
    });
});

describe("edges", () => {
    test("a box's twelve, each between two faces", () => {
        const { edges, segments, segmentEdge } = bodyEdges(bodiesOf(box(40, 30, 5))[0]!);
        expect(edges).toHaveLength(12);
        expect(edges.every((edge) => edge.faces.length === 2 && !edge.closed)).toBe(true);
        expect(segments.length / 6).toBe(12);
        expect(new Set(segmentEdge).size).toBe(12);
    });

    test("a hole's rim is one circle", () => {
        // A tube's outside, with a top ring around it: their shared edge goes all the way around.
        const n = 32;
        const ring = {
            points: Array.from({ length: n }, (_, i): Vec3[] => {
                const a = (2 * Math.PI * i) / n;
                return [
                    [5 * Math.cos(a), 5 * Math.sin(a), 10],
                    [8 * Math.cos(a), 8 * Math.sin(a), 10],
                ];
            }).flat(),
            triangles: Array.from({ length: n }, (_, i): [number, number, number][] => {
                const [a, b] = [2 * i, (2 * i + 2) % (2 * n)];
                return [
                    [a, b, b + 1],
                    [a, b + 1, a + 1],
                ];
            }).flat(),
        };
        const tube = bodiesOf(meshOf([cylinder(5, 10, n), ring]))[0]!;
        const { edges } = bodyEdges(tube);
        const rim = edges.find((edge) => edge.faces.length === 2)!;
        expect(rim.closed).toBe(true);
        const points = Array.from({ length: rim.points.length / 3 }, (_, i): Vec3 => [
            rim.points[3 * i]!,
            rim.points[3 * i + 1]!,
            rim.points[3 * i + 2]!,
        ]);
        const circle = analyzeEdge(points, rim.closed);
        expect(circle).toMatchObject({ type: "circle", closed: true });
        expect(circle.type === "circle" && circle.radius).toBeCloseTo(5, 5);
        expect(circle.type === "circle" && circle.center[2]).toBeCloseTo(10, 5);
    });

    test("lines, arcs, and three points that could be on any curve", () => {
        expect(
            analyzeEdge(
                [
                    [0, 0, 0],
                    [5, 0, 0],
                    [10, 0, 0],
                ],
                false,
            ),
        ).toMatchObject({ type: "line", length: 10 });
        const arc = Array.from({ length: 7 }, (_, i): Vec3 => [4 * Math.cos(i / 4), 4 * Math.sin(i / 4), 1]);
        const fitted = analyzeEdge(arc, false);
        expect(fitted).toMatchObject({ type: "circle", closed: false });
        expect(fitted.type === "circle" && fitted.radius).toBeCloseTo(4, 6);
        expect(
            analyzeEdge(
                [
                    [0, 0, 0],
                    [1, 1, 0],
                    [2, 0, 0],
                ],
                false,
            ).type,
        ).toBe("curve");
    });
});

describe("measuring", () => {
    const plane = (normal: Vec3, point: Vec3): Entity => ({
        kind: "face",
        face: { type: "plane", normal, point, area: 100 },
        points: [point],
    });
    const hole = (point: Vec3, radius: number): Entity => ({
        kind: "face",
        face: { type: "cylinder", axis: [0, 0, 1], point, radius, area: 50 },
        points: [point],
    });

    test("what one thing is", () => {
        const reading = measureOne(hole([0, 0, 0], 3.175), "mm");
        expect(reading.title).toBe("Cylinder");
        expect(reading.readings[0]).toEqual({ label: "Diameter", value: "6.350 mm" });
        expect(measureOne(hole([0, 0, 0], 3.175), "in").readings[0]!.value).toBe("0.2500 in");
        expect(measureOne({ kind: "point", point: [1, 2, 3] }, "mm").readings.map((r) => r.value)).toEqual([
            "1.000 mm",
            "2.000 mm",
            "3.000 mm",
        ]);
    });

    test("between two parallel faces, the distance; between others, the angle", () => {
        const top = plane([0, 0, 1], [3, 4, 5]);
        const bottom = plane([0, 0, -1], [10, 10, 0]);
        const thickness = measureTwo(top, bottom, "mm");
        expect(thickness.readings[0]).toEqual({ label: "Distance", value: "5.000 mm" });
        expect(thickness.line).toEqual([
            [3, 4, 5],
            [3, 4, 0],
        ]);
        const side = plane([Math.SQRT1_2, Math.SQRT1_2, 0], [0, 0, 0]);
        expect(measureTwo(top, side, "mm").readings[0]).toEqual({ label: "Angle", value: "90.00°" });
    });

    test("between holes, from center to center; from a hole to a face, to the axis and to the surface", () => {
        const a = hole([0, 0, 2.5], 3.175);
        const b = hole([30, 40, 0], 2);
        expect(measureTwo(a, b, "mm").readings[0]).toEqual({ label: "Center distance", value: "50.000 mm" });
        const wall = plane([1, 0, 0], [20, 0, 0]);
        expect(measureTwo(a, wall, "mm").readings.map((r) => r.value)).toEqual(["20.000 mm", "16.825 mm"]);
    });

    test("from point to point, with how far along each axis", () => {
        const result = measureTwo({ kind: "point", point: [0, 0, 0] }, { kind: "point", point: [3, -4, 12] }, "mm");
        expect(result.readings.map((r) => [r.label, r.value])).toEqual([
            ["Distance", "13.000 mm"],
            ["ΔX", "3.000 mm"],
            ["ΔY", "4.000 mm"],
            ["ΔZ", "12.000 mm"],
        ]);
        expect(formatLength(25.4, "in")).toBe("1.0000 in");
    });
});

describe("the tree", () => {
    const node = (id: string, children: Node[] = []): Node => ({
        id,
        name: id,
        kind: children.length > 0 ? "assembly" : "part",
        matrix: fromRows([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0]),
        hidden: false,
        children,
    });
    const model: Model = { units: "mm", nodes: [node("0", [node("0/0"), node("0/1")]), node("1")] };

    test("hiding a component hides what's in it; isolating one shows only it", () => {
        const all = shownNodes(model, new Set(), null);
        expect([...all].sort()).toEqual(["0", "0/0", "0/1", "1"]);
        expect([...shownNodes(model, new Set(["0"]), null)]).toEqual(["1"]);
        expect([...shownNodes(model, new Set(), new Set(["0"]))].sort()).toEqual(["0", "0/0", "0/1"]);
        expect([...shownNodes(model, new Set(["0/1"]), new Set(["0"]))].sort()).toEqual(["0", "0/0"]);
    });

    test("a component's transform, from the server's rows to three.js's columns", () => {
        expect(model.nodes[0]!.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]);
    });
});
