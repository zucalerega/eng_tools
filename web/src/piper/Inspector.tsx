import { useState } from "react";
import type { Palette } from "./colors";
import type { Commands } from "./commands";
import { LINE_STYLES } from "./DiagramView";
import { LINE_KINDS, type Drawing, type Fluid, type Line, type Part } from "./drawing";
import { carryFluid, rerouteLines, sharedTags, updateLine, updatePart, type Alignment } from "./edit";
import { FluidSelect, Row, ShowToggle, StatePicker } from "./fields";
import { fluidOf, fluidsOf, fluidsUsed, newFluidId, STANDARD_FLUIDS, withFluid } from "./fluids";
import { PartIcon } from "./icons";
import { LINE_FIELDS } from "./labels";
import { CATEGORIES, kindOf, PRESETS, titleOf } from "./library/index";
import type { Field } from "./library/kinds";
import { channelName, findChannel, formatValue, outline, valueAt, type Samples } from "./testdata";
import { useEditor, type EditorStore } from "./store";
import type { TestReading } from "./useTest";

// The inspector, beside the drawing: what's selected, to name and describe (a part's tag and properties, a line's
// fluid and size), or, with nothing selected, the diagram's fluids and colors.

interface Props {
    store: EditorStore;
    commands: Commands;
    palette: Palette;
    test: TestReading | null;
    onPlot: (channels: string[]) => void;
}

export function Inspector({ store, commands, palette, test, onPlot }: Props) {
    const { drawing, selection } = useEditor(store, (state) => state);
    const parts = drawing.parts.filter((part) => selection.includes(part.id));
    const lines = drawing.lines.filter((line) => selection.includes(line.id));
    let body;
    if (parts.length === 0 && lines.length === 0) {
        body = <DiagramPanel store={store} drawing={drawing} palette={palette} />;
    } else if (parts.length === 1 && lines.length === 0) {
        body = (
            <PartPanel
                key={parts[0]!.id}
                store={store}
                commands={commands}
                part={parts[0]!}
                drawing={drawing}
                palette={palette}
                test={test}
                onPlot={onPlot}
            />
        );
    } else if (lines.length === 1 && parts.length === 0) {
        body = <LinePanel key={lines[0]!.id} store={store} commands={commands} line={lines[0]!} drawing={drawing} />;
    } else {
        body = (
            <ManyPanel
                store={store}
                commands={commands}
                parts={parts}
                lines={lines}
                drawing={drawing}
                palette={palette}
            />
        );
    }
    return (
        <aside className="piper-inspector" aria-label="Inspector">
            {test && (
                <datalist id="piper-channels">
                    {test.detail.channels.map((channel) => (
                        <option key={channel.name} value={channel.name} />
                    ))}
                </datalist>
            )}
            {body}
        </aside>
    );
}

/** A property field's input: text, a choice, a fluid, a channel, or notes. */
function FieldInput({
    id,
    field,
    value,
    drawing,
    part,
    test,
    onChange,
}: {
    id: string;
    field: Field;
    value: string;
    drawing: Drawing;
    part?: Part;
    test?: TestReading | null;
    onChange: (value: string) => void;
}) {
    switch (field.type) {
        case "select":
            return (
                <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
                    {!field.options?.some((option) => option.value === value) && <option value={value}>{value}</option>}
                    {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            );
        case "fluid":
            return <FluidSelect id={id} drawing={drawing} value={value} onChange={onChange} none="Nothing" />;
        case "long":
            return <textarea id={id} value={value} rows={3} onChange={(event) => onChange(event.target.value)} />;
        case "channel":
            return (
                <input
                    id={id}
                    value={value}
                    list={test ? "piper-channels" : undefined}
                    placeholder={part?.tag ? `${part.tag} (its tag)` : "A test's channel"}
                    onChange={(event) => onChange(event.target.value)}
                />
            );
        default:
            return (
                <input
                    id={id}
                    value={value}
                    placeholder={field.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                />
            );
    }
}

/** A field of the team's own, added to a part or a line: named as they like. */
function AddField({ taken, onAdd }: { taken: string[]; onAdd: (name: string) => void }) {
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const clean = name.trim();
    const exists = taken.some((key) => key.toLowerCase() === clean.toLowerCase());
    if (!adding) {
        return (
            <button type="button" className="button-small piper-add-field" onClick={() => setAdding(true)}>
                + Add a field
            </button>
        );
    }
    return (
        <form
            className="piper-add-form"
            onSubmit={(event) => {
                event.preventDefault();
                if (clean && !exists) {
                    onAdd(clean);
                    setName("");
                    setAdding(false);
                }
            }}
        >
            <input
                autoFocus
                aria-label="New field's name"
                placeholder="Part number, torque…"
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        setAdding(false);
                    }
                }}
            />
            <button type="submit" className="button-small" disabled={!clean || exists}>
                Add
            </button>
        </form>
    );
}

