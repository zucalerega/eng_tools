import { useEffect, useState, type DragEvent, type MouseEvent } from "react";
import { yorg, type Channel, type Dataset, type DatasetDetail, type Formula } from "./api";
import { fits, dataset as loadDataset, formulas as loadFormulas } from "./data";
import { FormulaDialog } from "./Formulas";
import { isPlotted, type Action, type Layout, type PanelSpec } from "./layout";
import { formatValue } from "./scale";
import type { Resolved } from "./Workspace";
import { CHANNEL_TYPE } from "./Workspace";

// The workspace's left side: its datasets (and how each lines up in time), their channels and calculated channels to
// plot, and the markers. A channel's dot says it's plotted: clicking it again takes it off.

/** What the channel list offers to plot: a channel, or a calculated channel (formula). */
interface Pick {
    dataset: number;
    channel: string;
    formula: number | null;
}

const dragPick = (event: DragEvent, pick: Pick) => {
    event.dataTransfer.setData(CHANNEL_TYPE, JSON.stringify(pick));
    event.dataTransfer.effectAllowed = "copy";
};

/** Channels in groups by what they start with (PT, TC, LC...), when there are enough to need it. */
function groups(channels: Channel[]): [string, Channel[]][] {
    if (channels.length <= 12) {
        return [["", channels]];
    }
    const found = new Map<string, Channel[]>();
    for (const channel of channels) {
        const prefix = /^[A-Za-z]+/.exec(channel.name)?.[0].toUpperCase() ?? "";
        const group = prefix.length > 0 && prefix.length <= 6 ? prefix : "Other";
        found.set(group, [...(found.get(group) ?? []), channel]);
    }
    const singles = [...found].filter(([, list]) => list.length === 1);
    if (singles.length > 0) {
        found.set("Other", [...(found.get("Other") ?? []), ...singles.flatMap(([, list]) => list)]);
        singles.forEach(([group]) => group !== "Other" && found.delete(group));
    }
    return [...found].sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
}

function matches(channel: Channel, words: string[]): boolean {
    const text = `${channel.name} ${channel.unit}`.toLowerCase();
    return words.every((word) => text.includes(word));
}

export function Sidebar({
    layout,
    dispatch,
    activePanel,
    plotted,
    view,
    time,
}: {
    layout: Layout;
    dispatch: (action: Action) => void;
    activePanel: PanelSpec | null;
    plotted: Resolved[];
    view: [number, number];
    time: { at: (x: number) => string };
}) {
    const [filter, setFilter] = useState("");
    const [editing, setEditing] = useState<{ formula: Formula | null; detail: DatasetDetail } | null>(null);
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const several = layout.datasets.length > 1;
    // A click plots a channel on the selected plot, or takes it off if it's plotted; shift-click: a plot of its own.
    const pick = (what: Pick, newPanel: boolean) => {
        if (!newPanel && isPlotted(layout, what)) {
            dispatch({ type: "unplot", ...what });
        } else {
            dispatch({ type: "addSeries", panel: newPanel ? null : (activePanel?.id ?? null), ...what });
        }
    };
    const colors = new Map(
        plotted.map((series) => [pickKey(series.spec), series.spec.color] as const).reverse(), // the first one's color
    );
    return (
        <aside className="yorg-sidebar" aria-label="Channels">
            <input
                type="search"
                className="yorg-filter"
                placeholder="Find channels"
                aria-label="Find channels"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
            />
            {layout.datasets.map((ref, index) => {
                const loaded = loadDataset(ref.id);
                return (
                    <section key={ref.id} className="yorg-source">
                        {several && (
                            <DatasetHead
                                name={loaded.status === "ready" ? loaded.value.name : `Dataset ${ref.id}`}
                                shift={ref.shift}
                                first={index === 0}
                                onShift={(shift) => dispatch({ type: "shiftDataset", dataset: ref.id, shift })}
                                onRemove={() => dispatch({ type: "removeDataset", dataset: ref.id })}
                            />
                        )}
                        {loaded.status === "loading" && <p className="muted">Loading…</p>}
                        {loaded.status === "failed" && <p className="field-problem">{loaded.error}</p>}
                        {loaded.status === "ready" && (
                            <>
                                <ChannelList detail={loaded.value} words={words} colors={colors} onPick={pick} />
                                <Calculated
                                    detail={loaded.value}
                                    words={words}
                                    colors={colors}
                                    onPick={pick}
                                    onEdit={(formula) => setEditing({ formula, detail: loaded.value })}
                                />
                            </>
                        )}
                    </section>
                );
            })}
            <AddDataset layout={layout} dispatch={dispatch} />
            <Markers layout={layout} dispatch={dispatch} view={view} time={time} />
            {editing && (
                <FormulaDialog
                    formula={editing.formula}
                    detail={editing.detail}
                    onClose={() => setEditing(null)}
                    onSaved={(saved, created) => {
                        const detail = editing.detail;
                        setEditing(null);
                        const what = { dataset: detail.id, channel: saved.name, formula: saved.id };
                        if (created && fits(saved.expression, detail) && !isPlotted(layout, what)) {
                            pick(what, false);
                        }
                    }}
                />
            )}
        </aside>
    );
}

