import { ApiError, requestBytes } from "../../api";
import { vaultApi, type CaliperComponent, type CaliperModel, type CaliperParts } from "../api";
import { readMesh, type Mesh } from "./format";
import { fromRows, IDENTITY, type Body, type Model, type Node, type Shape, type Source, type Why } from "./model";
import { fileFormat } from "../paths";
import { bodiesOfCad, modelFromCad, readCadFile, type CadFormat } from "./step";
import { modelFromStl } from "./stl";

// Caliper's model of a file, from wherever it comes: a part's mesh, or an assembly's components and their parts'
// meshes (made by Vault for SolidWorks, or by the server from the files), or the STEP and IGES files placed in it; or a
// STEP, IGES, or STL file, read in the browser.

export type Progress = (done: number, total: number) => void;

/** Why a component's part has no model to show: the server's reason, said as it is, and what sort of reason. */
class NoModel extends Error {
    constructor(
        message: string,
        readonly why: Why,
    ) {
        super(message);
    }
}

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

/** A STEP or IGES file's solids, read in the browser as opening it on its own would. */
async function cadBodies(fileId: number, version: number, format: CadFormat): Promise<Body[]> {
    const bytes = new Uint8Array(await requestBytes(vaultApi.downloadUrl(fileId, version)));
    return bodiesOfCad(await readCadFile(bytes, format));
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

/** What a component draws, once loaded: a shape's bodies, where they came from, and which version they're of. */
interface Loaded {
    key?: string; // the shape's, where it isn't the component's own (an older version's)
    bodies: Body[];
    source: Source;
    version?: number; // where it isn't the one asked for: the one the assembly was checked in with
    older?: string; // and why the one asked for isn't shown
}

/** Every component, at every level. */
function* components(found: CaliperComponent[]): Generator<CaliperComponent> {
    for (const c of found) {
        yield c;
        yield* components(c.children);
    }
}

/**
 * An assembly's model: its components, where it has them, each part with its own model's mesh (the same part at the
 * same version and configuration comes once). Its parts as it was checked in, or each at its latest (parts), as the
 * server has them; there, a sub-assembly checked in since without a model of that version has the server make one
 * first, so its newer parts show. A part without a model has one made from its file first, as opening it on its own
 * would; at its latest, one that can't be shows the version the assembly was checked in with, and says why; one that
 * can't be shown at all, or whose mesh doesn't come, says so and draws nothing, and the rest still does. A STEP or
 * IGES file placed in it (SolidWorks' 3D Interconnect) is read as it is, one at a time: OpenCascade takes a lot of
 * memory. Also says how many components are of files you can't see.
 */
export async function assemblyModel(
    fileId: number,
    model: CaliperModel,
    parts: CaliperParts,
    progress: Progress,
): Promise<{ model: Model; leftOut: number }> {
    // A version's model, made from its file where it has none yet, in the configuration it's used in (where the
    // assembly says which): once for each version and configuration, however many use it.
    const made = new Map<string, Promise<CaliperModel>>();
    const make = (id: number, version: number, configuration: string): Promise<CaliperModel> => {
        const key = `${id}:${version}:${configuration}`;
        if (!made.has(key)) {
            made.set(key, vaultApi.makeCaliperModel(id, version, configuration || undefined));
        }
        return made.get(key)!;
    };

    const fetchAssembly = () => vaultApi.caliperAssembly(fileId, model.version, model.configuration, parts);
    let assembly = await fetchAssembly();
    // Sub-assemblies checked in since whose newer version has no model yet: made, then asked for again (a few times,
    // for those inside them).
    const tried = new Set<string>();
    for (let round = 0; parts === "latest" && round < 3; round++) {
        const behind = [...components(assembly.components)].filter(
            (c) =>
                c.kind === "assembly" &&
                c.file_id !== null &&
                c.version !== null &&
                (c.latest_version ?? 0) > c.version &&
                !tried.has(`${c.file_id}:${c.latest_version}:${c.configuration}`),
        );
        if (behind.length === 0) {
            break;
        }
        behind.forEach((c) => tried.add(`${c.file_id}:${c.latest_version}:${c.configuration}`));
        const results = await Promise.allSettled(
            behind.map((c) => make(c.file_id!, c.latest_version!, c.configuration)),
        );
        if (!results.some((result) => result.status === "fulfilled")) {
            break;
        }
        assembly = await fetchAssembly();
    }

    const keyOf = (c: CaliperComponent) =>
        c.mesh
            ? `mesh:${c.mesh}`
            : c.format
              ? `cad:${c.file_id}:${c.version}`
              : `${c.file_id}:${c.version}:${c.configuration}`;
    const wanted = new Map<string, () => Promise<Loaded>>();
    let cadTurn: Promise<unknown> = Promise.resolve();
    const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
        const run = cadTurn.then(work, work);
        cadTurn = run.catch(() => undefined);
        return run;
    };
    const meshBodies = async (bytes: Promise<ArrayBuffer>, source: Source) => ({
        bodies: bodiesOf(readMesh(await bytes)),
        source,
    });
    // A part's shape at a version: its own model's (own: where it came from), or one the server makes from its file.
    const partShape = async (id: number, version: number, configuration: string, own: Source | null) => {
        let shown = configuration;
        let source = own;
        if (source === null) {
            // The server reads it from the file: the configuration it was saved in, from its 3D view; another, from
            // the solid SolidWorks kept of it, which it doesn't of every one. An assembly that doesn't say which
            // configuration it uses shows the one it was saved in.
            const ready = await make(id, version, configuration).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                const other =
                    error instanceof ApiError && ["configuration_not_saved", "no_configuration"].includes(error.code);
                throw new NoModel(message, other ? "configuration" : "unreadable");
            });
            shown = ready.configuration;
            source = ready.source;
        }
        return meshBodies(vaultApi.caliperMesh(id, version, shown), source);
    };
    const visit = (found: CaliperComponent[]) => {
        for (const c of found) {
            visit(c.children);
            if (c.mesh) {
                const mesh = c.mesh;
                // Its source is the server's to say; one from before it did is the assembly's file's.
                const source = c.source ?? (c.virtual ? "solid" : "saved_view");
                wanted.set(keyOf(c), () =>
                    meshBodies(vaultApi.caliperMesh(fileId, model.version, model.configuration, mesh), source),
                );
            } else if (c.format && c.children.length === 0 && c.file_id !== null && c.version !== null) {
                const [id, version, format] = [c.file_id, c.version, c.format];
                wanted.set(keyOf(c), async () => ({
                    bodies: await oneAtATime(() => cadBodies(id, version, format)),
                    source: "browser",
                }));
            } else if (c.children.length === 0 && c.file_id !== null && c.version !== null && c.kind !== "assembly") {
                const [id, version, configuration] = [c.file_id, c.version, c.configuration];
                const own = c.model ? (c.source ?? "file") : null;
                const checkedIn = c.checked_in_version ?? null;
                wanted.set(keyOf(c), async (): Promise<Loaded> => {
                    try {
                        return await partShape(id, version, configuration, own);
                    } catch (error) {
                        if (checkedIn === null || checkedIn === version || !(error instanceof NoModel)) {
                            throw error;
                        }
                        // Its latest can't be shown: the version the assembly was checked in with, which says why.
                        const older = await partShape(id, checkedIn, configuration, null).catch(() => {
                            throw error;
                        });
                        const why = `v${version}, its latest, has no 3D model: ${error.message}`;
                        return { ...older, key: `${id}:${checkedIn}:${configuration}`, version: checkedIn, older: why };
                    }
                });
            }
        }
    };
    visit(assembly.components);

    const shapes = new Map<string, Loaded | Error>();
    let done = 0;
    progress(0, wanted.size);
    await inTurn([...wanted], 6, async ([key, load]) => {
        try {
            shapes.set(key, await load());
        } catch (error) {
            shapes.set(key, error instanceof Error ? error : new Error(String(error)));
        }
        progress(++done, wanted.size);
    });
    // One shape for each, however many components draw it.
    const drawn = new Map<string, Shape>();
    const shapeOf = (key: string, loaded: Loaded): Shape => {
        const shapeKey = loaded.key ?? key;
        if (!drawn.has(shapeKey)) {
            drawn.set(shapeKey, { key: shapeKey, bodies: loaded.bodies, source: loaded.source });
        }
        return drawn.get(shapeKey)!;
    };

    const problem = (c: CaliperComponent, found: Loaded | Error | undefined): Pick<Node, "problem" | "why"> => {
        if (c.children.length > 0 || (found && !(found instanceof Error))) {
            return {};
        }
        if (c.virtual && !c.mesh) {
            return {
                problem:
                    "It's kept inside its assembly's file (as routed tubes are), and Caliper found no shape of it " +
                    "there: SolidWorks saved it empty, or the sub-assembly that keeps it isn't in the vault",
                why: "inside",
            };
        }
        if (c.kind === "assembly") {
            // Nothing under it: none of its parts were found in the vault.
            return { problem: "Caliper found none of its parts in the vault", why: "elsewhere" };
        }
        if (found instanceof NoModel) {
            return { problem: found.message, why: found.why };
        }
        if (found instanceof Error) {
            return { problem: `Its 3D model didn't load: ${found.message}`, why: "failed" };
        }
        return {
            problem: `v${c.version} has no 3D model in ${c.configuration || "this configuration"} yet`,
            why: "unreadable",
        };
    };

    const node = (c: CaliperComponent, id: string): Node => {
        const leaf = c.children.length === 0;
        const found = leaf ? shapes.get(keyOf(c)) : undefined;
        const loaded = found instanceof Error ? undefined : found;
        return {
            id,
            name: c.name,
            kind: leaf && c.kind !== "assembly" ? "part" : "assembly",
            ...(c.file_id !== null && c.version !== null
                ? {
                      file: { id: c.file_id, version: loaded?.version ?? c.version, configuration: c.configuration },
                      checkedIn: c.checked_in_version ?? null,
                      ...(c.latest_version ? { latest: c.latest_version } : {}),
                  }
                : {}),
            ...(loaded?.older ? { older: loaded.older } : {}),
            matrix: fromRows(c.transform),
            ...(loaded ? { shape: shapeOf(keyOf(c), loaded) } : {}),
            hidden: c.hidden,
            ...(c.color ? { color: c.color } : {}),
            ...(c.opacity < 1 ? { opacity: c.opacity } : {}),
            children: c.children.map((child, i) => node(child, `${id}/${i}`)),
            ...problem(c, found),
        };
    };
    return {
        model: { units: model.units, nodes: assembly.components.map((c, i) => node(c, String(i))) },
        leftOut: assembly.left_out,
    };
}

/** A STEP, IGES, or STL file's model, read from the file itself. */
export async function cadModel(fileId: number, version: number, name: string): Promise<Model> {
    const format = fileFormat(name);
    if (!format) {
        throw new Error(`Caliper reads STEP, IGES, and STL files, and ${name} isn't one.`);
    }
    const bytes = new Uint8Array(await requestBytes(vaultApi.downloadUrl(fileId, version)));
    if (format === "stl") {
        return modelFromStl(bytes, `stl:${fileId}:${version}`);
    }
    return modelFromCad(await readCadFile(bytes, format));
}
