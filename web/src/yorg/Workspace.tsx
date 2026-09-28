import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type DragEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";
import { MenuButton, Notice, placeMenuAt, usePopover } from "../components";
import type { Channel, DatasetDetail, Formula } from "./api";
import { usePlotColors } from "./colors";
import {
    calculated,
    formulas as loadFormulas,
    dataset as loadDataset,
    samples as loadSamples,
    masked,
    maskRuns,
    useLoaded,
    type Loaded,
} from "./data";
import { exportCsv, exportImage } from "./export";
import {
    newAxisSide,
    newId,
    PALETTE,
    shiftOf,
    type Action,
    type AxisSpec,
    type AxisTarget,
    type Layout,
    type Mask,
    type Note,
    type PanelSpec,
    type SeriesSpec,
    type Side,
    type TimeMode,
} from "./layout";
import { MaskDialog } from "./MaskDialog";
import {
    Plot,
    type Anchor,
    type MenuTarget,
    type PlotMark,
    type PlotSeries,
    type Shading,
    type TimeAxis,
} from "./Plot";
import { sampleAt, type Placement, type Samples } from "./samples";
import { clockTicks, formatClock, formatDuration, formatTick, formatValue, ticks } from "./scale";
import { Sidebar } from "./Sidebar";
import { SplitDialog } from "./Split";

// A page of plots: the channels on the left, and panels stacked on one time axis, each with its legend. Every
// panel shows the same time window and the same cursor.

/** A series with what it draws: its dataset, channel (or calculated channel), and samples (or why they're missing). */
export interface Resolved {
    spec: SeriesSpec;
    panel: string;
    detail: DatasetDetail | null;
    channel: Channel | null;
    formula: Formula | null;
    samples: Samples | null;
    placement: Placement;
    name: string;
    unit: string;
    step: boolean;
    problem: string | null;
    loading: boolean;
}

export const CHANNEL_TYPE = "application/x-yorg-channel"; // {dataset, channel, formula, quantity}, from the list
export const SERIES_TYPE = "application/x-yorg-series"; // {panel, series, quantity}, from a legend

/** What a channel's values are, to put it on an axis with others like it: its unit, or "state" (valves, modes). */
export const quantityOf = (one: { channel: Channel | null; unit: string }): string =>
    one.channel?.kind === "state" ? "state" : one.unit.trim().toLowerCase();

// Plots share the window's height (each at least MIN_PLOT), less what's around each plot (its title bar, border, and
// the gap under it) and the room kept for "Add a plot" under them.
const MIN_PLOT = 220;
const PANEL_CHROME = 52;
const ADD_PLOT_ROOM = 60;
const NARROW_PLOT = 300; // on a narrow screen, where each plot's legend is under it
const T0_MARK = "t0"; // T0's line, dragged like a marker (whose ids are newId's, never this)

/**
 * A series with its samples outside the hiding masks left out (where they don't hold in its own dataset). Until the
 * masks are worked out it has none, rather than everything and then less; where they can't be (its dataset hasn't a
 * channel they use), it's whole, and the masks' list says why.
 */
function hideOutside(one: Resolved, hide: readonly string[]): Resolved {
    if (hide.length === 0 || !one.samples || !one.detail) {
        return one;
    }
    const runs = maskRuns(one.detail, hide);
    if (runs.status === "ready") {
        return { ...one, samples: masked(one.samples, runs.value) };
    }
    return runs.status === "loading" ? { ...one, samples: null, loading: true } : one;
}

function resolve(
    layout: Layout,
    panel: PanelSpec,
    spec: SeriesSpec,
    several: boolean,
    formulaList: Loaded<Formula[]>,
): Resolved {
    const base: Resolved = {
        spec,
        panel: panel.id,
        detail: null,
        channel: null,
        formula: null,
        samples: null,
        placement: { shift: shiftOf(layout, spec.dataset), scale: spec.scale, offset: spec.offset },
        name: spec.label || spec.channel,
        unit: spec.unit ?? "",
        step: spec.step ?? false,
        problem: null,
        loading: false,
    };
    const loaded = loadDataset(spec.dataset);
    if (loaded.status !== "ready") {
        return {
            ...base,
            problem: loaded.status === "failed" ? `Couldn't load its dataset: ${loaded.error}` : null,
            loading: loaded.status === "loading",
        };
    }
    const detail = loaded.value;
    const tag = several && !spec.label ? ` · ${detail.name}` : "";
    if (spec.formula !== null) {
        if (formulaList.status !== "ready") {
            return {
                ...base,
                detail,
                problem:
                    formulaList.status === "failed"
                        ? `Couldn't load the calculated channels: ${formulaList.error}`
                        : null,
                loading: formulaList.status === "loading",
            };
        }
        const formula = formulaList.value.find((one) => one.id === spec.formula) ?? null;
        const named = {
            detail,
            name: (spec.label || formula?.name || spec.channel) + tag,
            unit: spec.unit ?? formula?.unit ?? "",
        };
        if (!formula) {
            return { ...base, ...named, problem: `The calculated channel ${spec.channel} was deleted` };
        }
        const found = calculated(detail, formula);
        return {
            ...base,
            ...named,
            formula,
            samples: found.status === "ready" ? found.value : null,
            problem: found.status === "failed" ? `Couldn't work it out: ${found.error}` : null,
            loading: found.status === "loading",
        };
    }
    const channel = detail.channels.find((one) => one.name === spec.channel) ?? null;
    const named = {
        detail,
        channel,
        name: (spec.label || spec.channel) + tag,
        unit: spec.unit ?? channel?.unit ?? "",
        step: spec.step ?? channel?.kind === "state",
    };
    if (!channel) {
        return { ...base, ...named, problem: `${detail.name} has no channel called ${spec.channel}` };
    }
    const found: Loaded<Samples> = loadSamples(detail, channel);
    return {
        ...base,
        ...named,
        samples: found.status === "ready" ? found.value : null,
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

/** How times read: on the time axis, at the cursor, and in the window's inputs (and how what's typed there reads). */
export interface TimeLabels {
    axis: TimeAxis;
    title: string;
    at: (x: number) => string; // the cursor's time, or a marker's: T+1.5 s, or 21:15:03.250 UTC
    clockAt: ((x: number) => string) | null; // its time of day as well, when the axis reads from T0 and there's one
    absolute: (x: number) => string; // where a time is, whatever T0 is: its time of day, or seconds in the file
    text: (x: number, span: number) => string; // for the window's inputs, to span's precision: T-7.48, 21:15:03.25
    // What's typed: T-10, T0, 21:15:03, a Unix or ISO time, or seconds (from T0, or from the file's start).
    parse: (text: string, plain?: "t0" | "file") => number | null;
    number: (x: number) => number; // seconds from T0 (or the start), for exports
    clockable: boolean; // the data has times of day
    dated: boolean; // and dates (Unix times and the like), so it can be read in UTC or this computer's zone
    here: string; // this computer's zone, as it's called when the data starts (EDT)
}

const MINUS = "\u2212";

/** A zone's name at a moment, as this computer names it (EDT; a UTC offset where the zone has no name). */
function zoneName(unix: number): string {
    try {
        const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(
            new Date(unix * 1000),
        );
        return parts.find((part) => part.type === "timeZoneName")?.value ?? "local";
    } catch {
        return "local";
    }
}

/** A time of day typed (21:15, 21:15:03.25): seconds after midnight. */
function readClock(text: string): number | null {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d*)?))?$/.exec(text);
    if (!match) {
        return null;
    }
    const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    return hours < 24 && minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
}

