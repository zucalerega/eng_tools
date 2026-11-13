import engineSource from "./engine/engine.py?raw";
import contractSource from "./engine/luna_contract.py?raw";
import validationSource from "./engine/luna_validation.py?raw";
import type { SimulationResult } from "./types";
import workerSource from "./worker.js?raw";

function dataUrl(source: string): string {
    const bytes = new TextEncoder().encode(source);
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return `data:text/javascript;base64,${btoa(binary)}`;
}

const WORKER_URL = dataUrl(workerSource);

export interface TempoRunRequest {
    source: string;
    mapping: string;
    mode: "validate" | "simulate";
    options: {
        clock_mode?: "deterministic" | "realtime";
        speed: number;
        max_duration: number;
    };
}

export interface TempoRunner {
    onStatus?: (message: string, ready: boolean) => void;
    warm?: () => void;
    run(request: TempoRunRequest): Promise<SimulationResult>;
    stop(): void;
}

type WorkerOut =
    | { type: "frame" }
    | { type: "progress"; message: string }
    | { type: "ready" }
    | { type: "startup-error"; message: string }
    | { type: "result"; id: number; result: SimulationResult }
    | { type: "failure"; id: number; message: string };

/**
 * Runs Tempo's Python validation & simulation inside a sandboxed <iframe sandbox="allow-scripts">
 * with an opaque origin, isolated from the Engineering Tools session, cookies, and APIs.
 */
export class TempoSandbox implements TempoRunner {
    onStatus?: (message: string, ready: boolean) => void;

    private frame: HTMLIFrameElement | null = null;
    private ready = false;
    private runId = 0;
    private pending: {
        id: number;
        request: TempoRunRequest;
        timeoutMs: number;
        dispatched: boolean;
        resolve: (result: SimulationResult) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | null;
    } | null = null;
    private startupTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly listener = (event: MessageEvent) => this.handleMessage(event);

    warm(): void {
        this.ensureFrame();
    }

    private ensureFrame(): void {
        if (this.frame) {
            return;
        }
        this.ready = false;
        window.addEventListener("message", this.listener);
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("title", "Tempo Python Simulator");
        frame.style.display = "none";
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>
const worker = new Worker(${JSON.stringify(WORKER_URL)}, { type: "module" });
worker.onmessage = (event) => parent.postMessage(event.data, "*");
worker.onerror = (event) => parent.postMessage({ type: "startup-error", message: event.message || "Python worker stopped" }, "*");
addEventListener("message", (event) => {
    if (event.source === parent) worker.postMessage(event.data);
});
parent.postMessage({ type: "frame" }, "*");
</script>`;
        document.body.appendChild(frame);
        this.frame = frame;
        this.onStatus?.("Loading Python runtime…", false);
        this.startupTimer = setTimeout(() => {
            if (!this.ready) {
                this.onStatus?.("Python runtime timed out while loading.", false);
                this.stop("Python runtime timed out while loading.");
            }
        }, 45000);
    }

    private handleMessage(event: MessageEvent): void {
        if (!this.frame || event.source !== this.frame.contentWindow) {
            return;
        }
        const msg = event.data as WorkerOut | null;
        if (!msg || typeof msg !== "object") {
            return;
        }
        if (msg.type === "frame") {
            this.frame.contentWindow?.postMessage(
                {
                    type: "init",
                    files: {
                        "luna_contract.py": contractSource,
                        "luna_validation.py": validationSource,
                        "engine.py": engineSource,
                    },
                },
                "*",
            );
            return;
        }
        if (msg.type === "progress") {
            this.onStatus?.(msg.message, false);
            return;
        }
        if (msg.type === "ready") {
            this.ready = true;
            if (this.startupTimer) {
                clearTimeout(this.startupTimer);
                this.startupTimer = null;
            }
            this.onStatus?.("Python runtime ready", true);
            this.dispatchPending();
            return;
        }
        if (msg.type === "startup-error") {
            this.onStatus?.(msg.message, false);
            this.stop(msg.message);
            return;
        }
        if (msg.type === "result" && this.pending && msg.id === this.pending.id) {
            const active = this.pending;
            this.pending = null;
            if (active.timer) {
                clearTimeout(active.timer);
            }
            active.resolve(msg.result);
            return;
        }
        if (msg.type === "failure" && this.pending && msg.id === this.pending.id) {
            const active = this.pending;
            this.pending = null;
            if (active.timer) {
                clearTimeout(active.timer);
            }
            active.reject(new Error(msg.message || "Simulation failed"));
        }
    }

    private dispatchPending(): void {
        const active = this.pending;
        if (!active || active.dispatched || !this.ready || !this.frame?.contentWindow) {
            return;
        }
        active.dispatched = true;
        active.timer = setTimeout(() => {
            if (this.pending && this.pending.id === active.id) {
                this.stop("Simulation timed out and was terminated.");
            }
        }, active.timeoutMs);
        this.frame.contentWindow.postMessage(
            {
                type: "run",
                id: active.id,
                source: active.request.source,
                mapping: active.request.mapping,
                mode: active.request.mode,
                options: active.request.options,
            },
            "*",
        );
    }

    run(request: TempoRunRequest): Promise<SimulationResult> {
        if (this.pending) {
            this.stop("Replaced by a newer run.");
        }
        this.ensureFrame();
        const id = ++this.runId;
        const speed = Math.max(1, request.options.speed || 1);
        const limit = Math.max(1, request.options.max_duration || 600);
        const timeoutMs = request.mode === "validate" ? 20000 : Math.max(20000, (limit / speed + 20) * 1000);

        return new Promise<SimulationResult>((resolve, reject) => {
            this.pending = {
                id,
                request,
                timeoutMs,
                dispatched: false,
                resolve,
                reject,
                timer: null,
            };
            if (this.ready) {
                this.dispatchPending();
            }
        });
    }

    stop(reason = "Simulation stopped."): void {
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        if (this.pending) {
            const active = this.pending;
            this.pending = null;
            if (active.timer) {
                clearTimeout(active.timer);
            }
            active.reject(new Error(reason));
        }
        window.removeEventListener("message", this.listener);
        if (this.frame) {
            this.frame.remove();
            this.frame = null;
        }
        this.ready = false;
    }
}
