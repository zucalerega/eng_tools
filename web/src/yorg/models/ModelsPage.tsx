import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { request } from "../../api";
import { Dialog, MenuButton, Notice } from "../../components";
import type { Dataset } from "../api";
import { dataset as loadDataset, samples as loadSamples, useLoaded } from "../data";
import { linkTarget } from "../../preview";
import { datasetUrl, storedT0 } from "../pages";
import { sampleAt } from "../samples";
import { formatValue } from "../scale";
import {
    devApi,
    type Catalog,
    type FitKnob,
    type Quantity,
    type RunResult,
    type RunStatus,
    type SavedModel,
    type SystemModel,
} from "./api";
import { Diagram, HEIGHT, WIDTH, type Tool } from "./Diagram";
import { applyKnobs, FitDialog, FitSummary, type Knob } from "./Fit";
import { Inspector } from "./Inspector";
import {
    addEdge,
    addNode,
    changePart,
    connectProblem,
    EMPTY_MODEL,
    exampleModel,
    exportModel,
    importModel,
    pressurizedExample,
    removePart,
} from "./model";
import { Results } from "./Results";
import { channelToSiLinear, readingFor } from "./units";
import "./models.css";

// Yorg's system models (Models, in the preview while they're tried out). Draw a test stand's feed system, link its valves and sensors to a test's
// channels, run it with FullFlow on the server, and compare it with what was measured; turn the knobs marked "tune"
// until it matches, or have a fit turn them.

const FULLFLOW = "https://github.com/saakethramoju/FullFlow";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Current {
    id: string | null; // saved as, if it is
    name: string;
    model: SystemModel;
    dirty: boolean;
}

type Asking = { ask: "save-as" } | { ask: "delete" } | { ask: "discard"; then: () => void } | { ask: "fit" } | null;

/** A run or a fit on the server: what it ran (the model as it was, against which dataset), and how it's going. */
interface Job {
    kind: "run" | "fit";
    id: string;
    model: SystemModel;
    datasetId: number;
    knobs: Knob[];
    status: RunStatus | null;
}

/** What a fit found, to apply: the knobs from where they started, and how it went. */
interface Found {
    knobs: FitKnob[];
    note: string;
}

/** A run's window on a dataset, from its T0 (or start): a second before T0 to ten after (or its first ten seconds). */
function windowFor(
    found: Dataset,
    asked: [number, number] | null = null,
): { from: string; to: string } | Record<string, never> {
    if (found.t_min === null || found.t_max === null) {
        return {};
    }
    const at = storedT0(found.id);
    const origin = at ?? found.t_min;
    // A page's time in view, when it sent one (on the test's clock); else a second before T0 to ten after.
    const from = asked ? asked[0] : at === null ? found.t_min : Math.max(found.t_min, at - 1);
    const to = asked ? asked[1] : Math.min(found.t_max, (at ?? found.t_min) + 10);
    return { from: formatValue(from - origin), to: formatValue(to - origin) };
}

/** The time in view a page sent (?window=12,18.5), if it did. */
function askedWindow(): [number, number] | null {
    const parts = (new URLSearchParams(window.location.search).get("window") ?? "").split(",").map(Number);
    return parts.length === 2 && parts.every(Number.isFinite) && parts[1]! > parts[0]! ? [parts[0]!, parts[1]!] : null;
}

