import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type DragEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";
import { MenuButton, Notice, usePopover } from "../components";
import type { Channel, DatasetDetail } from "./api";
import { usePlotColors } from "./colors";
import { dataset as loadDataset, samples as loadSamples, useLoaded, type Loaded } from "./data";
import { exportCsv, exportImage } from "./export";
import {
    PALETTE,
    shiftOf,
    type Action,
    type AxisSpec,
    type Layout,
    type PanelSpec,
    type SeriesSpec,
    type Side,
} from "./layout";
import { Plot, type PlotMark, type PlotSeries, type TimeAxis } from "./Plot";
import { sampleAt, type Placement, type Samples } from "./samples";
import { clockTicks, formatClock, formatDuration, formatTick, formatValue, ticks } from "./scale";
import { Sidebar } from "./Sidebar";

// A page of plots: the channels on the left, and panels stacked on one time axis, each with its legend. Every
// panel shows the same time window and the same cursor.

/** A series with what it draws: its dataset, channel, and samples (or why they're missing). */
export interface Resolved {
    spec: SeriesSpec;
    panel: string;
    detail: DatasetDetail | null;
    channel: Channel | null;
    samples: Samples | null;
    placement: Placement;
    name: string;
    unit: string;
    step: boolean;
    problem: string | null;
    loading: boolean;
}

export const CHANNEL_TYPE = "application/x-yorg-channel";

function resolve(layout: Layout, panel: PanelSpec, spec: SeriesSpec, several: boolean): Resolved {
    const placement = { shift: shiftOf(layout, spec.dataset), scale: spec.scale, offset: spec.offset };
    const base = { spec, panel: panel.id, placement, name: spec.label || spec.channel, unit: spec.unit ?? "" };
    const loaded = loadDataset(spec.dataset);
    if (loaded.status !== "ready") {
        return {
            ...base,
            detail: null,
            channel: null,
            samples: null,
            step: spec.step ?? false,
            problem: loaded.status === "failed" ? `Couldn't load its dataset: ${loaded.error}` : null,
            loading: loaded.status === "loading",
        };
    }
    const detail = loaded.value;
    const channel = detail.channels.find((one) => one.name === spec.channel) ?? null;
    const name = (spec.label || spec.channel) + (several && !spec.label ? ` · ${detail.name}` : "");
    const unit = spec.unit ?? channel?.unit ?? "";
    const step = spec.step ?? channel?.kind === "state";
    if (!channel) {
        return {
            ...base,
            name,
            unit,
            detail,
            channel,
            samples: null,
            step,
            problem: `${detail.name} has no channel called ${spec.channel}`,
            loading: false,
        };
    }
    const found: Loaded<Samples> = loadSamples(detail, channel);
    return {
        ...base,
        name,
        unit,
        detail,
        channel,
        samples: found.status === "ready" ? found.value : null,
        step,
        problem: found.status === "failed" ? `Couldn't load it: ${found.error}` : null,
        loading: found.status === "loading",
    };
}

/** How to write a reading: a state's name, or the number with the file's decimals (if it isn't scaled). */
export function reading(series: Resolved, value: number): string {
    const plain = series.spec.scale === 1 && series.spec.offset === 0;
    if (plain && series.channel?.kind === "state" && Number.isInteger(value)) {
        return series.channel.labels[value] ?? formatValue(value);
    }
    return formatValue(value, plain ? (series.channel?.decimals ?? null) : null);
}

interface TimeLabels {
    axis: TimeAxis;
    title: string;
    at: (x: number) => string; // the cursor's time
    number: (x: number) => number; // what the window's inputs show for a time
    fromNumber: (value: number) => number;
    clockable: boolean;
}

function timeLabels(layout: Layout, primary: DatasetDetail | null): TimeLabels {
    const base =
        primary?.start_epoch === null || primary?.start_epoch === undefined
            ? null
            : primary.start_epoch + (primary.time_kind === "absolute" ? (primary.read_info.utc_offset ?? 0) : 0);
    const zero = layout.t0 ?? 0;
    const relative = {
        number: (x: number) => x - zero,
        fromNumber: (value: number) => value + zero,
        clockable: base !== null,
    };
    if (layout.clock && base !== null) {
        return {
            ...relative,
            axis: {
                ticks: (from, to, count) => {
                    const found = clockTicks(from + base, to + base, count);
                    return { values: found.values.map((value) => value - base), step: found.step };
                },
                label: (x, step) => formatClock(x + base, step),
            },
            title: "Time of day",
            at: (x) => formatClock(x + base, 0.001),
        };
    }
    return {
        ...relative,
        axis: {
            ticks: (from, to, count) => {
                const found = ticks(from - zero, to - zero, count);
                return { values: found.values.map((value) => value + zero), step: found.step };
            },
            label: (x, step) => formatTick(x - zero, step),
        },
        title: layout.t0 === null ? "Time (s)" : "Time from T0 (s)",
        at: (x) => {
            const value = formatValue(x - zero);
            return layout.t0 === null ? `${value} s` : `T${x - zero < 0 ? "" : "+"}${value} s`;
        },
    };
}

