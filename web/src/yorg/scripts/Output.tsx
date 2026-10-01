import { useEffect, useMemo, useState } from "react";
import { usePlotColors } from "../colors";
import type { AxisSpec } from "../layout";
import { Plot, type PlotSeries, type TimeAxis } from "../Plot";
import { Samples, sampleAt } from "../samples";
import { formatTick, formatValue, ticks } from "../scale";
import { Icon } from "./icons";
import { breakdown, formatElapsed, formatSeconds, stepNote, stepText, type Step } from "./progress";
import type { PythonState, RunRecord, ScriptPlotData } from "./python";
import { topImports } from "./tree";

// What Python's up to, where people look for it: its state in the page's bar (starting, getting a script's imports
// ready, running, ready), and a run's output: while it goes, the step it's on, for how long, and why that step takes
// as long as it does; once it's over, how long it took and where the time went; then what it printed, the files it
// offers, its plots, and matplotlib's figures.

const COLORS = ["#2f7ed8", "#e0a500", "#2aa876", "#d64541", "#8e5bd1", "#e67e22", "#16a0b5", "#7f8c8d"];

/** The time, kept current (every half second) while on: for timers beside what's going. */
export function useTicking(on: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!on) {
            return;
        }
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 500);
        return () => window.clearInterval(timer);
    }, [on]);
    return now;
}

/** Whether anything Python's doing has a timer going. */
export const isTicking = (python: PythonState, ...runs: (RunRecord | null)[]): boolean =>
    python.busy !== null || runs.some((run) => run?.status === "queued" || run?.status === "running");

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A step, and how long it's been going: "Importing CoolProp · 12 s". */
const stepLine = (step: Step, now: number, asked: string[] = []) =>
    `${stepText(step, asked)} · ${formatElapsed(now - step.since)}`;

/** Python's state, for the page's bar, with the way to start it over. */
export function PythonStatus({ python, now, onRestart }: { python: PythonState; now: number; onRestart: () => void }) {
    const busy = python.busy;
    let tone: "off" | "busy" | "running" | "ready" | "failed" = "ready";
    let text = `Python ${python.version ?? ""} ready`;
    if (python.status === "failed") {
        tone = "failed";
        text = `Python didn't start: ${python.error ?? "no reason given"}`;
    } else if (python.status === "off") {
        tone = "off";
        text = python.idle ? "Python stopped after half an hour unused: a run starts it" : "Python is off";
    } else if (busy?.kind === "run") {
        tone = "running";
        text = `Running · ${formatElapsed(now - busy.since)}`;
    } else if (busy) {
        tone = "busy";
        text =
            busy.kind === "start"
                ? stepLine(busy.step, now)
                : busy.kind === "tools"
                  ? `Getting the editor's suggestions ready · ${formatElapsed(now - busy.since)}`
                  : `Getting the script's imports ready: ${lowerFirst(stepLine(busy.step, now, busy.asked))}`;
    }
    return (
        <span className="python-status" title={text}>
            <span className={`python-dot python-${tone}`} aria-hidden="true" />
            <span role="status" className="python-status-text">
                {text}
            </span>
            {python.status === "failed" ? (
                <button type="button" className="button-small" onClick={onRestart}>
                    Start Python again
                </button>
            ) : (
                python.status === "ready" && (
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Restart Python"
                        onClick={onRestart}
                        title="Restart Python: afresh, without what it's imported and the channels it has (it takes a few seconds)"
                    >
                        <Icon name="restart" />
                    </button>
                )
            )}
        </span>
    );
}

// Under this, a notebook's cell that's done says only so, beside its name: a run that took longer says where the time went.
const WORTH_SAYING_S = 2;

/** What a cell's run is up to, beside the cell's name: "Running · 3 s", "✓ 0.4 s", "Not run". */
export function cellStatus(run: RunRecord, now: number): string {
    const total = ((run.finished ?? now) - run.requested) / 1000;
    switch (run.status) {
        case "queued":
            return `Waiting · ${formatElapsed(now - run.requested)}`;
        case "running":
            return `Running · ${formatElapsed(now - run.requested)}`;
        case "done":
            return `Done in ${formatSeconds(total)}`;
        case "error":
            return `Failed in ${formatSeconds(total)}`;
        case "stopped":
            return run.skipped ? "Not run" : `Stopped after ${formatSeconds(total)}`;
    }
}

/**
 * How a run is going, or how it went: a headline, what it's on (or where its time went), and why. Compact (a cell's,
 * whose name says how it went): only while it goes, when it took long enough to say where the time went, or stopped.
 */
