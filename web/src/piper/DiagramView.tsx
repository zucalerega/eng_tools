import { memo, useMemo, type ReactNode } from "react";
import { normalFill, normalState, type Palette } from "./colors";
import type { Drawing, Line, Part, Point } from "./drawing";
import { sharedTags } from "./edit";
import { fluidOf, isGas } from "./fluids";
import { grow, partTransform, segmentsOf } from "./geometry";
import { pathsWithHops } from "./hops";
import { badgePlacer, labelPlace, lineLabelPlaces, partLabel, textSizes, type BadgePlace } from "./labels";
import { FONT } from "./library/draw";
import { boxOf, kindOf } from "./library/index";
import type { DiagramMeta, DrawContext } from "./library/kinds";
import { LinkMarks } from "./links";
import { linesOn, partsById, pathOf, portsOf } from "./ports";
import type { ValveState } from "./testdata";

// A drawing, drawn: regions, then lines (in their fluids' colors, hopping where they cross), then parts, their labels,
// and what a test says of them. The editor draws it with what it needs to be worked on (where a click lands, ports,
// handles, what's selected); exports draw it bare.

/** What a test says of a part at the time shown: its channel's value, and a valve's state; and, in Simulation mode
 * with a run, what the model says there. */
export interface LiveValue {
    text: string;
    state: ValveState | null;
    missing: boolean; // it names a channel the test doesn't have
    model?: string; // the model's value
}

export const LINE_STYLES: Record<Line["kind"], { width: number; dash?: string }> = {
    pipe: { width: 2.5 },
    tube: { width: 1.8 },
    hose: { width: 2.2, dash: "10 3 2 3" },
    pneumatic: { width: 1.4 },
    electric: { width: 1.3, dash: "7 4" },
    signal: { width: 1.3, dash: "2 3" },
};

interface Props {
    drawing: Drawing;
    palette: Palette;
    meta: DiagramMeta;
    selection?: ReadonlySet<string>;
    live?: ReadonlyMap<string, LiveValue> | null;
    /** Drawn to be worked on: where clicks land, handles on what's selected, and ports where they're wanted. */
    interactive?: boolean;
    /** Worked on by someone editing it: what's selected has handles to drag. Else, only its outline. */
    editable?: boolean;
    zoom?: number;
    ports?: ReadonlySet<string> | "all"; // whose ports show: the part under the pointer, or all while a line's drawn
}

