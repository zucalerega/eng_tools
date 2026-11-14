import { ApiError, requestBytes } from "../../api";
import { vaultApi, type CaliperComponent, type CaliperModel, type CaliperModelKey } from "../api";
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
        source: model.source,
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

/**
 * Ask the server for something it reads SolidWorks files for, again while it says it's busy reading others (it reads
 * a couple at a time, and an assembly's first look can ask for hundreds): a part isn't missing for having waited.
 */
export async function patiently<T>(work: () => Promise<T>, tries = 12, wait = 2500): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (!(error instanceof ApiError && error.code === "busy") || attempt >= tries) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }
}

/** What a component's shape is of, and where from; and, where it stands in for the one wanted, why that isn't there. */
interface Found {
    shape: Shape;
    source: Source;
    version?: number;
    configuration?: string;
    why?: string;
}

const keyOf = (model: CaliperModelKey) => `${model.file_id}:${model.version}:${model.configuration}`;

/**
 * An assembly's model: its components, where it has them, each part with its own model's mesh (the same part at the
 * same version and configuration comes once).
 *
 * As it is now (latest): each part and sub-assembly at its latest version, as SolidWorks opens it. The server says
 * which sub-assemblies were checked in since the assembly was and have no model yet (wanted): each is made, and the
 * assembly asked for again, so it shows their own components. As it was checked in (not latest): each at the version
 * it had then.
 *
 * A part without a model of the version and configuration wanted has the best the server has or can make of its file
 * (caliperBest): that one, or the nearest, which stands in, and the node says so. One with none, or whose mesh doesn't
 * come, says why and draws nothing, and the rest still does; so does one whose file isn't in the vault. A STEP or IGES
 * file placed in it (SolidWorks' 3D Interconnect) is read as it is, one at a time: OpenCascade takes a lot of memory.
 * Also says how many components are of files you can't see.
 */
