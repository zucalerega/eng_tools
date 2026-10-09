import type { OcctNode } from "occt-import-js";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import type { RGB } from "./format";
import { IDENTITY, type Model, type Node, type Shape } from "./model";

// STEP and IGES files, read in the browser by OpenCascade (occt-import-js, compiled to WebAssembly: 7 MB, fetched the
// first time one is opened). Reading a big file takes a while, so it's done in a worker (stepWorker.ts), off the page's
// thread. Their solids come placed where the file has them, each a body whose triangles are in faces, as Caliper's
// meshes are; and their products are the tree, an assembly's parts under it.

export type CadFormat = "step" | "iges";

/** A solid of the file, as the worker hands it over: arrays it can pass without copying. */
export interface CadMesh {
    name: string;
    color: RGB | null;
    faces: { first: number; count: number; color?: RGB }[];
    positions: Float32Array;
    indices: Uint32Array;
}

export interface CadFile {
    root: OcctNode;
    meshes: CadMesh[];
}

const DEFAULT_COLOR: RGB = [0.79, 0.82, 0.93]; // SolidWorks' blue-gray, for solids the file gives no color

// Where the WebAssembly comes from: the app's own copy, unless the tests say otherwise (they read it from disk).
let loadWasm = (): Promise<ArrayBuffer> => fetch(wasmUrl).then((response) => response.arrayBuffer());

export function wasmFrom(load: () => Promise<ArrayBuffer>): void {
    loadWasm = load;
}

/** Read a file with OpenCascade, here (the worker does this too). */
export async function parseCad(bytes: Uint8Array, format: CadFormat, wasm?: ArrayBuffer): Promise<CadFile> {
    const { default: occtimportjs } = await import("occt-import-js");
    const occt = await occtimportjs({ wasmBinary: wasm ?? (await loadWasm()) });
    const result = format === "step" ? occt.ReadStepFile(bytes, null) : occt.ReadIgesFile(bytes, null);
    if (!result.success) {
        throw new Error(`OpenCascade couldn't read this ${format === "step" ? "STEP" : "IGES"} file.`);
    }
    return {
        root: result.root,
        meshes: result.meshes.map((mesh) => ({
            name: mesh.name,
            color: mesh.color ?? null,
            faces: mesh.brep_faces.map((face) => ({
                first: face.first,
                count: face.last - face.first + 1,
                ...(face.color ? { color: face.color } : {}),
            })),
            positions: new Float32Array(mesh.attributes.position.array),
            indices: new Uint32Array(mesh.index.array),
        })),
    };
}

/** Read a file with OpenCascade, in a worker where the browser has them. */
export function readCadFile(bytes: Uint8Array, format: CadFormat): Promise<CadFile> {
    if (typeof Worker === "undefined") {
        return parseCad(bytes, format);
    }
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./stepWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ file?: CadFile; error?: string }>) => {
            worker.terminate();
            if (event.data.file) {
                resolve(event.data.file);
            } else {
                reject(new Error(event.data.error ?? "The file couldn't be read."));
            }
        };
        worker.onerror = (event) => {
            worker.terminate();
            reject(new Error(event.message || "The file couldn't be read."));
        };
        worker.postMessage({ bytes, format }, [bytes.buffer]);
    });
}

/** Caliper's model of a file OpenCascade read: its products as the tree, each solid a body. */
export function modelFromCad(file: CadFile): Model {
    const shapes = file.meshes.map((mesh, i): Shape => ({
        key: `cad:${i}`,
        bodies: [
            {
                name: mesh.name,
                solid: true,
                color: mesh.color ?? DEFAULT_COLOR,
                opacity: 1,
                faces: mesh.faces,
                positions: mesh.positions,
                indices: mesh.indices,
            },
        ],
    }));
    const leaf = (id: string, name: string, meshes: number[]): Node => ({
        id,
        name,
        kind: "part",
        matrix: IDENTITY,
        shape: { key: `cad:${meshes.join(",")}`, bodies: meshes.flatMap((i) => shapes[i]?.bodies ?? []) },
        hidden: false,
        children: [],
    });
    const node = (product: OcctNode, id: string, fallback: string): Node => {
        const name = product.name || fallback;
        if (product.children.length === 0) {
            return leaf(id, name, product.meshes);
        }
        const children = product.children.map((child, i) => node(child, `${id}/${i}`, `${name} ${i + 1}`));
        if (product.meshes.length > 0) {
            children.unshift(leaf(`${id}/own`, name, product.meshes)); // an assembly's own solids
        }
        return { id, name, kind: "assembly", matrix: IDENTITY, hidden: false, children };
    };
    // The file's root is nameless: its products are the tree's top.
    const top = file.root.name || file.root.meshes.length > 0 ? [file.root] : file.root.children;
    return { units: "mm", nodes: top.map((product, i) => node(product, String(i), `Product ${i + 1}`)) };
}