export function Workspace({
    layout,
    dispatch,
    title,
    actions,
    notice,
}: {
    layout: Layout;
    dispatch: (action: Action) => void;
    title: ReactNode;
    actions?: ReactNode;
    notice?: ReactNode;
}) {
    const version = useLoaded();
    const colors = usePlotColors();
    const root = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState<string | null>(null);
    const activePanel = layout.panels.find((panel) => panel.id === active) ?? layout.panels[0] ?? null;
    const primaryLoaded = layout.datasets[0] ? loadDataset(layout.datasets[0].id) : null;
    const primary = primaryLoaded?.status === "ready" ? primaryLoaded.value : null;
    const several = layout.datasets.length > 1;

    // These depend on what's loaded as well as on the layout: version counts loads.
    const resolved = useMemo(() => {
        const byPanel = new Map<string, Resolved[]>();
        for (const panel of layout.panels) {
            byPanel.set(
                panel.id,
                panel.series.map((spec) => resolve(layout, panel, spec, several)),
            );
        }
        return byPanel;
    }, [layout.panels, layout.datasets, several, version]);

    const full = useMemo((): [number, number] => {
        let start = Infinity;
        let end = -Infinity;
        for (const ref of layout.datasets) {
            const loaded = loadDataset(ref.id);
            if (loaded.status === "ready" && loaded.value.t_min !== null && loaded.value.t_max !== null) {
                start = Math.min(start, loaded.value.t_min + ref.shift);
                end = Math.max(end, loaded.value.t_max + ref.shift);
            }
        }
        if (start > end) {
            return [0, 1];
        }
        return end > start ? [start, end] : [start - 0.5, end + 0.5];
    }, [layout.datasets, version]);
    const view: [number, number] = layout.window ?? full;

    // Back: the windows you zoomed and panned from (a burst of wheel turns is one step).
    const history = useRef<([number, number] | null)[]>([]);
    const remembered = useRef(0);
    const latest = useRef(layout);
    latest.current = layout;
    const setWindow = useCallback(
        (next: [number, number] | null, remember: boolean) => {
            if (remember) {
                if (Date.now() - remembered.current > 600) {
                    history.current = [...history.current, latest.current.window].slice(-100);
                }
                remembered.current = Date.now();
            }
            if (next && !(next[1] - next[0] > 1e-9)) {
                return;
            }
            dispatch({ type: "window", window: next });
        },
        [dispatch],
    );
    const back = () => {
        const previous = history.current.pop();
        if (previous !== undefined) {
            dispatch({ type: "window", window: previous });
        }
    };
    const zoom = (factor: number) => {
        const middle = (view[0] + view[1]) / 2;
        const half = ((view[1] - view[0]) / 2) * factor;
        setWindow([middle - half, middle + half], true);
    };
    const pan = (share: number) => {
        const by = (view[1] - view[0]) * share;
        setWindow([view[0] + by, view[1] + by], true);
    };

    // The cursor, at most once a frame.
    const [cursor, setCursor] = useState<number | null>(null);
    const lastCursor = useRef<number | null>(null);
    const frame = useRef(0);
    const pending = useRef<number | null>(null);
    const onCursor = useCallback((x: number | null) => {
        pending.current = x;
        if (x !== null) {
            lastCursor.current = x;
        }
        if (typeof requestAnimationFrame !== "function") {
            setCursor(x);
            return;
        }
        if (!frame.current) {
            frame.current = requestAnimationFrame(() => {
                frame.current = 0;
                setCursor(pending.current);
            });
        }
    }, []);
    useEffect(() => () => cancelAnimationFrame?.(frame.current), []);

    const time = useMemo(() => timeLabels(layout, primary), [layout.t0, layout.clock, primary]);

    const marks = useMemo(() => {
        const found: PlotMark[] = layout.markers.map((marker) => ({
            x: marker.t,
            label: marker.label,
            kind: "marker",
        }));
        if (layout.events && primary) {
            // The first dataset's: another's, compared with it, would repeat every step.
            for (const event of primary.events) {
                found.push({ x: event.t + shiftOf(layout, primary.id), label: event.label, kind: "event" });
            }
        }
        if (layout.t0 !== null) {
            found.push({ x: layout.t0, label: "T0", kind: "t0" });
        }
        return found;
    }, [layout.markers, layout.events, layout.t0, layout.datasets, primary]);

    const plotted = useMemo(() => {
        const byPanel = new Map<string, PlotSeries[]>();
        for (const [panel, list] of resolved) {
            byPanel.set(
                panel,
                list
                    .filter((one) => !one.spec.hidden)
                    .map((one) => ({
                        id: one.spec.id,
                        color: one.spec.color,
                        width: one.spec.width,
                        step: one.step,
                        axis: one.spec.axis,
                        samples: one.samples,
                        placement: one.placement,
                        unit: one.unit,
                        labels:
                            one.channel?.kind === "state" && one.spec.scale === 1 && one.spec.offset === 0
                                ? one.channel.labels
                                : null,
                    })),
            );
        }
        return byPanel;
    }, [resolved]);

    const readouts = useMemo(() => {
        const found = new Map<string, { x: number; y: number } | null>();
        if (cursor === null) {
            return found;
        }
        for (const list of resolved.values()) {
            for (const one of list) {
                found.set(one.spec.id, one.samples ? sampleAt(one.samples, cursor, one.placement) : null);
            }
        }
        return found;
    }, [cursor, resolved]);

    const rightGutter = layout.panels.some((panel) => panel.series.some((series) => series.axis === "right"));
    const [menu, setMenu] = useState<{ x: number; left: number; top: number } | null>(null);

    const addMarker = (at: number) =>
        dispatch({ type: "addMarker", t: at, label: `Marker ${layout.markers.length + 1}` });

    // Keys, when you're not typing: arrows pan and zoom, and so on (the Keys button lists them).
    const keys = useRef<(event: KeyboardEvent) => void>(() => {});
    keys.current = (event: KeyboardEvent) => {
        const target = event.target;
        if (
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            (target instanceof Element && target.closest("input, textarea, select, [contenteditable], .dialog"))
        ) {
            return;
        }
        const handled = () => event.preventDefault();
        switch (event.key) {
            case "ArrowLeft":
                pan(event.shiftKey ? -0.5 : -0.1);
                return handled();
            case "ArrowRight":
                pan(event.shiftKey ? 0.5 : 0.1);
                return handled();
            case "ArrowUp":
            case "+":
            case "=":
                zoom(0.5);
                return handled();
            case "ArrowDown":
            case "-":
            case "_":
                zoom(2);
                return handled();
            case "Home":
            case "0":
                setWindow(null, true);
                return handled();
            case "Backspace":
                back();
                return handled();
            case "m":
                addMarker(lastCursor.current ?? (view[0] + view[1]) / 2);
                return handled();
            case "t":
                dispatch({ type: "t0", t0: lastCursor.current ?? (view[0] + view[1]) / 2 });
                return handled();
        }
    };
    useEffect(() => {
        const listener = (event: KeyboardEvent) => keys.current(event);
        window.addEventListener("keydown", listener);
        return () => window.removeEventListener("keydown", listener);
    }, []);

    const everyResolved = [...resolved.values()].flat();
    const nothingPlotted = everyResolved.length === 0;

    return (
        <div className="yorg-workspace" ref={root}>
            <Sidebar
                layout={layout}
                dispatch={dispatch}
                activePanel={activePanel}
                plotted={everyResolved}
                view={view}
                time={time}
            />
            <section className="yorg-main" aria-label="Plots">
                <div className="yorg-toolbar">
                    <div className="yorg-title">{title}</div>
                    <WindowInputs view={view} time={time} onChange={(next) => setWindow(next, true)} />
                    <div className="yorg-tools" role="toolbar" aria-label="Time window">
                        <button type="button" onClick={back} title="Back to the last window (Backspace)">
                            Back
                        </button>
                        <button type="button" onClick={() => zoom(2)} title="Zoom out (Down arrow)">
                            Zoom out
                        </button>
                        <button type="button" onClick={() => setWindow(null, true)} title="Show everything (Home)">
                            Show all
                        </button>
                    </div>
                    <div className="yorg-tools">
                        <MenuButton
                            label="T0"
                            items={[
                                {
                                    label: "Set T0 at the last cursor",
                                    onSelect: () =>
                                        dispatch({ type: "t0", t0: lastCursor.current ?? (view[0] + view[1]) / 2 }),
                                },
                                {
                                    label: "Set T0 at the start of the window",
                                    onSelect: () => dispatch({ type: "t0", t0: view[0] }),
                                },
                                ...(primary?.events ?? []).slice(0, 12).map((event) => ({
                                    label: `Set T0 at ${event.label} (${formatValue(event.t)} s)`,
                                    onSelect: () =>
                                        dispatch({ type: "t0", t0: event.t + shiftOf(layout, primary!.id) }),
                                })),
                                ...(layout.t0 === null
                                    ? []
                                    : [{ label: "Clear T0", onSelect: () => dispatch({ type: "t0", t0: null }) }]),
                            ]}
                        />
                        <button
                            type="button"
                            onClick={() => addMarker(lastCursor.current ?? (view[0] + view[1]) / 2)}
                            title="Add a marker at the last cursor (M)"
                        >
                            Marker
                        </button>
                        <OptionsMenu layout={layout} dispatch={dispatch} time={time} primary={primary} />
                        <MenuButton
                            label="Export"
                            items={[
                                {
                                    label: "Image of the plots (PNG)",
                                    onSelect: () => exportImage(root.current, layout, resolved, colors),
                                },
                                {
                                    label: "Data in view (CSV)",
                                    onSelect: () => exportCsv(layout, everyResolved, view, time),
                                },
                            ]}
                        />
                        {actions}
                    </div>
                </div>
                {notice}
                {nothingPlotted && (
                    <p className="yorg-hint">
                        Pick channels on the left to plot them: click to add one to the selected plot, shift-click for a
                        plot of its own, or drag one onto a plot. Drag across a plot to zoom in; the wheel zooms too.
                    </p>
                )}
                <div className="yorg-panels">
                    {layout.panels.map((panel, index) => (
                        <PanelView
                            key={panel.id}
                            panel={panel}
                            index={index}
                            count={layout.panels.length}
                            series={resolved.get(panel.id) ?? []}
                            plotSeries={plotted.get(panel.id) ?? []}
                            others={layout.panels.filter((other) => other.id !== panel.id)}
                            active={activePanel?.id === panel.id}
                            onActivate={() => setActive(panel.id)}
                            dispatch={dispatch}
                            plot={{
                                window: view,
                                time: time.axis,
                                marks,
                                cursor,
                                readouts,
                                rightGutter,
                                colors,
                                onCursor,
                                onWindow: setWindow,
                                onMenu: (x, left, top) => setMenu({ x, left, top }),
                            }}
                        />
                    ))}
                    <button
                        type="button"
                        className="yorg-add-panel"
                        onClick={() => dispatch({ type: "addPanel" })}
                        onDragOver={(event) => acceptChannel(event)}
                        onDrop={(event) =>
                            dropChannel(event, (dataset, channel) =>
                                dispatch({ type: "addSeries", panel: null, dataset, channel }),
                            )
                        }
                    >
                        Add a plot
                    </button>
                </div>
                {cursor !== null && (
                    <p className="yorg-cursor" aria-live="off">
                        {time.at(cursor)}
                    </p>
                )}
            </section>
            {menu && (
                <PlotMenu
                    at={menu}
                    onClose={() => setMenu(null)}
                    items={[
                        { label: "Add a marker here", onSelect: () => addMarker(menu.x) },
                        { label: "Set T0 here", onSelect: () => dispatch({ type: "t0", t0: menu.x }) },
                        { label: "Zoom out", onSelect: () => zoom(2) },
                        { label: "Show all", onSelect: () => setWindow(null, true) },
                    ]}
                />
            )}
        </div>
    );
}

