// A plot layout: the datasets it draws from, its panels (stacked plots sharing one time axis), the channels in each,
// and the time window, T0, markers, and masks. It's plain JSON: saved views keep it as it is, and so does this browser
// for each dataset you look at.

export const PALETTE = [
    "#2f7ed8",
    "#e0a500",
    "#d64541",
    "#2ca25f",
    "#8e5bd6",
    "#16a5a5",
    "#e8743b",
    "#d9559a",
    "#7f9c1c",
    "#8c6d4e",
];

export type Side = "left" | "right";

export interface SeriesSpec {
    id: string;
    dataset: number;
    channel: string; // by name, so a layout works for another test with the same channels
    formula: number | null; // a calculated channel (by id; channel is its name when it was added)
    label: string; // "": the channel's name
    color: string;
    scale: number; // shown value = value * scale + offset
    offset: number;
    unit: string | null; // null: the channel's own
    axis: string; // its axis's id (in its panel's axes)
    hidden: boolean;
    width: number; // line width, in pixels
    step: boolean | null; // null: steps for states, lines for numbers
}

/** One of a plot's value axes (psi, lbf, a valve's states), on its left or right: each side's first is next to it. */
export interface AxisSpec {
    id: string;
    side: Side;
    label: string; // "": the units of its channels
    min: number | null; // null: fit what's in view
    max: number | null;
}

/** Where a series goes: onto an axis (by id), or onto a new one on a side. */
export type AxisTarget = string | { new: Side };

/** A label on a plot, pointing at a place in its data: a time, and a value on one of its axes. */
export interface Note {
    id: string;
    t: number;
    y: number;
    axis: string; // the axis y is on
    text: string;
    dx: number; // where the label sits, in pixels from the point, so it reads the same at any zoom
    dy: number;
    arrow: boolean; // an arrow from the label to the point
}

export interface PanelSpec {
    id: string;
    title: string;
    height: number | null; // the plot's, in pixels; null: the plots share the window's height
    series: SeriesSpec[];
    axes: AxisSpec[]; // the left's from the plot out, then the right's
    notes: Note[];
}

export interface Marker {
    id: string;
    t: number; // on the time axis
    label: string;
}

/**
 * Where a test on channels holds, by their names (so it works for another test's data too): a valve open, a pressure
 * over its redline. It can shade the plots where it holds, and hide data where it doesn't.
 */
export interface Mask {
    id: string;
    name: string;
    expression: string; // like a calculated channel's: [MOV-OX] == 1, [PT-CHAMBER] > 450
    color: string;
    shade: boolean;
    hide: boolean;
}

/** A dataset in the layout, and how far its times move along the time axis (to line up tests, say). */
export interface DatasetRef {
    id: number;
    shift: number;
}

/**
 * How the time axis reads: from T0 (T-10, T0, T+15; from the start without one), or as time of day, in UTC or this
 * computer's time zone. auto: time of day for dated data until there's a T0, then from it.
 */
export type TimeMode = "auto" | "t0" | "utc" | "local";

export interface Layout {
    version: 1;
    datasets: DatasetRef[]; // the first one's times are the time axis's
    panels: PanelSpec[];
    window: [number, number] | null; // what's in view; null: everything
    t0: number | null; // where the time axis reads 0 (ignition, say)
    markers: Marker[];
    masks: Mask[];
    events: boolean; // show the datasets' events (a sequence's steps) as markers
    time: TimeMode;
}

const OLD_PANEL_HEIGHT = 260; // every plot's height before plots filled the window: read as filling it

