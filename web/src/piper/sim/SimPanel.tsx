import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog, Notice } from "../../components";
import { formatValue } from "../../scale";
import { usePalette } from "../colors";
import type { Commands } from "../commands";
import { useEditor, type EditorStore } from "../store";
import { samplesOf, type Samples, type TestDetail } from "../testdata";
import { TestSelect } from "../TestPanel";
import { formatSeconds, Timeline } from "../Timeline";
import { NO_PLAN, type AnchorPlan } from "./Anchor";
import {
    simApi,
    type AnchorPick,
    type Catalog,
    type FitKnob,
    type Knob,
    type RunResult,
    type RunStatus,
    type ScriptRequest,
    type Solver,
    type SystemModel,
} from "./api";
import { FitSummary } from "./Fit";
import type { Built } from "./model";
import { Reference } from "./Reference";
import { Results } from "./Results";
import { ScriptDialog } from "./Script";
import { applyKnobs, comparisons } from "./settings";
import { type Method, TuneDialog } from "./Tune";
import { readingFor } from "./units";

// Simulation mode's panel, under the drawing: the test the P&ID's model runs against (one of Yorg's, as Test data
// reads), the run's window, time step, and solver, and Run and Tune…, which Yorg runs with FullFlow on the server; what
// keeps the model from running, or what it does differently than the P&ID might seem to say, each to go to; and a
// run's results, compared with the test, on the timeline the drawing shows. What a fit or an anchored run found is the
// P&ID's when it's applied.

const FULLFLOW = "https://github.com/saakethramoju/FullFlow";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A run shown: what it found, the model as it ran (and what each of its parts was on the P&ID), against which test. */
export interface Shown {
    result: RunResult;
    model: SystemModel;
    built: Built;
    testId: number;
}

/** A run, a fit, or an anchored run on the server: what it ran, and how it's going. */
export interface Job {
    kind: "run" | "fit" | "anchor";
    id: string;
    built: Built;
    testId: number;
    knobs: Knob[];
    status: RunStatus | null;
}

/** What a fit (or an anchored run) found, to apply: the knobs from where they started, and how it went. */
export interface Found {
    built: Built;
    knobs: FitKnob[];
    note: string;
    title?: string;
    spread?: Record<string, [number, number]>; // an anchored run's: how much each knob moved, by part.key
    how?: Record<string, string>; // and how each was found (anchored, fitted), by part.key
}

/**
 * What the panel has, kept by the editor while the diagram's open, so turning Simulation mode off and on again keeps it:
 * the run's settings, the run going (which the panel asks after while it's shown), what it found, and what's shown.
 */
export interface SimState {
    window: { from: string; to: string; dt: string }; // seconds on the test's clock
    windowFor: number | null; // the test the window was set for
    solver: Solver;
    job: Job | null;
    found: Found | null;
    shown: Shown | null;
    lastKnobs: Knob[]; // the last fit's, to start the next from
    lastAnchors: AnchorPlan; // the last anchored run's
    lastMethod: Method;
}

export const NO_SIM: SimState = {
    window: { from: "", to: "", dt: "0.01" },
    windowFor: null,
    solver: "transient",
    job: null,
    found: null,
    shown: null,
    lastKnobs: [],
    lastAnchors: NO_PLAN,
    lastMethod: "fit",
};

