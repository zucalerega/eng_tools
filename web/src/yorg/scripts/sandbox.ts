import workerSource from "./worker.js?raw";
import type { Phase, Timing } from "./progress";

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
// it asks for (python.ts answers: a test's channels, the list of tests), read-only. Stopping it ends the worker; the
// browser keeps Pyodide's files, so starting again needs no download.

/** Bytes in a message: a structured clone, so their buffer is always an ArrayBuffer of their own. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** The editor's questions for Python about a cell's code (line from 1, column from 0). */
export type Service = "complete" | "inspect" | "check";

/** What the page tells Python (worker.js). */
export type ToPython =
    | { type: "init"; module: string } // yorg.py's source
    | { type: "prepare"; code: string } // import a script's slow modules, ahead of its run
    | { type: "tools" } // get the editor's suggestions ready
    | {
          type: "run";
          run: string;
          code: string;
          context: string; // JSON (inputs.ts)
          keys: string[];
          namespace: string | null; // a notebook's: its cells share their variables (null: a script on its own)
          filename: string; // as tracebacks name it: script.py, or a notebook cell's <In [3]>
          install?: string[]; // packages from PyPI ("name==version") to install first, with micropip
          files?: { path: string; data: Bytes }[]; // to write where they say, before it runs
          setup?: string; // Python to run first, in the code's variables (named <setup>)
          finish?: string; // and after the code, unless it failed (named <finish>)
      }
    | {
          type: "service";
          id: number;
          what: Service;
          namespace: string | null;
          code: string;
          line: number;
          column: number;
      }
    | { type: "response"; id: number; value?: unknown; error?: string };

/** What Python tells the page (see worker.js). Output and steps say which run they're from (null: none). */
export type FromPython =
    | { type: "progress"; run: string | null; phase: Phase; packages?: string[]; module?: string; attempt?: number }
    | { type: "ready"; version: string }
    | { type: "prepared" }
    | { type: "stdout" | "stderr"; run: string | null; text: string }
    | {
          type: "plot";
          run: string | null;
          title: string;
          name: string;
          unit: string;
          x: Bytes;
          y: Bytes;
          dataset?: number; // x is this test's times (a Channel's): a page puts them where that test is
      }
    | { type: "figure"; run: string | null; png: Bytes }
    | { type: "file"; run: string | null; name: string; data: Bytes }
    | { type: "report"; run: string | null; key: string; value: string } // for the page that ran it: JSON, by key
    | { type: "done"; run: string; elapsed: number; timings: Timing[] }
    | { type: "error"; run: string; text: string; line: number | null; elapsed: number; timings: Timing[] }
    | { type: "request"; id: number; run: string | null; what: string; args: Record<string, unknown> }
    | { type: "answer"; id: number; value: unknown } // to a service
    | { type: "failed"; error: string };

/** Where Python runs: the sandbox, or, in tests (jsdom can't run Pyodide), something that answers as it would. */
export interface PythonTransport {
    /** Start Python; what it says goes to receive. Messages posted before it's up wait for it. */
    start(receive: (message: FromPython) => void): void;
    /** Tell Python something; buffers in transfer move to it rather than being copied. */
    post(message: ToPython, transfer?: Transferable[]): void;
    /** End it, and what it was doing. */
    stop(): void;
}

/** Python in a sandboxed frame of its own. */
export class PythonSandbox implements PythonTransport {
    private frame: HTMLIFrameElement | null = null;
    private ready = false;
    private waiting: { message: ToPython; transfer: Transferable[] }[] = [];
    private receiver: ((message: FromPython) => void) | null = null;
    private readonly listener = (event: MessageEvent) => this.receive(event);

    start(receive: (message: FromPython) => void): void {
        this.receiver = receive;
        window.addEventListener("message", this.listener);
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("title", "Python");
        frame.style.display = "none";
        // The frame passes messages both ways, moving the buffers a message lists in its transfer.
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>
const worker = new Worker(${JSON.stringify(WORKER_URL)}, { type: "module" });
worker.onmessage = (event) => parent.postMessage(event.data, "*", (event.data && event.data.transfer) || []);
worker.onerror = (event) => parent.postMessage({ type: "failed", error: event.message || "Python stopped" }, "*");
addEventListener("message", (event) => {
    if (event.source === parent) worker.postMessage(event.data, (event.data && event.data.transfer) || []);
});
parent.postMessage({ type: "frame" }, "*");
</script>`;
        document.body.appendChild(frame);
        this.frame = frame;
    }

    post(message: ToPython, transfer: Transferable[] = []): void {
        if (!this.ready) {
            this.waiting.push({ message, transfer });
            return;
        }
        // The frame's origin is opaque: there's no name to give it.
        this.frame?.contentWindow?.postMessage(transfer.length ? { ...message, transfer } : message, "*", transfer);
    }

    stop(): void {
        window.removeEventListener("message", this.listener);
        this.frame?.remove();
        this.frame = null;
        this.ready = false;
        this.waiting = [];
        this.receiver = null;
    }

    private receive(event: MessageEvent): void {
        if (!this.frame || event.source !== this.frame.contentWindow) {
            return; // only our frame's messages
        }
        const message = event.data as FromPython | { type: "frame" };
        if (message.type === "frame") {
            this.ready = true;
            const waiting = this.waiting;
            this.waiting = [];
            waiting.forEach(({ message: next, transfer }) => this.post(next, transfer));
        } else {
            this.receiver?.(message);
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