const showable = (field: Field) => field.type !== "long" && field.type !== "channel";

function PartPanel({
    store,
    commands,
    part,
    drawing,
    palette,
    test,
    onPlot,
}: {
    store: EditorStore;
    commands: Commands;
    part: Part;
    drawing: Drawing;
    palette: Palette;
    test: TestReading | null;
    onPlot: (channels: string[]) => void;
}) {
    const kind = kindOf(part.kind);
    const shared = sharedTags(drawing).has(part.tag.trim().toUpperCase());
    const change = (key: string, update: (part: Part) => Part) =>
        store.commit(updatePart(store.getState().drawing, part.id, update), undefined, `${part.id}:${key}`);
    const setProp = (key: string, value: string) =>
        change(key, (now) => ({ ...now, props: { ...now.props, [key]: value } }));
    const toggleShown = (key: string) =>
        change("shown", (now) => ({
            ...now,
            shown: now.shown.includes(key) ? now.shown.filter((entry) => entry !== key) : [...now.shown, key],
        }));
    const custom = Object.keys(part.props).filter((key) => !kind.fields.some((field) => field.key === key));
    const category = CATEGORIES.find(
        (entry) => entry.id === PRESETS.find((preset) => preset.kind === part.kind)?.category,
    );
    const turns = !["region", "legend", "titleblock"].includes(part.kind);
    return (
        <>
            <header className="piper-inspector-head">
                <PartIcon part={part} palette={palette} size={38} />
                <div>
                    <h2>{titleOf(part)}</h2>
                    {category && <p className="muted">{category.name}</p>}
                </div>
            </header>
            {kind.tag !== "none" && (
                <Row label="Tag">
                    {(id) => (
                        <input
                            id={id}
                            data-piper-field="tag"
                            value={part.tag}
                            placeholder="PT-101"
                            maxLength={100}
                            onChange={(event) => change("tag", (now) => ({ ...now, tag: event.target.value }))}
                        />
                    )}
                </Row>
            )}
            {shared && <p className="piper-warning">Another part is tagged {part.tag} too.</p>}
            {kind.text && (
                <Row label={kind.text}>
                    {(id) => (
                        <textarea
                            id={id}
                            data-piper-field="text"
                            value={part.text}
                            rows={part.kind === "text" ? 3 : 1}
                            onChange={(event) => change("text", (now) => ({ ...now, text: event.target.value }))}
                        />
                    )}
                </Row>
            )}
            {kind.fields.map((field) =>
                field.key === "normal" ? (
                    <Row
                        key={field.key}
                        label={field.label}
                        after={
                            <ShowToggle
                                label={field.label}
                                on={part.shown.includes(field.key)}
                                onToggle={() => toggleShown(field.key)}
                            />
                        }
                    >
                        {() => (
                            <StatePicker
                                value={part.props.normal ?? ""}
                                palette={palette}
                                onChange={(value) => setProp("normal", value)}
                            />
                        )}
                    </Row>
                ) : (
                    <Row
                        key={field.key}
                        label={field.label}
                        after={
                            showable(field) && (
                                <ShowToggle
                                    label={field.label}
                                    on={part.shown.includes(field.key)}
                                    onToggle={() => toggleShown(field.key)}
                                />
                            )
                        }
                    >
                        {(id) => (
                            <FieldInput
                                id={id}
                                field={field}
                                value={part.props[field.key] ?? ""}
                                drawing={drawing}
                                part={part}
                                test={test}
                                onChange={(value) => setProp(field.key, value)}
                            />
                        )}
                    </Row>
                ),
            )}
            {custom.map((key) => (
                <Row
                    key={key}
                    label={key}
                    after={
                        <>
                            <ShowToggle label={key} on={part.shown.includes(key)} onToggle={() => toggleShown(key)} />
                            <button
                                type="button"
                                className="piper-remove"
                                aria-label={`Remove ${key}`}
                                title={`Remove ${key}`}
                                onClick={() =>
                                    change(key, (now) => {
                                        const props = { ...now.props };
                                        delete props[key];
                                        return { ...now, props, shown: now.shown.filter((entry) => entry !== key) };
                                    })
                                }
                            >
                                ×
                            </button>
                        </>
                    }
                >
                    {(id) => (
                        <input
                            id={id}
                            value={part.props[key] ?? ""}
                            onChange={(event) => setProp(key, event.target.value)}
                        />
                    )}
                </Row>
            ))}
            {kind.tag !== "none" || kind.fields.length > 0 ? (
                <AddField
                    taken={[...kind.fields.map((field) => field.key), ...Object.keys(part.props)]}
                    onAdd={(name) => setProp(name, "")}
                />
            ) : null}
            {kind.reads && test && <Reading part={part} test={test} palette={palette} onPlot={onPlot} />}
            <div className="piper-inspector-actions">
                {turns && (
                    <button type="button" className="button-small" onClick={() => commands.turn(true)} title="R">
                        Turn
                    </button>
                )}
                {turns && (
                    <button type="button" className="button-small" onClick={() => commands.flip()} title="F">
                        Flip
                    </button>
                )}
                <button type="button" className="button-small button-danger" onClick={() => commands.remove()}>
                    Delete
                </button>
            </div>
        </>
    );
}