function download(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "model"}.json`;
    link.click();
    URL.revokeObjectURL(url);
}

export function ModelsPage() {
    useLoaded();
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [saved, setSaved] = useState<SavedModel[]>([]);
    const [datasets, setDatasets] = useState<Dataset[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    const [current, setCurrent] = useState<Current>({ id: null, name: "New model", model: EMPTY_MODEL, dirty: false });
    const [undo, setUndo] = useState<SystemModel[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [tool, setTool] = useState<Tool>({ mode: "select" });
    const [asking, setAsking] = useState<Asking>(null);
    const [newName, setNewName] = useState("");
    const [datasetId, setDatasetId] = useState<number | null>(null);
    // The run's window, in seconds from T0 (or, without one, from the dataset's start).
    const [windowText, setWindowText] = useState({ from: "", to: "", dt: "0.01" });
    const [job, setJob] = useState<Job | null>(null);
    const [shown, setShown] = useState<{ result: RunResult; model: SystemModel; datasetId: number } | null>(null);
    const [found, setFound] = useState<Found | null>(null);
    const [lastKnobs, setLastKnobs] = useState<Knob[]>([]);
    const dragStart = useRef<SystemModel | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        Promise.all([devApi.catalog(), devApi.models(), request<Dataset[]>("GET", "/api/yorg/datasets")]).then(
            ([loadedCatalog, models, all]) => {
                setCatalog(loadedCatalog);
                setSaved(models);
                const ready = all.filter((one) => one.status === "ready");
                setDatasets(ready);
                // Come from a dataset's or view's page (?dataset=5&window=12,18.5): that test, over that time.
                const asked = Number(new URLSearchParams(window.location.search).get("dataset"));
                const found = ready.find((one) => one.id === asked);
                if (found) {
                    setDatasetId(found.id);
                    setWindowText((now) => ({ ...now, ...windowFor(found, askedWindow()) }));
                }
            },
            (error) => setProblem(message(error)),
        );
    }, []);

    // A dataset picked: its channels load, and the run's window starts as a second before T0 to ten after (or its
    // first ten seconds, without a T0).
    const detail = datasetId === null ? null : loadDataset(datasetId);
    const channels = detail?.status === "ready" ? detail.value.channels : [];
    const picked = datasets.find((one) => one.id === datasetId);
    const t0 = datasetId === null ? null : storedT0(datasetId);
    const zero = t0 ?? picked?.t_min ?? 0;
    function pickDataset(id: number | null) {
        setDatasetId(id);
        const found = datasets.find((one) => one.id === id);
        if (found) {
            setWindowText({ ...windowText, ...windowFor(found) });
        }
    }

    // While a run or a fit goes, ask how it's doing.
    useEffect(() => {
        if (!job || (job.status && job.status.state !== "running")) {
            return;
        }
        const timer = window.setTimeout(
            () => {
                devApi.status(job.id).then(
                    (status) => {
                        setJob({ ...job, status });
                        if (status.state === "done") {
                            setShown({ result: status.result, model: job.model, datasetId: job.datasetId });
                            const fit = status.result.fit;
                            if (fit) {
                                const better = fit.cost_start > 0 ? 100 * (1 - fit.cost / fit.cost_start) : 0;
                                setFound({
                                    knobs: fit.knobs,
                                    note: `${fit.stopped ? "Stopped at the time limit: the best of" : "Done:"} ${fit.tries} runs, the error ${better.toFixed(1)}% smaller.`,
                                });
                            }
                        } else if (status.state === "failed" && job.kind === "fit" && status.progress?.values) {
                            // Stopped: what it had found so far is still worth having.
                            const values = status.progress.values;
                            setFound({
                                knobs: job.knobs.map((knob, index) => ({
                                    ...knob,
                                    start: Number(
                                        [...job.model.nodes, ...job.model.edges].find((one) => one.id === knob.part)
                                            ?.settings[knob.key] ?? 0,
                                    ),
                                    value: values[index] ?? 0,
                                })),
                                note: `Stopped after ${status.progress.tries ?? 0} runs: the best it had found.`,
                            });
                        }
                    },
                    (error) =>
                        setJob({
                            ...job,
                            status: { state: "failed", elapsed: 0, duration: 0, message: message(error) },
                        }),
                );
            },
            job.kind === "fit" ? 1000 : 600,
        );
        return () => window.clearTimeout(timer);
    }, [job]);

    if (!catalog) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }

    function change(model: SystemModel, keep = true) {
        if (keep) {
            setUndo([...undo.slice(-99), current.model]);
        }
        setCurrent({ ...current, model, dirty: true });
    }

    function undoLast() {
        const last = undo[undo.length - 1];
        if (last) {
            setUndo(undo.slice(0, -1));
            setCurrent({ ...current, model: last, dirty: true });
        }
    }

    function withSaved(then: () => void) {
        if (current.dirty) {
            setAsking({ ask: "discard", then });
        } else {
            then();
        }
    }

    function open(model: SystemModel, id: string | null, name: string) {
        setCurrent({ id, name, model, dirty: id === null && model.nodes.length > 0 });
        setUndo([]);
        setSelected(null);
        setTool({ mode: "select" });
        setShown(null);
        setFound(null);
    }

    async function act(action: () => Promise<void>) {
        setProblem(null);
        try {
            await action();
        } catch (error) {
            setProblem(message(error));
        }
    }

    const save = (name: string, asNew: boolean) =>
        act(async () => {
            const done =
                asNew || !current.id
                    ? await devApi.addModel(name, current.model)
                    : await devApi.saveModel(current.id, name, current.model);
            setCurrent({ ...current, id: done.id, name: done.name, dirty: false });
            setSaved(await devApi.models());
            setAsking(null);
        });

    function onKey(event: KeyboardEvent) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            undoLast();
        }
    }

    async function importFile(file: File) {
        const text = await file.text();
        const imported = importModel(text, file.name.replace(/\.json$/i, ""));
        withSaved(() => open(imported.model, null, imported.name));
    }

    const from = Number(windowText.from);
    const to = Number(windowText.to);
    const dt = Number(windowText.dt);
    const start = zero + from;
    const end = zero + to;
    const running = job !== null && (job.status === null || job.status.state === "running");
    const windowOk =
        datasetId !== null &&
        windowText.from.trim() !== "" &&
        windowText.to.trim() !== "" &&
        Number.isFinite(from) &&
        Number.isFinite(to) &&
        to > from &&
        dt > 0;
    const status = job?.status;

    /** A channel's value at the run's start, in SI, from the picked test (null until its samples are in). */
    function startValue(name: string, quantity: Quantity): number | null {
        if (detail?.status !== "ready" || !windowOk) {
            return null;
        }
        const channel = detail.value.channels.find((one) => one.name === name);
        if (!channel) {
            return null;
        }
        const loaded = loadSamples(detail.value, channel);
        if (loaded.status !== "ready") {
            return null;
        }
        const { scale, offset } = channelToSiLinear(quantity, channel.unit, current.model.display);
        return sampleAt(loaded.value, start, { shift: 0, scale, offset })?.y ?? null;
    }

    const runBody = (model: SystemModel, id: number) => ({
        model,
        dataset_id: id,
        start,
        end,
        dt,
        reading: readingFor(model.display),
    });

    const startRun = () =>
        act(async () => {
            if (datasetId === null) {
                return;
            }
            const model = current.model;
            const started = await devApi.run(runBody(model, datasetId));
            setFound(null);
            setJob({ kind: "run", id: started.id, model, datasetId, knobs: [], status: null });
        });

    const startFit = (knobs: Knob[]) =>
        act(async () => {
            if (datasetId === null) {
                return;
            }
            const model = current.model;
            setAsking(null);
            setLastKnobs(knobs);
            const started = await devApi.fit({ ...runBody(model, datasetId), knobs });
            setFound(null);
            setJob({ kind: "fit", id: started.id, model, datasetId, knobs, status: null });
        });

    const nodeTypes = catalog.parts.filter((part) => part.kind === "node");
    const edgeTypes = catalog.parts.filter((part) => part.kind === "edge");
    const shownDetail = shown && shown.datasetId === datasetId && detail?.status === "ready" ? detail.value : null;
    const display = current.model.display;
    const progress = status?.progress;
    const better =
        progress?.cost_start && progress.cost !== undefined && Number.isFinite(progress.cost)
            ? 100 * (1 - progress.cost / progress.cost_start)
            : null;

    return (
        <section className="yorg-page dev-page" onKeyDown={onKey}>
            <div className="page-head">
                <div>
                    <h1>Models</h1>
                    <p className="muted dev-powered">
                        Powered by{" "}
                        <a href={FULLFLOW} target="_blank" rel="noreferrer">
                            FullFlow
                        </a>
                    </p>
                </div>
                <div className="dev-head-actions">
                    <select
                        aria-label="Saved models"
                        value={current.id ?? ""}
                        onChange={(event) => {
                            const id = event.target.value;
                            withSaved(() =>
                                id
                                    ? void act(async () => {
                                          const found = await devApi.model(id);
                                          open(found.model ?? EMPTY_MODEL, found.id, found.name);
                                      })
                                    : open(EMPTY_MODEL, null, "New model"),
                            );
                        }}
                    >
                        <option value="">
                            {current.id ? "New model" : `${current.name}${current.dirty ? " (not saved)" : ""}`}
                        </option>
                        {saved.map((one) => (
                            <option key={one.id} value={one.id}>
                                {one.name}
                                {one.id === current.id && current.dirty ? " (changed)" : ""}
                            </option>
                        ))}
                    </select>
                    <button type="button" onClick={() => withSaved(() => open(EMPTY_MODEL, null, "New model"))}>
                        New
                    </button>
                    <MenuButton
                        label="Start from an example"
                        items={[
                            {
                                label: "Cold flow",
                                onSelect: () => withSaved(() => open(exampleModel(catalog), null, "Cold flow example")),
                            },
                            {
                                label: "Pressurized flow",
                                onSelect: () =>
                                    withSaved(() => open(pressurizedExample(catalog), null, "Pressurized example")),
                            },
                        ]}
                    />
                    <button
                        type="button"
                        className="button-primary"
                        disabled={!current.dirty && current.id !== null}
                        onClick={() =>
                            current.id
                                ? void save(current.name, false)
                                : (setNewName(current.name), setAsking({ ask: "save-as" }))
                        }
                    >
                        Save
                    </button>
                    <button
                        type="button"
                        onClick={() => (setNewName(`${current.name} copy`), setAsking({ ask: "save-as" }))}
                    >
                        Save as…
                    </button>
                    <MenuButton
                        label="File"
                        items={[
                            { label: "Import a model file…", onSelect: () => fileInput.current?.click() },
                            {
                                label: "Export to a file",
                                onSelect: () => download(current.name, exportModel(current.name, current.model)),
                            },
                        ]}
                    />
                    <input
                        ref={fileInput}
                        type="file"
                        accept=".json,application/json"
                        hidden
                        aria-label="Model file"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) {
                                void act(() => importFile(file));
                            }
                        }}
                    />
                    {current.id && (
                        <button type="button" className="button-danger" onClick={() => setAsking({ ask: "delete" })}>
                            Delete…
                        </button>
                    )}
                </div>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}

            <div className="dev-toolbar" role="toolbar" aria-label="Tools">
                <button type="button" aria-pressed={tool.mode === "select"} onClick={() => setTool({ mode: "select" })}>
                    Select
                </button>
                <span className="dev-divider" />
                {nodeTypes.map((kind) => (
                    <button
                        key={kind.type}
                        type="button"
                        aria-pressed={tool.mode === "place" && tool.type === kind.type}
                        title={kind.help}
                        onClick={() => setTool({ mode: "place", type: kind.type })}
                    >
                        + {kind.label}
                    </button>
                ))}
                <span className="dev-divider" />
                {edgeTypes.map((kind) => (
                    <button
                        key={kind.type}
                        type="button"
                        className={kind.phase === "gas" ? "dev-gas-tool" : undefined}
                        aria-pressed={tool.mode === "connect" && tool.type === kind.type}
                        title={`${kind.help} Click where it starts, then where it ends.`}
                        onClick={() => setTool({ mode: "connect", type: kind.type, from: null })}
                    >
                        ↦ {kind.label}
                    </button>
                ))}
                <span className="dev-divider" />
                <button type="button" disabled={undo.length === 0} onClick={undoLast} title="Ctrl+Z">
                    Undo
                </button>
                <label className="check" title="Show pressures above the atmosphere (psig), or absolute (psia)">
                    <input
                        type="checkbox"
                        checked={display.gauge}
                        onChange={(event) =>
                            change({ ...current.model, display: { ...display, gauge: event.target.checked } }, false)
                        }
                    />
                    Gauge
                </label>
                <select
                    aria-label="Units"
                    value={display.units}
                    onChange={(event) =>
                        change(
                            { ...current.model, display: { ...display, units: event.target.value as "us" | "si" } },
                            false,
                        )
                    }
                >
                    <option value="us">psi, °F, in, gal</option>
                    <option value="si">bar, K, mm, L</option>
                </select>
            </div>
            <p className="muted dev-hint" role="status">
                {tool.mode === "place"
                    ? "Click where it goes."
                    : tool.mode === "connect"
                      ? tool.from
                          ? "Now click where it flows to (Esc to stop)."
                          : "Click where it flows from."
                      : current.model.nodes.length === 0
                        ? "Add tanks, junctions, and outlets, then connect them with lines, valves, and orifices (gas parts, dashed, for pressurant)."
                        : "Click a part to set it up; drag to move it; Delete removes it."}
            </p>

            <div className="dev-editor">
                <Diagram
                    model={current.model}
                    catalog={catalog}
                    selected={selected}
                    tool={tool}
                    onSelect={setSelected}
                    onMove={(id, x, y, done) => {
                        if (!dragStart.current) {
                            dragStart.current = current.model;
                        }
                        const moved = changePart(current.model, id, { x, y });
                        if (done) {
                            setUndo([...undo.slice(-99), dragStart.current]);
                            dragStart.current = null;
                        }
                        setCurrent({ ...current, model: moved, dirty: true });
                    }}
                    onPlace={(type, x, y) => {
                        const [model, id] = addNode(
                            current.model,
                            catalog,
                            type,
                            Math.min(x, WIDTH - 40),
                            Math.min(y, HEIGHT - 60),
                        );
                        change(model);
                        setSelected(id);
                        setTool({ mode: "select" });
                    }}
                    onConnect={(from, to) => {
                        if (tool.mode !== "connect") {
                            return;
                        }
                        const wrong = connectProblem(current.model, catalog, tool.type, from, to);
                        if (wrong) {
                            setProblem(wrong);
                            setTool({ ...tool, from: null });
                            return;
                        }
                        setProblem(null);
                        const [model, id] = addEdge(current.model, catalog, tool.type, from, to);
                        change(model);
                        setSelected(id);
                        setTool({ ...tool, from: to }); // on from there, for the next part in the run
                    }}
                    onTool={setTool}
                    onDelete={(id) => {
                        change(removePart(current.model, id));
                        setSelected(null);
                    }}
                />
                <aside className="dev-side">
                    {selected ? (
                        <Inspector
                            model={current.model}
                            catalog={catalog}
                            id={selected}
                            channels={channels}
                            startValue={startValue}
                            onChange={change}
                            onDelete={(id) => {
                                change(removePart(current.model, id));
                                setSelected(null);
                            }}
                        />
                    ) : (
                        <p className="muted">
                            Pick a part to set it up and link it to the test&apos;s channels: a tank&apos;s pressure, a
                            valve&apos;s command, a junction&apos;s pressure transducer. A tank or gas junction linked
                            to a sensor starts from its value at the run&apos;s start.
                        </p>
                    )}
                </aside>
            </div>

            <div className="dev-run" role="group" aria-label="Run">
                <label className="field">
                    Test
                    <select
                        value={datasetId ?? ""}
                        onChange={(event) => pickDataset(event.target.value ? Number(event.target.value) : null)}
                    >
                        <option value="">Pick a dataset</option>
                        {datasets.map((one) => (
                            <option key={one.id} value={one.id}>
                                {one.name}
                            </option>
                        ))}
                    </select>
                </label>
                {datasetId !== null && (
                    <a
                        className="dev-open-test"
                        href={linkTarget(datasetUrl(datasetId))}
                        target="_blank"
                        rel="noreferrer"
                        title="Its plots, in a new tab"
                    >
                        Open the test ↗
                    </a>
                )}
                <label className="field" title={t0 === null ? "Seconds from the dataset's start" : "Seconds from T0"}>
                    From (s)
                    <input
                        inputMode="decimal"
                        value={windowText.from}
                        onChange={(event) => setWindowText({ ...windowText, from: event.target.value })}
                    />
                </label>
                <label className="field" title={t0 === null ? "Seconds from the dataset's start" : "Seconds from T0"}>
                    To (s)
                    <input
                        inputMode="decimal"
                        value={windowText.to}
                        onChange={(event) => setWindowText({ ...windowText, to: event.target.value })}
                    />
                </label>
                <label className="field">
                    Time step (s)
                    <input
                        inputMode="decimal"
                        value={windowText.dt}
                        onChange={(event) => setWindowText({ ...windowText, dt: event.target.value })}
                    />
                </label>
                {running ? (
                    <button type="button" onClick={() => job && void act(async () => devApi.stop(job.id))}>
                        Stop
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="button-primary"
                            disabled={!windowOk}
                            onClick={() => void startRun()}
                        >
                            Run
                        </button>
                        <button type="button" disabled={!windowOk} onClick={() => setAsking({ ask: "fit" })}>
                            Fit…
                        </button>
                    </>
                )}
                <span className="muted" role="status">
                    {status?.state === "running" && job?.kind === "fit"
                        ? `Fitting: ${progress?.tries ?? 0} runs${better === null ? "" : `, the error ${better.toFixed(1)}% smaller`}, ${Math.round(status.elapsed)} s so far`
                        : status?.state === "running"
                          ? `Running: ${formatValue(status.done)} of ${formatValue(status.duration)} s, ${Math.round(status.elapsed)} s so far`
                          : running
                            ? "Starting…"
                            : status?.state === "done"
                              ? `Done in ${Math.round(status.elapsed)} s`
                              : ""}
                </span>
                {datasetId !== null && (
                    <span className="muted dev-zero">
                        {t0 === null ? "Times from the dataset's start" : "Times from T0 (set on the dataset's plots)"}
                    </span>
                )}
            </div>
            {status?.state === "failed" && <Notice tone="error">{status.message}</Notice>}
            {found && (
                <FitSummary
                    model={current.model}
                    catalog={catalog}
                    found={found.knobs}
                    note={found.note}
                    onApply={() => {
                        change(applyKnobs(current.model, found.knobs));
                        setFound(null);
                    }}
                    onDiscard={() => setFound(null)}
                />
            )}
            {shown && shownDetail && (
                <Results model={shown.model} catalog={catalog} result={shown.result} detail={shownDetail} zero={t0} />
            )}

            {asking?.ask === "fit" && (
                <FitDialog
                    model={current.model}
                    catalog={catalog}
                    picked={lastKnobs}
                    onStart={(knobs) => void startFit(knobs)}
                    onCancel={() => setAsking(null)}
                />
            )}
            {asking?.ask === "save-as" && (
                <Dialog
                    title="Save the model"
                    confirm="Save"
                    disabled={newName.trim() === ""}
                    onConfirm={() => void save(newName.trim(), true)}
                    onCancel={() => setAsking(null)}
                >
                    <label className="field">
                        Name
                        <input
                            value={newName}
                            maxLength={120}
                            onChange={(event) => setNewName(event.target.value)}
                            autoFocus
                        />
                    </label>
                </Dialog>
            )}
            {asking?.ask === "delete" && current.id && (
                <Dialog
                    title={`Delete ${current.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() =>
                        void act(async () => {
                            await devApi.removeModel(current.id!);
                            setSaved(await devApi.models());
                            open(EMPTY_MODEL, null, "New model");
                            setAsking(null);
                        })
                    }
                    onCancel={() => setAsking(null)}
                >
                    <p>It&apos;s gone for everyone. The tests it ran against stay as they are.</p>
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
                    <p>{current.name} has changes that aren&apos;t saved.</p>
                </Dialog>
            )}
        </section>
    );
}