function acceptChannel(event: DragEvent<HTMLElement>) {
    if (event.dataTransfer.types.includes(CHANNEL_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }
}

function dropChannel(event: DragEvent<HTMLElement>, add: (dataset: number, channel: string) => void) {
    const data = event.dataTransfer.getData(CHANNEL_TYPE);
    if (!data) {
        return;
    }
    event.preventDefault();
    const { dataset, channel } = JSON.parse(data) as { dataset: number; channel: string };
    add(dataset, channel);
}

/** The window's start and end, typed: seconds (from T0, if it's set). */
function WindowInputs({
    view,
    time,
    onChange,
}: {
    view: [number, number];
    time: TimeLabels;
    onChange: (window: [number, number]) => void;
}) {
    const shown = (x: number) => String(Number(time.number(x).toPrecision(8)));
    const [draft, setDraft] = useState<[string, string] | null>(null);
    const values = draft ?? [shown(view[0]), shown(view[1])];
    const apply = () => {
        if (!draft) {
            return;
        }
        const [start, end] = draft.map(Number) as [number, number];
        setDraft(null);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            onChange([time.fromNumber(start), time.fromNumber(end)]);
        }
    };
    const field = (index: 0 | 1, label: string) => (
        <input
            type="number"
            step="any"
            aria-label={label}
            value={values[index]}
            onChange={(event) => {
                const next: [string, string] = [...values];
                next[index] = event.target.value;
                setDraft(next);
            }}
            onBlur={apply}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    apply();
                } else if (event.key === "Escape") {
                    setDraft(null);
                }
            }}
        />
    );
    return (
        <div className="yorg-window">
            <span className="muted">{time.title.replace(" (s)", "")}</span>
            {field(0, "Window start (s)")}
            <span className="muted">to</span>
            {field(1, "Window end (s)")}
            <span className="muted">s · {formatDuration(view[1] - view[0])} in view</span>
        </div>
    );
}

