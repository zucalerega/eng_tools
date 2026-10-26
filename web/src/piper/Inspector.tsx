import { useMemo, useRef, useState } from "react";
import type { Palette } from "./colors";
import type { Commands } from "./commands";
import { LINE_STYLES, scalable } from "./DiagramView";
import {
    LINE_KINDS,
    PART_SCALES,
    type Drawing,
    type Fluid,
    type LabelSize,
    type Line,
    type Page,
    type Part,
} from "./drawing";
import {
    carryFluid,
    drawingBox,
    rerouteLines,
    sharedTags,
    updateLine,
    updatePart,
    withPicture,
    type Alignment,
} from "./edit";
import { fitSheet, PAPERS } from "./pdf";
import { FluidSelect, Row, ShowToggle, StatePicker } from "./fields";
import {
    applyScheme,
    fluidOf,
    fluidsOf,
    fluidsUsed,
    isGas,
    newFluidId,
    schemeChanged,
    STANDARD_FLUIDS,
    withFluid,
} from "./fluids";
import { piper, type Scheme } from "./api";
import { Link } from "../router";
import { PartIcon } from "./icons";
import { LABEL_SIZES, LINE_FIELDS } from "./labels";
import { CATEGORIES, kindOf, PRESETS, titleOf } from "./library/index";
import { pictureAspect } from "./library/notes";
import type { Field } from "./library/kinds";
import { channelName, findChannel, formatValue, outline, valueAt, type Samples } from "./testdata";
import { useEditor, type EditorStore } from "./store";
import type { TestReading } from "./useTest";
import { DiagramSimSection, LineSimSection, PartSimSection, type SimContext } from "./sim/SimSection";

// The inspector, beside the drawing: what's selected, to name and describe (a part's tag and properties, a line's
// fluid and size), or, with nothing selected, the diagram's fluids and colors. In Simulation mode, what it is in the
// model comes first.

interface Props {
    store: EditorStore;
    commands: Commands;
    palette: Palette;
    test: TestReading | null;
    onPlot: (channels: string[]) => void;
    schemes: Scheme[] | null; // the team's color schemes, for the diagram to take one's colors
    sim: SimContext | null; // in Simulation mode, the model the P&ID is
}

