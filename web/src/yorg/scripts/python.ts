import { useSyncExternalStore } from "react";
import { channelNamed, datasetList, gatherInputs, handover, type Inputs } from "./inputs";
import type { Step, Timing } from "./progress";
import { floatsOf, PythonSandbox, type Bytes, type FromPython, type PythonTransport } from "./sandbox";
import { slowImports, topImports } from "./tree";
import moduleSource from "./yorg.py?raw";

// Python for the whole tab: one Pyodide (sandbox.ts), started when a page first wants it and kept while the tab is
// open, so leaving the Scripts page and coming back finds it as it was, its imports done and the channels it had.
// It does one thing at a time: runs, in the order asked for, and, with none waiting, a script's slow imports ahead of
// its run. It says what it's doing at every step (progress.ts words them), and keeps each run's output until the page
// lets it go. When nothing has used it for half an hour it stops, to give its memory back.

const IDLE_MS = 30 * 60 * 1000;
const MAX_LINES = 5000; // of a run's printed output: more would slow the page, and nobody reads them all

export type Line = { kind: "stdout" | "stderr"; text: string };

/** One of a run's plots (yorg.plot): its series, each over its own x. */
export interface ScriptPlotData {
    title: string;
    series: { name: string; unit: string; x: Float64Array; y: Float64Array }[];
}

export interface RunOutput {
    lines: Line[];
    dropped: number; // lines printed after MAX_LINES, not kept
    plots: ScriptPlotData[];
    figures: string[]; // object URLs of PNGs
    files: { name: string; url: string }[];
}

export type RunStatus = "queued" | "running" | "done" | "error" | "stopped";

/** A run, from Run to done: how it's going, then how it went, and what it made. */
export interface RunRecord {
    id: string;
    status: RunStatus;
    code: string;
    requested: number; // when Run was pressed (Date.now())
    finished: number | null;
    step: Step | null; // what it's on: its channels coming from the server (queued), or a step in Python (running)
    output: RunOutput;
    timings: Timing[]; // where its time went
    error: string | null; // the traceback, or why it couldn't start
    line: number | null; // the script's line it failed on
    restarted: boolean; // stopped while Python ran it: Python started again, without what it had
}

/** What Python is busy with: starting, getting a script's imports ready, or a run. */
export interface Busy {
    kind: "start" | "prepare" | "run";
    run: string | null;
    since: number;
    step: Step;
    asked: string[]; // the packages the script imports, to name first among those loading
}

export interface PythonState {
    status: "off" | "starting" | "ready" | "failed";
    version: string | null;
    error: string | null; // failed: why
    idle: boolean; // off because nothing used it for a while
    generation: number; // up each time Python starts over: what it had (imports, channels) is gone
    busy: Busy | null;
}

/** A run: a script's code, and the tests attached to it (the first first). */
export interface RunRequest {
    code: string;
    datasets: number[];
}

type Gathered = { inputs: Inputs; at: number; waitedFor: "start" | "prepare" | "run" | null };
type RunJob = { kind: "run"; id: string; request: RunRequest; gathered: Gathered | null };
type Job = { kind: "prepare"; code: string; key: string } | RunJob;

const emptyOutput = (): RunOutput => ({ lines: [], dropped: 0, plots: [], figures: [], files: [] });
const OFF: PythonState = { status: "off", version: null, error: null, idle: false, generation: 0, busy: null };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const buffersOf = (bytes: (Bytes | null)[]): ArrayBuffer[] => bytes.flatMap((one) => (one ? [one.buffer] : []));

/** Let a run's figures and files go. */
function revoke(record: RunRecord): void {
    for (const url of [...record.output.figures, ...record.output.files.map((one) => one.url)]) {
        URL.revokeObjectURL(url);
    }
}

export class PythonSession {
    private transport: PythonTransport | null = null;
    private state: PythonState = OFF;
    private readonly runs = new Map<string, RunRecord>();
    private queue: Job[] = [];
    private active: Job | null = null;
    private readonly prepared = new Set<string>(); // slow imports got ready (as slowImports lists them), this time
    private users = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private soon: ReturnType<typeof setTimeout> | null = null;
    private count = 0;
    private readonly listeners = new Set<() => void>();

    constructor(private make: () => PythonTransport) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    snapshot = (): PythonState => this.state;