export function timeLabels(layout: Layout, primary: DatasetDetail | null): TimeLabels {
    const epoch = primary?.start_epoch ?? null;
    const dated = primary?.time_kind === "absolute" && epoch !== null;
    const clockable = epoch !== null && (primary?.time_kind === "absolute" || primary?.time_kind === "clock");
    const here = dated ? zoneName(epoch) : "local";
    const zero = layout.t0 ?? 0;
    const mode: TimeMode = layout.time;
    const clock = clockable && (mode === "utc" || mode === "local" || (mode === "auto" && layout.t0 === null));
    // The zone times of day are in: UTC or this computer's for dates, as chosen (or the file's own, if it gave
    // dates with an offset); a file of times of day alone is in its own.
    const fileOffset = primary?.read_info.utc_offset ?? null;
    const offset = !dated
        ? 0
        : mode === "local"
          ? -new Date(epoch * 1000).getTimezoneOffset() * 60
          : mode === "utc"
            ? 0
            : (fileOffset ?? 0);
    const zone = !dated
        ? ""
        : mode === "local"
          ? here
          : mode === "utc" || fileOffset === null
            ? "UTC"
            : `UTC${fileOffset < 0 ? MINUS : "+"}${formatClock(Math.abs(fileOffset), 60).slice(0, 5)}`;
    const base = (epoch ?? 0) + offset; // a time plus base: seconds on the clock
    const ofDay = (x: number) => {
        const text = formatClock(x + base, 0.001);
        return zone ? `${text} ${zone}` : text;
    };
    const fromT0 = (value: number, write: (size: number) => string): string =>
        Math.abs(value) < 1e-9 ? "T0" : `T${value < 0 ? MINUS : "+"}${write(Math.abs(value))}`;
    const middle = primary?.t_min != null && primary.t_max != null ? (primary.t_min + primary.t_max) / 2 : zero;

    const parse = (typed: string, plain: "t0" | "file" = "t0"): number | null => {
        const text = typed.trim().replace(/\u2212/g, "-");
        const t = /^t\s*([+-])?\s*(\d*\.?\d+(?:e[+-]?\d+)?)?\s*s?$/i.exec(text);
        if (t) {
            const size = t[2] === undefined ? 0 : Number(t[2]);
            return (layout.t0 ?? 0) + (t[1] === "-" ? -size : size);
        }
        if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*s?$/i.test(text)) {
            const value = Number(text.replace(/\s*s$/i, ""));
            if (dated && Math.abs(value) >= 1e8) {
                return (Math.abs(value) >= 1e11 ? value / 1000 : value) - epoch; // Unix seconds, or milliseconds
            }
            return plain === "file" ? value : value + zero;
        }
        const seconds = readClock(text);
        if (seconds !== null && clockable) {
            // That time on the day of the data's middle, or the day before or after (a test past midnight).
            const day = Math.floor((middle + base) / 86400) * 86400;
            const found = [-86400, 0, 86400].map((shift) => day + shift + seconds - base);
            return found.reduce((best, x) => (Math.abs(x - middle) < Math.abs(best - middle) ? x : best));
        }
        if (dated && /^\d{4}-\d{2}-\d{2}[t ]\d/i.test(text)) {
            const at = Date.parse(text);
            return Number.isNaN(at) ? null : at / 1000 - epoch;
        }
        return null;
    };
    const text = (x: number, span: number): string => {
        const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(Math.max(span, 1e-9) / 2000))));
        if (clock) {
            const written = formatClock(x + base, 10 ** -decimals);
            return written.includes(".") ? written.replace(/0+$/, "").replace(/\.$/, "") : written;
        }
        const value = Number((x - zero).toFixed(decimals));
        const fixed = (size: number) => String(Number(size.toFixed(decimals)));
        return layout.t0 === null
            ? fixed(value)
            : value === 0
              ? "T0"
              : `T${value < 0 ? "-" : "+"}${fixed(Math.abs(value))}`;
    };
    const common = {
        clockable,
        dated,
        here,
        text,
        parse,
        number: (x: number) => x - zero,
        absolute: (x: number) => (clockable ? ofDay(x) : `${formatValue(x)} s in the file`),
    };
    if (clock) {
        return {
            ...common,
            axis: {
                ticks: (from, to, count) => {
                    const found = clockTicks(from + base, to + base, count);
                    return { values: found.values.map((value) => value - base), step: found.step };
                },
                label: (x, step) => formatClock(x + base, step),
            },
            title: zone ? `Time of day (${zone})` : "Time of day",
            at: ofDay,
            clockAt: null,
        };
    }
    return {
        ...common,
        axis: {
            ticks: (from, to, count) => {
                const found = ticks(from - zero, to - zero, count);
                return { values: found.values.map((value) => value + zero), step: found.step };
            },
            label: (x, step) =>
                layout.t0 === null ? formatTick(x - zero, step) : fromT0(x - zero, (size) => formatTick(size, step)),
        },
        title: layout.t0 === null ? "Time (s)" : "Time from T0 (s)",
        at: (x) =>
            layout.t0 === null
                ? `${formatValue(x - zero)} s`
                : Math.abs(x - zero) < 1e-9
                  ? "T0"
                  : `${fromT0(x - zero, (size) => formatValue(size))} s`,
        clockAt: clockable ? ofDay : null,
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
    const formulaList = loadFormulas();
    const hide = layout.masks.filter((mask) => mask.hide).map((mask) => mask.expression);
    const hideKey = hide.join("\n");
    const resolved = useMemo(() => {
        const byPanel = new Map<string, Resolved[]>();
        for (const panel of layout.panels) {
            byPanel.set(
                panel.id,
                panel.series.map((spec) => hideOutside(resolve(layout, panel, spec, several, formulaList), hide)),
            );
        }
        return byPanel;
    }, [layout.panels, layout.datasets, several, version, hideKey]);

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

    const time = useMemo(() => timeLabels(layout, primary), [layout.t0, layout.time, primary]);

    const marks = useMemo(() => {
        const found: PlotMark[] = layout.markers.map((marker) => ({
            id: marker.id,
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
            found.push({ id: T0_MARK, x: layout.t0, label: "T0", kind: "t0" });
        }
        return found;
    }, [layout.markers, layout.events, layout.t0, layout.datasets, primary]);

    // Where the masks hold, shaded: in the first dataset (another's, compared with it, would cover the same tests).
    const shading = useMemo(() => {
        const found: Shading[] = [];
        for (const mask of layout.masks) {
            const runs = mask.shade && primary ? maskRuns(primary, [mask.expression]) : null;
            if (runs?.status === "ready") {
                found.push({ runs: runs.value, shift: shiftOf(layout, primary!.id), color: mask.color });
            }
        }
        return found;
    }, [layout.masks, layout.datasets, primary, version]);

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

    // Room on each side of every plot for as many axes as any plot has there, so their time axes line up.
    const gutters = useMemo(() => {
        const most = { left: 0, right: 0 };
        for (const panel of layout.panels) {
            const left = panel.axes.filter((axis) => axis.side === "left").length;
            most.left = Math.max(most.left, left);
            most.right = Math.max(most.right, panel.axes.length - left);
        }
        return most;
    }, [layout.panels]);

    // Where a channel goes on a plot: onto the axis of others like it (the same unit; states), else a new axis.
    const placeFor = (panelId: string | null, quantity: string): AxisTarget | undefined => {
        const panel = layout.panels.find((one) => one.id === panelId);
        if (!panel || panel.axes.length === 0) {
            return undefined;
        }
        const like = (resolved.get(panel.id) ?? []).find((one) => quantityOf(one) === quantity);
        return like ? like.spec.axis : { new: newAxisSide(panel) };
    };

    // Plots share the height the window has for them, unless one's been given its own.
    const main = useRef<HTMLElement>(null);
    const panelList = useRef<HTMLDivElement>(null);
    const [room, setRoom] = useState<number | null>(null); // null: a narrow screen, or not measured yet
    const nothingYet = [...resolved.values()].every((list) => list.length === 0);
    useLayoutEffect(() => {
        const measure = () => {
            const box = main.current;
            const list = panelList.current;
            if (!box || !list || window.innerWidth <= 900) {
                setRoom(null);
                return;
            }
            const top = list.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
            setRoom(Math.max(0, box.clientHeight - top - ADD_PLOT_ROOM));
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [layout.panels.length, nothingYet, notice !== undefined]);
    const heightOf = (panel: PanelSpec): number => {
        if (panel.height !== null) {
            return panel.height;
        }
        if (room === null) {
            return NARROW_PLOT;
        }
        const fixed = layout.panels.reduce(
            (total, one) => total + (one.height === null ? 0 : one.height + PANEL_CHROME),
            0,
        );
        const sharing = layout.panels.filter((one) => one.height === null).length;
        return Math.max(MIN_PLOT, Math.floor((room - fixed) / Math.max(1, sharing)) - PANEL_CHROME);
    };

    const [menu, setMenu] = useState<{
        x: number;
        left: number;
        top: number;
        panel: string;
        target: MenuTarget;
    } | null>(null);
    // Placing a label (or T0): the next click on a plot puts it there. Changing a label: its editor, where it was.
    const [placing, setPlacing] = useState<"label" | "t0" | null>(null);
    const [editing, setEditing] = useState<{ panel: string; note: string; left: number; top: number } | null>(null);
    const addNote = (panel: string, anchor: Anchor, left: number, top: number) => {
        const note: Note = { id: newId(), ...anchor, text: "", dx: 48, dy: -40, arrow: true };
        dispatch({ type: "addNote", panel, note });
        setPlacing(null);
        setEditing({ panel, note: note.id, left, top });
    };
    const place = (panel: string, anchor: Anchor, left: number, top: number) => {
        if (placing === "t0") {
            dispatch({ type: "t0", t0: anchor.t });
            setPlacing(null);
        } else {
            addNote(panel, anchor, left, top);
        }
    };

    const addMarker = (at: number) =>
        dispatch({ type: "addMarker", t: at, label: `Marker ${layout.markers.length + 1}` });
    // A mask being made (mask null) or changed, and splitting the file into its tests.
    const [maskEditing, setMaskEditing] = useState<{ mask: Mask | null } | null>(null);
    const [splitting, setSplitting] = useState(false);

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
            case "l":
                setPlacing(placing === "label" ? null : "label");
                return handled();
            case "Escape":
                if (placing) {
                    setPlacing(null);
                    return handled();
                }
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
                placeFor={placeFor}
                onEditMask={(mask) => setMaskEditing({ mask })}
            />
            <section className="yorg-main" aria-label="Plots" ref={main}>
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
                        <T0Menu
                            layout={layout}
                            time={time}
                            events={(primary?.events ?? []).map((event) => ({
                                label: event.label,
                                t: event.t + shiftOf(layout, primary!.id),
                            }))}
                            cursor={lastCursor.current ?? (view[0] + view[1]) / 2}
                            view={view}
                            placing={placing === "t0"}
                            onSet={(t0) => dispatch({ type: "t0", t0 })}
                            onPlace={() => setPlacing(placing === "t0" ? null : "t0")}
                        />
                        <button
                            type="button"
                            onClick={() => addMarker(lastCursor.current ?? (view[0] + view[1]) / 2)}
                            title="Add a marker at the last cursor (M). Drag a marker to move it."
                        >
                            Marker
                        </button>
                        <button
                            type="button"
                            aria-pressed={placing === "label"}
                            onClick={() => setPlacing(placing === "label" ? null : "label")}
                            title="Click a plot to put a label there, with an arrow to the data (L). Drag labels to move them."
                        >
                            {placing === "label" ? "Click a plot…" : "Label"}
                        </button>
                        <button
                            type="button"
                            disabled={!primary}
                            onClick={() => setMaskEditing({ mask: null })}
                            title="Where a test on channels holds, like a valve open or a pressure over its redline: shade the plots there, or hide data everywhere else"
                        >
                            Mask
                        </button>
                        <button
                            type="button"
                            disabled={!primary}
                            onClick={() => setSplitting(true)}
                            title="Make a dataset of each test in this file: where a mask holds, or between times you choose"
                        >
                            Split
                        </button>
                        <OptionsMenu layout={layout} dispatch={dispatch} time={time} />
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
                <div className="yorg-panels" ref={panelList}>
                    {layout.panels.map((panel, index) => (
                        <PanelView
                            key={panel.id}
                            panel={panel}
                            index={index}
                            count={layout.panels.length}
                            height={heightOf(panel)}
                            placeFor={placeFor}
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
                                shading,
                                cursor,
                                readouts,
                                gutters,
                                colors,
                                onCursor,
                                onWindow: setWindow,
                                onMenu: (x, left, top, target) => setMenu({ x, left, top, target, panel: panel.id }),
                                placing: placing !== null,
                                onPlace: (anchor, left, top) => place(panel.id, anchor, left, top),
                                onEditNote: (note, left, top) => setEditing({ panel: panel.id, note, left, top }),
                                onMoveMark: (marker, x) =>
                                    dispatch(
                                        marker === T0_MARK
                                            ? { type: "t0", t0: x }
                                            : { type: "changeMarker", marker, change: { t: x } },
                                    ),
                            }}
                        />
                    ))}
                    <button
                        type="button"
                        className="yorg-add-panel"
                        onClick={() => dispatch({ type: "addPanel" })}
                        onDragOver={(event) => void allowDrop(event)}
                        onDrop={(event) => drop(event, null, "auto", dispatch, placeFor)}
                    >
                        Add a plot
                    </button>
                </div>
                {cursor !== null && (
                    <p className="yorg-cursor" aria-live="off">
                        {time.at(cursor)}
                        {time.clockAt && <span className="muted"> · {time.clockAt(cursor)}</span>}
                    </p>
                )}
            </section>
            {menu && (
                <PlotMenu
                    at={menu}
                    onClose={() => setMenu(null)}
                    items={[
                        ...(menu.target.note
                            ? [
                                  {
                                      label: "Change this label…",
                                      onSelect: () =>
                                          setEditing({
                                              panel: menu.panel,
                                              note: menu.target.note!,
                                              left: menu.left,
                                              top: menu.top,
                                          }),
                                  },
                                  {
                                      label: "Remove this label",
                                      onSelect: () =>
                                          dispatch({ type: "removeNote", panel: menu.panel, note: menu.target.note! }),
                                  },
                              ]
                            : []),
                        ...(menu.target.marker
                            ? [
                                  menu.target.marker === T0_MARK
                                      ? { label: "Clear T0", onSelect: () => dispatch({ type: "t0", t0: null }) }
                                      : {
                                            label: "Remove this marker",
                                            onSelect: () =>
                                                dispatch({ type: "removeMarker", marker: menu.target.marker! }),
                                        },
                              ]
                            : []),
                        ...(menu.target.anchor
                            ? [
                                  {
                                      label: "Add a label here",
                                      onSelect: () => addNote(menu.panel, menu.target.anchor!, menu.left, menu.top),
                                  },
                              ]
                            : []),
                        { label: "Add a marker here", onSelect: () => addMarker(menu.x) },
                        { label: "Set T0 here", onSelect: () => dispatch({ type: "t0", t0: menu.x }) },
                        { label: "Zoom out", onSelect: () => zoom(2) },
                        { label: "Show all", onSelect: () => setWindow(null, true) },
                    ]}
                />
            )}
            {maskEditing && primary && (
                <MaskDialog
                    mask={maskEditing.mask}
                    detail={primary}
                    count={layout.masks.length}
                    onSave={(mask) => {
                        dispatch(
                            maskEditing.mask
                                ? { type: "changeMask", mask: mask.id, change: mask }
                                : { type: "addMask", mask },
                        );
                        setMaskEditing(null);
                    }}
                    onRemove={() => {
                        if (maskEditing.mask) {
                            dispatch({ type: "removeMask", mask: maskEditing.mask.id });
                        }
                        setMaskEditing(null);
                    }}
                    onClose={() => setMaskEditing(null)}
                />
            )}
            {splitting && primary && (
                <SplitDialog detail={primary} layout={layout} at={time.at} onClose={() => setSplitting(false)} />
            )}
            {editing && (
                <NoteEditor
                    at={editing}
                    note={
                        layout.panels
                            .find((panel) => panel.id === editing.panel)
                            ?.notes.find((note) => note.id === editing.note) ?? null
                    }
                    onChange={(change) =>
                        dispatch({ type: "changeNote", panel: editing.panel, note: editing.note, change })
                    }
                    onRemove={() => {
                        dispatch({ type: "removeNote", panel: editing.panel, note: editing.note });
                        setEditing(null);
                    }}
                    onClose={() => setEditing(null)}
                />
            )}
        </div>
    );
}

/** Whether what's dragged can go on a plot (a channel from the list, or a series from a legend): if so, it may. */
function allowDrop(event: DragEvent<HTMLElement>): boolean {
    const types = event.dataTransfer.types;
    if (!types.includes(CHANNEL_TYPE) && !types.includes(SERIES_TYPE)) {
        return false;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = types.includes(SERIES_TYPE) ? "move" : "copy";
    return true;
}

/**
 * Put what was dropped on a plot (null: a new plot): onto an axis (by id), a new one ("new"), or ("auto", anywhere
 * else on the plot) the axis of others like it.
 */
function drop(
    event: DragEvent<HTMLElement>,
    panel: PanelSpec | null,
    target: string,
    dispatch: (action: Action) => void,
    placeFor: (panel: string | null, quantity: string) => AxisTarget | undefined,
) {
    const channel = event.dataTransfer.getData(CHANNEL_TYPE);
    const series = event.dataTransfer.getData(SERIES_TYPE);
    if (!channel && !series) {
        return;
    }
    event.preventDefault();
    const found = JSON.parse(channel || series) as {
        dataset: number;
        channel: string;
        formula: number | null;
        panel: string;
        series: string;
        quantity?: string;
    };
    if (series && target === "auto" && found.panel === panel?.id) {
        return; // onto its own plot: it stays on its axis
    }
    const axis: AxisTarget | undefined = !panel
        ? undefined
        : target === "new"
          ? { new: newAxisSide(panel) }
          : target === "auto"
            ? placeFor(panel.id, found.quantity ?? "")
            : target;
    if (channel) {
        const { dataset, formula } = found;
        dispatch({ type: "addSeries", panel: panel?.id ?? null, dataset, channel: found.channel, formula, axis });
    } else {
        dispatch({ type: "moveSeries", panel: found.panel, series: found.series, to: panel?.id ?? null, axis });
    }
}

/** The window's start and end, as the time axis reads them (T-7.48, 21:15:03.25), and typed any way it reads. */
function WindowInputs({
    view,
    time,
    onChange,
}: {
    view: [number, number];
    time: TimeLabels;
    onChange: (window: [number, number]) => void;
}) {
    const span = view[1] - view[0];
    const [draft, setDraft] = useState<[string, string] | null>(null);
    const values = draft ?? [time.text(view[0], span), time.text(view[1], span)];
    const apply = () => {
        if (!draft) {
            return;
        }
        const [start, end] = draft.map((text) => time.parse(text));
        setDraft(null);
        if (start !== null && start !== undefined && end !== null && end !== undefined && end > start) {
            onChange([start, end]);
        }
    };
    const field = (index: 0 | 1, label: string) => (
        <input
            type="text"
            spellCheck={false}
            title="A time as the axis reads it: T-10, T+15, 21:15:03, or seconds"
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
            {field(0, "Window start")}
            <span className="muted">to</span>
            {field(1, "Window end")}
            <span className="muted">· {formatDuration(span)} in view</span>
        </div>
    );
}

/**
 * T0: typed (a time of day, a Unix time, T+12 from the T0 there is, or seconds), put where the next click on a plot
 * is, at the cursor or the window's start, or at one of the file's events. Its line can be dragged too.
 */
function T0Menu({
    layout,
    time,
    events,
    cursor,
    view,
    placing,
    onSet,
    onPlace,
}: {
    layout: Layout;
    time: TimeLabels;
    events: { label: string; t: number }[];
    cursor: number;
    view: [number, number];
    placing: boolean;
    onSet: (t0: number | null) => void;
    onPlace: () => void;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const [typed, setTyped] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const set = (t0: number | null) => {
        onSet(t0);
        setOpen(false);
        setTyped("");
        setProblem(null);
    };
    const item = (label: string, onSelect: () => void) => (
        <button key={label} type="button" role="menuitem" className="menu-item" onClick={onSelect}>
            {label}
        </button>
    );
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className="menu-button"
                aria-haspopup="true"
                aria-expanded={open}
                aria-pressed={placing || undefined}
                onClick={() => setOpen(!open)}
            >
                {placing ? "Click a plot…" : "T0"}
            </button>
            {open && (
                <div className="menu yorg-t0-menu">
                    <form
                        className="yorg-t0-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const at = time.parse(typed, "file");
                            if (at === null) {
                                setProblem(
                                    time.clockable
                                        ? "Write a time of day (21:15:03.25), a Unix time, T+12 from the T0 there is, or seconds in the file."
                                        : "Write seconds in the file, or T+12 from the T0 there is.",
                                );
                            } else {
                                set(at);
                            }
                        }}
                    >
                        <label className="field">
                            T0 at
                            <input
                                autoFocus
                                value={typed}
                                spellCheck={false}
                                placeholder={time.clockable ? "21:15:03.25, or a Unix time" : "12.5 (s)"}
                                onChange={(event) => setTyped(event.target.value)}
                            />
                        </label>
                        <button type="submit" className="button-small button-primary" disabled={!typed.trim()}>
                            Set
                        </button>
                    </form>
                    {problem && <p className="field-problem">{problem}</p>}
                    <div role="menu" aria-label="T0">
                        {item("Set T0 by clicking a plot", () => {
                            setOpen(false);
                            onPlace();
                        })}
                        {item("Set T0 at the last cursor", () => set(cursor))}
                        {item("Set T0 at the start of the window", () => set(view[0]))}
                        {events
                            .slice(0, 12)
                            .map((event) =>
                                item(`Set T0 at ${event.label} (${time.absolute(event.t)})`, () => set(event.t)),
                            )}
                        {layout.t0 !== null && item("Clear T0", () => set(null))}
                    </div>
                </div>
            )}
        </div>
    );
}

