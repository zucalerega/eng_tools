import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { handoffOf, starterScript } from "../analysis";
import { dataset as loadDataset, useLoaded } from "../data";
import type { Layout } from "../layout";
import type { ExtraPlot } from "../Workspace";
import { codeOf, parseCells, type Cell } from "./cells";
import type { Attached } from "./complete";
import { gatherInputs, type PageView } from "./inputs";
import { Notebook } from "./Notebook";
import { python, usePython, useRuns } from "./python";
import { keepNotebook, keptNotebook, openInScripts } from "./stored";
import "../models/models.css";
import "./scripts.css";

// A dataset's or view's page's own Python, docked beside its plots: a notebook of the page's (kept in the tab), on the
// page's tests, run with its time in view, T0, and shifts as they are when a cell runs (yorg.window, yorg.t0,
// yorg.shifts), and whose plots go on the page's own, on its time axis (the Workspace's extra plots), while it's open.
// It starts on what the page plots. Its notebook, variables and all, opens on the Scripts page to be kept.

const PREPARE_MS = 600; // how long typing pauses before Python gets the notebook's imports ready
const WIDTH_KEY = "yorg.python.width";
const MIN_WIDTH = 340;

interface Props {
    page: string; // whose notebook: "dataset-5", "view-12"
    title: string; // the page's: "Hotfire 3", or the view's name
    layout: Layout;
    onPlots: (plots: ExtraPlot[]) => void;
    onClose: () => void;
}

/** How wide it was dragged to, else a third of the window or so (the plots keep the most of it). */
function storedWidth(): number {
    const fallback = Math.round(Math.min(560, Math.max(MIN_WIDTH + 40, window.innerWidth * 0.34)));
    try {
        const found = Number(window.localStorage.getItem(WIDTH_KEY));
        return Number.isFinite(found) && found >= MIN_WIDTH ? found : fallback;
    } catch {
        return fallback;
    }
}

/** The page's time in view (all of its tests', when it hasn't been zoomed), on the first test's clock. */
function inView(layout: Layout): [number, number] | null {
    if (layout.window) {
        return layout.window;
    }
    let start = Infinity;
    let end = -Infinity;
    for (const ref of layout.datasets) {
        const loaded = loadDataset(ref.id);
        if (loaded.status === "ready" && loaded.value.t_min !== null && loaded.value.t_max !== null) {
            start = Math.min(start, loaded.value.t_min + ref.shift);
            end = Math.max(end, loaded.value.t_max + ref.shift);
        }
    }
    return end >= start ? [start, end] : null;
}

export function PythonDock({ page, title, layout, onPlots, onClose }: Props) {
    useLoaded();
    const state = usePython();
    const datasets = useMemo(() => layout.datasets.map((ref) => ref.id), [layout.datasets]);
    const names = Object.fromEntries(
        datasets.map((id) => {
            const loaded = loadDataset(id);
            return [id, loaded.status === "ready" ? loaded.value.name : `test ${id}`];
        }),
    );
    const [cells, setCells] = useState<Cell[]>(
        () => keptNotebook(page)?.cells ?? parseCells(starterScript(handoffOf(layout, title), names)),
    );
    const [runs, setRuns] = useState<Record<string, string>>(() => keptNotebook(page)?.runs ?? {});
    const [width, setWidth] = useState(storedWidth);
    const namespace = `page-${page}`;
    const code = useMemo(() => codeOf(cells), [cells]);

    useEffect(() => python.acquire(), []);
    useEffect(() => keepNotebook(page, { cells, runs }), [page, cells, runs]);

    // As on the Scripts page: while it's read and edited, Python gets its slow imports ready, and the channels it names
    // come from the server.
    const ready = state.status === "ready";
    useEffect(() => {
        if (!ready) {
            return;
        }
        const timer = window.setTimeout(() => {
            python.prepare(code);
            gatherInputs(code, datasets).catch(() => {}); // what's wrong, the run says
        }, PREPARE_MS);
        return () => window.clearTimeout(timer);
    }, [code, datasets, ready, state.generation]);

    // The page's tests and their channels, for the editor's suggestions.
    const attached: Attached[] = datasets.map((id) => {
        const loaded = loadDataset(id);
        const detail = loaded.status === "ready" ? loaded.value : null;
        return {
            id,
            name: names[id] ?? `Test ${id}`,
            channels: detail ? detail.channels.map(({ name, unit }) => ({ name, unit })) : [],
        };
    });

    const view: PageView = {
        window: inView(layout),
        t0: layout.t0,
        shifts: Object.fromEntries(layout.datasets.map((ref) => [ref.id, ref.shift])),
    };

    // What its cells' last runs drew goes on the page's plots, while it's open: said again only when that changes (a
    // plot's id is its run's, so running a cell again brings one taken off the page back).
    const records = useRuns(cells.map((cell) => runs[cell.id]));
    const drawn = records.flatMap((record) =>
        (record?.output.plots ?? []).map((plot, index) => ({ id: `${record!.id}:${index}`, ...plot })),
    );
    const key = drawn.map((plot) => `${plot.id}:${plot.series.length}`).join("|");
    const plots = useMemo(() => drawn, [key]);
    const report = useRef(onPlots);
    report.current = onPlots;
    useEffect(() => report.current(plots), [plots]);
    useEffect(() => () => report.current([]), []);

    /** Drag the dock's edge to make it wider or narrower. */
    function resize(event: ReactPointerEvent<HTMLDivElement>) {
        const startX = event.clientX;
        const startWidth = width;
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const most = () => Math.max(MIN_WIDTH, window.innerWidth * 0.7);
        const move = (next: PointerEvent) =>
            setWidth(Math.min(most(), Math.max(MIN_WIDTH, startWidth + startX - next.clientX)));
        const done = (last: PointerEvent) => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", done);
            const final = Math.min(most(), Math.max(MIN_WIDTH, startWidth + startX - last.clientX));
            try {
                window.localStorage.setItem(WIDTH_KEY, String(Math.round(final)));
            } catch {
                // storage blocked: the width's for this visit
            }
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", done);
    }

    return (
        <aside className="yorg-dock" aria-label="Python" style={{ width }}>
            <div
                className="yorg-dock-edge"
                role="separator"
                aria-orientation="vertical"
                aria-label="Python's width"
                title="Drag to make it wider or narrower"
                onPointerDown={resize}
            />
            <div className="yorg-dock-head">
                <h2>Python</h2>
                <span className="muted">on {title}: its plots go on this page&apos;s</span>
                <button
                    type="button"
                    className="button-small"
                    title="The notebook on the Scripts page, to keep it: its cells, tests, and variables go along"
                    onClick={() => openInScripts({ name: `From ${title}`, cells, namespace, datasets })}
                >
                    Open in Scripts
                </button>
                <button type="button" className="button-small" aria-label="Close Python" onClick={onClose}>
                    ×
                </button>
            </div>
            <Notebook
                cells={cells}
                setCells={setCells}
                runs={runs}
                setRuns={setRuns}
                namespace={namespace}
                datasets={datasets}
                attached={attached}
                onSave={() => {}}
                view={view}
            />
        </aside>
    );
}