export function DiagramView({
    drawing,
    palette,
    meta,
    selection = EMPTY,
    live = null,
    interactive = false,
    editable = true,
    zoom = 1,
    ports = EMPTY,
}: Props) {
    const parts = useMemo(() => partsById(drawing), [drawing]);
    const paths = useMemo(() => new Map(drawing.lines.map((line) => [line.id, pathOf(parts, line)])), [drawing, parts]);
    const hopped = useMemo(() => pathsWithHops(paths), [paths]);
    const lineLabels = useMemo(() => lineLabelPlaces(drawing, paths), [drawing, paths]);
    const place = useMemo(() => badgePlacer(drawing, paths), [drawing, paths]); // where test values go, if shown
    const shared = useMemo(() => sharedTags(drawing), [drawing]);
    // Under the lines: what's drawn behind everything (regions, figures) and parts sent to the back. Over them: the rest.
    // Each in the drawing's order, so a part later is over one earlier.
    const under = (part: Part) => kindOf(part.kind).behind || part.back === true;
    const behind = drawing.parts.filter(under);
    const front = drawing.parts.filter((part) => !under(part));
    const labelled = drawing.parts.filter((part) => !kindOf(part.kind).behind); // tags over everything, to be read
    const reach = 12 / zoom; // how far from a line a click still lands on it

    const contextOf = (part: Part): DrawContext => {
        const kind = kindOf(part.kind);
        const tested = live?.get(part.id)?.state ?? null;
        const fill = tested
            ? { open: palette.no, closed: palette.nc, other: palette.other }[tested]
            : kind.state
              ? normalFill(palette, part.props.normal)
              : null;
        const holds = fluidOf(drawing, part.props.fluid ?? "");
        const on = linesOn(drawing, part.id);
        const piped = on.map(({ line }) => fluidOf(drawing, line.fluid)?.color).find(Boolean) ?? null;
        return {
            ink: palette.ink,
            paper: palette.paper,
            muted: palette.muted,
            fill,
            state: tested ?? (kind.state ? normalState(part.props.normal) : null),
            fluid: holds?.color ?? null,
            fluidLabel: holds?.label ?? "",
            gas: holds ? isGas(drawing, holds.id) : false,
            pipe: on.length > 0 ? (piped ?? palette.ink) : null,
            lines: on.length,
            states: { no: palette.no, nc: palette.nc, fip: palette.fip },
            drawing,
            meta,
        };
    };

    return (
        <g className="piper-drawing">
            {behind.map((part) => (
                <PartView
                    key={part.id}
                    part={part}
                    context={contextOf(part)}
                    interactive={interactive}
                    box={kindOf(part.kind).box(part, drawing)}
                />
            ))}
            {drawing.lines.map((line) => (
                <LineView
                    key={line.id}
                    line={line}
                    d={hopped.get(line.id) ?? ""}
                    path={paths.get(line.id) ?? []}
                    color={fluidOf(drawing, line.fluid)?.color ?? palette.ink}
                    halo={selection.has(line.id) ? palette.select : null}
                    interactive={interactive}
                    reach={reach}
                />
            ))}
            {lineLabels.map((place) => (
                <text
                    key={`label-${place.line}`}
                    x={place.level ? place.at.x : place.at.x + 5}
                    y={place.level ? place.at.y - 5 : place.at.y}
                    textAnchor={place.level ? "middle" : "start"}
                    dominantBaseline={place.level ? "auto" : "central"}
                    fontSize={textSizes(drawing).line}
                    fontFamily={FONT}
                    fontWeight={700}
                    fill={fluidOf(drawing, place.fluid)?.color ?? palette.ink}
                    stroke={palette.paper}
                    strokeWidth={2.5}
                    paintOrder="stroke"
                    pointerEvents="none"
                >
                    {place.text}
                </text>
            ))}
            {live && <LiveLeaders drawing={drawing} live={live} place={place} palette={palette} />}
            {front.map((part) => (
                <PartView
                    key={part.id}
                    part={part}
                    context={contextOf(part)}
                    interactive={interactive}
                    box={kindOf(part.kind).box(part, drawing)}
                />
            ))}
            {labelled.map((part) => (
                <PartLabel
                    key={`label-${part.id}`}
                    drawing={drawing}
                    part={part}
                    palette={palette}
                    shared={shared.has(part.tag.trim().toUpperCase())}
                    interactive={interactive}
                />
            ))}
            {live && <LiveBadges drawing={drawing} live={live} place={place} palette={palette} />}
            {interactive && <LinkMarks drawing={drawing} palette={palette} />}
            {interactive && (
                <Handles
                    drawing={drawing}
                    paths={paths}
                    selection={selection}
                    editable={editable}
                    palette={palette}
                    zoom={zoom}
                    ports={ports}
                />
            )}
        </g>
    );
}

const EMPTY: ReadonlySet<string> = new Set();

const PartView = memo(function PartView({
    part,
    context,
    interactive,
    box,
}: {
    part: Part;
    context: DrawContext;
    interactive: boolean;
    box: readonly [number, number, number, number];
}) {
    const kind = kindOf(part.kind);
    const [x0, y0, x1, y1] = box;
    return (
        <g
            transform={partTransform(part)}
            data-hit={interactive ? `part:${part.id}` : undefined}
            data-kind={part.kind}
            className={interactive ? "piper-part" : undefined}
            role={interactive ? "button" : undefined}
            aria-label={interactive ? `${part.tag || kind.name}` : undefined}
        >
            {kind.draw(part, context)}
            {interactive &&
                // Where a click lands on it: all of its box, not only its strokes. A region's only its edge, so
                // what's in it can be clicked.
                (kind.behind ? (
                    <rect
                        x={x0}
                        y={y0}
                        width={x1 - x0}
                        height={y1 - y0}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                        pointerEvents="stroke"
                    />
                ) : (
                    <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="transparent" />
                ))}
        </g>
    );
});

