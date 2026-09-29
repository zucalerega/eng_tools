import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { request } from "../../api";
import { Dialog, Notice } from "../../components";
import type { Dataset } from "../api";
import { dataset as loadDataset, useLoaded } from "../data";
import { formatValue } from "../scale";
import { devApi, type Catalog, type RunResult, type RunStatus, type SavedModel, type SystemModel } from "./api";
import { Diagram, HEIGHT, WIDTH, type Tool } from "./Diagram";
import { Inspector } from "./Inspector";
import { addEdge, addNode, changePart, connectProblem, EMPTY_MODEL, exampleModel, removePart } from "./model";
import { Results } from "./Results";
import { readingFor } from "./units";
import "./dev.css";

// Yorg's dev page (admins): system models. Draw a test stand's feed system, link its valves and sensors to a test's
// channels, run it with FullFlow on the server, and compare it with what was measured; turn the knobs marked "tune"
// until it matches.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Current {
    id: string | null; // saved as, if it is
    name: string;
    model: SystemModel;
    dirty: boolean;
}

type Asking = { ask: "save-as" } | { ask: "delete" } | { ask: "discard"; then: () => void } | null;

export function DevPage() {
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
    const [windowText, setWindowText] = useState({ start: "", end: "", dt: "0.01" });
    // A run: what it ran (the model as it was, against which dataset), and how it's going.
    const [run, setRun] = useState<{
        id: string;
        model: SystemModel;
        datasetId: number;
        status: RunStatus | null;
    } | null>(null);
    const [shown, setShown] = useState<{ result: RunResult; model: SystemModel; datasetId: number } | null>(null);
    const dragStart = useRef<SystemModel | null>(null);

    useEffect(() => {
        Promise.all([devApi.catalog(), devApi.models(), request<Dataset[]>("GET", "/api/yorg/datasets")]).then(
            ([loadedCatalog, models, all]) => {
                setCatalog(loadedCatalog);
                setSaved(models);
                setDatasets(all.filter((one) => one.status === "ready"));
            },
            (error) => setProblem(message(error)),
        );
    }, []);

    // A dataset picked: its channels load, and the run's window starts as its first 10 seconds.
    const detail = datasetId === null ? null : loadDataset(datasetId);
    const channels = detail?.status === "ready" ? detail.value.channels : [];
    function pickDataset(id: number | null) {
        setDatasetId(id);
        const found = datasets.find((one) => one.id === id);
        if (found && found.t_min !== null && found.t_max !== null) {
            setWindowText({
                ...windowText,
                start: formatValue(found.t_min),
                end: formatValue(Math.min(found.t_max, found.t_min + 10)),
            });
        }
    }

    // While a run goes, ask how it's doing.
    useEffect(() => {
        if (!run || (run.status && run.status.state !== "running")) {
            return;
        }
        const timer = window.setTimeout(() => {
            devApi.status(run.id).then(
                (status) => {
                    setRun({ ...run, status });
                    if (status.state === "done") {
                        setShown({ result: status.result, model: run.model, datasetId: run.datasetId });
                    }
                },
                (error) =>
                    setRun({ ...run, status: { state: "failed", elapsed: 0, duration: 0, message: message(error) } }),
            );
        }, 600);
        return () => window.clearTimeout(timer);
    }, [run]);

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

    const start = Number(windowText.start);
    const end = Number(windowText.end);
    const dt = Number(windowText.dt);
    const running = run?.status?.state === "running" || (run !== null && run.status === null);
    const canRun =
        datasetId !== null && Number.isFinite(start) && Number.isFinite(end) && end > start && dt > 0 && !running;
    const status = run?.status;

    const startRun = () =>
        act(async () => {
            if (datasetId === null) {
                return;
            }
            const model = current.model;
            const started = await devApi.run({
                model,
                dataset_id: datasetId,
                start,
                end,
                dt,
                reading: readingFor(model.display),
            });
            setRun({ id: started.id, model, datasetId, status: null });
        });

    const nodeTypes = catalog.parts.filter((part) => part.kind === "node");
    const edgeTypes = catalog.parts.filter((part) => part.kind === "edge");
    const shownDetail = shown && shown.datasetId === datasetId && detail?.status === "ready" ? detail.value : null;
    const display = current.model.display;

    return (
        <section className="yorg-page dev-page" onKeyDown={onKey}>
            <div className="page-head">
                <h1>System models</h1>
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
                    <button
                        type="button"
                        onClick={() => withSaved(() => open(exampleModel(catalog), null, "Cold flow example"))}
                    >
                        Start from an example
                    </button>
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
                        ? "Add tanks, junctions, and outlets, then connect them with lines, valves, and orifices."
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
                            onChange={change}
                            onDelete={(id) => {
                                change(removePart(current.model, id));
                                setSelected(null);
                            }}
                        />
                    ) : (
                        <p className="muted">
                            Pick a part to set it up and link it to the test&apos;s channels: a tank&apos;s pressure, a
                            valve&apos;s command, a junction&apos;s pressure transducer.
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
                <label className="field">
                    From (s)
                    <input
                        inputMode="decimal"
                        value={windowText.start}
                        onChange={(event) => setWindowText({ ...windowText, start: event.target.value })}
                    />
                </label>
                <label className="field">
                    To (s)
                    <input
                        inputMode="decimal"
                        value={windowText.end}
                        onChange={(event) => setWindowText({ ...windowText, end: event.target.value })}
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
                    <button type="button" onClick={() => run && void act(async () => devApi.stop(run.id))}>
                        Stop
                    </button>
                ) : (
                    <button type="button" className="button-primary" disabled={!canRun} onClick={() => void startRun()}>
                        Run
                    </button>
                )}
                <span className="muted" role="status">
                    {status?.state === "running"
                        ? `Running: ${formatValue(status.done)} of ${formatValue(status.duration)} s, ${Math.round(status.elapsed)} s so far`
                        : running
                          ? "Starting…"
                          : status?.state === "done"
                            ? `Done in ${Math.round(status.elapsed)} s`
                            : ""}
                </span>
            </div>
            {status?.state === "failed" && <Notice tone="error">{status.message}</Notice>}
            {shown && shownDetail && (
                <Results model={shown.model} catalog={catalog} result={shown.result} detail={shownDetail} />
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