let counter = 0;
export const newId = (): string =>
    `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newPanel(): PanelSpec {
    return { id: newId(), title: "", height: null, series: [], axes: [], notes: [] };
}

/** The side a panel's next axis goes on: the left first, then whichever has fewer. */
export function newAxisSide(panel: PanelSpec): Side {
    const left = panel.axes.filter((axis) => axis.side === "left").length;
    return left <= panel.axes.length - left ? "left" : "right";
}

/** The axis a target means in a panel, made if it's new (or named but missing: an old layout's "right"). */
function axisFor(panel: PanelSpec, target: AxisTarget | undefined): [PanelSpec, string] {
    if (typeof target === "string" && panel.axes.some((axis) => axis.id === target)) {
        return [panel, target];
    }
    if (target === undefined && panel.axes[0]) {
        return [panel, panel.axes[0].id];
    }
    const side: Side =
        typeof target === "object" ? target.new : target === "left" || target === "right" ? target : newAxisSide(panel);
    const axis: AxisSpec = { id: typeof target === "string" ? target : newId(), side, label: "", min: null, max: null };
    return [{ ...panel, axes: [...panel.axes, axis] }, axis.id];
}

/** A panel's axes, tidied: each series' axis is there (made if it's missing), and those with no series go. */
function tidyAxes(panel: PanelSpec): PanelSpec {
    const used = new Set(panel.series.map((series) => series.axis));
    let axes = panel.axes.filter((axis) => used.has(axis.id));
    for (const id of used) {
        if (!axes.some((axis) => axis.id === id)) {
            axes = [...axes, { id, side: id === "right" ? "right" : "left", label: "", min: null, max: null }];
        }
    }
    return axes.length === panel.axes.length && axes.every((axis, index) => axis === panel.axes[index])
        ? panel
        : { ...panel, axes };
}

export function newLayout(dataset: number): Layout {
    return {
        version: 1,
        datasets: [{ id: dataset, shift: 0 }],
        panels: [newPanel()],
        window: null,
        t0: null,
        markers: [],
        masks: [],
        events: true,
        time: "auto",
    };
}

/** The first color no series is drawn in yet. */
export function nextColor(layout: Layout): string {
    const used = new Set(layout.panels.flatMap((panel) => panel.series.map((series) => series.color)));
    const count = layout.panels.reduce((total, panel) => total + panel.series.length, 0);
    return PALETTE.find((color) => !used.has(color)) ?? PALETTE[count % PALETTE.length]!;
}

export const shiftOf = (layout: Layout, dataset: number): number =>
    layout.datasets.find((ref) => ref.id === dataset)?.shift ?? 0;

/** Whether a series draws this channel (or calculated channel) of this dataset. */
export const isOf = (series: SeriesSpec, what: { dataset: number; channel: string; formula: number | null }): boolean =>
    series.dataset === what.dataset &&
    (what.formula === null
        ? series.formula === null && series.channel === what.channel
        : series.formula === what.formula);

/** Whether a channel (or calculated channel) of this dataset is on any plot. */
export const isPlotted = (
    layout: Layout,
    what: { dataset: number; channel: string; formula: number | null },
): boolean => layout.panels.some((panel) => panel.series.some((series) => isOf(series, what)));

export type Action =
    | {
          type: "addSeries";
          panel: string | null; // null: a new panel
          dataset: number;
          channel: string;
          formula?: number | null;
          axis?: AxisTarget; // none: the panel's first axis
      }
    | { type: "removeSeries"; panel: string; series: string }
    | { type: "unplot"; dataset: number; channel: string; formula: number | null } // wherever it's plotted
    | { type: "changeSeries"; panel: string; series: string; change: Partial<SeriesSpec> }
    | { type: "moveSeries"; panel: string; series: string; to: string | null; axis?: AxisTarget } // null: a new panel
    | { type: "addPanel" }
    | { type: "removePanel"; panel: string }
    | { type: "movePanel"; panel: string; by: -1 | 1 }
    | { type: "changePanel"; panel: string; change: Partial<Pick<PanelSpec, "title" | "height">> }
    | { type: "changeAxis"; panel: string; axis: string; change: Partial<Omit<AxisSpec, "id">> }
    | { type: "addNote"; panel: string; note: Note }
    | { type: "changeNote"; panel: string; note: string; change: Partial<Omit<Note, "id">> }
    | { type: "removeNote"; panel: string; note: string }
    | { type: "window"; window: [number, number] | null }
    | { type: "t0"; t0: number | null }
    | { type: "addMarker"; t: number; label: string }
    | { type: "changeMarker"; marker: string; change: Partial<Omit<Marker, "id">> }
    | { type: "removeMarker"; marker: string }
    | { type: "addMask"; mask: Mask }
    | { type: "changeMask"; mask: string; change: Partial<Omit<Mask, "id">> }
    | { type: "removeMask"; mask: string }
    | { type: "addDataset"; dataset: number; shift: number }
    | { type: "removeDataset"; dataset: number }
    | { type: "shiftDataset"; dataset: number; shift: number }
    | { type: "options"; change: Partial<Pick<Layout, "events" | "time">> }
    | { type: "replace"; layout: Layout };

const mapPanel = (layout: Layout, id: string, change: (panel: PanelSpec) => PanelSpec): Layout => ({
    ...layout,
    panels: layout.panels.map((panel) => (panel.id === id ? change(panel) : panel)),
});

/** A panel with a series added, on the axis the target means. */
function withSeries(panel: PanelSpec, series: SeriesSpec, target: AxisTarget | undefined): PanelSpec {
    const [withAxis, axis] = axisFor(panel, target);
    return { ...withAxis, series: [...withAxis.series, { ...series, axis }] };
}

export function reduce(layout: Layout, action: Action): Layout {
    switch (action.type) {
        case "addSeries": {
            const series: SeriesSpec = {
                id: newId(),
                dataset: action.dataset,
                channel: action.channel,
                formula: action.formula ?? null,
                label: "",
                color: nextColor(layout),
                scale: 1,
                offset: 0,
                unit: null,
                axis: "",
                hidden: false,
                width: 1.5,
                step: null,
            };
            const target = layout.panels.find((panel) => panel.id === action.panel);
            if (!target) {
                return { ...layout, panels: [...layout.panels, withSeries(newPanel(), series, action.axis)] };
            }
            return mapPanel(layout, target.id, (panel) => withSeries(panel, series, action.axis));
        }
        case "removeSeries":
            return mapPanel(layout, action.panel, (panel) =>
                tidyAxes({ ...panel, series: panel.series.filter((series) => series.id !== action.series) }),
            );
        case "unplot":
            return {
                ...layout,
                panels: layout.panels.map((panel) =>
                    tidyAxes({ ...panel, series: panel.series.filter((series) => !isOf(series, action)) }),
                ),
            };
        case "changeSeries":
            return mapPanel(layout, action.panel, (panel) => ({
                ...panel,
                series: panel.series.map((series) =>
                    series.id === action.series ? { ...series, ...action.change } : series,
                ),
            }));
        case "moveSeries": {
            const found = layout.panels
                .find((panel) => panel.id === action.panel)
                ?.series.find((series) => series.id === action.series);
            if (!found) {
                return layout;
            }
            if (action.to === action.panel) {
                // Onto another axis of its plot (or a new one).
                return mapPanel(layout, action.panel, (panel) => {
                    const [withAxis, axis] = axisFor(panel, action.axis ?? found.axis);
                    return tidyAxes({
                        ...withAxis,
                        series: withAxis.series.map((series) =>
                            series.id === found.id ? { ...series, axis } : series,
                        ),
                    });
                });
            }
            const without = reduce(layout, { type: "removeSeries", panel: action.panel, series: action.series });
            const target = without.panels.find((panel) => panel.id === action.to);
            if (!target) {
                return { ...without, panels: [...without.panels, withSeries(newPanel(), found, action.axis)] };
            }
            return mapPanel(without, target.id, (panel) => withSeries(panel, found, action.axis));
        }
        case "addPanel":
            return { ...layout, panels: [...layout.panels, newPanel()] };
        case "removePanel":
            return { ...layout, panels: layout.panels.filter((panel) => panel.id !== action.panel) };
        case "movePanel": {
            const panels = [...layout.panels];
            const from = panels.findIndex((panel) => panel.id === action.panel);
            const to = from + action.by;
            if (from < 0 || to < 0 || to >= panels.length) {
                return layout;
            }
            [panels[from], panels[to]] = [panels[to]!, panels[from]!];
            return { ...layout, panels };
        }
        case "changePanel":
            return mapPanel(layout, action.panel, (panel) => ({ ...panel, ...action.change }));
        case "changeAxis":
            return mapPanel(layout, action.panel, (panel) => {
                const axes = panel.axes.map((axis) => (axis.id === action.axis ? { ...axis, ...action.change } : axis));
                const moved = action.change.side && axes.find((axis) => axis.id === action.axis);
                // An axis moved to the other side goes outside the axes there.
                return { ...panel, axes: moved ? [...axes.filter((axis) => axis !== moved), moved] : axes };
            });
        case "addNote":
            return mapPanel(layout, action.panel, (panel) => ({ ...panel, notes: [...panel.notes, action.note] }));
        case "changeNote":
            return mapPanel(layout, action.panel, (panel) => ({
                ...panel,
                notes: panel.notes.map((note) => (note.id === action.note ? { ...note, ...action.change } : note)),
            }));
        case "removeNote":
            return mapPanel(layout, action.panel, (panel) => ({
                ...panel,
                notes: panel.notes.filter((note) => note.id !== action.note),
            }));
        case "window":
            return { ...layout, window: action.window };
        case "t0":
            return { ...layout, t0: action.t0 };
        case "addMarker":
            return { ...layout, markers: [...layout.markers, { id: newId(), t: action.t, label: action.label }] };
        case "changeMarker":
            return {
                ...layout,
                markers: layout.markers.map((marker) =>
                    marker.id === action.marker ? { ...marker, ...action.change } : marker,
                ),
            };
        case "removeMarker":
            return { ...layout, markers: layout.markers.filter((marker) => marker.id !== action.marker) };
        case "addMask":
            return { ...layout, masks: [...layout.masks, action.mask] };
        case "changeMask":
            return {
                ...layout,
                masks: layout.masks.map((mask) => (mask.id === action.mask ? { ...mask, ...action.change } : mask)),
            };
        case "removeMask":
            return { ...layout, masks: layout.masks.filter((mask) => mask.id !== action.mask) };
        case "addDataset":
            if (layout.datasets.some((ref) => ref.id === action.dataset)) {
                return layout;
            }
            return { ...layout, datasets: [...layout.datasets, { id: action.dataset, shift: action.shift }] };
        case "removeDataset":
            return {
                ...layout,
                datasets: layout.datasets.filter((ref) => ref.id !== action.dataset),
                panels: layout.panels.map((panel) =>
                    tidyAxes({ ...panel, series: panel.series.filter((series) => series.dataset !== action.dataset) }),
                ),
            };
        case "shiftDataset":
            return {
                ...layout,
                datasets: layout.datasets.map((ref) =>
                    ref.id === action.dataset ? { ...ref, shift: action.shift } : ref,
                ),
            };
        case "options":
            return { ...layout, ...action.change };
        case "replace":
            return action.layout;
    }
}

/** The same layout for another dataset: its channels, by name, in place of the first dataset's. */
export function forDataset(layout: Layout, dataset: number): Layout {
    const first = layout.datasets[0]?.id;
    return {
        ...layout,
        datasets: [{ id: dataset, shift: 0 }, ...layout.datasets.slice(1).filter((ref) => ref.id !== dataset)],
        panels: layout.panels.map((panel) => ({
            ...panel,
            series: panel.series.map((series) => (series.dataset === first ? { ...series, dataset } : series)),
        })),
        window: null,
    };
}

// --- reading a layout back ----------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
const numOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function axis(value: unknown, id: string, side: Side): AxisSpec {
    const found = isObject(value) ? value : {};
    return {
        id: str(found.id) || id,
        side: found.side === "right" || found.side === "left" ? found.side : side,
        label: str(found.label),
        min: numOrNull(found.min),
        max: numOrNull(found.max),
    };
}

/** A panel's axes: as saved, or an older layout's left and right. */
function axes(panel: Loose): AxisSpec[] {
    if (Array.isArray(panel.axes)) {
        const found = panel.axes.filter(isObject).map((entry) => axis(entry, newId(), "left"));
        return found.filter((one, index) => found.findIndex((other) => other.id === one.id) === index);
    }
    return [axis(panel.left, "left", "left"), axis(panel.right, "right", "right")];
}

const TIME_MODES: TimeMode[] = ["auto", "t0", "utc", "local"];

/** The time axis's mode, or an older layout's: time of day (then only in the file's zone, UTC for Unix times). */
function timeMode(found: Loose): TimeMode {
    if (TIME_MODES.includes(found.time as TimeMode)) {
        return found.time as TimeMode;
    }
    return found.clock === true ? "utc" : found.clock === false ? "t0" : "auto";
}

function note(value: unknown): Note | null {
    if (!isObject(value) || numOrNull(value.t) === null || numOrNull(value.y) === null) {
        return null;
    }
    return {
        id: str(value.id) || newId(),
        t: num(value.t, 0),
        y: num(value.y, 0),
        axis: str(value.axis) || "left",
        text: str(value.text).slice(0, 500),
        dx: Math.min(2000, Math.max(-2000, num(value.dx, 40))),
        dy: Math.min(2000, Math.max(-2000, num(value.dy, -36))),
        arrow: value.arrow !== false,
    };
}

function mask(value: unknown, index: number): Mask | null {
    if (!isObject(value) || !str(value.expression).trim()) {
        return null;
    }
    return {
        id: str(value.id) || newId(),
        name: str(value.name).slice(0, 200) || `Mask ${index + 1}`,
        expression: str(value.expression).slice(0, 2000),
        color: /^#[0-9a-fA-F]{6}$/.test(str(value.color)) ? str(value.color) : PALETTE[3]!,
        shade: value.shade !== false,
        hide: value.hide === true,
    };
}

function series(value: unknown, dataset: number): SeriesSpec | null {
    if (!isObject(value) || typeof value.channel !== "string") {
        return null;
    }
    return {
        id: str(value.id) || newId(),
        dataset: num(value.dataset, dataset),
        channel: value.channel,
        formula: typeof value.formula === "number" && Number.isInteger(value.formula) ? value.formula : null,
        label: str(value.label),
        color: /^#[0-9a-fA-F]{6}$/.test(str(value.color)) ? str(value.color) : PALETTE[0]!,
        scale: num(value.scale, 1),
        offset: num(value.offset, 0),
        unit: typeof value.unit === "string" ? value.unit : null,
        axis: str(value.axis) || "left",
        hidden: value.hidden === true,
        width: Math.min(6, Math.max(0.5, num(value.width, 1.5))),
        step: typeof value.step === "boolean" ? value.step : null,
    };
}

/** A layout from a saved view or this browser's storage, with anything missing or unreadable set to its default. */
export function readLayout(value: unknown, dataset: number): Layout {
    const found = isObject(value) ? value : {};
    const datasets = list(found.datasets)
        .filter(isObject)
        .map((ref) => ({ id: num(ref.id, NaN), shift: num(ref.shift, 0) }))
        .filter((ref) => Number.isInteger(ref.id));
    const panels = list(found.panels)
        .filter(isObject)
        .map((panel) => {
            const height = numOrNull(panel.height);
            return tidyAxes({
                id: str(panel.id) || newId(),
                title: str(panel.title),
                height: height === null || height === OLD_PANEL_HEIGHT ? null : Math.min(2400, Math.max(120, height)),
                series: list(panel.series)
                    .map((entry) => series(entry, datasets[0]?.id ?? dataset))
                    .filter((entry) => entry !== null),
                axes: axes(panel),
                notes: list(panel.notes)
                    .map(note)
                    .filter((entry) => entry !== null),
            });
        });
    const window = list(found.window);
    const [start, end] = [numOrNull(window[0]), numOrNull(window[1])];
    return {
        version: 1,
        datasets: datasets.length > 0 ? datasets : [{ id: dataset, shift: 0 }],
        panels: panels.length > 0 ? panels : [newPanel()],
        window: start !== null && end !== null && end > start ? [start, end] : null,
        t0: numOrNull(found.t0),
        markers: list(found.markers)
            .filter(isObject)
            .filter((marker) => numOrNull(marker.t) !== null)
            .map((marker) => ({ id: str(marker.id) || newId(), t: num(marker.t, 0), label: str(marker.label) })),
        masks: list(found.masks)
            .map(mask)
            .filter((entry) => entry !== null),
        events: found.events !== false,
        time: timeMode(found),
    };
}