function OptionsMenu({
    layout,
    dispatch,
    time,
    primary,
}: {
    layout: Layout;
    dispatch: (action: Action) => void;
    time: TimeLabels;
    primary: DatasetDetail | null;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const events = layout.datasets.reduce((total, ref) => {
        const loaded = loadDataset(ref.id);
        return total + (loaded.status === "ready" ? loaded.value.events.length : 0);
    }, 0);
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className="menu-button"
                aria-haspopup="true"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                Options
            </button>
            {open && (
                <div className="menu yorg-options">
                    <label className="check" title={time.clockable ? "" : "This data's times aren't times of day"}>
                        <input
                            type="checkbox"
                            checked={layout.clock && time.clockable}
                            disabled={!time.clockable}
                            onChange={(event) => dispatch({ type: "options", change: { clock: event.target.checked } })}
                        />
                        Time of day
                        {primary?.time_kind === "absolute" && (primary.read_info.utc_offset ?? null) === null
                            ? " (UTC: the file doesn't say its time zone)"
                            : ""}
                    </label>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={layout.events}
                            onChange={(event) =>
                                dispatch({ type: "options", change: { events: event.target.checked } })
                            }
                        />
                        Show events ({events})
                    </label>
                    <hr />
                    <p className="menu-label">Keys</p>
                    <dl className="yorg-keys">
                        <dt>Drag</dt>
                        <dd>zoom to a time</dd>
                        <dt>Shift-drag</dt>
                        <dd>zoom to a box</dd>
                        <dt>Right-drag</dt>
                        <dd>pan (or Ctrl-drag)</dd>
                        <dt>Wheel</dt>
                        <dd>zoom time; on an axis, zoom it</dd>
                        <dt>← →</dt>
                        <dd>pan; ↑ ↓ zoom</dd>
                        <dt>Home</dt>
                        <dd>show all; Backspace: back</dd>
                        <dt>M, T</dt>
                        <dd>marker, T0 at the cursor</dd>
                    </dl>
                </div>
            )}
        </div>
    );
}