    runOf = (id: string): RunRecord | undefined => this.runs.get(id);

    /** A page wants Python (started now, if it isn't). Call what this returns once the page doesn't. */
    acquire(): () => void {
        this.users += 1;
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (!this.transport) {
            this.start();
        }
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.users -= 1;
            if (this.users === 0) {
                this.idleTimer = setTimeout(() => this.sleep(), IDLE_MS);
            }
        };
    }

    /**
     * Run a script. It waits for Python (starting it if need be), for the channels it names to come from the server
     * (they start coming now), and for whatever's before it. Its id is its record's.
     */
    run(request: RunRequest): string {
        this.count += 1;
        const id = `run-${this.count}`;
        this.runs.set(id, {
            id,
            status: "queued",
            code: request.code,
            requested: Date.now(),
            finished: null,
            step: null,
            output: emptyOutput(),
            timings: [],
            error: null,
            line: null,
            restarted: false,
        });
        const job: RunJob = { kind: "run", id, request, gathered: null };
        gatherInputs(request.code, request.datasets, (channels) =>
            this.update(id, { step: { phase: "server", since: Date.now(), channels } }),
        ).then(
            (inputs) => {
                const waitedFor = this.state.status === "starting" ? "start" : (this.active?.kind ?? null);
                job.gathered = { inputs, at: Date.now(), waitedFor };
                if (this.runs.get(id)?.status === "queued") {
                    this.update(id, { step: null });
                }
                this.pump();
            },
            (error: unknown) => {
                // Said now, rather than once Python gets to it.
                const at = this.queue.indexOf(job);
                if (at >= 0) {
                    this.queue.splice(at, 1);
                    this.finish(id, { status: "error", error: `Couldn't get what it needs: ${message(error)}` });
                    this.pump();
                }
            },
        );
        // Before any imports waiting to get ready: those are only ahead of time.
        const prepare = this.queue.findIndex((one) => one.kind === "prepare");
        this.queue.splice(prepare < 0 ? this.queue.length : prepare, 0, job);
        if (!this.transport) {
            this.start();
        }
        this.notify();
        return id;
    }

    /** Get a script's slow imports ready before it runs (unless they are, or a run's waiting: it'll import them). */
    prepare(code: string): void {
        const key = slowImports(code).join(",");
        if (!key || this.prepared.has(key) || (this.active?.kind === "prepare" && this.active.key === key)) {
            return;
        }
        this.queue = this.queue.filter((job) => job.kind !== "prepare"); // only the latest code's
        this.queue.push({ kind: "prepare", code, key });
        this.pump();
    }

    /** Stop a run: one waiting leaves the queue; the one running stops Python, which starts again. */
    stop(id: string): void {
        const at = this.queue.findIndex((job) => job.kind === "run" && job.id === id);
        if (at >= 0) {
            this.queue.splice(at, 1);
            this.finish(id, { status: "stopped" });
            this.pump();
        } else if (this.active?.kind === "run" && this.active.id === id) {
            this.restart();
        }
    }

    /** Stop Python and start it again, without what it had (its imports, channels): a run it was on stops. */
    restart(): void {
        const job = this.active;
        this.transport?.stop();
        this.transport = null;
        this.active = null;
        if (job?.kind === "run") {
            this.finish(job.id, { status: "stopped", restarted: true });
        }
        this.prepared.clear();
        this.state = { ...OFF, generation: this.state.generation + 1 };
        this.start();
    }

    /** Let a run's record go, with its figures and files (a run that's on is stopped first). */
    forget(id: string): void {
        const record = this.runs.get(id);
        if (!record) {
            return;
        }
        if (record.status === "queued" || record.status === "running") {
            this.stop(id);
        }
        revoke(record);
        this.runs.delete(id);
        this.notify();
    }

    /** Start over, with Python from make: a stand-in for tests (jsdom can't run Pyodide), or the sandbox again. */
    reset(make: () => PythonTransport = () => new PythonSandbox()): void {
        this.transport?.stop();
        this.transport = null;
        this.queue = [];
        this.active = null;
        this.runs.forEach(revoke);
        this.runs.clear();
        this.prepared.clear();
        this.users = 0;
        for (const timer of [this.idleTimer, this.soon]) {
            if (timer !== null) {
                clearTimeout(timer);
            }
        }
        this.idleTimer = this.soon = null;
        this.make = make;
        this.state = OFF;
        this.notify();
    }

    private start(): void {
        const transport = this.make();
        this.transport = transport;
        const now = Date.now();
        this.set({
            status: "starting",
            version: null,
            error: null,
            idle: false,
            busy: { kind: "start", run: null, since: now, step: { phase: "python", since: now }, asked: [] },
        });
        transport.start((found) => {
            if (this.transport === transport) {
                this.receive(found);
            }
        });
        transport.post({ type: "init", module: moduleSource });
    }

    /** Nothing's used Python for a while: stop it, to give its memory back. The next page to want it starts it. */
    private sleep(): void {
        this.idleTimer = null;
        if (this.users > 0 || this.active || this.queue.length > 0 || !this.transport) {
            return;
        }
        this.transport.stop();
        this.transport = null;
        this.prepared.clear();
        this.set({ ...OFF, idle: true, generation: this.state.generation + 1 });
    }

    /** Give Python the next thing to do, if it's free: the first run (once its channels are in), else a warm-up. */
    private pump(): void {
        const transport = this.transport;
        if (this.active || this.state.status !== "ready" || !transport) {
            return;
        }
        const job = this.queue[0];
        if (!job || (job.kind === "run" && !job.gathered)) {
            return; // a run whose channels are still coming holds its place, and what's after it waits
        }
        this.queue.shift();
        const now = Date.now();
        if (job.kind === "prepare") {
            if (this.prepared.has(job.key)) {
                this.pump();
                return;
            }
            this.active = job;
            const first = job.key.split(",")[0];
            const step: Step = { phase: "import", since: now, module: first };
            this.set({ busy: { kind: "prepare", run: null, since: now, step, asked: topImports(job.code) } });
            transport.post({ type: "prepare", code: job.code });
            return;
        }
        const gathered = job.gathered!;
        this.active = job;
        const record = this.runs.get(job.id)!;
        const timings: Timing[] = [];
        if (gathered.inputs.fetched) {
            timings.push({ kind: "server", seconds: (gathered.at - record.requested) / 1000 });
        }
        if (gathered.waitedFor) {
            timings.push({ kind: "waiting", seconds: (now - gathered.at) / 1000, reason: gathered.waitedFor });
        }
        const step: Step = { phase: "code", since: now };
        this.update(job.id, { status: "running", step, timings });
        this.set({ busy: { kind: "run", run: job.id, since: now, step, asked: topImports(job.request.code) } });
        transport.post({
            type: "run",
            run: job.id,
            code: job.request.code,
            context: JSON.stringify(gathered.inputs.context),
            keys: gathered.inputs.keys,
        });
    }

    private receive(found: FromPython): void {
        switch (found.type) {
            case "ready":
                this.set({ status: "ready", version: found.version, busy: null });
                this.pump();
                return;
            case "progress": {
                const step: Step = {
                    phase: found.phase,
                    since: Date.now(),
                    packages: found.packages,
                    module: found.module,
                    attempt: found.attempt,
                };
                if (found.run) {
                    this.update(found.run, { step });
                }
                if (this.state.busy) {
                    this.set({ busy: { ...this.state.busy, step } });
                }
                return;
            }
            case "prepared":
                if (this.active?.kind === "prepare") {
                    this.prepared.add(this.active.key);
                    this.active = null;
                }
                this.set({ busy: null });
                this.pump();
                return;
            case "stdout":
            case "stderr": {
                const line: Line = { kind: found.type, text: found.text };
                this.output(found.run, (output) => {
                    if (output.lines.length >= MAX_LINES) {
                        return { ...output, dropped: output.dropped + 1 };
                    }
                    output.lines.push(line); // in place: a long run prints a lot
                    return { ...output };
                });
                return;
            }
            case "plot": {
                const series = { name: found.name, unit: found.unit, x: floatsOf(found.x), y: floatsOf(found.y) };
                this.output(found.run, (output) => {
                    const plots = output.plots.some((plot) => plot.title === found.title)
                        ? output.plots.map((plot) =>
                              plot.title === found.title ? { ...plot, series: [...plot.series, series] } : plot,
                          )
                        : [...output.plots, { title: found.title, series: [series] }];
                    return { ...output, plots };
                });
                return;
            }
            case "figure": {
                const url = URL.createObjectURL(new Blob([found.png], { type: "image/png" }));
                this.output(found.run, (output) => ({ ...output, figures: [...output.figures, url] }));
                return;
            }
            case "file": {
                const url = URL.createObjectURL(new Blob([found.data]));
                this.output(found.run, (output) => ({
                    ...output,
                    files: [...output.files, { name: found.name, url }],
                }));
                return;
            }
            case "done":
            case "error": {
                if (this.active?.kind !== "run" || this.active.id !== found.run) {
                    return; // stopped meanwhile
                }
                this.active = null;
                const before = this.runs.get(found.run)?.timings ?? [];
                const timings = [...before, ...found.timings];
                this.finish(
                    found.run,
                    found.type === "done"
                        ? { status: "done", timings }
                        : { status: "error", timings, error: found.text, line: found.line },
                );
                this.set({ busy: null });
                this.pump();
                return;
            }
            case "request":
                void this.answer(found);
                return;
            case "failed":
                this.failed(found.error);
                return;
        }
    }

    /** What a script asks for, answered read-only: the channels its run named, any channel, the list of tests. */
    private async answer({ id, run, what, args }: Extract<FromPython, { type: "request" }>): Promise<void> {
        const transport = this.transport;
        const job = this.active?.kind === "run" && this.active.id === run ? this.active : null;
        const reply = (value: unknown, transfer: Transferable[] = []) => {
            if (transport && transport === this.transport) {
                transport.post({ type: "response", id, value }, transfer);
            }
        };
        try {
            if (what === "channels") {
                if (!job?.gathered) {
                    throw new Error("There's no run to hand channels to");
                }
                const found = await handover(job.gathered.inputs, strings(args.keys), strings(args.times));
                reply(found, buffersOf(found.flatMap((one) => [one.t, one.v])));
            } else if (what === "channel") {
                const found = await channelNamed(
                    String(args.name ?? ""),
                    args.dataset ?? null,
                    job?.request.datasets ?? [],
                );
                reply(found, buffersOf([found.t, found.v]));
            } else if (what === "datasets") {
                reply(await datasetList());
            } else {
                throw new Error(`A script can't ask for ${what}`);
            }
        } catch (error) {
            if (transport && transport === this.transport) {
                transport.post({ type: "response", id, error: message(error) });
            }
        }
    }

    /** Python couldn't start, or stopped: say why, and let a run it was on go with it. Waiting runs wait for it. */
    private failed(error: string): void {
        const job = this.active;
        this.transport?.stop();
        this.transport = null;
        this.active = null;
        if (job?.kind === "run") {
            this.finish(job.id, { status: "error", error: `Python stopped: ${error}` });
        }
        this.prepared.clear();
        this.set({ status: "failed", error, version: null, busy: null, generation: this.state.generation + 1 });
    }

    private finish(id: string, change: Partial<RunRecord>): void {
        this.update(id, { finished: Date.now(), step: null, ...change });
    }

    private update(id: string, change: Partial<RunRecord>): void {
        const record = this.runs.get(id);
        if (record) {
            this.runs.set(id, { ...record, ...change });
            this.notify();
        }
    }

    /** A run's output changed (not while getting imports ready: that's nobody's). Said soon, not at every line. */
    private output(id: string | null, change: (output: RunOutput) => RunOutput): void {
        const record = id === null ? undefined : this.runs.get(id);
        if (!record) {
            return;
        }
        this.runs.set(record.id, { ...record, output: change(record.output) });
        if (this.soon === null) {
            this.soon = setTimeout(() => this.notify(), 50);
        }
    }

    private set(change: Partial<PythonState>): void {
        this.state = { ...this.state, ...change };
        this.notify();
    }

    private notify(): void {
        if (this.soon !== null) {
            clearTimeout(this.soon);
            this.soon = null;
        }
        this.listeners.forEach((listener) => listener());
    }
}

/** The tab's Python. */
export const python = new PythonSession(() => new PythonSandbox());

/** How Python is, kept current. */
export function usePython(): PythonState {
    return useSyncExternalStore(python.subscribe, python.snapshot);
}

/** A run's record, kept current (null: none, or let go). */
export function useRun(id: string | null): RunRecord | null {
    return useSyncExternalStore(python.subscribe, () => (id === null ? null : (python.runOf(id) ?? null)));
}
