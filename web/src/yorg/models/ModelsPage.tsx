import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { request } from "../../api";
import { Dialog, MenuButton, Notice } from "../../components";
import { yorg, type Dataset } from "../api";
import { dataset as loadDataset, samples as loadSamples, useLoaded } from "../data";
import { linkTarget } from "../../preview";
import { datasetUrl, storedT0 } from "../pages";
import { sampleAt } from "../samples";
import { formatValue } from "../scale";
import { isTicking, RunView, useTicking } from "../scripts/Output";
import { formatSeconds } from "../scripts/progress";
import { python, usePython, useRun } from "../scripts/python";
import { AnchorDialog, NO_PLAN, type AnchorPlan } from "./Anchor";
import {
    devApi,
    type AnchorPick,
    type Catalog,
    type FitKnob,
    type Quantity,
    type RunResult,
    type RunStatus,
    type SavedModel,
    type ScriptLibrary,
    type ScriptRequest,
    type Solver,
    type SystemModel,
} from "./api";
import { browserProgress, browserResult, browserRun } from "./browserRun";
import { Diagram, HEIGHT, WIDTH, type Tool } from "./Diagram";
import { applyKnobs, FitDialog, FitSummary, type Knob } from "./Fit";
import { FULLFLOW, FullFlowReference } from "./FullFlowReference";
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
    vespulaExample,
    VESPULA_RUN,
} from "./model";
import { Results } from "./Results";
import { ScriptView } from "./ScriptView";
import { channelToSiLinear, readingFor } from "./units";
import "./models.css";

// Yorg's system models (Models, in the preview while they're tried out). Draw a test stand's feed system, link its valves and sensors to a test's
// channels, run it with FullFlow on the server, and compare it with what was measured; turn the knobs marked "tune"
// until it matches, have a fit turn them, or anchor them to sensors (FullFlow moves them in every time step). The
// Script view shows the model as the FullFlow script that runs it, to change and run in the browser; the Reference,
// how FullFlow models a system.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const PID_ONLY = "Fits and anchored runs run the P&ID's model on the server, not a changed script";

interface Current {
    id: string | null; // saved as, if it is
    name: string;
    model: SystemModel;
    dirty: boolean;
}

type Asking =
    | { ask: "save-as" }
    | { ask: "delete" }
    | { ask: "discard"; then: () => void }
    | { ask: "fit" }
    | { ask: "anchor" }
    | null;

/** The script written from the P&ID, for the run as it's set up (by its request, as JSON), or why there isn't one. */
interface Written {
    key: string;
    script: string | null;
    problem: string | null;
}

/** A changed script: the one it was changed from, and what it is now. */
interface Edits {
    base: string;
    text: string;
}

/** A changed script's run in the browser (the tab's Python): what it ran against, and whether it's been shown. */
interface BrowserJob {
    id: string;
    model: SystemModel;
    datasetId: number;
    duration: number; // simulated seconds
    shown: boolean;
}

/** A run, a fit, or an anchored run on the server: what it ran (the model as it was, against which dataset), and how
 * it's going. */
interface Job {
    kind: "run" | "fit" | "anchor";
    id: string;
    model: SystemModel;
    datasetId: number;
    knobs: Knob[];
    status: RunStatus | null;
}

/** What a fit (or an anchored run) found, to apply: the knobs from where they started, and how it went. */
interface Found {
    knobs: FitKnob[];
    note: string;
    title?: string;
    spread?: Record<string, [number, number]>; // an anchored run's: how much each knob moved, by part.key
    how?: Record<string, string>; // and how each was found (anchored, fitted), by part.key
}