/** A menu at the pointer, for a right-click on a plot. */
function PlotMenu({
    at,
    items,
    onClose,
}: {
    at: { left: number; top: number };
    items: { label: string; onSelect: () => void }[];
    onClose: () => void;
}) {
    const menu = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const close = (event: MouseEvent | KeyboardEvent) => {
            const outside = event instanceof MouseEvent && !menu.current?.contains(event.target as Node);
            if (outside || (event instanceof KeyboardEvent && event.key === "Escape")) {
                onClose();
            }
        };
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", close);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", close);
        };
    }, [onClose]);
    return (
        <div className="menu yorg-plot-menu" role="menu" ref={menu} style={{ left: at.left, top: at.top }}>
            {items.map((item) => (
                <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                        onClose();
                        item.onSelect();
                    }}
                >
                    {item.label}
                </button>
            ))}
        </div>
    );
}

interface PlotBits {
    window: [number, number];
    time: TimeAxis;
    marks: PlotMark[];
    cursor: number | null;
    readouts: ReadonlyMap<string, { x: number; y: number } | null>;
    rightGutter: boolean;
    colors: ReturnType<typeof usePlotColors>;
    onCursor: (x: number | null) => void;
    onWindow: (window: [number, number] | null, remember: boolean) => void;
    onMenu: (x: number, left: number, top: number) => void;
}