function OptionsMenu({
    layout,
    dispatch,
    time,
}: {
    layout: Layout;
    dispatch: (action: Action) => void;
    time: TimeLabels;
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
                    <label className="field">
                        Time reads
                        <select
                            value={layout.time}
                            onChange={(event) =>
                                dispatch({ type: "options", change: { time: event.target.value as TimeMode } })
                            }
                        >
                            <option value="auto">
                                {time.clockable ? "As time of day until there's a T0, then from it" : "From T0"}
                            </option>
                            <option value="t0">
                                From T0: T{MINUS}10, T0, T+15 (seconds from the start without one)
                            </option>
                            <option value="utc" disabled={!time.clockable}>
                                {time.dated ? "As time of day, UTC" : "As time of day"}
                            </option>
                            <option value="local" disabled={!time.dated}>
                                As time of day, {time.here} (this computer's)
                            </option>
                        </select>
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
                        <dt>L</dt>
                        <dd>place a label: click where it points</dd>
                        <dt>Drag</dt>
                        <dd>a marker, a label, or its arrow's tip, to move it</dd>
                    </dl>
                </div>
            )}
        </div>
    );
}

/** Changing a label: its words (Enter for a new line with Shift), its arrow, or taking it away. Empty, it goes. */
function NoteEditor({
    at,
    note,
    onChange,
    onRemove,
    onClose,
}: {
    at: { left: number; top: number };
    note: Note | null;
    onChange: (change: Partial<Omit<Note, "id">>) => void;
    onRemove: () => void;
    onClose: () => void;
}) {
    const box = useRef<HTMLDivElement>(null);
    const latest = useRef({ note, onRemove, onClose });
    latest.current = { note, onRemove, onClose };
    useLayoutEffect(() => {
        if (box.current) {
            placeMenuAt(box.current, at.left + 8, at.top + 8);
        }
    }, [at]);
    useEffect(() => {
        const done = () => (latest.current.note?.text.trim() ? latest.current.onClose() : latest.current.onRemove());
        const close = (event: MouseEvent | KeyboardEvent) => {
            const outside = event instanceof MouseEvent && !box.current?.contains(event.target as Node);
            if (outside || (event instanceof KeyboardEvent && event.key === "Escape")) {
                done();
            }
        };
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", close);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", close);
        };
    }, []);
    if (!note) {
        return null;
    }
    return (
        <div className="menu yorg-note-editor" role="dialog" aria-label="Label" ref={box}>
            <label className="field">
                Label
                <textarea
                    autoFocus
                    value={note.text}
                    placeholder="What's here: ignition, a spike…"
                    onChange={(event) => onChange({ text: event.target.value })}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            if (note.text.trim()) {
                                onClose();
                            } else {
                                onRemove();
                            }
                        }
                    }}
                />
            </label>
            <div className="yorg-note-tools">
                <label className="check">
                    <input
                        type="checkbox"
                        checked={note.arrow}
                        onChange={(event) => onChange({ arrow: event.target.checked })}
                    />
                    Arrow to the data
                </label>
                <button type="button" className="button-small" onClick={onRemove}>
                    Remove
                </button>
                <button
                    type="button"
                    className="button-small button-primary"
                    disabled={!note.text.trim()}
                    onClick={onClose}
                >
                    Done
                </button>
            </div>
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
    useLayoutEffect(() => {
        if (menu.current) {
            placeMenuAt(menu.current, at.left, at.top);
        }
    }, [at]);
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
        <div className="menu yorg-plot-menu" role="menu" ref={menu}>
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
    shading: Shading[];
    cursor: number | null;
    readouts: ReadonlyMap<string, { x: number; y: number } | null>;
    gutters: { left: number; right: number };
    colors: ReturnType<typeof usePlotColors>;
    onCursor: (x: number | null) => void;
    onWindow: (window: [number, number] | null, remember: boolean) => void;
    onMenu: (x: number, left: number, top: number, target: MenuTarget) => void;
    placing: boolean;
    onPlace: (anchor: Anchor, left: number, top: number) => void;
    onEditNote: (note: string, left: number, top: number) => void;
    onMoveMark: (marker: string, x: number) => void;
}