/** What a test says of a part: its channel, its value at the time shown, and a line of it over the whole test. */
function Reading({
    part,
    test,
    palette,
    onPlot,
}: {
    part: Part;
    test: TestReading;
    palette: Palette;
    onPlot: (channels: string[]) => void;
}) {
    const name = channelName(part);
    const channel = findChannel(test.detail, name);
    if (!channel) {
        return (
            <div className="piper-reading">
                <p className="muted">
                    {name
                        ? `${test.detail.name} has no channel ${name}: name the one this reads in Test channel.`
                        : "Tag it, or name its channel in Test channel, to read it from the test."}
                </p>
            </div>
        );
    }
    const samples = test.samples.get(channel.name);
    const value = samples ? valueAt(samples, test.time) : null;
    return (
        <div className="piper-reading">
            <p>
                <strong>{channel.name}</strong> in {test.detail.name}:{" "}
                <span className="piper-reading-value">
                    {samples ? (value === null ? "no sample yet" : formatValue(channel, value)) : "loading…"}
                </span>
            </p>
            {samples && test.detail.t_min !== null && test.detail.t_max !== null && (
                <Sparkline
                    samples={samples}
                    from={test.detail.t_min}
                    to={test.detail.t_max}
                    time={test.time}
                    palette={palette}
                />
            )}
            <button type="button" className="button-small" onClick={() => onPlot([channel.name])}>
                Plot in Yorg
            </button>
        </div>
    );
}

/** A channel over the whole test, with where the time shown is. */
function Sparkline({
    samples,
    from,
    to,
    time,
    palette,
}: {
    samples: Samples;
    from: number;
    to: number;
    time: number;
    palette: Palette;
}) {
    const width = 230;
    const height = 46;
    const columns = outline(samples, from, to, width);
    if (columns.length === 0) {
        return null;
    }
    const lo = Math.min(...columns.map((column) => column.lo));
    const hi = Math.max(...columns.map((column) => column.hi));
    const y = (value: number) => (hi === lo ? height / 2 : height - 3 - ((value - lo) / (hi - lo)) * (height - 6));
    const x = (t: number) => ((t - from) / (to - from)) * width;
    const d = columns.map(
        (column, index) => `${index === 0 ? "M" : "L"}${x(column.t)} ${y(column.hi)} L${x(column.t)} ${y(column.lo)}`,
    );
    return (
        <svg
            className="piper-sparkline"
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            aria-hidden="true"
        >
            <path d={d.join(" ")} fill="none" stroke={palette.select} strokeWidth={1.2} />
            <line x1={x(time)} x2={x(time)} y1={0} y2={height} stroke={palette.guide} strokeWidth={1.5} />
        </svg>
    );
}

