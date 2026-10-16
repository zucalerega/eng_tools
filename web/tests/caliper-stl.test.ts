import { expect, test } from "vitest";
import { analyzeFace } from "../src/vault/caliper/geometry";
import { bodiesOfTriangles, modelFromStl, StlError, stlTriangles } from "../src/vault/caliper/stl";

// STL files: triangles only, which Caliper welds and splits into faces at sharp edges so they measure as CAD files do.

type Triangle = [number, number, number][];

/** A box's twelve triangles, from (x, y, z), its sides dx, dy, dz. */
function box(x: number, y: number, z: number, dx: number, dy: number, dz: number): Triangle[] {
    const p = (i: number, j: number, k: number): [number, number, number] => [x + i * dx, y + j * dy, z + k * dz];
    const quad = (a: Triangle[0], b: Triangle[0], c: Triangle[0], d: Triangle[0]): Triangle[] => [
        [a, b, c],
        [a, c, d],
    ];
    return [
        ...quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)),
        ...quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
        ...quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)),
        ...quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
        ...quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)),
        ...quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
    ];
}

/** A closed cylinder of radius r and height h about z, its side in n facets. */
function cylinder(r: number, h: number, n: number): Triangle[] {
    const at = (i: number, z: number): [number, number, number] => [
        r * Math.cos((2 * Math.PI * i) / n),
        r * Math.sin((2 * Math.PI * i) / n),
        z,
    ];
    const out: Triangle[] = [];
    for (let i = 0; i < n; i++) {
        out.push([at(i, 0), at(i + 1, 0), at(i + 1, h)], [at(i, 0), at(i + 1, h), at(i, h)]);
        out.push([[0, 0, 0], at(i + 1, 0), at(i, 0)], [[0, 0, h], at(i, h), at(i + 1, h)]);
    }
    return out;
}

function binary(triangles: Triangle[]): Uint8Array {
    const bytes = new Uint8Array(84 + 50 * triangles.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, triangles.length, true);
    triangles.forEach((triangle, t) =>
        triangle.forEach((corner, k) =>
            corner.forEach((value, j) => view.setFloat32(84 + 50 * t + 12 + 12 * k + 4 * j, value, true)),
        ),
    );
    return bytes;
}

function text(triangles: Triangle[]): Uint8Array {
    const facets = triangles.map(
        (triangle) =>
            `facet normal 0 0 0\n outer loop\n${triangle.map((c) => `  vertex ${c.join(" ")}\n`).join("")} endloop\nendfacet\n`,
    );
    return new TextEncoder().encode(`solid part\n${facets.join("")}endsolid part\n`);
}

const faceTypes = (stl: Uint8Array) =>
    bodiesOfTriangles(stlTriangles(stl)).map((body) =>
        body.faces.map((face) => analyzeFace(body.positions, body.indices, face.first, face.count)),
    );

test("a box is one closed body of six flat faces, binary or text", () => {
    for (const stl of [binary(box(0, 0, 0, 40, 30, 5)), text(box(0, 0, 0, 40, 30, 5))]) {
        const [body, ...others] = bodiesOfTriangles(stlTriangles(stl));
        expect(others).toEqual([]);
        expect(body!.solid).toBe(true);
        const faces = faceTypes(stl)[0]!;
        expect(faces.map((face) => face.type)).toEqual(Array(6).fill("plane"));
        expect(faces.map((face) => Math.round(face.area)).sort((a, b) => a - b)).toEqual([
            150, 150, 200, 200, 1200, 1200,
        ]);
    }
});

test("a cylinder's facets are one face, measured as a cylinder; its ends are planes", () => {
    const faces = faceTypes(binary(cylinder(3.175, 10, 48)))[0]!;
    expect(faces.map((face) => face.type).sort()).toEqual(["cylinder", "plane", "plane"]);
    const side = faces.find((face) => face.type === "cylinder");
    expect(side?.type === "cylinder" && 2 * side.radius).toBeCloseTo(6.35, 5);
});

test("separate shells are separate bodies; an open one is a surface", () => {
    const open = box(100, 0, 0, 10, 10, 10).slice(2); // its bottom left off
    const bodies = bodiesOfTriangles(stlTriangles(binary([...box(0, 0, 0, 10, 10, 10), ...open])));
    expect(bodies.map((body) => [body.name, body.solid])).toEqual([
        ["Body 1", true],
        ["Body 2", false],
    ]);
    const model = modelFromStl(binary(box(0, 0, 0, 1, 2, 3)), "stl:1:1");
    expect(model.units).toBe("mm");
    expect(model.nodes.map((node) => [node.name, node.kind])).toEqual([["Body", "body"]]);
});

test("a file that isn't STL, or is cut off, says so", () => {
    expect(() => stlTriangles(new TextEncoder().encode("ISO-10303-21;"))).toThrow(StlError);
    const cut = text(box(0, 0, 0, 1, 1, 1)).slice(0, 200);
    expect(() => stlTriangles(cut)).toThrow(/cut off/);
    expect(() => modelFromStl(binary([]), "stl:1:1")).toThrow(/no triangles/);
});
