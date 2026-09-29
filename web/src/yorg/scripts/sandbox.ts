import workerSource from "./worker.js?raw";
import moduleSource from "./yorg.py?raw";

/** The worker's source as a data: URL, which a sandboxed frame can start a module worker from (not a blob's). */
function dataUrl(source: string): string {
    const bytes = new TextEncoder().encode(source);
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return `data:text/javascript;base64,${btoa(binary)}`;
}

const WORKER_URL = dataUrl(workerSource);

// Where scripts run: Pyodide in a worker, in an iframe sandboxed to scripts alone. Its origin is its own (not the
// site's), so a script can't reach the site, its API, or who's signed in, whoever wrote it: the page gives it only what
// it asks for through answer() (a test's channels, the list of tests), read-only. Stopping a script ends the worker, and
// the next run starts Python again (the browser has its files by then, so it's quick).

/** Bytes in a message: a structured clone, so their buffer is always an ArrayBuffer of their own. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** What the worker sends the page (see worker.js). */
export type FromPython =
    | { type: "status"; text: string }
    | { type: "ready"; version: string }
    | { type: "stdout" | "stderr"; text: string }
    | { type: "plot"; title: string; name: string; unit: string; x: Bytes; y: Bytes }
    | { type: "figure"; png: Bytes }
    | { type: "file"; name: string; data: Bytes }
    | { type: "done"; elapsed: number }
    | { type: "error"; text: string; elapsed: number }
    | { type: "failed"; error: string };

type Request = { type: "request"; id: number; what: string; args: Record<string, unknown> };

/** What a run starts with: the test picked, and the channels the script names (loaded already). */
export interface RunContext {
    dataset: {
        id: number;
        name: string;
        channels: { name: string; unit: string; kind: string; labels: string[] }[];
    } | null;
    t0: number | null;
}

export interface Preloaded {
    name: string;
    unit: string;
    labels: string[];
    dataset: string;
    t: Bytes; // float64s, little-endian
    v: Bytes;
}

/** The page's side of the sandbox: one Python, run by one script at a time. */
export class PythonSandbox {
    private frame: HTMLIFrameElement | null = null;
    private readonly listener = (event: MessageEvent) => this.receive(event);

    constructor(
        private readonly onMessage: (message: FromPython) => void,
        private readonly answer: (what: string, args: Record<string, unknown>) => Promise<unknown>,
    ) {
        window.addEventListener("message", this.listener);
    }

    /** Start Python (if it isn't started already): it says "ready" when it can run a script. */
    start(): void {
        if (this.frame) {
            return;
        }
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("title", "Python");
        frame.style.display = "none";
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>
const worker = new Worker(${JSON.stringify(WORKER_URL)}, { type: "module" });
worker.onmessage = (event) => parent.postMessage(event.data, "*");
worker.onerror = (event) => parent.postMessage({ type: "failed", error: event.message || "Python stopped" }, "*");
addEventListener("message", (event) => { if (event.source === parent) worker.postMessage(event.data); });
parent.postMessage({ type: "frame" }, "*");
</script>`;
        document.body.appendChild(frame);
        this.frame = frame;
    }

    /** Run a script (Python must be ready). */
    run(code: string, context: RunContext, preloaded: Preloaded[]): void {
        this.post({ type: "run", code, context, preloaded });
    }

    /** Stop what's running, and Python with it (start() starts it again). */
    stop(): void {
        this.frame?.remove();
        this.frame = null;
    }

    dispose(): void {
        this.stop();
        window.removeEventListener("message", this.listener);
    }

    private post(message: unknown): void {
        this.frame?.contentWindow?.postMessage(message, "*"); // the frame's origin is opaque: no name to give it
    }

    private receive(event: MessageEvent): void {
        if (!this.frame || event.source !== this.frame.contentWindow) {
            return; // only our frame's messages
        }
        const message = event.data as FromPython | Request | { type: "frame" };
        if (message.type === "frame") {
            this.post({ type: "init", module: moduleSource });
        } else if (message.type === "request") {
            this.answer(message.what, message.args ?? {}).then(
                (value) => this.post({ type: "response", id: message.id, value }),
                (error: unknown) =>
                    this.post({
                        type: "response",
                        id: message.id,
                        error: error instanceof Error ? error.message : String(error),
                    }),
            );
        } else {
            this.onMessage(message);
        }
    }
}

/** Float64s as their bytes (a copy: the plots keep the originals). */
export function bytesOf(values: Float64Array): Bytes {
    return new Uint8Array(values.slice().buffer);
}

/** Bytes (as the worker sends them) as float64s. */
export function floatsOf(bytes: Bytes): Float64Array {
    return new Float64Array(bytes.slice().buffer);
}