function LinePanel({
    store,
    commands,
    line,
    drawing,
}: {
    store: EditorStore;
    commands: Commands;
    line: Line;
    drawing: Drawing;
}) {
    const change = (key: string, update: (line: Line) => Line) =>
        store.commit(updateLine(store.getState().drawing, line.id, update), undefined, `${line.id}:${key}`);
    const setProp = (key: string, value: string) =>
        change(key, (now) => ({ ...now, props: { ...now.props, [key]: value } }));
    const toggleShown = (key: string) =>
        change("shown", (now) => ({
            ...now,
            shown: now.shown.includes(key) ? now.shown.filter((entry) => entry !== key) : [...now.shown, key],
        }));
    const fluid = fluidOf(drawing, line.fluid);
    const style = LINE_STYLES[line.kind];
    const custom = Object.keys(line.props).filter((key) => !LINE_FIELDS.some((field) => field.key === key));
    return (
        <>
            <header className="piper-inspector-head">
                <svg width={38} height={38} viewBox="0 0 38 38" aria-hidden="true">
                    <path
                        d="M3 30 H19 V8 H35"
                        fill="none"
                        stroke={fluid?.color ?? "currentColor"}
                        strokeWidth={style.width + 0.5}
                        strokeDasharray={style.dash}
                    />
                </svg>
                <div>
                    <h2>{LINE_KINDS.find((entry) => entry.value === line.kind)?.label ?? "Line"}</h2>
                    <p className="muted">{fluid ? fluid.name : "No fluid"}</p>
                </div>
            </header>
            <Row
                label="Tag"
                after={
                    <ShowToggle label="its tag" on={line.shown.includes("tag")} onToggle={() => toggleShown("tag")} />
                }
            >
                {(id) => (
                    <input
                        id={id}
                        data-piper-field="tag"
                        value={line.tag}
                        placeholder="L-101"
                        maxLength={100}
                        onChange={(event) => change("tag", (now) => ({ ...now, tag: event.target.value }))}
                    />
                )}
            </Row>
            <Row
                label="Fluid"
                after={
                    <ShowToggle
                        label="its fluid"
                        on={line.shown.includes("fluid")}
                        onToggle={() => toggleShown("fluid")}
                    />
                }
            >
                {(id) => (
                    <FluidSelect
                        id={id}
                        drawing={drawing}
                        value={line.fluid}
                        onChange={(value) => change("fluid", (now) => ({ ...now, fluid: value }))}
                    />
                )}
            </Row>
            <button
                type="button"
                className="button-small piper-carry"
                title="This line's fluid, on every line it flows on to through valves, fittings, and instruments"
                onClick={() => store.commit(carryFluid(store.getState().drawing, line.id, line.fluid))}
            >
                Carry {fluid ? fluid.label || fluid.name : "no fluid"} along its run
            </button>
            <Row label="Type">
                {(id) => (
                    <select
                        id={id}
                        value={line.kind}
                        onChange={(event) =>
                            change("kind", (now) => ({ ...now, kind: event.target.value as Line["kind"] }))
                        }
                    >
                        {LINE_KINDS.map((entry) => (
                            <option key={entry.value} value={entry.value}>
                                {entry.label}
                            </option>
                        ))}
                    </select>
                )}
            </Row>
            <Row label="Flow arrows">
                {(id) => (
                    <select
                        id={id}
                        value={line.arrow}
                        onChange={(event) =>
                            change("arrow", (now) => ({ ...now, arrow: event.target.value as Line["arrow"] }))
                        }
                    >
                        <option value="none">None</option>
                        <option value="forward">From where it starts</option>
                        <option value="backward">Toward where it starts</option>
                    </select>
                )}
            </Row>
            {LINE_FIELDS.map((field) => (
                <Row
                    key={field.key}
                    label={field.label}
                    after={
                        showable(field) && (
                            <ShowToggle
                                label={field.label}
                                on={line.shown.includes(field.key)}
                                onToggle={() => toggleShown(field.key)}
                            />
                        )
                    }
                >
                    {(id) => (
                        <FieldInput
                            id={id}
                            field={field}
                            value={line.props[field.key] ?? ""}
                            drawing={drawing}
                            onChange={(value) => setProp(field.key, value)}
                        />
                    )}
                </Row>
            ))}
            {custom.map((key) => (
                <Row
                    key={key}
                    label={key}
                    after={<ShowToggle label={key} on={line.shown.includes(key)} onToggle={() => toggleShown(key)} />}
                >
                    {(id) => (
                        <input
                            id={id}
                            value={line.props[key] ?? ""}
                            onChange={(event) => setProp(key, event.target.value)}
                        />
                    )}
                </Row>
            ))}
            <AddField
                taken={[...LINE_FIELDS.map((field) => field.key), ...Object.keys(line.props)]}
                onAdd={(name) => setProp(name, "")}
            />
            <p className="piper-route muted">
                {line.auto
                    ? "Routed for itself: moving its parts routes it again."
                    : "Routed by hand: it keeps its bends."}
            </p>
            <div className="piper-inspector-actions">
                {!line.auto && (
                    <button
                        type="button"
                        className="button-small"
                        onClick={() => store.commit(rerouteLines(store.getState().drawing, new Set([line.id])))}
                    >
                        Route automatically
                    </button>
                )}
                <button type="button" className="button-small button-danger" onClick={() => commands.remove()}>
                    Delete
                </button>
            </div>
        </>
    );
}