/** What an anchored run found, to apply: its anchored knobs (where FullFlow could anchor them), and what it fitted. */
function anchoredFound(result: RunResult): Found {
    const settled = (result.anchors ?? []).flatMap((one) =>
        one.value === null || one.low === null || one.high === null
            ? []
            : [{ ...one, value: one.value, low: one.low, high: one.high }],
    );
    const fit = result.fit;
    const id = (one: { part: string; key: string }) => `${one.part}.${one.key}`;
    const fitted = fit?.knobs ?? [];
    const better = fit && fit.cost_start > 0 ? 100 * (1 - fit.cost / fit.cost_start) : 0;
    return {
        knobs: [
            ...settled.map((one) => ({ part: one.part, key: one.key, start: one.start, value: one.value })),
            ...fitted,
        ],
        title: fit ? "Anchored and fitted" : "Anchored",
        note: fit
            ? `Done: ${settled.length} anchored, each its median where FullFlow anchored it; ${fitted.length} fitted in ${fit.tries} runs, the error ${better.toFixed(1)}% smaller${fit.stopped ? " (stopped at the time limit)" : ""}.`
            : "Done in one run: each knob's median where FullFlow anchored it.",
        spread: Object.fromEntries(settled.map((one) => [id(one), [one.low, one.high]])),
        how: Object.fromEntries([
            ...settled.map((one) => [id(one), "anchored"]),
            ...fitted.map((one) => [
                id(one),
                fit?.fallback?.some((failed) => failed.part === one.part && failed.key === one.key)
                    ? "fitted (its anchor didn't work)"
                    : "fitted",
            ]),
        ]),
    };
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
    const [lastAnchors, setLastAnchors] = useState<AnchorPlan>(NO_PLAN);
    const [solver, setSolver] = useState<Solver>("transient");
    const [view, setView] = useState<"pid" | "script">("pid");
    const [reference, setReference] = useState(false);
    const [written, setWritten] = useState<Written | null>(null);
    const [edits, setEdits] = useState<Edits | null>(null);
    const [library, setLibrary] = useState<ScriptLibrary | null>(null);
    const [withAnchors, setWithAnchors] = useState(false);
    const [browser, setBrowser] = useState<BrowserJob | null>(null);
    const browserRecord = useRun(browser?.id ?? null);
    const pythonState = usePython();
    const now = useTicking(isTicking(pythonState, browserRecord));
    const dragStart = useRef<SystemModel | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const wanted = useRef<string | null>(null); // the script asked for last

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

    const from = Number(windowText.from);
    const to = Number(windowText.to);
    const dt = Number(windowText.dt);
    const start = zero + from;
    const end = zero + to;
    const windowOk =
        datasetId !== null &&
        windowText.from.trim() !== "" &&
        windowText.to.trim() !== "" &&
        Number.isFinite(from) &&
        Number.isFinite(to) &&
        to > from &&
        dt > 0;

    /** An anchor plan's anchors, as the server takes them: their spans on the dataset's clock. */
    const anchorPicks = (plan: AnchorPlan): AnchorPick[] => {
        const at = (text: string) => (text.trim() === "" ? undefined : zero + Number(text));
        return plan.anchors.map((one) => ({
            part: one.part,
            key: one.key,
            sensor: one.sensor,
            link: one.link,
            start: at(one.from),
            end: at(one.to),
        }));
    };

    // The script, as the server writes it for the run as it's set up (over 0 to 10 s, until there's a window): asked
    // for while the Script view's open, a moment after the model or the run's settings last changed.
    const anchoring = withAnchors && lastAnchors.anchors.length > 0;
    const scriptRequest: ScriptRequest = {
        model: current.model,
        start: windowOk ? start : 0,
        end: windowOk ? end : 10,
        dt: dt > 0 ? dt : 0.01,
        solver,
        ...(anchoring ? { anchors: anchorPicks(lastAnchors) } : {}),
    };
    const scriptKey = view === "script" && catalog ? JSON.stringify(scriptRequest) : null;
    useEffect(() => {
        if (scriptKey === null) {
            return;
        }
        wanted.current = scriptKey;
        const timer = window.setTimeout(() => {
            const keep = (found: Written) => {
                if (wanted.current === found.key) {
                    setWritten(found);
                }
            };
            devApi.script(JSON.parse(scriptKey) as ScriptRequest).then(
                (found) => keep({ key: scriptKey, script: found.script, problem: null }),
                (error) => keep({ key: scriptKey, script: null, problem: message(error) }),
            );
        }, 300);
        return () => window.clearTimeout(timer);
    }, [scriptKey]);

    // What the script imports from Yorg, to read beside it and to run it in the browser; and FullFlow's version.
    useEffect(() => {
        if ((view === "script" || reference) && !library) {
            devApi.library().then(setLibrary, (error) => setProblem(message(error)));
        }
    }, [view, reference, library]);

    const script = written?.script ?? null;
    const changed = edits !== null && edits.text !== edits.base;
    const stale = changed && script !== null && edits.base !== script;

    // A changed script keeps the tab's Python, which runs it, from stopping for want of use.
    useEffect(() => (changed ? python.acquire() : undefined), [changed]);

    // Leaving the page lets its run in the browser go (stopped, if it's on): its result would have nowhere to go.
    const browserId = useRef<string | null>(null);
    browserId.current = browser?.id ?? null;
    useEffect(
        () => () => {
            if (browserId.current) {
                python.forget(browserId.current);
            }
        },
        [],
    );

    // A run in the browser that's done: its result, shown as a run's on the server is.
    useEffect(() => {
        if (!browser || browser.shown || browserRecord?.status !== "done") {
            return;
        }
        const result = browserResult(browserRecord.output.reports);
        setBrowser({ ...browser, shown: true });
        if (result) {
            setShown({ result, model: browser.model, datasetId: browser.datasetId });
            if (result.anchors?.length) {
                setFound(anchoredFound(result));
            }
        }
    }, [browser, browserRecord]);

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
                            if (job.kind === "anchor") {
                                setFound(anchoredFound(status.result));
                            } else if (fit) {
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
        if (current.dirty || changed) {
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
        setEdits(null);
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

    const inBrowser =
        browserRecord !== null && (browserRecord.status === "queued" || browserRecord.status === "running");
    const scriptOnly = view === "script" && changed; // Fit and Anchor run the P&ID's model, not a changed script
    const simulated = browserRecord ? browserProgress(browserRecord.output.reports) : null;
    const browserTotal = browserRecord ? ((browserRecord.finished ?? now) - browserRecord.requested) / 1000 : 0;
    const browserStatus = !browserRecord
        ? ""
        : inBrowser
          ? simulated !== null && browser
              ? `Running in your browser: ${formatValue(simulated)} of ${formatValue(browser.duration)} s, ${Math.round(browserTotal)} s so far`
              : "Running in your browser…"
          : browserRecord.status === "done"
            ? `Done in your browser in ${formatSeconds(browserTotal)}`
            : browserRecord.status === "error"
              ? "Failed in your browser"
              : "Stopped";
    const running = inBrowser || (job !== null && (job.status === null || job.status.state === "running"));
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

    /** Let the last run in the browser go: a run on the server is the one shown now. */
    function forgetBrowser() {
        if (browser) {
            python.forget(browser.id);
            setBrowser(null);
        }
    }

    const runBody = (model: SystemModel, id: number) => ({
        model,
        dataset_id: id,
        start,
        end,
        dt,
        reading: readingFor(model.display),
        solver,
    });

    const startRun = () =>
        act(async () => {
            if (datasetId === null) {
                return;
            }
            const model = current.model;
            const started = await devApi.run(runBody(model, datasetId));
            forgetBrowser();
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
            forgetBrowser();
            setFound(null);
            setJob({ kind: "fit", id: started.id, model, datasetId, knobs, status: null });
        });

    const startAnchor = (plan: AnchorPlan) =>
        act(async () => {
            if (datasetId === null) {
                return;
            }
            const model = current.model;
            setAsking(null);
            setLastAnchors(plan);
            const started = await devApi.anchor({
                ...runBody(model, datasetId),
                anchors: anchorPicks(plan),
                knobs: plan.knobs,
                fallback: plan.fallback,
            });
            forgetBrowser();
            setFound(null);
            setJob({ kind: "anchor", id: started.id, model, datasetId, knobs: [], status: null });
        });

    /**
     * Run the script as it's shown: on the server while it's as written from the P&ID (with anchors, the anchored
     * run's, without a fit of what they don't settle), and in the browser once it's changed.
     */
    const startScript = () =>
        act(async () => {
            if (datasetId === null) {
                return;
            }
            const model = current.model;
            if (edits === null || edits.text === edits.base) {
                if (!anchoring) {
                    await startRun();
                    return;
                }
                const body = { ...runBody(model, datasetId), anchors: anchorPicks(lastAnchors) };
                const started = await devApi.anchor({ ...body, knobs: [], fallback: false });
                forgetBrowser();
                setFound(null);
                setJob({ kind: "anchor", id: started.id, model, datasetId, knobs: [], status: null });
                return;
            }
            const text = edits.text;
            const [imported, data] = await Promise.all([
                library ?? devApi.library(),
                devApi.inputs(runBody(model, datasetId)),
            ]);
            setLibrary(imported);
            forgetBrowser();
            setJob(null);
            setFound(null);
            const id = python.run(browserRun(text, imported, data));
            setBrowser({ id, model, datasetId, duration: end - start, shown: false });
        });

    /** Vespula's prop system, against its run's data: uploaded to Yorg the first time, found by its name after. */
    const openVespula = () =>
        withSaved(
            () =>
                void act(async () => {
                    open(vespulaExample(catalog), null, "Vespula prop system");
                    let found = datasets.find((one) => one.name === VESPULA_RUN.dataset);
                    if (!found) {
                        const { default: csv } = await import("./vespula-run.csv?raw");
                        const file = new File([csv], "Vespula prop system.csv", { type: "text/csv" });
                        const uploaded = await yorg.upload(file, () => {}, VESPULA_RUN.dataset);
                        found = uploaded;
                        setDatasets([uploaded, ...datasets]);
                    }
                    setDatasetId(found.id);
                    const origin = storedT0(found.id) ?? found.t_min ?? 0;
                    setWindowText({
                        from: formatValue(0 - origin),
                        to: formatValue(VESPULA_RUN.end - origin),
                        dt: "0.1",
                    });
                }),
        );

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
                            { label: "Vespula prop system, with its run's data", onSelect: openVespula },
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

            <div className="dev-views">
                <div className="dev-segmented" role="group" aria-label="View">
                    <button type="button" aria-pressed={view === "pid"} onClick={() => setView("pid")}>
                        P&amp;ID
                    </button>
                    <button
                        type="button"
                        aria-pressed={view === "script"}
                        onClick={() => setView("script")}
                        title="The model as the FullFlow script that runs it: to read, change, and run"
                    >
                        Script
                    </button>
                </div>
                <button
                    type="button"
                    className="dev-reference-toggle"
                    aria-pressed={reference}
                    onClick={() => setReference(!reference)}
                    title="What FullFlow is, and how it models a system"
                >
                    Reference
                </button>
            </div>

            {view === "pid" && (
                <>
                    <div className="dev-toolbar" role="toolbar" aria-label="Tools">
                        <button
                            type="button"
                            aria-pressed={tool.mode === "select"}
                            onClick={() => setTool({ mode: "select" })}
                        >
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
                                    change(
                                        { ...current.model, display: { ...display, gauge: event.target.checked } },
                                        false,
                                    )
                                }
                            />
                            Gauge
                        </label>
                        <select
                            aria-label="Units"
                            value={display.units}
                            onChange={(event) =>
                                change(
                                    {
                                        ...current.model,
                                        display: { ...display, units: event.target.value as "us" | "si" },
                                    },
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
                </>
            )}

            <div className={`dev-editor${view === "script" && !reference ? " dev-editor-wide" : ""}`}>
                {view === "script" ? (
                    <ScriptView
                        script={script}
                        problem={written?.problem ?? null}
                        text={changed ? edits.text : (script ?? "")}
                        onChange={(text) =>
                            setEdits(text === script ? null : { base: edits?.base ?? script ?? "", text })
                        }
                        changed={changed}
                        stale={stale}
                        onReset={() => setEdits(null)}
                        library={library}
                        note={
                            windowOk
                                ? null
                                : "Pick a test and the run's window: until then, the script is written for 0 to 10 s."
                        }
                        anchors={{
                            offered: lastAnchors.anchors.length > 0,
                            on: anchoring,
                            onChange: setWithAnchors,
                        }}
                        error={
                            browserRecord?.status === "error" && browserRecord.line !== null
                                ? {
                                      line: browserRecord.line,
                                      message: browserRecord.error ?? "",
                                      code: browserRecord.code,
                                  }
                                : null
                        }
                        onRun={() => {
                            if (windowOk && !running) {
                                void startScript();
                            }
                        }}
                    />
                ) : (
                    <Diagram
                        model={current.model}
                        catalog={catalog}
                        selected={selected}
                        tool={tool}
                        onSelect={(id) => {
                            setSelected(id);
                            if (id !== null) {
                                setReference(false); // a part picked: its settings, where the Reference was
                            }
                        }}
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
                )}
                {reference ? (
                    <FullFlowReference
                        version={
                            library?.packages
                                .find((one) => one.toLowerCase().startsWith("fullflow=="))
                                ?.split("==")[1] ?? null
                        }
                        onClose={() => setReference(false)}
                    />
                ) : (
                    view === "pid" && (
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
                                    Pick a part to set it up and link it to the test&apos;s channels: a tank&apos;s
                                    pressure, a valve&apos;s command, a junction&apos;s pressure transducer. A tank or
                                    junction linked to a sensor starts from its value at the run&apos;s start.
                                </p>
                            )}
                        </aside>
                    )
                )}
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
                <label
                    className="field"
                    title="Steady: FullFlow's quasi-steady sweep. In each time step, lines, junctions, and regulators settle at once, and tanks (and gas junctions a transducer reads) hold the pressure measured (or set) instead of draining. Much faster, without inertia."
                >
                    Solver
                    <select value={solver} onChange={(event) => setSolver(event.target.value as Solver)}>
                        <option value="transient">Transient</option>
                        <option value="steady">Steady</option>
                    </select>
                </label>
                {running ? (
                    <button
                        type="button"
                        onClick={() =>
                            inBrowser && browser
                                ? python.stop(browser.id)
                                : job && void act(async () => devApi.stop(job.id))
                        }
                    >
                        Stop
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="button-primary"
                            disabled={!windowOk}
                            onClick={() => void (view === "script" ? startScript() : startRun())}
                            title={
                                view === "script"
                                    ? changed
                                        ? "Run the script as it is, in your browser"
                                        : "Run the script on the server, as it's written"
                                    : undefined
                            }
                        >
                            {view === "script" && changed ? "Run in browser" : "Run"}
                        </button>
                        <button
                            type="button"
                            disabled={!windowOk || scriptOnly}
                            title={scriptOnly ? PID_ONLY : undefined}
                            onClick={() => setAsking({ ask: "fit" })}
                        >
                            Fit…
                        </button>
                        <button
                            type="button"
                            disabled={!windowOk || scriptOnly}
                            title={scriptOnly ? PID_ONLY : undefined}
                            onClick={() => setAsking({ ask: "anchor" })}
                        >
                            Anchor…
                        </button>
                    </>
                )}
                <span className="muted" role="status">
                    {browserRecord && job === null
                        ? browserStatus
                        : status?.state === "running" && (job?.kind === "fit" || progress?.tries !== undefined)
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
            {browserRecord && job === null && (
                <div className="dev-browser-run" aria-label="Run in the browser" role="region">
                    <RunView run={browserRecord} python={pythonState} now={now} />
                </div>
            )}
            {found && (
                <FitSummary
                    model={current.model}
                    catalog={catalog}
                    found={found.knobs}
                    note={found.note}
                    title={found.title}
                    spread={found.spread}
                    how={found.how}
                    onApply={() => {
                        change(applyKnobs(current.model, catalog, found.knobs));
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
            {asking?.ask === "anchor" && (
                <AnchorDialog
                    model={current.model}
                    catalog={catalog}
                    solver={solver}
                    picked={lastAnchors}
                    window={{ from: windowText.from, to: windowText.to }}
                    onStart={(plan) => void startAnchor(plan)}
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
                    <p>
                        {current.dirty
                            ? `${current.name} has changes that aren't saved.`
                            : `${current.name}'s script has changes.`}
                        {current.dirty && changed ? " Its script's changes go too." : ""}{" "}
                        {changed
                            ? "A changed script isn't saved with the model: copy it somewhere first to keep it."
                            : ""}
                    </p>
                </Dialog>
            )}
        </section>
    );
}