const pickKey = (what: Pick): string =>
    what.formula === null ? `${what.dataset}/channel/${what.channel}` : `${what.dataset}/formula/${what.formula}`;

/** A dataset's calculated channels: the team's, where this dataset has every channel they use. */
function Calculated({
    detail,
    words,
    colors,
    onPick,
    onEdit,
}: {
    detail: DatasetDetail;
    words: string[];
    colors: ReadonlyMap<string, string>;
    onPick: (what: Pick, newPanel: boolean) => void;
    onEdit: (formula: Formula | null) => void;
}) {
    const loaded = loadFormulas();
    const list = loaded.status === "ready" ? loaded.value.filter((formula) => fits(formula.expression, detail)) : [];
    const shown = list.filter((formula) =>
        words.every((word) => `${formula.name} ${formula.unit} ${formula.expression}`.toLowerCase().includes(word)),
    );
    if (words.length > 0 && shown.length === 0) {
        return null;
    }
    return (
        <details className="yorg-group yorg-calculated" open>
            <summary>
                Calculated <span className="muted">{list.length}</span>
            </summary>
            {loaded.status === "failed" && <p className="field-problem">{loaded.error}</p>}
            <ul className="yorg-channels">
                {shown.map((formula) => {
                    const what = { dataset: detail.id, channel: formula.name, formula: formula.id };
                    return (
                        <li key={formula.id} className="yorg-calculated-row">
                            <button
                                type="button"
                                className="yorg-channel"
                                draggable
                                aria-pressed={colors.has(pickKey(what))}
                                title={`${formula.name} = ${formula.expression}${formula.description ? `\n${formula.description}` : ""}`}
                                onDragStart={(event) => dragPick(event, what)}
                                onClick={(event: MouseEvent) => onPick(what, event.shiftKey)}
                            >
                                <span
                                    className="yorg-dot"
                                    style={{ background: colors.get(pickKey(what)) ?? "transparent" }}
                                    aria-hidden="true"
                                />
                                <span className="yorg-channel-name">{formula.name}</span>
                                <span className="yorg-channel-unit">{formula.unit}</span>
                            </button>
                            <button
                                type="button"
                                className="yorg-edit"
                                aria-label={`${formula.can_change ? "Change" : "About"} ${formula.name}`}
                                title={formula.can_change ? "Change it" : "What it is"}
                                onClick={() => onEdit(formula)}
                            >
                                {formula.can_change ? "✎" : "i"}
                            </button>
                        </li>
                    );
                })}
            </ul>
            <button type="button" className="button-small yorg-new-calculated" onClick={() => onEdit(null)}>
                New calculated channel
            </button>
        </details>
    );
}