export async function assemblyModel(
    fileId: number,
    model: CaliperModel,
    latest: boolean,
    progress: Progress,
): Promise<{ model: Model; leftOut: number }> {
    const ask = () => vaultApi.caliperAssembly(fileId, model.version, model.configuration, latest);
    let assembly = await ask();
    const made = new Set<string>();
    for (let round = 0; round < 8; round++) {
        const wanted = assembly.wanted.filter((sub) => !made.has(keyOf(sub)));
        if (wanted.length === 0) {
            break;
        }
        // One that can't be made (its file unreadable) keeps the components the assembly was checked in with.
        await inTurn(wanted, 3, async (sub) => {
            made.add(keyOf(sub));
            await patiently(() =>
                vaultApi.makeCaliperModel(sub.file_id, sub.version, sub.configuration || undefined),
            ).catch(() => undefined);
        });
        assembly = await ask();
    }

    const loadKey = (c: CaliperComponent) =>
        c.mesh
            ? `mesh:${c.mesh}`
            : c.format
              ? `cad:${c.file_id}:${c.version}`
              : `${c.file_id}:${c.version}:${c.configuration}:${c.pinned}`;
    const wanted = new Map<string, () => Promise<Found>>();
    let cadTurn: Promise<unknown> = Promise.resolve();
    const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
        const run = cadTurn.then(work, work);
        cadTurn = run.catch(() => undefined);
        return run;
    };
    const meshBodies = async (bytes: Promise<ArrayBuffer>) => bodiesOf(readMesh(await bytes));
    const visit = (components: CaliperComponent[]) => {
        for (const c of components) {
            visit(c.children);
            const key = loadKey(c);
            if (c.children.length > 0 || wanted.has(key)) {
                continue;
            }
            if (c.mesh) {
                const [mesh, from] = [c.mesh, c.carrier ?? { file_id: fileId, ...model }];
                wanted.set(key, async () => ({
                    shape: {
                        key,
                        bodies: await meshBodies(
                            vaultApi.caliperMesh(from.file_id, from.version, from.configuration, mesh),
                        ),
                    },
                    source: c.source ?? "file",
                }));
            } else if (c.format && c.file_id !== null && c.version !== null) {
                const [id, version, format] = [c.file_id, c.version, c.format];
                wanted.set(key, () =>
                    oneAtATime(async () => ({
                        shape: { key, bodies: await cadBodies(id, version, format) },
                        source: "cad" as const,
                    })),
                );
            } else if (c.file_id !== null && c.version !== null && c.kind !== "assembly") {
                const [id, version, configuration] = [c.file_id, c.version, c.configuration];
                wanted.set(key, async () => {
                    let shown = { version, configuration, source: c.source ?? ("file" as const) };
                    let why: string | undefined;
                    // An assembly that doesn't say which configuration it uses shows the one the part was saved in,
                    // which the server names.
                    if (!c.model || c.source === null || configuration === "") {
                        const best = await patiently(() =>
                            vaultApi.caliperBest(id, version, configuration, c.pinned),
                        ).catch((error: unknown) => {
                            const message = error instanceof Error ? error.message : String(error);
                            const other =
                                error instanceof ApiError &&
                                ["configuration_not_saved", "no_configuration"].includes(error.code);
                            throw new NoModel(message, other ? "configuration" : "unreadable");
                        });
                        shown = best.model;
                        why = best.missed[0]?.message;
                    }
                    const bodies = await meshBodies(vaultApi.caliperMesh(id, shown.version, shown.configuration));
                    return {
                        shape: { key: `${id}:${shown.version}:${shown.configuration}`, bodies },
                        source: shown.source,
                        version: shown.version,
                        configuration: shown.configuration,
                        ...(why === undefined ? {} : { why }),
                    };
                });
            }
        }
    };
    visit(assembly.components);

    const shapes = new Map<string, Found | Error>();
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

    const problem = (c: CaliperComponent, found: Found | Error | undefined): Pick<Node, "problem" | "why"> => {
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
        if (c.file_id === null && !c.mesh) {
            return {
                problem:
                    `${c.file ?? "Its file"} isn't in the vault, so there's no shape of it to show. It shows once ` +
                    "it's checked in, or once this assembly is checked in from SolidWorks with it open",
                why: "absent",
            };
        }
        if (c.kind === "assembly") {
            return { problem: "Its model has no components", why: "elsewhere" };
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

    // What a part's shape is of, where that isn't the version and configuration the assembly shows it as.
    const instead = (c: CaliperComponent, found: Found | Error | undefined): Pick<Node, "instead"> => {
        if (!found || found instanceof Error || found.version === undefined || found.configuration === undefined) {
            return {};
        }
        const other =
            found.version !== c.version || (c.configuration !== "" && found.configuration !== c.configuration);
        return other
            ? { instead: { version: found.version, configuration: found.configuration, why: found.why ?? "" } }
            : {};
    };

    const node = (c: CaliperComponent, id: string): Node => {
        const leaf = c.children.length === 0;
        const found = leaf ? shapes.get(loadKey(c)) : undefined;
        const drawn = found && !(found instanceof Error) ? found : undefined;
        return {
            id,
            name: c.name,
            kind: leaf && c.kind !== "assembly" ? "part" : "assembly",
            ...(c.file_id !== null && c.version !== null
                ? { file: { id: c.file_id, version: c.version, configuration: c.configuration } }
                : {}),
            ...(c.pinned !== null && c.version !== null && c.pinned !== c.version ? { pinned: c.pinned } : {}),
            matrix: fromRows(c.transform),
            ...(drawn ? { shape: drawn.shape, source: drawn.source } : {}),
            ...instead(c, found),
            ...(c.kind === "assembly" && c.layout !== null && c.version !== null && c.layout !== c.version
                ? { layout: c.layout }
                : {}),
            ...(c.deleted ? { deleted: true } : {}),
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