/** Pneumatic signal lines' marks: a pair of slashes across each segment's middle. */
function slashes(path: Point[]): string {
    return segmentsOf(path)
        .filter(({ a, b }) => Math.hypot(b.x - a.x, b.y - a.y) > 30)
        .map(({ a, b }) => {
            const x = (a.x + b.x) / 2;
            const y = (a.y + b.y) / 2;
            const level = Math.abs(a.y - b.y) < 1e-6;
            return level
                ? `M${x - 5} ${y + 4} L${x - 1} ${y - 4} M${x + 1} ${y + 4} L${x + 5} ${y - 4}`
                : `M${x - 4} ${y - 5} L${x + 4} ${y - 1} M${x - 4} ${y + 1} L${x + 4} ${y + 5}`;
        })
        .join(" ");
}

/** Flow arrows: one at the middle of each long enough segment, pointing the way the line says flow goes. */
function arrows(path: Point[], backward: boolean): string {
    return segmentsOf(path)
        .filter(({ a, b }) => Math.hypot(b.x - a.x, b.y - a.y) > 50)
        .map(({ a, b }) => {
            const [from, to] = backward ? [b, a] : [a, b];
            const length = Math.hypot(to.x - from.x, to.y - from.y);
            const ux = (to.x - from.x) / length;
            const uy = (to.y - from.y) / length;
            const tip = { x: (a.x + b.x) / 2 + ux * 5, y: (a.y + b.y) / 2 + uy * 5 };
            const base = { x: tip.x - ux * 10, y: tip.y - uy * 10 };
            return `M${tip.x} ${tip.y} L${base.x - uy * 5} ${base.y + ux * 5} L${base.x + uy * 5} ${base.y - ux * 5} Z`;
        })
        .join(" ");
}

const LineView = memo(function LineView({
    line,
    d,
    path,
    color,
    halo,
    interactive,
    reach,
}: {
    line: Line;
    d: string;
    path: Point[];
    color: string;
    halo: string | null;
    interactive: boolean;
    reach: number;
}) {
    const style = LINE_STYLES[line.kind];
    return (
        <g data-line={line.id}>
            {halo && (
                <path
                    d={d}
                    fill="none"
                    stroke={halo}
                    strokeOpacity={0.3}
                    strokeWidth={style.width + 7}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            )}
            <path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={style.width}
                strokeDasharray={style.dash}
                strokeLinejoin="round"
            />
            {line.kind === "pneumatic" && <path d={slashes(path)} fill="none" stroke={color} strokeWidth={1.2} />}
            {line.arrow !== "none" && <path d={arrows(path, line.arrow === "backward")} fill={color} />}
            {interactive &&
                segmentsOf(path).map((segment) => (
                    <path
                        key={segment.index}
                        d={`M${segment.a.x} ${segment.a.y} L${segment.b.x} ${segment.b.y}`}
                        stroke="transparent"
                        strokeWidth={reach}
                        fill="none"
                        data-hit={`segment:${line.id}:${segment.index}`}
                        className={
                            Math.abs(segment.a.y - segment.b.y) < 1e-6 ? "piper-segment-level" : "piper-segment-upright"
                        }
                    />
                ))}
        </g>
    );
});

/** Whether a part can be drawn bigger or smaller: not what's sized by its width and height, nor a tee, nor what reads
 * the drawing (a legend, a title block), whose size is their words'. */
export const scalable = (part: Part): boolean =>
    !kindOf(part.kind).resizable && !["junction", "legend", "titleblock", "text"].includes(part.kind);

function PartLabel({
    drawing,
    part,
    palette,
    shared,
    interactive,
}: {
    drawing: Drawing;
    part: Part;
    palette: Palette;
    shared: boolean;
    interactive: boolean;
}) {
    const rows = partLabel(drawing, part);
    if (rows.length === 0) {
        return null;
    }
    const sizes = textSizes(drawing, part);
    const { at, anchor } = labelPlace(part, boxOf(part, drawing), sizes.tag, drawing);
    return (
        <text
            x={at.x}
            y={at.y}
            textAnchor={anchor}
            fontFamily={FONT}
            stroke={palette.paper}
            strokeWidth={2.5}
            paintOrder="stroke"
            data-hit={interactive ? `label:${part.id}` : undefined}
            className={interactive ? "piper-label" : undefined}
        >
            {shared && <title>Another part has this tag too</title>}
            {rows.map((row, index) => (
                <tspan
                    key={index}
                    x={at.x}
                    dy={index === 0 ? 0 : sizes.gap}
                    fontSize={row.tag ? sizes.tag : sizes.row}
                    fontWeight={row.tag ? 700 : 500}
                    fill={row.tag && shared ? palette.other : row.tag ? palette.ink : palette.muted}
                >
                    {row.text}
                </tspan>
            ))}
        </text>
    );
}

