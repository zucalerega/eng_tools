import type { MeshBody, RGB } from "./format";

// What Caliper shows, whichever way it came: a part's or an assembly's model from the vault (made by Vault for
// SolidWorks), or a STEP file read in the browser. A tree of nodes (an assembly's components, a part's bodies), each
// that has a shape drawn where its matrix puts it.

export type Units = "mm" | "cm" | "m" | "in" | "ft";

/** A body's triangles, in its part's coordinates (millimeters), in runs that are its faces. */
export interface Body extends MeshBody {
    positions: Float32Array;
    indices: Uint32Array;
}

/** What a node draws: one or more bodies. A part's shape is shared by every component that's that part. */
export interface Shape {
    key: string; // the same for every node that draws it (a part at a version, in a configuration)
    bodies: Body[];
}

/** A vault file, at a version and in a configuration: what an assembly's component is. */
export interface FileRef {
    id: number;
    version: number;
    configuration: string;
}

export interface Node {
    id: string; // where it is in the tree: "2/0/1"
    name: string;
    kind: "assembly" | "part" | "body";
    file?: FileRef;
    matrix: number[]; // 4 x 4, by columns (as three.js keeps them): from its shape's coordinates to the model's
    shape?: Shape;
    hidden: boolean; // as SolidWorks had it
    color?: RGB; // its own, over its shape's
    opacity?: number;
    children: Node[];
    problem?: string; // why there's nothing to draw, in full: the server's reason, a mesh that didn't load
    why?: Why; // and what sort of reason, for the page to sum up
}

/** Why a component draws nothing: what SolidWorks can fix (configuration, unreadable), and what it can't. */
export type Why =
    | "elsewhere" // a sub-assembly none of whose parts are in the vault
    | "configuration" // a part used in a configuration its file has no 3D view of
    | "unreadable" // a part whose file has no 3D view Caliper can read
    | "inside" // a part kept inside an assembly's file (a routed tube) with no shape there that Caliper found
    | "failed"; // a model that didn't load

export interface Model {
    units: Units; // what measurements start in
    nodes: Node[];
}

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A matrix by columns from the server's transform: the rows of a 3 x 4 matrix, rotation then translation. */
export function fromRows(rows: number[]): number[] {
    const at = (i: number) => rows[i] ?? 0;
    return [at(0), at(4), at(8), 0, at(1), at(5), at(9), 0, at(2), at(6), at(10), 0, at(3), at(7), at(11), 1];
}

/** Every node, at every level, parents before children. */
export function* walk(nodes: Node[]): Generator<Node> {
    for (const node of nodes) {
        yield node;
        yield* walk(node.children);
    }
}

/** What's showing: hidden nodes and everything in them aren't, and when some are isolated, only what's in them is. */
export function shownNodes(
    model: Model,
    hidden: ReadonlySet<string>,
    isolated: ReadonlySet<string> | null,
): Set<string> {
    const shown = new Set<string>();
    const visit = (nodes: Node[], inIsolated: boolean) => {
        for (const node of nodes) {
            if (hidden.has(node.id)) {
                continue;
            }
            const inside = inIsolated || isolated === null || isolated.has(node.id);
            if (inside) {
                shown.add(node.id);
            }
            visit(node.children, inside);
        }
    };
    visit(model.nodes, false);
    return shown;
}

/** The nodes SolidWorks had hidden when the model was made: hidden here too, to start with. */
export const initiallyHidden = (model: Model): Set<string> =>
    new Set([...walk(model.nodes)].filter((node) => node.hidden).map((node) => node.id));
