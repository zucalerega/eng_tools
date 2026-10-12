import { requestBytes } from "../../api";
import { vaultApi, type CaliperComponent, type CaliperModel } from "../api";
import { readMesh, type Mesh } from "./format";
import { fromRows, IDENTITY, type Body, type Model, type Node, type Shape } from "./model";
import { cadFormat } from "../paths";
import { modelFromCad, readCadFile } from "./step";

// Caliper's model of a file, from wherever it comes: a part's mesh, or an assembly's components and their parts'
// meshes (made by Vault for SolidWorks, or by the server from the files); or a STEP or IGES file, read in the browser.

export type Progress = (done: number, total: number) => void;

/** Why a component's part has no model to show: the server's reason, said as it is. */
class NoModel extends Error {}

/** A mesh's bodies, each with just its own vertices and triangles, its faces in order. */
export function bodiesOf(mesh: Mesh): Body[] {
    return mesh.bodies.map((body) => {
        const remap = new Map<number, number>();
        const corners: number[] = [];
        const faces = body.faces.map((face) => {
            const first = corners.length / 3;
            for (let i = 3 * face.first; i < 3 * (face.first + face.count); i++) {
                const vertex = mesh.indices[i]!;
                let mine = remap.get(vertex);
                if (mine === undefined) {
                    mine = remap.size;
                    remap.set(vertex, mine);
                }
                corners.push(mine);
            }
            return { ...face, first };
        });
        const positions = new Float32Array(3 * remap.size);
        for (const [vertex, mine] of remap) {
            positions.set(mesh.positions.subarray(3 * vertex, 3 * vertex + 3), 3 * mine);
        }
        return { ...body, faces, positions, indices: new Uint32Array(corners) };
    });
}

/** A part's model: its bodies, each a node of the tree. */
export async function partModel(fileId: number, model: CaliperModel): Promise<Model> {
    const mesh = readMesh(await vaultApi.caliperMesh(fileId, model.version, model.configuration));
    const key = `${fileId}:${model.version}:${model.configuration}`;
    const nodes = bodiesOf(mesh).map((body, i): Node => ({
        id: String(i),
        name: body.name || `Body ${i + 1}`,
        kind: "body",
        matrix: IDENTITY,
        shape: { key: `${key}#${i}`, bodies: [body] },
        hidden: false,
        children: [],
    }));
    return { units: model.units, nodes };
}

/** Run work on each item, a few at a time. */
async function inTurn<T>(items: T[], at: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            await work(items[next++]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(at, items.length) }, worker));
}

/**
 * An assembly's model: its components, where it has them, each part with its own model's mesh (the same part at the
 * same version and configuration comes once). A part without a model has one made from its file first, as opening it
 * on its own would; one that can't be made, or whose mesh doesn't come, says so and draws nothing, and the rest still
 * does. Also says how many components are of files you can't see.
 */
export async function assemblyModel(
    fileId: number,
    model: CaliperModel,
    progress: Progress,
): Promise<{ model: Model; leftOut: number }> {
    const assembly = await vaultApi.caliperAssembly(fileId, model.version, model.configuration);
    const keyOf = (c: CaliperComponent) => (c.mesh ? `mesh:${c.mesh}` : `${c.file_id}:${c.version}:${c.configuration}`);
    const wanted = new Map<string, () => Promise<ArrayBuffer>>();
    // A part's model, made from its file where it has none yet: once for each version, however many use it.
    const made = new Map<string, Promise<CaliperModel>>();
    const make = (id: number, version: number): Promise<CaliperModel> => {
        const key = `${id}:${version}`;
        if (!made.has(key)) {
            made.set(key, vaultApi.makeCaliperModel(id, version));
        }
        return made.get(key)!;
    };
    const visit = (components: CaliperComponent[]) => {
        for (const c of components) {
            visit(c.children);
            if (c.mesh) {
                const mesh = c.mesh;
                wanted.set(keyOf(c), () => vaultApi.caliperMesh(fileId, model.version, model.configuration, mesh));
            } else if (c.children.length === 0 && c.file_id !== null && c.version !== null) {
                const [id, version, configuration, own] = [c.file_id, c.version, c.configuration, c.model];
                wanted.set(keyOf(c), async () => {
                    let shown = configuration;
                    if (!own) {
                        const ready = await make(id, version).catch((error: unknown) => {
                            throw new NoModel(error instanceof Error ? error.message : String(error));
                        });
                        // A part's file has the 3D view of the configuration it was saved in: only that one is made,
                        // which an assembly that doesn't say which it uses shows.
                        shown = ready.configuration;
                        if (configuration && shown !== configuration) {
                            throw new NoModel(
                                `v${version} has a 3D view of its ${shown} configuration, not ${configuration}`,
                            );
                        }
                    }
                    return vaultApi.caliperMesh(id, version, shown);
                });
            }
        }
    };
    visit(assembly.components);

    const shapes = new Map<string, Shape | Error>();
    let done = 0;
    progress(0, wanted.size);
    await inTurn([...wanted], 6, async ([key, load]) => {
        try {
            shapes.set(key, { key, bodies: bodiesOf(readMesh(await load())) });
        } catch (error) {
            shapes.set(key, error instanceof Error ? error : new Error(String(error)));
        }
        progress(++done, wanted.size);
    });

    const node = (c: CaliperComponent, id: string): Node => {
        const leaf = c.children.length === 0;
        const found = leaf ? shapes.get(keyOf(c)) : undefined;
        return {
            id,
            name: c.name,
            kind: leaf ? "part" : "assembly",
            ...(c.file_id !== null && c.version !== null
                ? { file: { id: c.file_id, version: c.version, configuration: c.configuration } }
                : {}),
            matrix: fromRows(c.transform),
            ...(found instanceof Error ? {} : found ? { shape: found } : {}),
            hidden: c.hidden,
            ...(c.color ? { color: c.color } : {}),
            ...(c.opacity < 1 ? { opacity: c.opacity } : {}),
            children: c.children.map((child, i) => node(child, `${id}/${i}`)),
            ...(leaf && !found
                ? { problem: `v${c.version} has no 3D model in ${c.configuration || "this configuration"} yet` }
                : found instanceof NoModel
                  ? { problem: found.message }
                  : found instanceof Error
                    ? { problem: `Its 3D model didn't load: ${found.message}` }
                    : {}),
        };
    };
    return {
        model: { units: model.units, nodes: assembly.components.map((c, i) => node(c, String(i))) },
        leftOut: assembly.left_out,
    };
}

/** A STEP or IGES file's model, read from the file itself. */
export async function cadModel(fileId: number, version: number, name: string): Promise<Model> {
    const format = cadFormat(name);
    if (!format) {
        throw new Error(`Caliper reads STEP and IGES files, and ${name} isn't one.`);
    }
    const bytes = new Uint8Array(await requestBytes(vaultApi.downloadUrl(fileId, version)));
    return modelFromCad(await readCadFile(bytes, format));
}