function PanelView({
    panel,
    index,
    count,
    series,
    plotSeries,
    others,
    active,
    onActivate,
    dispatch,
    plot,
}: {
    panel: PanelSpec;
    index: number;
    count: number;
    series: Resolved[];
    plotSeries: PlotSeries[];
    others: PanelSpec[];
    active: boolean;
    onActivate: () => void;
    dispatch: (action: Action) => void;
    plot: PlotBits;
}) {
    const name = panel.title || `Plot ${index + 1}`;
    const [dropping, setDropping] = useState(false);
    const setAxis = useCallback(
        (side: Side, range: [number, number] | null) =>
            dispatch({
                type: "changePanel",
                panel: panel.id,
                change: { [side]: { ...panel[side], min: range?.[0] ?? null, max: range?.[1] ?? null } },
            }),
        [dispatch, panel],
    );
    const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
        const startY = event.clientY;
        const startHeight = panel.height;
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        const move = (moving: PointerEvent) =>
            dispatch({
                type: "changePanel",
                panel: panel.id,
                change: { height: Math.min(1200, Math.max(120, startHeight + moving.clientY - startY)) },
            });
        const up = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
    };
    const loading = series.filter((one) => one.loading).length;
    return (
        <section
            className={`yorg-panel${active ? " yorg-panel-active" : ""}${dropping ? " yorg-panel-drop" : ""}`}
            aria-label={name}
            onPointerDown={onActivate}
            onFocus={onActivate}
            onDragOver={(event) => {
                acceptChannel(event);
                setDropping(event.dataTransfer.types.includes(CHANNEL_TYPE));
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(event) => {
                setDropping(false);
                dropChannel(event, (dataset, channel) =>
                    dispatch({ type: "addSeries", panel: panel.id, dataset, channel }),
                );
            }}
        >
            <header className="yorg-panel-head">
                <input
                    className="yorg-panel-title"
                    aria-label={`${name}: title`}
                    placeholder={`Plot ${index + 1}`}
                    value={panel.title}
                    onChange={(event) =>
                        dispatch({ type: "changePanel", panel: panel.id, change: { title: event.target.value } })
                    }
                />
                {loading > 0 && (
                    <span className="muted">Loading {loading === 1 ? "a channel" : `${loading} channels`}…</span>
                )}
                <div className="yorg-panel-tools">
                    <AxesButton panel={panel} dispatch={dispatch} />
                    <button
                        type="button"
                        className="button-small"
                        aria-label={`Move ${name} up`}
                        disabled={index === 0}
                        onClick={() => dispatch({ type: "movePanel", panel: panel.id, by: -1 })}
                    >
                        ↑
                    </button>
                    <button
                        type="button"
                        className="button-small"
                        aria-label={`Move ${name} down`}
                        disabled={index === count - 1}
                        onClick={() => dispatch({ type: "movePanel", panel: panel.id, by: 1 })}
                    >
                        ↓
                    </button>
                    <button
                        type="button"
                        className="button-small"
                        aria-label={`Remove ${name}`}
                        onClick={() => dispatch({ type: "removePanel", panel: panel.id })}
                    >
                        ×
                    </button>
                </div>
            </header>
            <div className="yorg-panel-body">
                <Plot
                    label={`${name}: ${series.map((one) => one.name).join(", ") || "empty"}`}
                    series={plotSeries}
                    left={panel.left}
                    right={panel.right}
                    height={panel.height}
                    window={plot.window}
                    time={plot.time}
                    marks={plot.marks}
                    cursor={plot.cursor}
                    readouts={plot.readouts}
                    rightGutter={plot.rightGutter}
                    colors={plot.colors}
                    onCursor={plot.onCursor}
                    onWindow={plot.onWindow}
                    onAxis={setAxis}
                    onMenu={plot.onMenu}
                />
                <Legend
                    name={name}
                    panel={panel}
                    series={series}
                    others={others}
                    readouts={plot.readouts}
                    dispatch={dispatch}
                />
            </div>
            <div
                className="yorg-panel-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize ${name}`}
                onPointerDown={resize}
            />
        </section>
    );
}

