import { useEffect, useMemo, useRef, useState } from "react";
import { request } from "../../api";
import { Dialog, Notice } from "../../components";
import { yorg, type Dataset, type DatasetDetail } from "../api";
import { usePlotColors } from "../colors";
import { readHandoff, starterScript } from "../analysis";
import { dataset as loadDataset, samplesWhenReady, useLoaded } from "../data";
import type { AxisSpec } from "../layout";
import { storedT0 } from "../pages";
import { Plot, type PlotSeries, type TimeAxis } from "../Plot";
import { Samples, sampleAt } from "../samples";
import { formatTick, formatValue, ticks } from "../scale";
import { scriptsApi, type Script } from "./api";
import type { Attached } from "./complete";
import { DataPanel } from "./DataPanel";
import { Editor, type EditorHandle } from "./Editor";
import { EXAMPLES } from "./examples";
import { bytesOf, floatsOf, PythonSandbox, type FromPython, type Preloaded, type RunContext } from "./sandbox";
import { channelsToLoad, folderTree, nameOfFile, tidyFolder, type Folder } from "./tree";
import "../models/models.css";
import "./scripts.css";

// Yorg's Python window (Scripts, in the preview while it's tried out): scripts that pull tests' channels and work them
// over, with NumPy, SciPy, pandas, matplotlib, and CoolProp, run in the browser (sandbox.ts). A script works on the
// tests attached to it (Data, beside it: DataPanel.tsx), and keeps them. Scripts are kept on the server in folders, for
// every admin; .py files upload as scripts and scripts download as them. A dataset's or view's page opens a script on
// what it had (analysis.ts).

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const DATASETS_KEY = "yorg.scripts.datasets"; // the tests attached last, for a new script
const COLORS = ["#2f7ed8", "#e0a500", "#2aa876", "#d64541", "#8e5bd1", "#e67e22", "#16a0b5", "#7f8c8d"];

/** What's open in the editor: a saved script, an example (saved only as a copy), or a new one. */
interface Open {
    id: string | null; // saved as, if it is
    example: string | null; // the example it is, if it is
    name: string;
    folder: string;
    code: string;
    datasets: number[]; // the tests attached, the first first
    dirty: boolean;
}

type Line = { kind: "stdout" | "stderr" | "error" | "note"; text: string };

interface Output {
    lines: Line[];
    plots: { title: string; series: { name: string; unit: string; x: Float64Array; y: Float64Array }[] }[];
    figures: string[]; // object URLs of PNGs
    files: { name: string; url: string }[];
}

const EMPTY_OUTPUT: Output = { lines: [], plots: [], figures: [], files: [] };

type Python =
    | { state: "loading"; text: string }
    | { state: "ready"; version: string }
    | { state: "running"; started: number; text: string }
    | { state: "failed"; error: string };

type Asking = { ask: "save-as" } | { ask: "delete" } | { ask: "discard"; then: () => void } | null;

const newScript = (datasets: number[]): Open => ({
    id: null,
    example: null,
    name: "New script",
    folder: "",
    code: "# Your analysis. Click a channel under Data to put it in, or type its name in quotes.\n",
    datasets,
    dirty: false,
});

/** The tests to start with: those a page sent (?dataset=5), or those attached here last. */
function storedDatasets(): number[] {
    const asked = Number(new URLSearchParams(window.location.search).get("dataset"));
    if (Number.isFinite(asked) && asked > 0) {
        return [asked];
    }
    try {
        const found: unknown = JSON.parse(window.localStorage.getItem(DATASETS_KEY) ?? "[]");
        return Array.isArray(found) ? found.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
    } catch {
        return [];
    }
}

function storeDatasets(ids: number[]) {
    try {
        window.localStorage.setItem(DATASETS_KEY, JSON.stringify(ids));
    } catch {
        // storage blocked: they're attached for this visit
    }
}