export function Inspector({ store, commands, palette, test, onPlot, schemes, sim }: Props) {
    const { drawing, selection, readOnly } = useEditor(store, (state) => state);
    const parts = drawing.parts.filter((part) => selection.includes(part.id));
    const lines = drawing.lines.filter((line) => selection.includes(line.id));
    // Only looked at: everything's shown as it is, to read, not change; a part's test reading can still be plotted.
    const reading = readOnly && parts.length === 1 && lines.length === 0 && kindOf(parts[0]!.kind).reads ? test : null;
    let body;
    if (parts.length === 0 && lines.length === 0) {
        body = <DiagramPanel store={store} drawing={drawing} palette={palette} schemes={schemes} sim={sim} />;
    } else if (parts.length === 1 && lines.length === 0) {
        body = (
            <PartPanel
                key={parts[0]!.id}
                store={store}
                commands={commands}
                part={parts[0]!}
                drawing={drawing}
                palette={palette}
                test={readOnly ? null : test}
                onPlot={onPlot}
                sim={sim}
            />
        );
    } else if (lines.length === 1 && parts.length === 0) {
        body = (
            <LinePanel
                key={lines[0]!.id}
                store={store}
                commands={commands}
                line={lines[0]!}
                drawing={drawing}
                sim={sim}
            />
        );
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
            <fieldset className="piper-fieldset" disabled={readOnly}>
                {body}
            </fieldset>
            {reading && <Reading part={parts[0]!} test={reading} palette={palette} onPlot={onPlot} />}
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
    sim,
}: {
    store: EditorStore;
    commands: Commands;
    part: Part;
    drawing: Drawing;
    palette: Palette;
    test: TestReading | null;
    onPlot: (channels: string[]) => void;
    sim: SimContext | null;
}) {
    const kind = kindOf(part.kind);
    const said = part.tag.trim().toUpperCase();
    const shared = sharedTags(drawing).has(said);
    const onAnother = (drawing.elsewhere ?? []).some((tag) => tag.trim().toUpperCase() === said);
    const change = (key: string, update: (part: Part) => Part) =>
        store.commit(updatePart(store.getState().drawing, part.id, update), undefined, `${part.id}:${key}`);
    const setProp = (key: string, value: string) =>
        change(key, (now) => ({ ...now, props: { ...now.props, [key]: value } }));
    const toggleShown = (key: string) =>
        change("shown", (now) => ({
            ...now,
            shown: now.shown.includes(key) ? now.shown.filter((entry) => entry !== key) : [...now.shown, key],
        }));
    // Its own properties, beside its kind's: not those its kind shows its own way (where a connector goes).
    const custom = Object.keys(part.props).filter(
        (key) => !kind.fields.some((field) => field.key === key) && !OWN_PROPS[part.kind]?.has(key),
    );
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
            {sim && <PartSimSection store={store} sim={sim} part={part} />}
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
            {shared && (
                <p className="piper-warning">
                    {onAnother ? "A part on another page" : "Another part"} is tagged {part.tag} too.
                </p>
            )}
            {(scalable(part) || kind.tag !== "none") && (
                <div className="piper-sizes">
                    {scalable(part) && (
                        <Row label="Size">
                            {(id) => (
                                <select
                                    id={id}
                                    value={part.scale}
                                    onChange={(event) =>
                                        store.commit(
                                            updatePart(drawing, part.id, (now) => ({
                                                ...now,
                                                scale: Number(event.target.value),
                                            })),
                                        )
                                    }
                                >
                                    {PART_SCALES.map((scale) => (
                                        <option key={scale} value={scale}>
                                            {scale === 1 ? "Its own" : `${Math.round(scale * 100)}%`}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </Row>
                    )}
                    {kind.tag !== "none" && (
                        <Row label="Label size">
                            {(id) => (
                                <select
                                    id={id}
                                    value={part.labelSize}
                                    onChange={(event) =>
                                        store.commit(
                                            updatePart(drawing, part.id, (now) => ({
                                                ...now,
                                                labelSize: event.target.value as Part["labelSize"],
                                            })),
                                        )
                                    }
                                >
                                    <option value="">The diagram's</option>
                                    {LABEL_SIZES.map((size) => (
                                        <option key={size.value} value={size.value}>
                                            {size.label}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </Row>
                    )}
                </div>
            )}
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
            {part.kind === "offpage" && <JumpSettings store={store} commands={commands} part={part} />}
            {part.kind === "picture" && <PictureSettings store={store} part={part} />}
            <ComesFrom store={store} commands={commands} part={part} />
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
    sim,
}: {
    store: EditorStore;
    commands: Commands;
    line: Line;
    drawing: Drawing;
    sim: SimContext | null;
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
            {sim && <LineSimSection store={store} sim={sim} line={line} />}
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
                {/* For itself or by hand, a line that's gone wrong is routed afresh. */}
                <button
                    type="button"
                    className="button-small"
                    onClick={() => store.commit(rerouteLines(store.getState().drawing, new Set([line.id])))}
                >
                    {line.auto ? "Route again" : "Route automatically"}
                </button>
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

/** What a kind keeps in its properties that it shows its own way: where an off-page connector goes (the page's id, and
 * a part's on it), and which picture a picture shows. */
const OWN_PROPS: Record<string, ReadonlySet<string>> = {
    offpage: new Set(["page", "part"]),
    picture: new Set(["image", "imageWidth", "imageHeight"]),
    figure: new Set(["figure"]),
};

/**
 * Where an off-page connector goes: to another of the diagram's pages, and at a part on it (its own connector back,
 * say). Go there goes, as double-clicking it does; what it arrives at lists it (ComesFrom), to go back. Picking a page
 * writes TO and its name on the connector, unless its words have been changed.
 */
function JumpSettings({ store, commands, part }: { store: EditorStore; commands: Commands; part: Part }) {
    const document = useEditor(store, (state) => state.document);
    const page = useEditor(store, (state) => state.page);
    const target = document.pages.findIndex((entry) => entry.id === part.props.page);
    const there = target >= 0 ? document.pages[target]! : null;
    const spots = (there?.parts ?? []).filter(
        (entry) => entry.kind === "offpage" || (entry.tag.trim() !== "" && entry.kind !== "junction"),
    );
    function setJump(pageId: string, partId: string) {
        const name = document.pages.find((entry) => entry.id === pageId)?.name ?? "";
        const said = part.text.trim().toUpperCase();
        // Its words follow where it goes, until they're written by hand.
        const written = said !== "" && said !== "TO GSE" && (!there || said !== `TO ${there.name.toUpperCase()}`);
        store.commit(
            updatePart(store.getState().drawing, part.id, (now) => ({
                ...now,
                props: { ...now.props, page: pageId, part: partId },
                text: written || !name ? now.text : `TO ${name.toUpperCase()}`,
            })),
        );
    }
    return (
        <>
            <Row label="To page">
                {(id) => (
                    <select id={id} value={there?.id ?? ""} onChange={(event) => setJump(event.target.value, "")}>
                        <option value="">{part.props.page && !there ? "A page since deleted" : "Nowhere yet"}</option>
                        {document.pages.map((entry, index) =>
                            index === page ? null : (
                                <option key={entry.id} value={entry.id}>
                                    {entry.name}
                                </option>
                            ),
                        )}
                    </select>
                )}
            </Row>
            {there && (
                <Row label="At">
                    {(id) => (
                        <select
                            id={id}
                            value={spots.some((entry) => entry.id === part.props.part) ? part.props.part : ""}
                            onChange={(event) => setJump(there.id, event.target.value)}
                        >
                            <option value="">The whole page</option>
                            {spots.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                    {tagOf(entry)}
                                    {entry.kind === "offpage" ? " (its connector)" : ""}
                                </option>
                            ))}
                        </select>
                    )}
                </Row>
            )}
            {there && (
                <button
                    type="button"
                    className="button-small"
                    onClick={() => commands.goTo(target, part.props.part ? [part.props.part] : [])}
                >
                    Go to {there.name}
                </button>
            )}
        </>
    );
}

/** Which picture a picture part shows: chosen from this computer, a PNG or a JPEG, and added to Piper. */
function PictureSettings({ store, part }: { store: EditorStore; part: Part }) {
    const picker = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function choose(file: File) {
        setBusy(true);
        setProblem(null);
        try {
            const image = await piper.addImage(file);
            store.commit(updatePart(store.getState().drawing, part.id, (now) => withPicture(now, image)));
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }
    const pixels = pictureAspect(part) && `${part.props.imageWidth} × ${part.props.imageHeight} pixels`;
    return (
        <>
            <Row label="Picture">
                {(id) => (
                    <div className="piper-picture-pick">
                        <button
                            id={id}
                            type="button"
                            className="button-small"
                            disabled={busy}
                            onClick={() => picker.current?.click()}
                        >
                            {busy ? "Adding…" : part.props.image ? "Replace…" : "Choose a picture…"}
                        </button>
                        <input
                            ref={picker}
                            type="file"
                            accept="image/png,image/jpeg"
                            hidden
                            aria-label="Picture to show"
                            onChange={(event) => {
                                const chosen = event.target.files?.[0];
                                event.target.value = "";
                                if (chosen) {
                                    void choose(chosen);
                                }
                            }}
                        />
                        {pixels && <span className="muted piper-small">{pixels}</span>}
                    </div>
                )}
            </Row>
            {problem && <p className="piper-warning">{problem}</p>}
            <p className="muted piper-small">
                A PNG or a JPEG, up to 5 MB. Drag its square corner to size it: it keeps its shape. Or drop a picture on
                the drawing.
            </p>
        </>
    );
}

const tagOf = (part: Part) => part.tag || part.text || titleOf(part);

/** The off-page connectors on other pages that go to a part (a connector back, or a tank), to go back to. */
function ComesFrom({ store, commands, part }: { store: EditorStore; commands: Commands; part: Part }) {
    const document = useEditor(store, (state) => state.document);
    const page = useEditor(store, (state) => state.page);
    const here = document.pages[page]?.id;
    const coming = document.pages.flatMap((entry, index) =>
        entry.parts
            .filter((other) => other.kind === "offpage" && other.props.page === here && other.props.part === part.id)
            .map((other) => ({ index, page: entry, part: other })),
    );
    if (coming.length === 0) {
        return null;
    }
    return (
        <div className="piper-coming">
            <span className="muted piper-small">Comes from</span>
            {coming.map((entry) => (
                <button
                    key={entry.part.id}
                    type="button"
                    className="button-small"
                    onClick={() => commands.goTo(entry.index, [entry.part.id])}
                >
                    {tagOf(entry.part)}, on {entry.page.name}
                </button>
            ))}
        </div>
    );
}

/**
 * Where the page prints: on which paper, turned which way, and where on it, as an outline on the canvas shows. Until
 * it's set, a PDF fits the page to the paper it's saved on; once it is, the page prints as the outline shows, so a
 * sheet's layout and scale stay put as the drawing changes. Fit moves it to what's on the page now.
 */
function SheetSettings({ store, drawing }: { store: EditorStore; drawing: Drawing }) {
    const sheet = drawing.sheet ?? null;
    const box = drawingBox(drawing) ?? { x0: -200, y0: -150, x1: 200, y1: 150 };
    const wide = box.y1 - box.y0 <= (box.x1 - box.x0) * 1.2;
    const set = (paper: string | null, landscape: boolean) =>
        store.commit({ ...drawing, sheet: paper ? fitSheet(box, paper, landscape) : null });
    return (
        <>
            <h3 className="piper-subhead">Printed sheet</h3>
            <Row label="Paper">
                {(id) => (
                    <select
                        id={id}
                        value={sheet?.paper ?? ""}
                        onChange={(event) => set(event.target.value || null, sheet?.landscape ?? wide)}
                    >
                        <option value="">Fitted to the PDF's paper</option>
                        {PAPERS.filter((paper) => paper.width > 0).map((paper) => (
                            <option key={paper.id} value={paper.id}>
                                {paper.name}
                            </option>
                        ))}
                    </select>
                )}
            </Row>
            {sheet ? (
                <>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={sheet.landscape}
                            onChange={(event) => set(sheet.paper, event.target.checked)}
                        />
                        Landscape
                    </label>
                    <p className="muted piper-small">
                        The outline shows where this page prints, at {Math.round(sheet.scale * 100)}% of its size: the
                        sheet's border, and the corner its title block takes.{" "}
                        <button
                            type="button"
                            className="button-small"
                            onClick={() => set(sheet.paper, sheet.landscape)}
                        >
                            Fit the sheet to the page
                        </button>
                    </p>
                </>
            ) : (
                <p className="muted piper-small">
                    Pick a paper to see where this page prints, and keep it there as the drawing changes.
                </p>
            )}
        </>
    );
}

function DiagramPanel({
    store,
    drawing,
    palette,
    schemes,
    sim,
}: {
    store: EditorStore;
    drawing: Drawing;
    palette: Palette;
    schemes: Scheme[] | null;
    sim: SimContext | null;
}) {
    const [editing, setEditing] = useState(false);
    const document = useEditor(store, (state) => state.document);
    // All the diagram's pages together: the fluids any of them use, and the lines and valves on all of them.
    const everywhere = useMemo(
        () => ({
            ...drawing,
            parts: document.pages.flatMap((page) => page.parts),
            lines: document.pages.flatMap((page) => page.lines),
        }),
        [document, drawing],
    );
    const taken = schemes?.find((scheme) => String(scheme.id) === drawing.style.scheme) ?? null;
    const used = fluidsUsed(everywhere);
    const valves = everywhere.parts.filter((part) => kindOf(part.kind).state).length;
    const setFluid = (fluid: Fluid, key: string) =>
        store.commit({ ...drawing, fluids: withFluid(drawing, fluid) }, undefined, `fluid:${fluid.id}:${key}`);
    const setStyle = (key: "no" | "nc" | "fip", value: string) =>
        store.commit({ ...drawing, style: { ...drawing.style, [key]: value } }, undefined, `style:${key}`);
    // What's written on every line, or every valve, at once, on every page: shown everywhere, or nowhere.
    const eachPage = (change: (page: Page) => Page) =>
        store.commitDocument({ ...document, pages: document.pages.map(change) });
    const showOnLines = (key: string, on: boolean) =>
        eachPage((page) => ({
            ...page,
            lines: page.lines.map((line) => ({
                ...line,
                shown: on ? [...new Set([...line.shown, key])] : line.shown.filter((entry) => entry !== key),
            })),
        }));
    const showOnValves = (on: boolean) =>
        eachPage((page) => ({
            ...page,
            parts: page.parts.map((part) =>
                kindOf(part.kind).state
                    ? {
                          ...part,
                          shown: on
                              ? [...new Set([...part.shown, "normal"])]
                              : part.shown.filter((entry) => entry !== "normal"),
                      }
                    : part,
            ),
        }));
    const labeledLines = everywhere.lines.filter((line) => line.shown.includes("fluid")).length;
    const labeledValves = everywhere.parts.filter(
        (part) => kindOf(part.kind).state && part.shown.includes("normal"),
    ).length;
    const standard = new Set(STANDARD_FLUIDS.map((fluid) => fluid.id));
    return (
        <>
            <header className="piper-inspector-head">
                <div>
                    <h2>This diagram</h2>
                    <p className="muted">
                        {drawing.parts.length} parts, {drawing.lines.length} lines
                        {document.pages.length > 1 ? ` on this page, of its ${document.pages.length}` : ""}. Select
                        something to name it and say what it is.
                    </p>
                </div>
            </header>
            {sim && <DiagramSimSection store={store} document={document} />}
            <SheetSettings store={store} drawing={drawing} />
            <h3 className="piper-subhead">Color scheme</h3>
            <Row label="Colors from">
                {(id) => (
                    <select
                        id={id}
                        value={taken ? String(taken.id) : ""}
                        onChange={(event) => {
                            const picked = schemes?.find((scheme) => String(scheme.id) === event.target.value);
                            store.commit(
                                picked
                                    ? applyScheme(drawing, picked)
                                    : { ...drawing, style: { ...drawing.style, scheme: "", schemeAt: "" } },
                            );
                        }}
                    >
                        <option value="">
                            {drawing.style.scheme && !taken ? "A scheme since deleted" : "No scheme"}
                        </option>
                        {schemes?.map((scheme) => (
                            <option key={scheme.id} value={scheme.id}>
                                {scheme.name}
                                {scheme.is_default ? " (the team's default)" : ""}
                            </option>
                        ))}
                    </select>
                )}
            </Row>
            {taken && schemeChanged(drawing, taken) && (
                <p className="piper-small">
                    {taken.name} has changed since this diagram took its colors.{" "}
                    <button
                        type="button"
                        className="button-small"
                        onClick={() => store.commit(applyScheme(drawing, taken))}
                    >
                        Take its colors again
                    </button>
                </p>
            )}
            <p className="muted piper-small">
                The team's schemes are on <Link to="/piper/schemes">Schemes</Link>. Changing a fluid here changes it for
                this diagram alone.
            </p>
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
                            <label
                                className="check piper-small"
                                title="A tank of it is full of it, not filled to a level"
                            >
                                <input
                                    type="checkbox"
                                    checked={isGas(drawing, fluid.id)}
                                    onChange={(event) => setFluid({ ...fluid, gas: event.target.checked }, "gas")}
                                />
                                Gas
                            </label>
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
                <label className="check">
                    <input type="color" value={palette.fip} onChange={(event) => setStyle("fip", event.target.value)} />
                    Fails in place
                </label>
                {(drawing.style.no || drawing.style.nc || drawing.style.fip) && (
                    <button
                        type="button"
                        className="button-small"
                        onClick={() =>
                            store.commit({ ...drawing, style: { ...drawing.style, no: "", nc: "", fip: "" } })
                        }
                    >
                        Standard colors
                    </button>
                )}
            </div>
            {valves === 0 && (
                <p className="muted piper-small">Valves are drawn in these colors by their normal states.</p>
            )}
            <h3 className="piper-subhead">Labels</h3>
            <Row label="Label size">
                {(id) => (
                    <select
                        id={id}
                        value={drawing.style.labels}
                        onChange={(event) =>
                            store.commit({
                                ...drawing,
                                style: { ...drawing.style, labels: event.target.value as LabelSize },
                            })
                        }
                    >
                        {LABEL_SIZES.map((size) => (
                            <option key={size.value} value={size.value}>
                                {size.label}
                            </option>
                        ))}
                    </select>
                )}
            </Row>
            {everywhere.lines.length > 0 && (
                <div className="piper-label-all">
                    <span className="muted piper-small">
                        Fluids written on lines: {labeledLines} of {everywhere.lines.length}
                        {document.pages.length > 1 ? ", on all its pages" : ""}
                    </span>
                    <button type="button" className="button-small" onClick={() => showOnLines("fluid", true)}>
                        Show on every line
                    </button>
                    <button type="button" className="button-small" onClick={() => showOnLines("fluid", false)}>
                        Hide on every line
                    </button>
                </div>
            )}
            {valves > 0 && (
                <div className="piper-label-all">
                    <span className="muted piper-small">
                        States written beside valves (NO, NC, FIP): {labeledValves} of {valves}
                        {document.pages.length > 1 ? ", on all its pages" : ""}
                    </span>
                    <button type="button" className="button-small" onClick={() => showOnValves(true)}>
                        Show on every valve
                    </button>
                    <button type="button" className="button-small" onClick={() => showOnValves(false)}>
                        Hide on every valve
                    </button>
                </div>
            )}
        </>
    );
}