function Legend({
    name,
    panel,
    series,
    others,
    readouts,
    dispatch,
}: {
    name: string;
    panel: PanelSpec;
    series: Resolved[];
    others: PanelSpec[];
    readouts: ReadonlyMap<string, { x: number; y: number } | null>;
    dispatch: (action: Action) => void;
}) {
    if (series.length === 0) {
        return <p className="yorg-legend-empty muted">No channels yet: pick some on the left, or drag them here.</p>;
    }
    return (
        <ul className="yorg-legend" aria-label={`${name}: channels`}>
            {series.map((one) => {
                const point = readouts.get(one.spec.id);
                const value = point && !Number.isNaN(point.y) ? reading(one, point.y) : "";
                return (
                    <li key={one.spec.id} className={one.spec.hidden ? "yorg-legend-hidden" : undefined}>
                        <button
                            type="button"
                            className="yorg-swatch"
                            style={{
                                background: one.spec.hidden ? "transparent" : one.spec.color,
                                borderColor: one.spec.color,
                            }}
                            aria-pressed={!one.spec.hidden}
                            aria-label={`Show ${one.name}`}
                            title={one.spec.hidden ? "Show it" : "Hide it"}
                            onClick={() =>
                                dispatch({
                                    type: "changeSeries",
                                    panel: panel.id,
                                    series: one.spec.id,
                                    change: { hidden: !one.spec.hidden },
                                })
                            }
                        />
                        <SeriesButton series={one} panel={panel} others={others} dispatch={dispatch} />
                        <span className="yorg-value" title={one.problem ?? undefined}>
                            {one.problem ? "⚠" : one.loading ? "…" : value}
                        </span>
                        <span className="yorg-unit">{one.unit}</span>
                        {one.problem && <span className="yorg-problem visually-hidden">{one.problem}</span>}
                    </li>
                );
            })}
        </ul>
    );
}

