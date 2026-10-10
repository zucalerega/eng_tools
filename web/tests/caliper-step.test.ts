import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { analyzeFace } from "../src/vault/caliper/geometry";
import { measureTwo, type Entity } from "../src/vault/caliper/measure";
import { modelFromCad, parseCad } from "../src/vault/caliper/step";
import { cadFormat } from "../src/vault/paths";

// STEP files, read by OpenCascade (occt-import-js) as the browser does. tab.step is a 40 x 30 x 5 mm plate with a
// 6.35 mm (1/4") hole through it, its center 10 mm from one end: made with build123d, which is OpenCascade too.

const wasm = () => readFile(resolve(import.meta.dirname, "../node_modules/occt-import-js/dist/occt-import-js.wasm"));
const tab = () => readFile(resolve(import.meta.dirname, "fixtures/tab.step"));

test("files OpenCascade reads, by their names", () => {
    expect(["Tab.STEP", "tab.stp", "Shell.IGS", "a.iges", "Tab.SLDPRT", "Tab.x_t"].map(cadFormat)).toEqual([
        "step",
        "step",
        "iges",
        "iges",
        null,
        null,
    ]);
});

test("a STEP file's solids, in their faces, and what they measure", async () => {
    const binary = await wasm();
    const file = await parseCad(new Uint8Array(await tab()), "step", binary.buffer as ArrayBuffer);
    const model = modelFromCad(file);
    expect(model.units).toBe("mm");
    expect(model.nodes.map((node) => [node.name, node.kind])).toEqual([["Tab", "part"]]);
    const body = model.nodes[0]!.shape!.bodies[0]!;
    expect(body.faces).toHaveLength(7); // six sides, and the hole

    const faces = body.faces.map((face) => analyzeFace(body.positions, body.indices, face.first, face.count));
    expect(faces.filter((face) => face.type === "plane")).toHaveLength(6);
    const hole = faces.find((face) => face.type === "cylinder");
    expect(hole?.type === "cylinder" && 2 * hole.radius).toBeCloseTo(6.35, 4);

    // Its thickness, between top and bottom; and the hole's axis from the near end.
    const entity = (face: (typeof faces)[number]): Entity => ({ kind: "face", face, points: [] });
    const flat = (axis: number, at: number) =>
        faces.find(
            (f) => f.type === "plane" && Math.abs(f.normal[axis]!) > 0.99 && Math.abs(f.point[axis]! - at) < 1e-3,
        )!;
    expect(measureTwo(entity(flat(2, 5)), entity(flat(2, 0)), "mm").readings[0]!.value).toBe("5.000 mm");
    expect(measureTwo(entity(hole!), entity(flat(0, 40)), "mm").readings[0]!.value).toBe("10.000 mm");
});