const ALIGNMENTS: [Alignment, string][] = [
    ["left", "Left"],
    ["center", "Center"],
    ["right", "Right"],
    ["top", "Top"],
    ["middle", "Middle"],
    ["bottom", "Bottom"],
    ["across", "Space across"],
    ["down", "Space down"],
];

function ManyPanel({
    store,
    commands,
    parts,
    lines,
    drawing,
    palette,
}: {
    store: EditorStore;
    commands: Commands;
    parts: Part[];
    lines: Line[];
    drawing: Drawing;
    palette: Palette;
}) {
    const ids = new Set(lines.map((line) => line.id));
    const fluids = new Set(lines.map((line) => line.fluid));
    const kinds = new Set(lines.map((line) => line.kind));
    const valves = parts.filter((part) => kindOf(part.kind).state);
    const states = new Set(valves.map((part) => part.props.normal ?? ""));
    const setLines = (update: (line: Line) => Line) =>
        store.commit({ ...drawing, lines: drawing.lines.map((line) => (ids.has(line.id) ? update(line) : line)) });
    const counted = [
        parts.length === 1 ? "1 part" : `${parts.length} parts`,
        lines.length === 1 ? "1 line" : `${lines.length} lines`,
    ]
        .filter((text) => !text.startsWith("0 "))
        .join(", ");
    return (
        <>
            <header className="piper-inspector-head">
                <div>
                    <h2>{counted}</h2>
                    <p className="muted">What's set here is set on all of them.</p>
                </div>
            </header>
            {lines.length > 0 && (
                <>
                    <Row label="Fluid">
                        {(id) => (
                            <FluidSelect
                                id={id}
                                drawing={drawing}
                                value={fluids.size === 1 ? [...fluids][0]! : ""}
                                none={fluids.size > 1 ? "Several" : "None"}
                                onChange={(value) => setLines((line) => ({ ...line, fluid: value }))}
                            />
                        )}
                    </Row>
                    <Row label="Type">
                        {(id) => (
                            <select
                                id={id}
                                value={kinds.size === 1 ? [...kinds][0] : ""}
                                onChange={(event) =>
                                    setLines((line) => ({ ...line, kind: event.target.value as Line["kind"] }))
                                }
                            >
                                {kinds.size > 1 && <option value="">Several</option>}
                                {LINE_KINDS.map((entry) => (
                                    <option key={entry.value} value={entry.value}>
                                        {entry.label}
                                    </option>
                                ))}
                            </select>
                        )}
                    </Row>
                </>
            )}
            {valves.length > 0 && (
                <Row label={`Normal state (${valves.length} ${valves.length === 1 ? "valve" : "valves"})`}>
                    {() => (
                        <StatePicker
                            value={states.size === 1 ? [...states][0]! : "several"}
                            palette={palette}
                            onChange={(value) => {
                                const chosen = new Set(valves.map((part) => part.id));
                                store.commit({
                                    ...drawing,
                                    parts: drawing.parts.map((part) =>
                                        chosen.has(part.id)
                                            ? { ...part, props: { ...part.props, normal: value } }
                                            : part,
                                    ),
                                });
                            }}
                        />
                    )}
                </Row>
            )}
            {parts.length >= 2 && (
                <div className="piper-align" role="group" aria-label="Line up">
                    <p className="piper-row-label">Line up</p>
                    <div className="piper-align-buttons">
                        {ALIGNMENTS.filter(([how]) => parts.length >= 3 || (how !== "across" && how !== "down")).map(
                            ([how, label]) => (
                                <button
                                    key={how}
                                    type="button"
                                    className="button-small"
                                    onClick={() => commands.align(how)}
                                >
                                    {label}
                                </button>
                            ),
                        )}
                    </div>
                </div>
            )}
            <div className="piper-inspector-actions">
                {parts.length > 0 && (
                    <>
                        <button type="button" className="button-small" onClick={() => commands.turn(true)}>
                            Turn
                        </button>
                        <button type="button" className="button-small" onClick={() => commands.flip()}>
                            Flip
                        </button>
                    </>
                )}
                <button type="button" className="button-small" onClick={() => commands.duplicate()}>
                    Duplicate
                </button>
                <button type="button" className="button-small button-danger" onClick={() => commands.remove()}>
                    Delete
                </button>
            </div>
        </>
    );
}