/** A series' name in the legend, which opens its settings: name, color, scale and offset, axis, and so on. */
function SeriesButton({
    series,
    panel,
    others,
    dispatch,
}: {
    series: Resolved;
    panel: PanelSpec;
    others: PanelSpec[];
    dispatch: (action: Action) => void;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const { spec } = series;
    const change = (next: Partial<SeriesSpec>) =>
        dispatch({ type: "changeSeries", panel: panel.id, series: spec.id, change: next });
    const numberField = (label: string, value: number, apply: (value: number) => void) => (
        <label className="field">
            {label}
            <input
                type="number"
                step="any"
                defaultValue={value}
                onBlur={(event) => {
                    const next = Number(event.target.value);
                    if (event.target.value.trim() !== "" && Number.isFinite(next)) {
                        apply(next);
                    }
                }}
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
        </label>
    );
    return (
        <div className="popover yorg-series" ref={within}>
            <button
                type="button"
                className="yorg-series-name"
                aria-haspopup="dialog"
                aria-expanded={open}
                title={series.problem ?? `${series.channel?.name ?? spec.channel}: settings`}
                onClick={() => setOpen(!open)}
            >
                {series.name}
                {(spec.scale !== 1 || spec.offset !== 0) && (
                    <span className="muted" title="Scaled">
                        {" "}
                        ×
                    </span>
                )}
            </button>
            {open && (
                <div className="menu yorg-series-menu" role="dialog" aria-label={`${series.name}: settings`}>
                    {series.problem && <Notice tone="warning">{series.problem}</Notice>}
                    <label className="field">
                        Name
                        <input
                            defaultValue={spec.label}
                            placeholder={spec.channel}
                            onBlur={(event) => change({ label: event.target.value.trim() })}
                            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                        />
                    </label>
                    <div className="yorg-colors" role="group" aria-label="Color">
                        {PALETTE.map((color) => (
                            <button
                                key={color}
                                type="button"
                                className="yorg-color"
                                style={{ background: color }}
                                aria-label={color}
                                aria-pressed={spec.color === color}
                                onClick={() => change({ color })}
                            />
                        ))}
                        <input
                            type="color"
                            aria-label="Another color"
                            value={spec.color}
                            onChange={(event) => change({ color: event.target.value })}
                        />
                    </div>
                    <div className="yorg-row">
                        {numberField("Scale (×)", spec.scale, (scale) => change({ scale }))}
                        {numberField("Offset (+)", spec.offset, (offset) => change({ offset }))}
                        <label className="field">
                            Unit
                            <input
                                defaultValue={spec.unit ?? ""}
                                placeholder={series.channel?.unit ?? ""}
                                onBlur={(event) => change({ unit: event.target.value.trim() || null })}
                                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                            />
                        </label>
                    </div>
                    <div className="yorg-row">
                        <label className="field">
                            Axis
                            <select
                                value={spec.axis}
                                onChange={(event) => change({ axis: event.target.value as Side })}
                            >
                                <option value="left">Left</option>
                                <option value="right">Right</option>
                            </select>
                        </label>
                        <label className="field">
                            Line
                            <select
                                value={spec.width}
                                onChange={(event) => change({ width: Number(event.target.value) })}
                            >
                                {[1, 1.5, 2, 3].map((width) => (
                                    <option key={width} value={width}>
                                        {width} px
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="field">
                            Draw as
                            <select
                                value={series.step ? "steps" : "lines"}
                                onChange={(event) => change({ step: event.target.value === "steps" })}
                            >
                                <option value="lines">Lines</option>
                                <option value="steps">Steps</option>
                            </select>
                        </label>
                    </div>
                    {series.channel && (
                        <p className="muted yorg-channel-facts">
                            {series.channel.name} in {series.detail?.name}: {series.channel.count.toLocaleString()}{" "}
                            samples
                            {series.channel.min !== null && series.channel.max !== null
                                ? `, ${formatValue(series.channel.min)} to ${formatValue(series.channel.max)} ${series.channel.unit}`
                                : ""}
                        </p>
                    )}
                    <div className="yorg-series-actions">
                        <select
                            aria-label="Move to"
                            value=""
                            onChange={(event) => {
                                setOpen(false);
                                dispatch({
                                    type: "moveSeries",
                                    panel: panel.id,
                                    series: spec.id,
                                    to: event.target.value === "new" ? null : event.target.value,
                                });
                            }}
                        >
                            <option value="" disabled>
                                Move to…
                            </option>
                            {others.map((other, index) => (
                                <option key={other.id} value={other.id}>
                                    {other.title || `Plot ${index + 1}`}
                                </option>
                            ))}
                            <option value="new">A new plot</option>
                        </select>
                        <button
                            type="button"
                            className="button-danger"
                            onClick={() => {
                                setOpen(false);
                                dispatch({ type: "removeSeries", panel: panel.id, series: spec.id });
                            }}
                        >
                            Remove
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

/** A plot's axes: fixed ranges (or fitting what's in view), and titles. */
function AxesButton({ panel, dispatch }: { panel: PanelSpec; dispatch: (action: Action) => void }) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const sides: [Side, string][] = [
        ["left", "Left axis"],
        ["right", "Right axis"],
    ];
    const change = (side: Side, next: Partial<AxisSpec>) =>
        dispatch({ type: "changePanel", panel: panel.id, change: { [side]: { ...panel[side], ...next } } });
    const bound = (side: Side, which: "min" | "max", label: string) => (
        <label className="field">
            {label}
            <input
                type="number"
                step="any"
                placeholder="fit"
                key={`${which}-${panel[side][which]}`}
                defaultValue={panel[side][which] ?? ""}
                onBlur={(event) => {
                    const text = event.target.value.trim();
                    const value = Number(text);
                    change(side, { [which]: text === "" || !Number.isFinite(value) ? null : value });
                }}
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
        </label>
    );
    return (
        <div className="popover" ref={within}>
            <button type="button" className="button-small" aria-expanded={open} onClick={() => setOpen(!open)}>
                Axes
            </button>
            {open && (
                <div className="menu menu-left yorg-axes-menu" role="dialog" aria-label="Axes">
                    {sides.map(([side, label]) => (
                        <fieldset key={side}>
                            <legend>{label}</legend>
                            <label className="field">
                                Title
                                <input
                                    defaultValue={panel[side].label}
                                    placeholder="the channels' units"
                                    onBlur={(event) => change(side, { label: event.target.value })}
                                />
                            </label>
                            <div className="yorg-row">
                                {bound(side, "min", "From")}
                                {bound(side, "max", "To")}
                                <button
                                    type="button"
                                    className="button-small"
                                    onClick={() => change(side, { min: null, max: null })}
                                >
                                    Fit
                                </button>
                            </div>
                        </fieldset>
                    ))}
                </div>
            )}
        </div>
    );
}