function RunHeader({
    run,
    python,
    now,
    compact,
}: {
    run: RunRecord;
    python: PythonState;
    now: number;
    compact: boolean;
}) {
    const asked = useMemo(() => topImports(run.code), [run.code]);
    const total = ((run.finished ?? now) - run.requested) / 1000;
    if (compact && (run.status === "done" || run.status === "error") && total < WORTH_SAYING_S) {
        return null;
    }
    let title: string;
    let line: string | null = null;
    let note: string | null = null;
    switch (run.status) {
        case "queued": {
            title = `Waiting · ${formatElapsed(now - run.requested)}`;
            const busy = python.busy;
            if (run.step) {
                line = stepLine(run.step, now);
                note = stepNote(run.step);
            } else if (python.status === "failed") {
                line = `Python didn't start: ${python.error ?? "no reason given"}`;
                note = "Start it again above, and the run goes on.";
            } else if (busy?.kind === "run") {
                line = "Waiting for the run before it";
            } else if (busy?.kind === "tools") {
                line = `Waiting for Python: getting the editor's suggestions ready · ${formatElapsed(now - busy.since)}`;
            } else if (busy) {
                line = `Waiting for Python: ${lowerFirst(stepLine(busy.step, now, busy.asked))}`;
                note = stepNote(busy.step);
            } else {
                line = "Starting";
            }
            break;
        }
        case "running":
            title = `Running · ${formatElapsed(now - run.requested)}`;
            if (run.step) {
                line = stepLine(run.step, now, asked);
                note = stepNote(run.step);
            }
            break;
        case "done":
        case "error":
            title = `${run.status === "done" ? "Done" : "Failed"} in ${formatSeconds(total)}`;
            line = breakdown(run.timings, total, asked)
                .map((part) => `${part.label} ${formatSeconds(part.seconds)}`)
                .join(" · ");
            break;
        case "stopped":
            title = run.skipped ? "Not run" : `Stopped after ${formatSeconds(total)}`;
            line =
                run.skipped === "failed"
                    ? "A cell run before it failed, so it wasn't run."
                    : run.skipped === "restart"
                      ? "Python started again before it ran."
                      : run.restarted
                        ? "Python is starting again without what it had: the next run imports its modules and gets its channels again."
                        : "It hadn't started.";
            break;
    }
    const going = run.status === "queued" || run.status === "running";
    return (
        <div className={`run-header run-${run.status}`}>
            {going && <div className="run-bar" aria-hidden="true" />}
            <div className="run-title">
                <span className="run-icon" aria-hidden="true" />
                <strong>{title}</strong>
            </div>
            {line && <p className="run-line">{line}</p>}
            {note && <p className="run-note muted">{note}</p>}
        </div>
    );
}

/**
 * A run's output, under how it's going (or went): compact for a notebook's cell (see RunHeader). Its plots are drawn
 * here, or, on a dataset's or view's page (plotsOnPage), said to be on the page's plots.
 */
export function RunView({
    run,
    python,
    now,
    compact = false,
    plotsOnPage = false,
}: {
    run: RunRecord;
    python: PythonState;
    now: number;
    compact?: boolean;
    plotsOnPage?: boolean;
}) {
    const { output } = run;
    return (
        <>
            <RunHeader run={run} python={python} now={now} compact={compact} />
            {(output.lines.length > 0 || run.error) && (
                <pre className="scripts-console" aria-label="Printed">
                    {output.lines.map((line, index) => (
                        <span key={index} className={`scripts-${line.kind}`}>
                            {line.text}
                            {"\n"}
                        </span>
                    ))}
                    {output.dropped > 0 && (
                        <span className="scripts-note">
                            … and {output.dropped.toLocaleString()} more lines, not shown
                            {"\n"}
                        </span>
                    )}
                    {run.error && <span className="scripts-error">{run.error}</span>}
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
            {plotsOnPage
                ? output.plots.length > 0 && (
                      <p className="scripts-elsewhere muted">
                          On the page&apos;s plots: {output.plots.map((plot) => plot.title).join(", ")}
                      </p>
                  )
                : output.plots.map((plot) => <ScriptPlot key={plot.title} {...plot} />)}
            {output.figures.map((url, index) => (
                <img key={url} src={url} alt={`Figure ${index + 1}`} className="scripts-figure" />
            ))}
        </>
    );
}

/** One of a script's plots (yorg.plot): its series over their x, zoomable like Yorg's. */
function ScriptPlot({ title, series }: ScriptPlotData) {
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
        <div
            className="scripts-plot"
            title="Drag across to zoom; Ctrl (⌘) and the wheel, or a pinch, zoom too; double-click shows it all"
        >
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
                wheelScrolls
            />
        </div>
    );
}