function DatasetHead({
    name,
    shift,
    first,
    onShift,
    onRemove,
}: {
    name: string;
    shift: number;
    first: boolean;
    onShift: (shift: number) => void;
    onRemove: () => void;
}) {
    return (
        <div className="yorg-source-head">
            <strong>{name}</strong>
            {!first && (
                <>
                    <label className="yorg-shift" title="Move this dataset along the time axis, to line it up">
                        Shift
                        <input
                            type="number"
                            step="any"
                            aria-label={`${name}: shift in time (s)`}
                            key={shift}
                            defaultValue={Number(shift.toPrecision(10))}
                            onBlur={(event) => {
                                const value = Number(event.target.value);
                                if (Number.isFinite(value)) {
                                    onShift(value);
                                }
                            }}
                            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                        />
                        s
                    </label>
                    <button type="button" className="button-small" aria-label={`Remove ${name}`} onClick={onRemove}>
                        ×
                    </button>
                </>
            )}
        </div>
    );
}

function ChannelList({
    detail,
    words,
    colors,
    onPick,
}: {
    detail: DatasetDetail;
    words: string[];
    colors: ReadonlyMap<string, string>;
    onPick: (what: Pick, newPanel: boolean) => void;
}) {
    const [closed, setClosed] = useState<Set<string>>(new Set());
    const shown = detail.channels.filter((channel) => matches(channel, words));
    if (detail.channels.length === 0) {
        return <p className="muted">{detail.status === "failed" ? detail.error : "This dataset has no channels."}</p>;
    }
    if (shown.length === 0) {
        return <p className="muted">No channels match.</p>;
    }
    return (
        <>
            {groups(shown).map(([group, channels]) => {
                const open = words.length > 0 || !closed.has(group);
                const list = (
                    <ul className="yorg-channels">
                        {channels.map((channel) => {
                            const what = { dataset: detail.id, channel: channel.name, formula: null };
                            const color = colors.get(pickKey(what));
                            return (
                                <li key={channel.name}>
                                    <button
                                        type="button"
                                        className="yorg-channel"
                                        draggable
                                        aria-pressed={color !== undefined}
                                        title={`${channel.name}${channel.unit ? ` (${channel.unit})` : ""}: ${channel.count.toLocaleString()} samples${
                                            channel.min !== null && channel.max !== null
                                                ? `, ${formatValue(channel.min)} to ${formatValue(channel.max)}`
                                                : ""
                                        }. ${color ? "Click to take it off the plots" : "Click to plot it"}; shift-click for a plot of its own.`}
                                        onDragStart={(event) => dragPick(event, what)}
                                        onClick={(event: MouseEvent) => onPick(what, event.shiftKey)}
                                    >
                                        <span
                                            className="yorg-dot"
                                            style={{ background: color ?? "transparent" }}
                                            aria-hidden="true"
                                        />
                                        <span className="yorg-channel-name">{channel.name}</span>
                                        <span className="yorg-channel-unit">
                                            {channel.kind === "state" ? "state" : channel.unit}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                );
                if (!group) {
                    return <div key="all">{list}</div>;
                }
                return (
                    <details
                        key={group}
                        className="yorg-group"
                        open={open}
                        onToggle={(event) => {
                            const isOpen = (event.target as HTMLDetailsElement).open;
                            if (words.length === 0 && isOpen === closed.has(group)) {
                                const next = new Set(closed);
                                if (isOpen) {
                                    next.delete(group);
                                } else {
                                    next.add(group);
                                }
                                setClosed(next);
                            }
                        }}
                    >
                        <summary>
                            {group} <span className="muted">{channels.length}</span>
                        </summary>
                        {list}
                    </details>
                );
            })}
        </>
    );
}

/** Plot another dataset alongside: lined up by clock time if both have dates, else from their starts. */
function AddDataset({ layout, dispatch }: { layout: Layout; dispatch: (action: Action) => void }) {
    const [choices, setChoices] = useState<Dataset[] | null>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (open && choices === null) {
            yorg.datasets().then(setChoices, () => setChoices([]));
        }
    }, [open, choices]);
    const first = layout.datasets[0] ? loadDataset(layout.datasets[0].id) : null;
    const add = (id: number) => {
        const chosen = choices?.find((one) => one.id === id);
        const base = first?.status === "ready" ? first.value : null;
        const lined =
            chosen?.time_kind === "absolute" &&
            base?.time_kind === "absolute" &&
            chosen.start_epoch !== null &&
            base.start_epoch !== null
                ? chosen.start_epoch - base.start_epoch
                : 0;
        dispatch({ type: "addDataset", dataset: id, shift: lined });
        setOpen(false);
    };
    if (!open) {
        return (
            <button type="button" className="button-small yorg-compare" onClick={() => setOpen(true)}>
                Compare with another dataset
            </button>
        );
    }
    const others = (choices ?? []).filter(
        (one) => one.status === "ready" && !layout.datasets.some((ref) => ref.id === one.id),
    );
    return (
        <label className="field yorg-compare">
            Compare with
            <select
                autoFocus
                value=""
                onChange={(event) => add(Number(event.target.value))}
                onBlur={() => setOpen(false)}
            >
                <option value="" disabled>
                    {choices === null ? "Loading…" : others.length ? "Choose a dataset" : "No other datasets"}
                </option>
                {others.map((one) => (
                    <option key={one.id} value={one.id}>
                        {one.name}
                    </option>
                ))}
            </select>
        </label>
    );
}

function Markers({
    layout,
    dispatch,
    view,
    time,
}: {
    layout: Layout;
    dispatch: (action: Action) => void;
    view: [number, number];
    time: { at: (x: number) => string };
}) {
    if (layout.markers.length === 0 && layout.t0 === null) {
        return null;
    }
    const goTo = (x: number) => {
        const half = (view[1] - view[0]) / 2;
        dispatch({ type: "window", window: [x - half, x + half] });
    };
    return (
        <section className="yorg-markers" aria-label="Markers">
            <h2>Markers</h2>
            <ul>
                {layout.t0 !== null && (
                    <li>
                        <button type="button" className="yorg-marker-time" onClick={() => goTo(layout.t0!)}>
                            T0
                        </button>
                        <input
                            type="number"
                            step="any"
                            aria-label="T0: time in the file (s)"
                            title="Where time reads 0, in the first dataset's own time"
                            key={layout.t0}
                            defaultValue={Number(layout.t0.toPrecision(10))}
                            onBlur={(event) => {
                                const value = Number(event.target.value);
                                if (event.target.value.trim() !== "" && Number.isFinite(value)) {
                                    dispatch({ type: "t0", t0: value });
                                }
                            }}
                            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                        />
                        <button
                            type="button"
                            className="button-small"
                            aria-label="Clear T0"
                            onClick={() => dispatch({ type: "t0", t0: null })}
                        >
                            ×
                        </button>
                    </li>
                )}
                {layout.markers.map((marker) => (
                    <li key={marker.id}>
                        <button
                            type="button"
                            className="yorg-marker-time"
                            title="Go to it"
                            onClick={() => goTo(marker.t)}
                        >
                            {time.at(marker.t)}
                        </button>
                        <input
                            aria-label={`Marker at ${time.at(marker.t)}: label`}
                            defaultValue={marker.label}
                            onBlur={(event) =>
                                dispatch({
                                    type: "changeMarker",
                                    marker: marker.id,
                                    change: { label: event.target.value },
                                })
                            }
                            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                        />
                        <button
                            type="button"
                            className="button-small"
                            aria-label={`Remove the marker ${marker.label}`}
                            onClick={() => dispatch({ type: "removeMarker", marker: marker.id })}
                        >
                            ×
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