/** How wide a badge's letters are, about: its words are 9.5 bold. */
const LETTER = 5.6;

/** A badge's color: a valve's state's, a channel the test hasn't got's, the model's gold where it's the model's alone,
 * else the test's blue. */
function badgeColor(value: LiveValue, palette: Palette): string {
    if (value.missing) {
        return palette.muted;
    }
    if (value.state) {
        return { open: palette.no, closed: palette.nc, other: palette.other }[value.state];
    }
    return value.model !== undefined && !value.text ? palette.model : palette.select;
}

/** How wide a badge of its kind usually is, which its side is chosen for (badgePlacer): a test's value, or the model's
 * beside it. Not what it says now, so it stays put as that changes. */
const usualWidth = (value: LiveValue): number => (value.model === undefined ? 60 : 110);

/** The lines that tie each part's badge to it, under the parts, so what's drawn of a part hides its end. */
function LiveLeaders({
    drawing,
    live,
    place,
    palette,
}: {
    drawing: Drawing;
    live: ReadonlyMap<string, LiveValue>;
    place: (part: Part, width: number) => BadgePlace;
    palette: Palette;
}) {
    return (
        <g className="piper-live-leaders" pointerEvents="none">
            {drawing.parts.map((part) => {
                const value = live.get(part.id);
                if (!value) {
                    return null;
                }
                const { from, to } = place(part, usualWidth(value));
                return (
                    <line
                        key={part.id}
                        data-leader={part.id}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        stroke={badgeColor(value, palette)}
                        strokeWidth={1.2}
                        strokeLinecap="round"
                    />
                );
            })}
        </g>
    );
}

/**
 * What a test says of each part, in a badge tied to it by its leader: a sensor's value, a valve's state. In Simulation
 * mode with a run, the model's value beside it, in gold, in the same badge. Each goes where it's clear of the drawing
 * (badgePlacer).
 */
function LiveBadges({
    drawing,
    live,
    place,
    palette,
}: {
    drawing: Drawing;
    live: ReadonlyMap<string, LiveValue>;
    place: (part: Part, width: number) => BadgePlace;
    palette: Palette;
}) {
    const words = (x: number, y: number, text: string, fill: string, anchor: "start" | "middle", model = false) => (
        <text
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="central"
            fontSize={9.5}
            fontFamily={FONT}
            fontWeight={700}
            fill={fill}
            {...(model ? { "data-model": "" } : {})}
        >
            {text}
        </text>
    );
    const badges: ReactNode[] = [];
    for (const part of drawing.parts) {
        const value = live.get(part.id);
        if (!value) {
            continue;
        }
        const at = place(part, usualWidth(value));
        const leftOf = (width: number) => (at.end ? at.x - width : at.x);
        const y = at.y;
        const color = badgeColor(value, palette);
        const tested = value.missing ? "no channel" : value.text;
        const ink = value.missing ? palette.muted : palette.ink;
        const frame = (x: number, width: number) => (
            <rect
                x={x}
                y={y - 8}
                width={width}
                height={15}
                rx={4}
                fill={palette.paper}
                stroke={color}
                strokeWidth={1.2}
            />
        );
        if (value.model === undefined) {
            const text = tested || "—";
            const width = text.length * LETTER + 10;
            const x = leftOf(width);
            badges.push(
                <g key={part.id} className="piper-live" data-live={part.id}>
                    {frame(x, width)}
                    {words(x + width / 2, y, text, ink, "middle")}
                </g>,
            );
            continue;
        }
        // The test's, if it says anything here, then a rule, then the model's, in gold.
        const testWidth = tested ? tested.length * LETTER + 12 : 0;
        const width = 5 + testWidth + value.model.length * LETTER + 5;
        const x = leftOf(width);
        badges.push(
            <g key={part.id} className="piper-live" data-live={part.id}>
                {frame(x, width)}
                {tested && words(x + 5, y, tested, ink, "start")}
                {tested && (
                    <line
                        x1={x + 5 + testWidth - 6}
                        y1={y - 5}
                        x2={x + 5 + testWidth - 6}
                        y2={y + 5}
                        stroke={palette.muted}
                        strokeWidth={0.8}
                    />
                )}
                {words(x + 5 + testWidth, y, value.model, palette.model, "start", true)}
            </g>,
        );
    }
    return <>{badges}</>;
}

