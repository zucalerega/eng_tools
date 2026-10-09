// occt-import-js: OpenCascade compiled to WebAssembly, which reads STEP and IGES files (its README has the result's
// shape). It has no types of its own.
declare module "occt-import-js" {
    export interface OcctFace {
        first: number; // its first triangle
        last: number; // and its last
        color: [number, number, number] | null;
    }

    export interface OcctMesh {
        name: string;
        color?: [number, number, number];
        brep_faces: OcctFace[];
        attributes: { position: { array: number[] }; normal?: { array: number[] } };
        index: { array: number[] };
    }

    export interface OcctNode {
        name: string;
        meshes: number[];
        children: OcctNode[];
    }

    export interface OcctResult {
        success: boolean;
        root: OcctNode;
        meshes: OcctMesh[];
    }

    export interface OcctParams {
        linearUnit?: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
        linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
        linearDeflection?: number;
        angularDeflection?: number;
    }

    export interface Occt {
        ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult;
        ReadIgesFile(content: Uint8Array, params: OcctParams | null): OcctResult;
    }

    // Emscripten's: wasmBinary is the WebAssembly itself, so it isn't fetched from where the script guesses.
    const occtimportjs: (overrides?: { wasmBinary?: ArrayBuffer }) => Promise<Occt>;
    export default occtimportjs;
}