function DiagramPanel({ store, drawing, palette }: { store: EditorStore; drawing: Drawing; palette: Palette }) {
    const [editing, setEditing] = useState(false);
    const used = fluidsUsed(drawing);
    const valves = drawing.parts.filter((part) => kindOf(part.kind).state).length;
    const setFluid = (fluid: Fluid, key: string) =>
        store.commit({ ...drawing, fluids: withFluid(drawing, fluid) }, undefined, `fluid:${fluid.id}:${key}`);
    const setStyle = (key: "no" | "nc", value: string) =>
        store.commit({ ...drawing, style: { ...drawing.style, [key]: value } }, undefined, `style:${key}`);
    const standard = new Set(STANDARD_FLUIDS.map((fluid) => fluid.id));
    return (
        <>
            <header className="piper-inspector-head">
                <div>
                    <h2>This diagram</h2>
                    <p className="muted">
                        {drawing.parts.length} parts, {drawing.lines.length} lines. Select something to name it and say
                        what it is.
                    </p>
                </div>
            </header>
            <h3 className="piper-subhead">Fluids</h3>
            {used.length === 0 ? (
                <p className="muted piper-small">Lines show their fluids here once they carry some.</p>
            ) : (
                <ul className="piper-fluids">
                    {used.map((fluid) => (
                        <li key={fluid.id}>
                            <span className="piper-swatch" style={{ background: fluid.color }} />
                            <strong>{fluid.label}</strong> <span className="muted">{fluid.name}</span>
                        </li>
                    ))}
                </ul>
            )}
            <button type="button" className="button-small" aria-expanded={editing} onClick={() => setEditing(!editing)}>
                {editing ? "Done with fluids" : "Change fluids…"}
            </button>
            {editing && (
                <div className="piper-fluid-editor">
                    {fluidsOf(drawing).map((fluid) => (
                        <div key={fluid.id} className="piper-fluid-row">
                            <input
                                type="color"
                                aria-label={`${fluid.name}'s color`}
                                value={fluid.color}
                                onChange={(event) => setFluid({ ...fluid, color: event.target.value }, "color")}
                            />
                            <input
                                aria-label={`${fluid.name}'s label`}
                                className="piper-fluid-label"
                                value={fluid.label}
                                maxLength={12}
                                onChange={(event) => setFluid({ ...fluid, label: event.target.value }, "label")}
                            />
                            <input
                                aria-label={`${fluid.name}'s name`}
                                value={fluid.name}
                                maxLength={60}
                                onChange={(event) => setFluid({ ...fluid, name: event.target.value }, "name")}
                            />
                            {!standard.has(fluid.id) && !used.some((entry) => entry.id === fluid.id) && (
                                <button
                                    type="button"
                                    className="piper-remove"
                                    aria-label={`Remove ${fluid.name}`}
                                    onClick={() =>
                                        store.commit({
                                            ...drawing,
                                            fluids: drawing.fluids.filter((entry) => entry.id !== fluid.id),
                                        })
                                    }
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    ))}
                    <button
                        type="button"
                        className="button-small"
                        onClick={() =>
                            store.commit({
                                ...drawing,
                                fluids: [
                                    ...drawing.fluids,
                                    {
                                        id: newFluidId(drawing, "fluid"),
                                        name: "New fluid",
                                        label: "NEW",
                                        color: "#8c6d4e",
                                    },
                                ],
                            })
                        }
                    >
                        + Add a fluid
                    </button>
                </div>
            )}
            <h3 className="piper-subhead">Valve colors</h3>
            <div className="piper-state-colors">
                <label className="check">
                    <input type="color" value={palette.no} onChange={(event) => setStyle("no", event.target.value)} />
                    Normally open
                </label>
                <label className="check">
                    <input type="color" value={palette.nc} onChange={(event) => setStyle("nc", event.target.value)} />
                    Normally closed
                </label>
                {(drawing.style.no || drawing.style.nc) && (
                    <button
                        type="button"
                        className="button-small"
                        onClick={() => store.commit({ ...drawing, style: { no: "", nc: "" } })}
                    >
                        Standard colors
                    </button>
                )}
            </div>
            {valves === 0 && (
                <p className="muted piper-small">Valves are drawn in these colors by their normal states.</p>
            )}
        </>
    );
}