/** What's needed to work on the drawing: outlines around what's selected, its handles, and ports to draw lines from. */
function Handles({
    drawing,
    paths,
    selection,
    editable,
    palette,
    zoom,
    ports,
}: {
    drawing: Drawing;
    paths: Map<string, Point[]>;
    selection: ReadonlySet<string>;
    editable: boolean;
    palette: Palette;
    zoom: number;
    ports: ReadonlySet<string> | "all";
}) {
    const size = 7 / zoom;
    const handles: ReactNode[] = [];
    for (const part of drawing.parts) {
        if (!selection.has(part.id)) {
            continue;
        }
        const box = grow(boxOf(part, drawing), 4);
        handles.push(
            <rect
                key={`box-${part.id}`}
                x={box.x0}
                y={box.y0}
                width={box.x1 - box.x0}
                height={box.y1 - box.y0}
                rx={3}
                fill="none"
                stroke={palette.select}
                strokeWidth={1.2 / zoom}
                strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                pointerEvents="none"
            />,
        );
        const outline = boxOf(part, drawing);
        if (!editable) {
            continue;
        }
        if (kindOf(part.kind).resizable && selection.size === 1) {
            // A box, a region, a text block: dragged to a width and height.
            handles.push(
                <rect
                    key={`resize-${part.id}`}
                    x={outline.x1 - size / 2}
                    y={outline.y1 - size / 2}
                    width={size}
                    height={size}
                    fill={palette.paper}
                    stroke={palette.select}
                    strokeWidth={1.5 / zoom}
                    data-hit={`resize:${part.id}`}
                    className="piper-resize"
                />,
            );
        } else if (scalable(part) && selection.size === 1) {
            // Any other part: dragged bigger or smaller, from half its size to double.
            handles.push(
                <circle
                    key={`scale-${part.id}`}
                    cx={box.x1}
                    cy={box.y1}
                    r={size / 2}
                    fill={palette.paper}
                    stroke={palette.select}
                    strokeWidth={1.5 / zoom}
                    data-hit={`scale:${part.id}`}
                    className="piper-resize"
                >
                    <title>Drag to make it bigger or smaller</title>
                </circle>,
            );
        }
    }
    for (const line of drawing.lines) {
        if (!editable || !selection.has(line.id) || selection.size > 1) {
            continue;
        }
        const path = paths.get(line.id) ?? [];
        for (const segment of segmentsOf(path)) {
            const level = Math.abs(segment.a.y - segment.b.y) < 1e-6;
            handles.push(
                <rect
                    key={`segment-${line.id}-${segment.index}`}
                    x={(segment.a.x + segment.b.x) / 2 - size / 2}
                    y={(segment.a.y + segment.b.y) / 2 - size / 2}
                    width={size}
                    height={size}
                    rx={size / 4}
                    fill={palette.select}
                    data-hit={`segment:${line.id}:${segment.index}`}
                    className={level ? "piper-segment-level" : "piper-segment-upright"}
                />,
            );
        }
        const ends: ["from" | "to", Point | undefined][] = [
            ["from", path[0]],
            ["to", path[path.length - 1]],
        ];
        for (const [end, at] of ends) {
            if (at) {
                handles.push(
                    <circle
                        key={`end-${line.id}-${end}`}
                        cx={at.x}
                        cy={at.y}
                        r={size * 0.7}
                        fill={palette.paper}
                        stroke={palette.select}
                        strokeWidth={1.6 / zoom}
                        data-hit={`end:${line.id}:${end}`}
                        className="piper-end"
                    />,
                );
            }
        }
    }
    const showing = ports === "all" ? drawing.parts : drawing.parts.filter((part) => ports.has(part.id));
    for (const part of showing) {
        for (const port of portsOf(part)) {
            handles.push(
                <circle
                    key={`port-${part.id}-${port.id}`}
                    cx={port.at.x}
                    cy={port.at.y}
                    r={4.5 / zoom}
                    fill={palette.paper}
                    stroke={palette.select}
                    strokeWidth={1.5 / zoom}
                    data-hit={`port:${part.id}:${port.id}`}
                    className="piper-port"
                />,
            );
        }
    }
    return <>{handles}</>;
}