/** What an anchored run found, to apply: its anchored knobs (where FullFlow could anchor them), and what it fitted. */
function anchoredFound(built: Built, result: RunResult): Found {
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
        built,
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

/** The page each of the P&ID's parts and lines is on, to go to it. */
function pageOfItem(store: EditorStore, id: string): number {
    const pages = store.getState().document.pages;
    const found = pages.findIndex(
        (page) => page.parts.some((part) => part.id === id) || page.lines.some((line) => line.id === id),
    );
    return found >= 0 ? found : store.getState().page;
}

/** The channels a run's compared with, loaded from the test as they're wanted (each once), beside those Test data
 * has. */
function useSamples(test: TestDetail | null, names: string[], have: ReadonlyMap<string, Samples>) {
    const [loaded, setLoaded] = useState<Map<string, Samples>>(new Map());
    const [problem, setProblem] = useState<string | null>(null);
    const asked = useRef<{ test: TestDetail | null; names: Set<string> }>({ test: null, names: new Set() });
    const wanted = names.filter((name) => !have.has(name)).join("\u0000");
    useEffect(() => {
        if (asked.current.test !== test) {
            asked.current = { test, names: new Set() };
            setLoaded(new Map());
            setProblem(null);
        }
        const now = asked.current;
        for (const name of test && wanted ? wanted.split("\u0000") : []) {
            const channel = test!.channels.find((one) => one.name === name);
            if (!channel || now.names.has(name)) {
                continue;
            }
            now.names.add(name);
            samplesOf(test!, channel).then(
                (samples) => asked.current === now && setLoaded((before) => new Map(before).set(name, samples)),
                (error: unknown) => asked.current === now && setProblem(`Couldn't load ${name}: ${message(error)}`),
            );
        }
    }, [test, wanted]);
    return { samples: useMemo(() => new Map([...have, ...loaded]), [have, loaded]), problem };
}

/** One end of the run's window, in seconds on the test's clock; or, at a click, the time on the timeline. */
function TimeField({
    label,
    value,
    time,
    onChange,
}: {
    label: string;
    value: string;
    time: number;
    onChange: (value: string) => void;
}) {
    const id = useId();
    return (
        <div className="piper-sim-field">
            <label htmlFor={id}>{label}</label>
            <span className="piper-sim-time">
                <input
                    id={id}
                    inputMode="decimal"
                    title="Seconds on the test's clock"
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                />
                <button
                    type="button"
                    className="piper-sim-now"
                    title="The time on the timeline"
                    aria-label={`${label}: the time on the timeline`}
                    onClick={() => onChange(formatValue(time))}
                >
                    ◷
                </button>
            </span>
        </div>
    );
}

export function SimPanel({
    store,
    commands,
    catalog,
    catalogProblem,
    built,
    testId,
    test,
    testSamples,
    testProblem,
    time,
    state,
    onState,
    onTest,
    onTime,
    onClose,
}: {
    store: EditorStore;
    commands: Commands;
    catalog: Catalog | null; // null: still loading
    catalogProblem: string | null; // why it isn't there
    built: Built | null;
    testId: number | null;
    test: TestDetail | null; // the test, once it's loaded
    testSamples: ReadonlyMap<string, Samples>; // the channels Test data has loaded of it already
    testProblem: string | null;
    time: number;
    state: SimState;
    onState: (change: (now: SimState) => SimState) => void;
    onTest: (id: number | null) => void;
    onTime: (time: number, settled: boolean) => void;
    onClose: () => void;
}) {
    const { window: windowText, solver, job, found, shown, lastKnobs, lastAnchors, lastMethod } = state;
    const [problem, setProblem] = useState<string | null>(null);
    const [asking, setAsking] = useState<"tune" | "script" | "reference" | null>(null);
    const editing = !useEditor(store, (now) => now.readOnly); // what a fit found goes on the P&ID only while it's yours
    const palette = usePalette(); // the drawing's: its gold for the model's values
    const [version, setVersion] = useState<string | null>(null);
    const setWindowText = (window: SimState["window"]) => onState((now) => ({ ...now, window }));
    const setFound = (next: Found | null) => onState((now) => ({ ...now, found: next }));

    // A test chosen: its window starts as its first ten seconds, until it's changed.
    useEffect(() => {
        if (!test || state.windowFor === test.id || test.t_min === null || test.t_max === null) {
            return;
        }
        const to = Math.min(test.t_max, test.t_min + 10);
        onState((now) => ({
            ...now,
            windowFor: test.id,
            window: { ...now.window, from: formatValue(test.t_min!), to: formatValue(to) },
        }));
    }, [test, state.windowFor, onState]);

    // FullFlow's version, as the server runs it: said beside its name.
    useEffect(() => {
        simApi.library().then(
            (library) =>
                setVersion(
                    library.packages.find((one) => one.toLowerCase().startsWith("fullflow=="))?.split("==")[1] ?? null,
                ),
            () => setVersion(null),
        );
    }, []);

    // While a run or a fit goes, ask how it's doing.
    useEffect(() => {
        if (!job || (job.status && job.status.state !== "running")) {
            return;
        }
        const timer = window.setTimeout(
            () => {
                simApi.status(job.id).then(
                    (status) => {
                        // Unless another run has taken its place meanwhile.
                        const update = (change: Partial<SimState>) =>
                            onState((now) => (now.job?.id === job.id ? { ...now, ...change } : now));
                        update({ job: { ...job, status } });
                        if (status.state === "done") {
                            const shown = {
                                result: status.result,
                                model: job.built.model,
                                built: job.built,
                                testId: job.testId,
                            };
                            const fit = status.result.fit;
                            if (job.kind === "anchor") {
                                update({ shown, found: anchoredFound(job.built, status.result) });
                            } else if (fit) {
                                const better = fit.cost_start > 0 ? 100 * (1 - fit.cost / fit.cost_start) : 0;
                                update({
                                    shown,
                                    found: {
                                        built: job.built,
                                        knobs: fit.knobs,
                                        note: `${fit.stopped ? "Stopped at the time limit: the best of" : "Done:"} ${fit.tries} runs, the error ${better.toFixed(1)}% smaller.`,
                                    },
                                });
                            } else {
                                update({ shown });
                            }
                        } else if (status.state === "failed" && job.kind === "fit" && status.progress?.values) {
                            // Stopped: what it had found so far is still worth having.
                            const values = status.progress.values;
                            const parts = [...job.built.model.nodes, ...job.built.model.edges];
                            update({
                                found: {
                                    built: job.built,
                                    knobs: job.knobs.map((knob, index) => ({
                                        ...knob,
                                        start: Number(
                                            parts.find((one) => one.id === knob.part)?.settings[knob.key] ?? 0,
                                        ),
                                        value: values[index] ?? 0,
                                    })),
                                    note: `Stopped after ${status.progress.tries ?? 0} runs: the best it had found.`,
                                },
                            });
                        }
                    },
                    (error: unknown) =>
                        onState((now) =>
                            now.job?.id === job.id
                                ? {
                                      ...now,
                                      job: {
                                          ...job,
                                          status: { state: "failed", elapsed: 0, duration: 0, message: message(error) },
                                      },
                                  }
                                : now,
                        ),
                );
            },
            job.kind === "fit" ? 1000 : 600,
        );
        return () => window.clearTimeout(timer);
    }, [job, onState]);

    const from = Number(windowText.from);
    const to = Number(windowText.to);
    const dt = Number(windowText.dt);
    const windowOk =
        windowText.from.trim() !== "" &&
        windowText.to.trim() !== "" &&
        Number.isFinite(from) &&
        Number.isFinite(to) &&
        to > from &&
        dt > 0;
    const problems = built?.findings.filter((one) => one.problem) ?? [];
    const notes = built?.findings.filter((one) => !one.problem) ?? [];
    const ready = catalog !== null && built !== null && test !== null && testId !== null && windowOk;
    const runnable = ready && problems.length === 0;
    const running = job !== null && (job.status === null || job.status.state === "running");
    const status = job?.status;
    const progress = status?.progress;
    const better =
        progress?.cost_start && progress.cost !== undefined && Number.isFinite(progress.cost)
            ? 100 * (1 - progress.cost / progress.cost_start)
            : null;
    const compared = useMemo(
        () => (catalog && shown ? comparisons(shown.model, catalog).map((one) => one.channel) : []),
        [catalog, shown],
    );
    const loaded = useSamples(shown && test && shown.testId === test.id ? test : null, compared, testSamples);

    /** An anchor plan's anchors, as the server takes them: their spans on the test's clock (blank: the run's). */
    const anchorPicks = (plan: AnchorPlan): AnchorPick[] =>
        plan.anchors.map((one) => ({
            part: one.part,
            key: one.key,
            sensor: one.sensor,
            link: one.link,
            start: one.from.trim() === "" ? undefined : Number(one.from),
            end: one.to.trim() === "" ? undefined : Number(one.to),
        }));

    async function act(action: () => Promise<void>) {
        setProblem(null);
        try {
            await action();
        } catch (error) {
            setProblem(message(error));
        }
    }

    const runBody = (now: Built, test: number) => ({
        model: now.model,
        dataset_id: test,
        start: from,
        end: to,
        dt,
        reading: readingFor(now.model.display),
        solver,
    });

    const start = (kind: Job["kind"], knobs: Knob[], begin: (body: ReturnType<typeof runBody>) => Promise<string>) =>
        act(async () => {
            if (!built || testId === null) {
                return;
            }
            setAsking(null);
            const id = await begin(runBody(built, testId));
            onState((now) => ({ ...now, found: null, job: { kind, id, built, testId, knobs, status: null } }));
        });

    const startRun = () => start("run", [], async (body) => (await simApi.run(body)).id);
    const startFit = (knobs: Knob[]) => {
        onState((now) => ({ ...now, lastKnobs: knobs, lastMethod: "fit" }));
        return start("fit", knobs, async (body) => (await simApi.fit({ ...body, knobs })).id);
    };
    const startAnchor = (plan: AnchorPlan) => {
        onState((now) => ({ ...now, lastAnchors: plan, lastMethod: "anchor" }));
        return start(
            "anchor",
            [],
            async (body) =>
                (
                    await simApi.anchor({
                        ...body,
                        anchors: anchorPicks(plan),
                        knobs: plan.knobs,
                        fallback: plan.fallback,
                    })
                ).id,
        );
    };

    const scriptRequest = (): ScriptRequest | null =>
        built
            ? {
                  model: built.model,
                  start: windowOk ? from : (test?.t_min ?? 0),
                  end: windowOk ? to : (test?.t_min ?? 0) + 10,
                  dt: dt > 0 ? dt : 0.01,
                  solver,
              }
            : null;

    const shownHere = shown && test && shown.testId === test.id ? shown : null;
    const statusText =
        status?.state === "running" && (job?.kind === "fit" || progress?.tries !== undefined)
            ? `Fitting: ${progress?.tries ?? 0} runs${better === null ? "" : `, the error ${better.toFixed(1)}% smaller`}, ${Math.round(status.elapsed)} s so far`
            : status?.state === "running"
              ? `Running: ${formatValue(Number(status.done.toPrecision(4)))} of ${formatValue(Number(status.duration.toPrecision(4)))} s, ${Math.round(status.elapsed)} s so far`
              : running
                ? "Starting…"
                : status?.state === "done"
                  ? `Done in ${Math.round(status.elapsed)} s`
                  : "";
    return (
        <section className="piper-test piper-sim" aria-label="Simulation">
            <div className="piper-test-head">
                <h2>Simulation</h2>
                <TestSelect testId={testId} onTest={onTest} />
                <span className="muted piper-small">
                    Powered by{" "}
                    <a href={FULLFLOW} target="_blank" rel="noreferrer">
                        FullFlow
                    </a>
                    {version ? ` ${version}` : ""}
                </span>
                <button type="button" className="button-small" onClick={() => setAsking("script")} disabled={!built}>
                    Script
                </button>
                <button
                    type="button"
                    className="button-small"
                    onClick={() => setAsking("reference")}
                    disabled={!catalog}
                >
                    How it&apos;s modeled
                </button>
                <button type="button" className="piper-close" aria-label="Leave Simulation mode" onClick={onClose}>
                    ×
                </button>
            </div>
            {testProblem && <Notice tone="error">{testProblem}</Notice>}
            {problem && <Notice tone="error">{problem}</Notice>}
            <div className="piper-sim-run" role="group" aria-label="Run">
                <TimeField
                    label="From (s)"
                    value={windowText.from}
                    time={time}
                    onChange={(from) => setWindowText({ ...windowText, from })}
                />
                <TimeField
                    label="To (s)"
                    value={windowText.to}
                    time={time}
                    onChange={(to) => setWindowText({ ...windowText, to })}
                />
                <label className="piper-sim-field">
                    Time step (s)
                    <input
                        inputMode="decimal"
                        value={windowText.dt}
                        onChange={(event) => setWindowText({ ...windowText, dt: event.target.value })}
                    />
                </label>
                <label
                    className="piper-sim-field"
                    title="Steady: FullFlow's quasi-steady sweep. In each time step, lines, points, and regulators settle at once, and tanks (and gas vessels and points a transducer reads) hold the pressure measured (or set) instead of draining. Much faster, without inertia."
                >
                    Solver
                    <select
                        value={solver}
                        onChange={(event) => onState((now) => ({ ...now, solver: event.target.value as Solver }))}
                    >
                        <option value="transient">Transient</option>
                        <option value="steady">Steady</option>
                    </select>
                </label>
                {running ? (
                    <button type="button" onClick={() => job && void act(async () => simApi.stop(job.id))}>
                        Stop
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="button-primary"
                            disabled={!runnable}
                            onClick={() => void startRun()}
                        >
                            Run
                        </button>
                        <button
                            type="button"
                            disabled={!runnable}
                            title="Fit or anchor the knobs (settings marked tune) to the test"
                            onClick={() => setAsking("tune")}
                        >
                            Tune…
                        </button>
                    </>
                )}
                <span className="muted piper-small" role="status">
                    {statusText}
                </span>
            </div>
            {testId === null && (
                <p className="muted piper-small">
                    The P&amp;ID is the model: pick a test, and its valves open as their channels say, what it&apos;s
                    linked to follows the test, and each transducer and flow meter is compared with what the model reads
                    there. Select a part to set it up.
                </p>
            )}
            {status?.state === "failed" && <Notice tone="error">{status.message}</Notice>}
            {catalogProblem ? (
                <Notice tone="error">The model&apos;s parts didn&apos;t load: {catalogProblem}</Notice>
            ) : (
                catalog === null && <p className="muted piper-small">Loading the model&apos;s parts…</p>
            )}
            {(problems.length > 0 || notes.length > 0) && (
                <ul className="piper-sim-findings" aria-label="What the model says of the P&ID">
                    {[...problems, ...notes].map((one, index) => (
                        <li key={index} className={one.problem ? "piper-sim-problem" : undefined}>
                            <span>{one.text}</span>
                            {one.items.length > 0 && (
                                <button
                                    type="button"
                                    className="button-small"
                                    onClick={() => commands.goTo(pageOfItem(store, one.items[0]!), one.items)}
                                >
                                    Go to
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {test && test.t_min !== null && test.t_max !== null && test.t_max > test.t_min && (
                <Timeline
                    key={test.id}
                    start={test.t_min}
                    end={test.t_max}
                    time={time}
                    events={test.events}
                    band={windowOk ? [from, to] : null}
                    onTime={onTime}
                />
            )}
            {shownHere && (
                <p className="muted piper-small piper-sim-key">
                    On the drawing at {formatSeconds(time)}, in the diagram&apos;s units: what the test measured, then{" "}
                    <strong style={{ color: palette.model }}>the model&apos;s, in gold</strong>.
                </p>
            )}
            <div className="piper-sim-body">
                {found && catalog && (
                    <FitSummary
                        model={found.built.model}
                        catalog={catalog}
                        found={found.knobs}
                        note={found.note}
                        title={found.title}
                        spread={found.spread}
                        how={found.how}
                        editing={editing}
                        onApply={() => {
                            store.commitDocument(
                                applyKnobs(store.getState().document, found.built, catalog, found.knobs),
                            );
                            setFound(null);
                        }}
                        onDiscard={() => setFound(null)}
                    />
                )}
                {loaded.problem && <Notice tone="error">{loaded.problem}</Notice>}
                {shownHere && catalog && test && (
                    <Results
                        model={shownHere.model}
                        catalog={catalog}
                        result={shownHere.result}
                        test={test}
                        samples={loaded.samples}
                        time={time}
                        onTime={(t) => onTime(t, true)}
                    />
                )}
            </div>
            {asking === "tune" && built && catalog && (
                <TuneDialog
                    model={built.model}
                    catalog={catalog}
                    solver={solver}
                    method={lastMethod}
                    knobs={lastKnobs}
                    plan={lastAnchors}
                    window={{ from: windowText.from, to: windowText.to }}
                    onFit={(knobs) => void startFit(knobs)}
                    onAnchor={(plan) => void startAnchor(plan)}
                    onCancel={() => setAsking(null)}
                />
            )}
            {asking === "script" && scriptRequest() && (
                <ScriptDialog
                    request={scriptRequest()!}
                    anchors={anchorPicks(lastAnchors)}
                    onClose={() => setAsking(null)}
                />
            )}
            {asking === "reference" && catalog && (
                <Dialog title="How the simulation's modeled" cancel="Close" onCancel={() => setAsking(null)} tall wide>
                    <Reference catalog={catalog} version={version} />
                </Dialog>
            )}
        </section>
    );
}
