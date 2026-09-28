// A plot layout: the datasets it draws from, its panels (stacked plots sharing one time axis), the channels in each,
// and the time window, T0, and markers. It's plain JSON: saved views keep it as it is, and so does this browser for
// each dataset you look at.

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
    axis: Side;
    hidden: boolean;
    width: number; // line width, in pixels
    step: boolean | null; // null: steps for states, lines for numbers
}

export interface AxisSpec {
    label: string; // "": the units of its channels
    min: number | null; // null: fit what's in view
    max: number | null;
}

export interface PanelSpec {
    id: string;
    title: string;
    height: number;
    series: SeriesSpec[];
    left: AxisSpec;
    right: AxisSpec;
}

export interface Marker {
    id: string;
    t: number; // on the time axis
    label: string;
}

/** A dataset in the layout, and how far its times move along the time axis (to line up tests, say). */
export interface DatasetRef {
    id: number;
    shift: number;
}

export interface Layout {
    version: 1;
    datasets: DatasetRef[]; // the first one's times are the time axis's
    panels: PanelSpec[];
    window: [number, number] | null; // what's in view; null: everything
    t0: number | null; // where the time axis reads 0 (ignition, say)
    markers: Marker[];
    events: boolean; // show the datasets' events (a sequence's steps) as markers
    clock: boolean; // label time as time of day, for datasets that have one
}

export const PANEL_HEIGHT = 260;

let counter = 0;
export const newId = (): string =>
    `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const AUTO: AxisSpec = { label: "", min: null, max: null };

export function newPanel(): PanelSpec {
    return { id: newId(), title: "", height: PANEL_HEIGHT, series: [], left: { ...AUTO }, right: { ...AUTO } };
}

export function newLayout(dataset: number): Layout {
    return {
        version: 1,
        datasets: [{ id: dataset, shift: 0 }],
        panels: [newPanel()],
        window: null,
        t0: null,
        markers: [],
        events: true,
        clock: false,
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
          axis?: Side;
      }
    | { type: "removeSeries"; panel: string; series: string }
    | { type: "unplot"; dataset: number; channel: string; formula: number | null } // wherever it's plotted
    | { type: "changeSeries"; panel: string; series: string; change: Partial<SeriesSpec> }
    | { type: "moveSeries"; panel: string; series: string; to: string | null; axis?: Side } // null: a new panel
    | { type: "addPanel" }
    | { type: "removePanel"; panel: string }
    | { type: "movePanel"; panel: string; by: -1 | 1 }
    | { type: "changePanel"; panel: string; change: Partial<Pick<PanelSpec, "title" | "height" | "left" | "right">> }
    | { type: "window"; window: [number, number] | null }
    | { type: "t0"; t0: number | null }
    | { type: "addMarker"; t: number; label: string }
    | { type: "changeMarker"; marker: string; change: Partial<Omit<Marker, "id">> }
    | { type: "removeMarker"; marker: string }
    | { type: "addDataset"; dataset: number; shift: number }
    | { type: "removeDataset"; dataset: number }
    | { type: "shiftDataset"; dataset: number; shift: number }
    | { type: "options"; change: Partial<Pick<Layout, "events" | "clock">> }
    | { type: "replace"; layout: Layout };

const mapPanel = (layout: Layout, id: string, change: (panel: PanelSpec) => PanelSpec): Layout => ({
    ...layout,
    panels: layout.panels.map((panel) => (panel.id === id ? change(panel) : panel)),
});

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
                axis: action.axis ?? "left",
                hidden: false,
                width: 1.5,
                step: null,
            };
            const target = layout.panels.find((panel) => panel.id === action.panel);
            if (!target) {
                return { ...layout, panels: [...layout.panels, { ...newPanel(), series: [series] }] };
            }
            return mapPanel(layout, target.id, (panel) => ({ ...panel, series: [...panel.series, series] }));
        }
        case "removeSeries":
            return mapPanel(layout, action.panel, (panel) => ({
                ...panel,
                series: panel.series.filter((series) => series.id !== action.series),
            }));
        case "unplot":
            return {
                ...layout,
                panels: layout.panels.map((panel) => ({
                    ...panel,
                    series: panel.series.filter((series) => !isOf(series, action)),
                })),
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
            const moving = action.axis ? { ...found, axis: action.axis } : found;
            if (action.to === action.panel) {
                return reduce(layout, { type: "changeSeries", panel: action.panel, series: found.id, change: moving });
            }
            const without = reduce(layout, { type: "removeSeries", panel: action.panel, series: action.series });
            const target = without.panels.find((panel) => panel.id === action.to);
            if (!target) {
                return { ...without, panels: [...without.panels, { ...newPanel(), series: [moving] }] };
            }
            return mapPanel(without, target.id, (panel) => ({ ...panel, series: [...panel.series, moving] }));
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
        case "addDataset":
            if (layout.datasets.some((ref) => ref.id === action.dataset)) {
                return layout;
            }
            return { ...layout, datasets: [...layout.datasets, { id: action.dataset, shift: action.shift }] };
        case "removeDataset":
            return {
                ...layout,
                datasets: layout.datasets.filter((ref) => ref.id !== action.dataset),
                panels: layout.panels.map((panel) => ({
                    ...panel,
                    series: panel.series.filter((series) => series.dataset !== action.dataset),
                })),
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

function axis(value: unknown): AxisSpec {
    const found = isObject(value) ? value : {};
    return { label: str(found.label), min: numOrNull(found.min), max: numOrNull(found.max) };
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
        axis: value.axis === "right" ? "right" : "left",
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
        .map((panel) => ({
            id: str(panel.id) || newId(),
            title: str(panel.title),
            height: Math.min(1200, Math.max(120, num(panel.height, PANEL_HEIGHT))),
            series: list(panel.series)
                .map((entry) => series(entry, datasets[0]?.id ?? dataset))
                .filter((entry) => entry !== null),
            left: axis(panel.left),
            right: axis(panel.right),
        }));
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
        events: found.events !== false,
        clock: found.clock === true,
    };
}
