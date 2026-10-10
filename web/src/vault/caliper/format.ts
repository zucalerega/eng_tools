// Caliper's mesh format: a part's shape, as Vault for SolidWorks makes it (server/src/yjsp_server/vault/caliper.py
// has the whole of it). The server sends meshes gzip-compressed, as it keeps them, and the browser unpacks them on the
// way: this reads what's inside. All little-endian: "CMSH", the format's version, the header's length, the header
// (JSON, padded with spaces to a multiple of 4 bytes), the vertices (float32 x, y, z in millimeters), and the
// triangles (uint32 indices, three each).

export type RGB = [number, number, number];

/** One face of a body, as SolidWorks has it: a run of the mesh's triangles. */
export interface MeshFace {
    first: number;
    count: number;
    color?: RGB; // its own, over its body's
}

export interface MeshBody {
    name: string;
    solid: boolean; // a closed solid, which a section fills where it cuts; else a surface
    color: RGB;
    opacity: number;
    faces: MeshFace[];
}

export interface Mesh {
    positions: Float32Array; // x, y, z of each vertex, in millimeters
    indices: Uint32Array; // three vertices per triangle
    bodies: MeshBody[];
}

const MAGIC = "CMSH";
const FORMAT = 1;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

interface Header {
    vertices: number;
    triangles: number;
    bodies: MeshBody[];
}

export class MeshError extends Error {}

/** A mesh, from its bytes (already unpacked). */
export function readMesh(buffer: ArrayBuffer): Mesh {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    if (buffer.byteLength < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) {
        throw new MeshError("That isn't a Caliper mesh.");
    }
    const format = view.getUint32(4, true);
    if (format !== FORMAT) {
        throw new MeshError(`This is a version ${format} mesh, which this page can't read: reload it.`);
    }
    const length = view.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))) as Header;
    const start = 12 + length;
    if (start + 12 * header.vertices + 12 * header.triangles !== buffer.byteLength) {
        throw new MeshError("The mesh's size isn't what its header says.");
    }
    const end = start + 12 * header.vertices;
    return {
        positions: floats(buffer, start, 3 * header.vertices),
        indices: uints(buffer, end, 3 * header.triangles),
        bodies: header.bodies.map((body) => ({
            name: body.name,
            solid: body.solid ?? true,
            color: body.color,
            opacity: body.opacity ?? 1,
            faces: body.faces,
        })),
    };
}

// The format is little-endian, like every computer a browser runs on; anything else reads it number by number.
function floats(buffer: ArrayBuffer, offset: number, count: number): Float32Array {
    if (LITTLE_ENDIAN) {
        return new Float32Array(buffer, offset, count);
    }
    const view = new DataView(buffer, offset, 4 * count);
    return Float32Array.from({ length: count }, (_, i) => view.getFloat32(4 * i, true));
}

function uints(buffer: ArrayBuffer, offset: number, count: number): Uint32Array {
    if (LITTLE_ENDIAN) {
        return new Uint32Array(buffer, offset, count);
    }
    const view = new DataView(buffer, offset, 4 * count);
    return Uint32Array.from({ length: count }, (_, i) => view.getUint32(4 * i, true));
}

/** A mesh's bytes, before they're compressed: for the tests, which make meshes as Vault for SolidWorks does. */
export function writeMesh(mesh: Mesh): Uint8Array<ArrayBuffer> {
    const header: Header = {
        vertices: mesh.positions.length / 3,
        triangles: mesh.indices.length / 3,
        bodies: mesh.bodies,
    };
    let text = JSON.stringify(header);
    text += " ".repeat((4 - (new TextEncoder().encode(text).length % 4)) % 4);
    const json = new TextEncoder().encode(text);
    const out = new Uint8Array(12 + json.length + 4 * mesh.positions.length + 4 * mesh.indices.length);
    const view = new DataView(out.buffer);
    out.set(new TextEncoder().encode(MAGIC), 0);
    view.setUint32(4, FORMAT, true);
    view.setUint32(8, json.length, true);
    out.set(json, 12);
    let offset = 12 + json.length;
    mesh.positions.forEach((value) => (view.setFloat32(offset, value, true), (offset += 4)));
    mesh.indices.forEach((value) => (view.setUint32(offset, value, true), (offset += 4)));
    return out;
}
