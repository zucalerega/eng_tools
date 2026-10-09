import { parseCad, type CadFormat } from "./step";

// Reads a STEP or IGES file with OpenCascade off the page's thread (step.ts), and hands back its solids' arrays
// without copying them.

self.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; format: CadFormat }>) => {
    try {
        const file = await parseCad(event.data.bytes, event.data.format);
        const arrays = file.meshes.flatMap((mesh) => [mesh.positions.buffer, mesh.indices.buffer]);
        self.postMessage({ file }, { transfer: arrays });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