function download(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/x-python" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

/** One of a script's plots (yorg.plot): its series over their x, zoomable like Yorg's. */
function ScriptPlot({ title, series }: Output["plots"][number]) {
    const colors = usePlotColors();
    const prepared = useMemo(
        () =>
            series.map((one, index) => {
                // Yorg's plots want x in order: a script's may not have it so.
                const order = Array.from(one.x.keys()).sort((a, b) => one.x[a]! - one.x[b]!);
                const x = Float64Array.from(order, (i) => one.x[i]!);
                const y = Float64Array.from(order, (i) => one.y[i]!);
                return {
                    id: `${title}:${index}`,
                    name: one.name,
                    color: COLORS[index % COLORS.length]!,
                    width: 1.5,
                    step: false,
                    axis: "a",
                    samples: new Samples(x, y),
                    placement: { shift: 0, scale: 1, offset: 0 },
                    unit: one.unit,
                    labels: null,
                } satisfies PlotSeries & { name: string };
            }),
        [series, title],
    );
    const span = useMemo((): [number, number] => {
        let low = Infinity;
        let high = -Infinity;
        for (const one of prepared) {
            const times = one.samples.times;
            if (times.length) {
                low = Math.min(low, times[0]!);
                high = Math.max(high, times[times.length - 1]!);
            }
        }
        return Number.isFinite(low) && high > low ? [low, high] : [0, 1];
    }, [prepared]);
    const [window, setWindow] = useState<[number, number] | null>(null);
    const [cursor, setCursor] = useState<number | null>(null);
    const time: TimeAxis = { ticks, label: (x, step) => formatTick(x, step) };
    const axes: AxisSpec[] = [{ id: "a", side: "left", label: "", min: null, max: null }];
    const readouts = new Map(
        prepared.map((one) => [one.id, cursor === null ? null : sampleAt(one.samples, cursor, one.placement)] as const),
    );
    const nothing = () => {};
    return (
        <div className="scripts-plot">
            <div className="dev-legend">
                <strong>{title}</strong>
                {prepared.map((one) => {
                    const point = readouts.get(one.id);
                    return (
                        <span key={one.id} className="dev-swatch">
                            <i style={{ background: one.color }} />
                            {one.name}
                            {point && ` ${formatValue(point.y)}${one.unit ? ` ${one.unit}` : ""}`}
                        </span>
                    );
                })}
            </div>
            <Plot
                label={title}
                series={prepared}
                axes={axes}
                height={220}
                window={window ?? span}
                time={time}
                marks={[]}
                shading={[]}
                cursor={cursor}
                readouts={readouts}
                gutters={{ left: 1, right: 0 }}
                colors={colors}
                onCursor={setCursor}
                onWindow={(next) => setWindow(next)}
                onAxis={nothing}
                onMenu={nothing}
                notes={[]}
                placing={false}
                onPlace={nothing}
                measure={null}
                onNote={nothing}
                onEditNote={nothing}
                onMoveMark={nothing}
            />
        </div>
    );
}

export function ScriptsPage() {
    useLoaded();
    const [scripts, setScripts] = useState<Script[] | null>(null);
    const [datasets, setDatasets] = useState<Dataset[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    const [open, setOpen] = useState<Open>(() => newScript(storedDatasets()));
    const [python, setPython] = useState<Python>({ state: "loading", text: "Starting Python…" });
    const [output, setOutput] = useState<Output>(EMPTY_OUTPUT);
    const [asking, setAsking] = useState<Asking>(null);
    const [saveAs, setSaveAs] = useState({ name: "", folder: "" });
    const [search, setSearch] = useState("");
    const [closed, setClosed] = useState<Set<string>>(new Set());
    const sandbox = useRef<PythonSandbox | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const editor = useRef<EditorHandle | null>(null);
    const details = useRef(new Map<number, DatasetDetail>());
    // What the sandbox calls: this render's, so they see the test picked now.
    const handlers = useRef<{
        receive: (found: FromPython) => void;
        answer: (what: string, args: Record<string, unknown>) => Promise<unknown>;
    } | null>(null);

    // Python starts when the page opens, so it's ready by the time a script is.
    useEffect(() => {
        const box = new PythonSandbox(
            (found) => handlers.current?.receive(found),
            (what, args) => handlers.current?.answer(what, args) ?? Promise.reject(new Error("The page is closing")),
        );
        sandbox.current = box;
        box.start();
        return () => box.dispose();
    }, []);

    useEffect(() => {
        Promise.all([scriptsApi.list(), request<Dataset[]>("GET", "/api/yorg/datasets")]).then(
            ([saved, all]) => {
                setScripts(saved);
                const ready = all.filter((one) => one.status === "ready");
                setDatasets(ready);
                // From a dataset's or view's page: a script on what it had.
                const handoff = readHandoff(window.location.search);
                if (handoff) {
                    const names = Object.fromEntries(ready.map((one) => [one.id, one.name]));
                    setOpen({
                        ...newScript(handoff.datasets.filter((id) => id in names)),
                        name: `From ${handoff.title || "a view"}`,
                        code: starterScript(handoff, names),
                        dirty: true,
                    });
                }
            },
            (error) => setProblem(message(error)),
        );
    }, []);

    async function detailOf(which: unknown): Promise<DatasetDetail> {
        let id: number | undefined;
        if (typeof which === "number") {
            id = which;
        } else if (typeof which === "string" && which.trim()) {
            const all = await request<Dataset[]>("GET", "/api/yorg/datasets");
            const wanted = which.trim().toLowerCase();
            const named = all.filter((one) => one.name === which);
            const found = named.length ? named : all.filter((one) => one.name.toLowerCase() === wanted);
            if (found.length > 1) {
                // Tests in two folders can have one name: only an id says which.
                const ids = found.map((one) => one.id).join(" or ");
                throw new Error(`${found.length} tests are called ${which}: say which by its id (dataset=${ids})`);
            }
            id = found[0]?.id;
            if (id === undefined) {
                throw new Error(`There's no test called ${which}`);
            }
        } else {
            id = open.datasets[0];
            if (id === undefined) {
                throw new Error("Attach a test to the script (Data), or name one: dataset=...");
            }
        }
        const known = details.current.get(id);
        if (known) {
            return known;
        }
        const detail = await yorg.dataset(id);
        details.current.set(id, detail);
        return detail;
    }

    async function channelOf(detail: DatasetDetail, name: string): Promise<Preloaded> {
        const channel =
            detail.channels.find((one) => one.name === name) ??
            detail.channels.find((one) => one.name.toLowerCase() === name.toLowerCase());
        if (!channel) {
            throw new Error(`${detail.name} has no channel ${name}`);
        }
        const loaded = await samplesWhenReady(detail, channel);
        return {
            name: channel.name,
            unit: channel.unit,
            labels: channel.labels,
            dataset: detail.name,
            dataset_id: detail.id,
            t: bytesOf(loaded.times),
            v: bytesOf(loaded.values),
        };
    }

    /** A script's requests, answered read-only: the tests, and their channels. */
    async function answer(what: string, args: Record<string, unknown>): Promise<unknown> {
        if (what === "datasets") {
            const all = await request<Dataset[]>("GET", "/api/yorg/datasets");
            return all
                .filter((one) => one.status === "ready")
                .map(({ id, name, rows, t_min, t_max, time_kind }) => ({ id, name, rows, t_min, t_max, time_kind }));
        }
        if (what === "channel") {
            return channelOf(await detailOf(args.dataset ?? null), String(args.name ?? ""));
        }
        throw new Error(`A script can't ask for ${what}`);
    }

    function receive(found: FromPython) {
        switch (found.type) {
            case "status":
                setPython((now) =>
                    now.state === "running" ? { ...now, text: found.text } : { state: "loading", text: found.text },
                );
                return;
            case "ready":
                setPython({ state: "ready", version: found.version });
                return;
            case "failed":
                setPython({ state: "failed", error: found.error });
                return;
            case "stdout":
            case "stderr":
                setOutput((now) => ({ ...now, lines: [...now.lines, { kind: found.type, text: found.text }] }));
                return;
            case "plot": {
                const series = { name: found.name, unit: found.unit, x: floatsOf(found.x), y: floatsOf(found.y) };
                setOutput((now) => {
                    const plots = now.plots.some((plot) => plot.title === found.title)
                        ? now.plots.map((plot) =>
                              plot.title === found.title ? { ...plot, series: [...plot.series, series] } : plot,
                          )
                        : [...now.plots, { title: found.title, series: [series] }];
                    return { ...now, plots };
                });
                return;
            }
            case "figure": {
                const url = URL.createObjectURL(new Blob([found.png], { type: "image/png" }));
                setOutput((now) => ({ ...now, figures: [...now.figures, url] }));
                return;
            }
            case "file": {
                const url = URL.createObjectURL(new Blob([found.data]));
                setOutput((now) => ({ ...now, files: [...now.files, { name: found.name, url }] }));
                return;
            }
            case "done":
            case "error":
                setPython((now) => (now.state === "running" ? { state: "ready", version: "" } : now));
                setOutput((now) => ({
                    ...now,
                    lines: [
                        ...now.lines,
                        found.type === "error"
                            ? { kind: "error", text: found.text }
                            : { kind: "note", text: `Done in ${formatValue(found.elapsed)} s` },
                    ],
                }));
                return;
        }
    }

    handlers.current = { receive, answer };

    const tree = useMemo(() => {
        const wanted = search.trim().toLowerCase();
        const all = [
            ...(scripts ?? []).map((one) => ({ ...one, example: false })),
            ...EXAMPLES.map((one) => ({ ...one, example: true })),
        ];
        return folderTree(
            wanted
                ? all.filter(
                      (one) => one.name.toLowerCase().includes(wanted) || one.folder.toLowerCase().includes(wanted),
                  )
                : all,
        );
    }, [scripts, search]);

    function withSaved(then: () => void) {
        if (open.dirty) {
            setAsking({ ask: "discard", then });
        } else {
            then();
        }
    }

    const act = async (action: () => Promise<void>) => {
        setProblem(null);
        try {
            await action();
        } catch (error) {
            setProblem(message(error));
        }
    };

    function openScript(id: string) {
        const example = EXAMPLES.find((one) => one.id === id);
        withSaved(() => {
            if (example) {
                setOpen({
                    id: null,
                    example: example.id,
                    name: example.name,
                    folder: "",
                    code: example.code,
                    datasets: open.datasets,
                    dirty: false,
                });
                return;
            }
            void act(async () => {
                const found = await scriptsApi.get(id);
                setOpen({
                    id: found.id,
                    example: null,
                    name: found.name,
                    folder: found.folder,
                    code: found.code ?? "",
                    datasets: found.datasets?.length ? found.datasets : open.datasets,
                    dirty: false,
                });
            });
        });
    }

    const save = (name: string, folder: string, asNew: boolean) =>
        act(async () => {
            const done =
                asNew || !open.id
                    ? await scriptsApi.add(name, tidyFolder(folder), open.code, open.datasets)
                    : await scriptsApi.save(open.id, name, tidyFolder(folder), open.code, open.datasets);
            setOpen({ ...open, id: done.id, example: null, name: done.name, folder: done.folder, dirty: false });
            setScripts(await scriptsApi.list());
            setAsking(null);
        });

    function saveNow() {
        if (open.id) {
            void save(open.name, open.folder, false);
        } else {
            setSaveAs({ name: open.name, folder: open.folder });
            setAsking({ ask: "save-as" });
        }
    }

    async function uploadFiles(files: FileList) {
        const added: Script[] = [];
        for (const file of Array.from(files)) {
            added.push(await scriptsApi.add(nameOfFile(file.name), open.folder, await file.text(), open.datasets));
        }
        setScripts(await scriptsApi.list());
        const last = added[added.length - 1];
        if (last) {
            withSaved(() =>
                setOpen({
                    id: last.id,
                    example: null,
                    name: last.name,
                    folder: last.folder,
                    code: last.code ?? "",
                    datasets: last.datasets ?? open.datasets,
                    dirty: false,
                }),
            );
        }
    }

    const run = () =>
        act(async () => {
            const box = sandbox.current;
            if (!box || python.state !== "ready") {
                return;
            }
            for (const url of [...output.figures, ...output.files.map((one) => one.url)]) {
                URL.revokeObjectURL(url);
            }
            setOutput(EMPTY_OUTPUT);
            setPython({ state: "running", started: Date.now(), text: "Loading its channels…" });
            let context: RunContext = { datasets: [] };
            const preloaded: Preloaded[] = [];
            try {
                const tests = await Promise.all(open.datasets.map((id) => detailOf(id)));
                context = {
                    datasets: tests.map((detail) => ({
                        id: detail.id,
                        name: detail.name,
                        t0: storedT0(detail.id),
                        channels: detail.channels.map(({ name, unit, kind, labels }) => ({ name, unit, kind, labels })),
                    })),
                };
                const wanted = channelsToLoad(
                    open.code,
                    tests.map((detail) => ({
                        id: detail.id,
                        name: detail.name,
                        channels: detail.channels.map((one) => one.name),
                    })),
                );
                preloaded.push(
                    ...(await Promise.all(
                        wanted.map((one) =>
                            channelOf(
                                tests.find((detail) => detail.id === one.dataset)!,
                                one.channel,
                            ),
                        ),
                    )),
                );
            } catch (error) {
                setPython({ state: "ready", version: "" });
                throw error;
            }
            setPython((now) => (now.state === "running" ? { ...now, text: "Running…" } : now));
            box.run(open.code, context, preloaded);
        });

    function stop() {
        const box = sandbox.current;
        if (!box) {
            return;
        }
        box.stop();
        setOutput((now) => ({
            ...now,
            lines: [...now.lines, { kind: "note", text: "Stopped. Python starts again…" }],
        }));
        setPython({ state: "loading", text: "Starting Python…" });
        box.start();
    }

    // Every test attached, in order (the first is the one that needs no dataset=), its channels once they've loaded.
    const attached: Attached[] = open.datasets.map((id) => {
        const loaded = loadDataset(id);
        const ready = loaded.status === "ready" ? loaded.value : null;
        return {
            id,
            name: ready?.name ?? datasets.find((one) => one.id === id)?.name ?? `Test ${id}`,
            channels: ready ? ready.channels.map(({ name, unit }) => ({ name, unit })) : [],
        };
    });

    const running = python.state === "running";
    const [, tick] = useState(0);
    useEffect(() => {
        if (!running) {
            return;
        }
        const timer = window.setInterval(() => tick((n) => n + 1), 500);
        return () => window.clearInterval(timer);
    }, [running]);

    function folderView(folder: Folder<(typeof tree)["items"][number]>, depth: number) {
        const shut = closed.has(folder.path);
        return (
            <li key={folder.path}>
                {folder.path && (
                    <button
                        type="button"
                        className="scripts-folder"
                        style={{ paddingLeft: `${depth * 0.9}rem` }}
                        aria-expanded={!shut}
                        onClick={() => {
                            const next = new Set(closed);
                            if (shut) {
                                next.delete(folder.path);
                            } else {
                                next.add(folder.path);
                            }
                            setClosed(next);
                        }}
                    >
                        {shut ? "▸" : "▾"} {folder.name}
                    </button>
                )}
                {!shut && (
                    <ul>
                        {folder.folders.map((inner) => folderView(inner, depth + (folder.path ? 1 : 0)))}
                        {folder.items.map((item) => {
                            const current = item.example ? open.example === item.id : open.id === item.id;
                            return (
                                <li key={item.id}>
                                    <button
                                        type="button"
                                        className={`scripts-item ${current ? "scripts-current" : ""}`}
                                        style={{ paddingLeft: `${(depth + (folder.path ? 1 : 0)) * 0.9 + 0.4}rem` }}
                                        aria-current={current ? "true" : undefined}
                                        onClick={() => openScript(item.id)}
                                    >
                                        {item.name}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </li>
        );
    }

    const statusText =
        python.state === "loading"
            ? python.text
            : python.state === "failed"
              ? `Python didn't start: ${python.error}`
              : python.state === "running"
                ? `${python.text} ${Math.round((Date.now() - python.started) / 1000)} s`
                : "Python ready";

    return (
        <section className="yorg-page scripts-page">
            <div className="page-head">
                <div>
                    <h1>Scripts</h1>
                    <p className="muted dev-powered">
                        Python 3.14 in your browser (Pyodide), with NumPy, SciPy, pandas, matplotlib, and CoolProp
                    </p>
                </div>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            <div className="scripts-layout">
                <aside className="scripts-side" aria-label="Scripts">
                    <div className="scripts-side-actions">
                        <button type="button" onClick={() => withSaved(() => setOpen(newScript(open.datasets)))}>
                            New
                        </button>
                        <button type="button" onClick={() => fileInput.current?.click()}>
                            Upload .py…
                        </button>
                        <input
                            ref={fileInput}
                            type="file"
                            accept=".py,text/x-python,text/plain"
                            multiple
                            hidden
                            aria-label="Python files"
                            onChange={(event) => {
                                const files = event.target.files;
                                if (files?.length) {
                                    void act(() => uploadFiles(files));
                                }
                                event.target.value = "";
                            }}
                        />
                    </div>
                    <input
                        className="scripts-search"
                        type="search"
                        placeholder="Find a script"
                        aria-label="Find a script"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                    {scripts === null ? (
                        <p className="muted">Loading…</p>
                    ) : (
                        <ul className="scripts-tree">{folderView(tree, 0)}</ul>
                    )}
                </aside>
                <div className="scripts-main">
                    <div className="scripts-bar">
                        <label className="field">
                            Name
                            <input
                                value={open.name}
                                maxLength={120}
                                onChange={(event) => setOpen({ ...open, name: event.target.value, dirty: true })}
                            />
                        </label>
                        <label className="field">
                            Folder
                            <input
                                value={open.folder}
                                maxLength={300}
                                placeholder="Hotfires/Injector"
                                onChange={(event) => setOpen({ ...open, folder: event.target.value, dirty: true })}
                            />
                        </label>
                    </div>
                    <div className="scripts-actions">
                        {running ? (
                            <button type="button" className="button-danger" onClick={stop}>
                                Stop
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="button-primary"
                                disabled={python.state !== "ready"}
                                title="Ctrl+Enter"
                                onClick={() => void run()}
                            >
                                Run
                            </button>
                        )}
                        <button
                            type="button"
                            disabled={open.id !== null && !open.dirty}
                            title="Ctrl+S"
                            onClick={saveNow}
                        >
                            Save
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setSaveAs({ name: open.id ? `${open.name} copy` : open.name, folder: open.folder });
                                setAsking({ ask: "save-as" });
                            }}
                        >
                            Save as…
                        </button>
                        <button type="button" onClick={() => download(`${open.name}.py`, open.code)}>
                            Download .py
                        </button>
                        {open.id && (
                            <button
                                type="button"
                                className="button-danger"
                                onClick={() => setAsking({ ask: "delete" })}
                            >
                                Delete…
                            </button>
                        )}
                        <span className="muted" role="status">
                            {statusText}
                            {open.example && " · an example: Save as… keeps a copy of your own"}
                        </span>
                    </div>
                    <Editor
                        ref={editor}
                        label="Code"
                        attached={attached}
                        code={open.code}
                        onChange={(code) => setOpen({ ...open, code, dirty: true })}
                        onRun={() => !running && python.state === "ready" && void run()}
                        onSave={saveNow}
                    />
                    <section className="scripts-output" aria-label="Output">
                        {output.lines.length === 0 &&
                            output.plots.length === 0 &&
                            output.figures.length === 0 &&
                            output.files.length === 0 && (
                                <p className="muted">
                                    What the script prints, plots (yorg.plot, matplotlib), and saves (yorg.download)
                                    shows here.
                                </p>
                            )}
                        {output.lines.length > 0 && (
                            <pre className="scripts-console">
                                {output.lines.map((line, index) => (
                                    <span key={index} className={`scripts-${line.kind}`}>
                                        {line.text}
                                        {"\n"}
                                    </span>
                                ))}
                            </pre>
                        )}
                        {output.files.length > 0 && (
                            <p className="scripts-files">
                                {output.files.map((file) => (
                                    <a key={file.url} href={file.url} download={file.name} className="button">
                                        Save {file.name}
                                    </a>
                                ))}
                            </p>
                        )}
                        {output.plots.map((plot) => (
                            <ScriptPlot key={plot.title} {...plot} />
                        ))}
                        {output.figures.map((url, index) => (
                            <img key={url} src={url} alt={`Figure ${index + 1}`} className="scripts-figure" />
                        ))}
                    </section>
                </div>
                <DataPanel
                    datasets={datasets}
                    attached={open.datasets}
                    onChange={(ids) => {
                        storeDatasets(ids);
                        setOpen({ ...open, datasets: ids, dirty: open.id !== null || open.dirty });
                    }}
                    onChannel={(channel, test) => editor.current?.insertChannel(channel, test)}
                />
            </div>

            {asking?.ask === "save-as" && (
                <Dialog
                    title="Save the script"
                    confirm="Save"
                    disabled={saveAs.name.trim() === ""}
                    onConfirm={() => void save(saveAs.name.trim(), saveAs.folder, true)}
                    onCancel={() => setAsking(null)}
                >
                    <label className="field">
                        Name
                        <input
                            value={saveAs.name}
                            maxLength={120}
                            onChange={(event) => setSaveAs({ ...saveAs, name: event.target.value })}
                            autoFocus
                        />
                    </label>
                    <label className="field">
                        Folder
                        <input
                            value={saveAs.folder}
                            maxLength={300}
                            placeholder="Hotfires/Injector"
                            onChange={(event) => setSaveAs({ ...saveAs, folder: event.target.value })}
                        />
                    </label>
                </Dialog>
            )}
            {asking?.ask === "delete" && open.id && (
                <Dialog
                    title={`Delete ${open.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() =>
                        void act(async () => {
                            await scriptsApi.remove(open.id!);
                            setScripts(await scriptsApi.list());
                            setOpen(newScript(open.datasets));
                            setAsking(null);
                        })
                    }
                    onCancel={() => setAsking(null)}
                >
                    <p>It&apos;s gone for everyone.</p>
                </Dialog>
            )}
            {asking?.ask === "discard" && (
                <Dialog
                    title="Leave your changes?"
                    confirm="Leave them"
                    danger
                    onConfirm={() => {
                        const then = asking.then;
                        setAsking(null);
                        then();
                    }}
                    onCancel={() => setAsking(null)}
                >
                    <p>{open.name} has changes that aren&apos;t saved.</p>
                </Dialog>
            )}
        </section>
    );
}