type Place = (panel: string | null, quantity: string) => AxisTarget | undefined;

/** An axis's name: its title, or its channels' units (or States), and where it is: psi · left, lbf · right 2. */
function axisName(axis: AxisSpec, series: Resolved[], axes: AxisSpec[]): string {
    const on = series.filter((one) => one.spec.axis === axis.id);
    const units = [...new Set(on.map((one) => one.unit).filter(Boolean))].join(", ");
    const states = on.length > 0 && on.every((one) => one.channel?.kind === "state");
    const out = axes.filter((other) => other.side === axis.side).indexOf(axis); // from the plot
    const place = out > 0 ? ` ${out + 1}` : "";
    return `${axis.label || units || (states ? "States" : "Values")} · ${axis.side}${place}`;
}

/** A panel's axes as the legend and menus list them: the left's from the plot out, then the right's. */
const inOrder = (axes: AxisSpec[]): AxisSpec[] => [
    ...axes.filter((axis) => axis.side === "left"),
    ...axes.filter((axis) => axis.side === "right"),
];

function PanelView({
    panel,
    index,
    count,
    height,
    series,
    plotSeries,
    others,
    active,
    onActivate,
    dispatch,
    placeFor,
    plot,
}: {
    panel: PanelSpec;
    index: number;
    count: number;
    height: number;
    series: Resolved[];
    plotSeries: PlotSeries[];
    others: PanelSpec[];
    active: boolean;
    onActivate: () => void;
    dispatch: (action: Action) => void;
    placeFor: Place;
    plot: PlotBits;
}) {
    const name = panel.title || `Plot ${index + 1}`;
    // While something's dragged over the plot: where it would go (an axis in the legend, "new", or "auto": the axis
    // for its unit).
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    const targetAt = (event: DragEvent<HTMLElement>): string =>
        (event.target as Element).closest?.("[data-axis]")?.getAttribute("data-axis") ?? "auto";
    const setAxis = useCallback(
        (axis: string, range: [number, number] | null) =>
            dispatch({
                type: "changeAxis",
                panel: panel.id,
                axis,
                change: { min: range?.[0] ?? null, max: range?.[1] ?? null },
            }),
        [dispatch, panel.id],
    );
    const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
        const startY = event.clientY;
        const startHeight = height;
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        const move = (moving: PointerEvent) =>
            dispatch({
                type: "changePanel",
                panel: panel.id,
                change: { height: Math.min(2400, Math.max(120, Math.round(startHeight + moving.clientY - startY))) },
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
            className={`yorg-panel${active ? " yorg-panel-active" : ""}${dropTarget ? " yorg-panel-drop" : ""}`}
            aria-label={name}
            onPointerDown={onActivate}
            onFocus={onActivate}
            onDragOver={(event) => {
                if (allowDrop(event)) {
                    setDropTarget(targetAt(event));
                }
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDropTarget(null);
                }
            }}
            onDrop={(event) => {
                const target = targetAt(event);
                setDropTarget(null);
                drop(event, panel, target, dispatch, placeFor);
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
                    <AxesButton panel={panel} series={series} dispatch={dispatch} />
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
                <div className="yorg-plot-area">
                    <Plot
                        label={`${name}: ${series.map((one) => one.name).join(", ") || "empty"}`}
                        series={plotSeries}
                        axes={panel.axes}
                        height={height}
                        window={plot.window}
                        time={plot.time}
                        marks={plot.marks}
                        shading={plot.shading}
                        cursor={plot.cursor}
                        readouts={plot.readouts}
                        gutters={plot.gutters}
                        colors={plot.colors}
                        onCursor={plot.onCursor}
                        onWindow={plot.onWindow}
                        onAxis={setAxis}
                        onMenu={plot.onMenu}
                        notes={panel.notes}
                        placing={plot.placing}
                        onPlace={plot.onPlace}
                        onNote={(note, change) => dispatch({ type: "changeNote", panel: panel.id, note, change })}
                        onEditNote={plot.onEditNote}
                        onMoveMark={plot.onMoveMark}
                    />
                    {dropTarget === "auto" && (
                        <div className="yorg-drop" aria-hidden="true">
                            <span>Onto the axis for its unit (or an axis in the list, or a new one)</span>
                        </div>
                    )}
                </div>
                <Legend
                    name={name}
                    panel={panel}
                    series={series}
                    others={others}
                    readouts={plot.readouts}
                    dropTarget={dropTarget}
                    dispatch={dispatch}
                    placeFor={placeFor}
                />
            </div>
            <div
                className="yorg-panel-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize ${name}`}
                title={
                    panel.height === null
                        ? "Drag to give this plot a height of its own"
                        : "Drag to resize it; double-click to share the window's height with the others again"
                }
                onPointerDown={resize}
                onDoubleClick={() => dispatch({ type: "changePanel", panel: panel.id, change: { height: null } })}
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
    dropTarget,
    dispatch,
    placeFor,
}: {
    name: string;
    panel: PanelSpec;
    series: Resolved[];
    others: PanelSpec[];
    readouts: ReadonlyMap<string, { x: number; y: number } | null>;
    dropTarget: string | null;
    dispatch: (action: Action) => void;
    placeFor: Place;
}) {
    if (series.length === 0 && dropTarget === null) {
        return <p className="yorg-legend-empty muted">No channels yet: pick some on the left, or drag them here.</p>;
    }
    // One list while there's one axis; a group for each once there are more, or while something's dragged.
    const titled = panel.axes.length > 1 || dropTarget !== null;
    return (
        <div className="yorg-legend" role="group" aria-label={`${name}: channels`}>
            {inOrder(panel.axes).map((axis) => {
                const title = axisName(axis, series, panel.axes);
                return (
                    <div
                        key={axis.id}
                        data-axis={axis.id}
                        className={`yorg-legend-side${dropTarget === axis.id ? " yorg-legend-drop" : ""}`}
                    >
                        {titled && <p className="yorg-legend-title">{title}</p>}
                        <ul aria-label={title}>
                            {series
                                .filter((one) => one.spec.axis === axis.id)
                                .map((one) => (
                                    <LegendRow
                                        key={one.spec.id}
                                        series={one}
                                        siblings={series}
                                        panel={panel}
                                        others={others}
                                        point={readouts.get(one.spec.id) ?? null}
                                        dispatch={dispatch}
                                        placeFor={placeFor}
                                    />
                                ))}
                        </ul>
                    </div>
                );
            })}
            {dropTarget !== null && (
                <div
                    data-axis="new"
                    className={`yorg-legend-side yorg-legend-new${dropTarget === "new" ? " yorg-legend-drop" : ""}`}
                >
                    <p className="yorg-legend-title">A new axis</p>
                    <p className="yorg-legend-hint muted">Drop here for an axis of its own</p>
                </div>
            )}
        </div>
    );
}

function LegendRow({
    series,
    siblings,
    panel,
    others,
    point,
    dispatch,
    placeFor,
}: {
    series: Resolved;
    siblings: Resolved[]; // its plot's series, which name its axes
    panel: PanelSpec;
    others: PanelSpec[];
    point: { x: number; y: number } | null;
    dispatch: (action: Action) => void;
    placeFor: Place;
}) {
    const value = point && !Number.isNaN(point.y) ? reading(series, point.y) : "";
    const { spec } = series;
    return (
        <li
            className={spec.hidden ? "yorg-legend-hidden" : undefined}
            draggable
            onDragStart={(event) => {
                const payload = { panel: panel.id, series: spec.id, quantity: quantityOf(series) };
                event.dataTransfer.setData(SERIES_TYPE, JSON.stringify(payload));
                event.dataTransfer.effectAllowed = "move";
            }}
        >
            <span className="yorg-grip" aria-hidden="true" title="Drag to another axis, or onto another plot">
                ⠿
            </span>
            <button
                type="button"
                className="yorg-swatch"
                style={{ background: spec.hidden ? "transparent" : spec.color, borderColor: spec.color }}
                aria-pressed={!spec.hidden}
                aria-label={`Show ${series.name}`}
                title={spec.hidden ? "Show it" : "Hide it"}
                onClick={() =>
                    dispatch({
                        type: "changeSeries",
                        panel: panel.id,
                        series: spec.id,
                        change: { hidden: !spec.hidden },
                    })
                }
            />
            <SeriesButton
                series={series}
                siblings={siblings}
                panel={panel}
                others={others}
                dispatch={dispatch}
                placeFor={placeFor}
            />
            <span className="yorg-value" title={series.problem ?? undefined}>
                {series.problem ? "⚠" : series.loading ? "…" : value}
            </span>
            <span className="yorg-unit">{series.unit}</span>
            {series.problem && <span className="yorg-problem visually-hidden">{series.problem}</span>}
        </li>
    );
}

/** A series' name in the legend, which opens its settings: name, color, scale and offset, axis, and so on. */
function SeriesButton({
    series,
    siblings,
    panel,
    others,
    dispatch,
    placeFor,
}: {
    series: Resolved;
    siblings: Resolved[];
    panel: PanelSpec;
    others: PanelSpec[];
    dispatch: (action: Action) => void;
    placeFor: Place;
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
                                onChange={(event) => {
                                    const value = event.target.value;
                                    dispatch({
                                        type: "moveSeries",
                                        panel: panel.id,
                                        series: spec.id,
                                        to: panel.id,
                                        axis:
                                            value === "new-left" || value === "new-right"
                                                ? { new: value === "new-left" ? "left" : "right" }
                                                : value,
                                    });
                                }}
                            >
                                {inOrder(panel.axes).map((axis) => (
                                    <option key={axis.id} value={axis.id}>
                                        {axisName(axis, siblings, panel.axes)}
                                    </option>
                                ))}
                                <option value="new-left">A new axis, on the left</option>
                                <option value="new-right">A new axis, on the right</option>
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
                    {series.formula && (
                        <p className="muted yorg-channel-facts">
                            Calculated: <code>{series.formula.expression}</code>
                        </p>
                    )}
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
                                const to = event.target.value === "new" ? null : event.target.value;
                                dispatch({
                                    type: "moveSeries",
                                    panel: panel.id,
                                    series: spec.id,
                                    to,
                                    axis: placeFor(to, quantityOf(series)),
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

/** A plot's axes: each one's title, range (fixed, or fitting what's in view), and side. */
function AxesButton({
    panel,
    series,
    dispatch,
}: {
    panel: PanelSpec;
    series: Resolved[];
    dispatch: (action: Action) => void;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const change = (axis: string, next: Partial<Omit<AxisSpec, "id">>) =>
        dispatch({ type: "changeAxis", panel: panel.id, axis, change: next });
    const bound = (axis: AxisSpec, which: "min" | "max", label: string) => (
        <label className="field">
            {label}
            <input
                type="number"
                step="any"
                placeholder="fit"
                key={`${which}-${axis[which]}`}
                defaultValue={axis[which] ?? ""}
                onBlur={(event) => {
                    const text = event.target.value.trim();
                    const value = Number(text);
                    change(axis.id, { [which]: text === "" || !Number.isFinite(value) ? null : value });
                }}
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
        </label>
    );
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className="button-small"
                aria-expanded={open}
                disabled={panel.axes.length === 0}
                onClick={() => setOpen(!open)}
            >
                Axes
            </button>
            {open && (
                <div className="menu menu-left yorg-axes-menu" role="dialog" aria-label="Axes">
                    {inOrder(panel.axes).map((axis) => (
                        <fieldset key={axis.id}>
                            <legend>{axisName(axis, series, panel.axes)}</legend>
                            <label className="field">
                                Title
                                <input
                                    defaultValue={axis.label}
                                    placeholder="the channels' units"
                                    onBlur={(event) => change(axis.id, { label: event.target.value })}
                                />
                            </label>
                            <div className="yorg-row">
                                {bound(axis, "min", "From")}
                                {bound(axis, "max", "To")}
                                <label className="field">
                                    Side
                                    <select
                                        value={axis.side}
                                        onChange={(event) => change(axis.id, { side: event.target.value as Side })}
                                    >
                                        <option value="left">Left</option>
                                        <option value="right">Right</option>
                                    </select>
                                </label>
                                <button
                                    type="button"
                                    className="button-small"
                                    onClick={() => change(axis.id, { min: null, max: null })}
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
