import type { Palette } from "./colors";
import { LINE_STYLES } from "./DiagramView";
import { LINE_KINDS, type Drawing, type Fluid, type LineKind, type Part } from "./drawing";
import { fluidsUsed } from "./fluids";
import type { Box } from "./geometry";
import { FONT } from "./library/draw";
import { ALL_KINDS, CATEGORIES, kindOf, PRESETS, titleOf } from "./library/index";
import type { DiagramMeta, DrawContext } from "./library/kinds";

// The legend an export can have (a PDF, an SVG or PNG image, a print): every kind of part on the page, with its symbol
// and its name, under its category in the library; each type of line, in its weight and dashes; each fluid, in its
// color; and the colors of its valves' normal states. Laid out in columns as the team's own P&ID legends are, and drawn
// in the drawing's units, at its labels' size, so a PDF prints it as it prints the drawing.

/** What isn't one of the system's parts: what's written or drawn on the page, a tee, a shape drawn as Visio drew it. */
const NOT_PARTS = new Set(["junction", "text", "region", "offpage", "legend", "titleblock", "picture", "figure"]);

const STATE_NAMES: Record<string, string> = { NO: "Normally open", NC: "Normally closed", FIP: "Fails in place" };

export interface LegendEntries {
    parts: { category: string; name: string; part: Part }[]; // the first part of each name: its symbol's drawn
    lines: LineKind[];
    fluids: Fluid[];
    states: string[]; // the normal states its valves have: NO, NC, FIP
}

/** What a page's legend lists: its parts by what they're called, in the library's order; its lines' types; its
 * fluids (unless it's printed in black and white, where they're all ink); its valves' normal states. */
export function legendOf(drawing: Drawing, withFluids = true): LegendEntries {
    const order = new Map(ALL_KINDS.map((kind, index) => [kind.id, index]));
    const named = new Map<string, Part>();
    for (const part of drawing.parts) {
        const name = titleOf(part);
        if (!NOT_PARTS.has(part.kind) && order.has(part.kind) && !named.has(name)) {
            named.set(name, part);
        }
    }
    const category = (kind: string) =>
        CATEGORIES.find((entry) => entry.id === PRESETS.find((preset) => preset.kind === kind)?.category)?.name ??
        "Parts";
    const used = new Set(drawing.lines.map((line) => line.kind));
    const states = new Set(
        drawing.parts.filter((part) => kindOf(part.kind).state).map((part) => part.props.normal ?? ""),
    );
    return {
        // In the library's order of kinds (its categories'), and each kind's in the order they're first on the page.
        parts: [...named.entries()]
            .map(([name, part]) => ({ category: category(part.kind), name, part }))
            .sort((a, b) => order.get(a.part.kind)! - order.get(b.part.kind)!),
        lines: LINE_KINDS.map((entry) => entry.value).filter((kind) => used.has(kind)),
        fluids: withFluids ? fluidsUsed(drawing) : [],
        states: ["NO", "NC", "FIP"].filter((state) => states.has(state)),
    };
}

type Item =
    | { type: "heading"; text: string }
    | { type: "part"; name: string; part: Part }
    | { type: "line"; name: string; kind: LineKind }
    | { type: "fluid"; name: string; fluid: Fluid }
    | { type: "state"; name: string; state: string };

/** An item where it is in the legend: its row's top left, and its height. */
interface Placed {
    item: Item;
    x: number;
    y: number;
    height: number;
}

export interface LegendLayout {
    width: number;
    height: number;
    placed: Placed[];
}

const PAD = 12;
const TOP = 30; // under its title
const CELL = 56; // a symbol's, or a line's, room across
const SYMBOL: [number, number] = [50, 32]; // the most a symbol's drawn across and up
const SIZE = 9.5; // its names'
const HEADING = 7.5;
const GAP = 22; // between its columns

/** How big a part's symbol is drawn, of its own size: as big as fits its cell, and at most four fifths of it. */
function symbolScale(part: Part, drawing: Drawing): { scale: number; box: readonly [number, number, number, number] } {
    const box = kindOf(part.kind).box(part, drawing);
    const [w, h] = [box[2] - box[0], box[3] - box[1]];
    return { scale: Math.min(0.8, SYMBOL[0] / Math.max(1, w), SYMBOL[1] / Math.max(1, h)), box };
}

function rowHeight(item: Item, drawing: Drawing): number {
    switch (item.type) {
        case "heading":
            return 18;
        case "part": {
            const { scale, box } = symbolScale(item.part, drawing);
            return Math.max(24, (box[3] - box[1]) * scale + 8);
        }
        default:
            return 20;
    }
}

const itemWidth = (item: Item) =>
    item.type === "heading" ? item.text.length * HEADING * 0.72 : CELL + 8 + item.name.length * SIZE * 0.56;

/**
 * The legend laid out: its title, then each category's heading and rows, in columns no taller than maxHeight (at
 * least one row each), left to right. A heading starts a column rather than end one.
 */
export function layoutLegend(entries: LegendEntries, drawing: Drawing, maxHeight: number): LegendLayout {
    const items: Item[] = [];
    let category = "";
    for (const { category: name, name: title, part } of entries.parts) {
        if (name !== category) {
            items.push({ type: "heading", text: name.toUpperCase() });
            category = name;
        }
        items.push({ type: "part", name: title, part });
    }
    if (entries.lines.length > 0) {
        items.push({ type: "heading", text: "LINES" });
        for (const kind of entries.lines) {
            items.push({ type: "line", kind, name: LINE_KINDS.find((entry) => entry.value === kind)!.label });
        }
    }
    if (entries.fluids.length > 0) {
        items.push({ type: "heading", text: "FLUIDS" });
        for (const fluid of entries.fluids) {
            const name = fluid.label && fluid.label !== fluid.name ? `${fluid.label}: ${fluid.name}` : fluid.name;
            items.push({ type: "fluid", fluid, name });
        }
    }
    if (entries.states.length > 0) {
        items.push({ type: "heading", text: "VALVE STATES" });
        for (const state of entries.states) {
            items.push({ type: "state", state, name: STATE_NAMES[state]! });
        }
    }
    const placed: Placed[] = [];
    let [x, y, column, bottom] = [PAD, TOP, 0, TOP];
    items.forEach((item, index) => {
        const height = rowHeight(item, drawing);
        const next = items[index + 1];
        const needs = item.type === "heading" && next ? height + rowHeight(next, drawing) : height;
        if (y + needs > maxHeight - PAD && y > TOP) {
            [x, y, column] = [x + column + GAP, TOP, 0];
        }
        placed.push({ item, x, y, height });
        column = Math.max(column, itemWidth(item));
        y += height;
        bottom = Math.max(bottom, y);
    });
    return {
        width: Math.max(x + column + PAD, 120),
        height: placed.length > 0 ? bottom + PAD : TOP + 20 + PAD,
        placed,
    };
}

/** The legend's box, its top left at a point, in the drawing's units. */
export const legendBox = (layout: LegendLayout, at: { x: number; y: number }): Box => ({
    x0: at.x,
    y0: at.y,
    x1: at.x + layout.width,
    y1: at.y + layout.height,
});

/** A legend, drawn: its frame, its title, and its rows, at a point of the drawing. */
export function LegendBlock({
    layout,
    at,
    drawing,
    palette,
    meta,
}: {
    layout: LegendLayout;
    at: { x: number; y: number };
    drawing: Drawing;
    palette: Palette;
    meta: DiagramMeta;
}) {
    const ink = { stroke: palette.ink, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
    const name = (x: number, y: number, text: string) => (
        <text x={x} y={y} fontSize={SIZE} fontFamily={FONT} dominantBaseline="central" fill={palette.ink}>
            {text}
        </text>
    );
    return (
        <g className="piper-legend" transform={`translate(${at.x} ${at.y})`}>
            <rect
                x={0}
                y={0}
                width={layout.width}
                height={layout.height}
                fill={palette.paper}
                strokeWidth={1.2}
                {...ink}
            />
            <text
                x={PAD}
                y={20}
                fontSize={11}
                fontFamily={FONT}
                fontWeight={700}
                letterSpacing="0.1em"
                fill={palette.ink}
            >
                LEGEND
            </text>
            {layout.placed.map(({ item, x, y, height }, index) => {
                const middle = y + height / 2;
                const text = x + CELL + 8;
                switch (item.type) {
                    case "heading":
                        return (
                            <text
                                key={index}
                                x={x}
                                y={y + 13}
                                fontSize={HEADING}
                                fontFamily={FONT}
                                fontWeight={700}
                                letterSpacing="0.08em"
                                fill={palette.muted}
                            >
                                {item.text}
                            </text>
                        );
                    case "part": {
                        const { scale, box } = symbolScale(item.part, drawing);
                        const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
                        // As the library draws it: no state's color, nothing in it, no line on it.
                        const context: DrawContext = {
                            ink: palette.ink,
                            paper: palette.paper,
                            muted: palette.muted,
                            fill: null,
                            fluid: null,
                            fluidLabel: "",
                            gas: false,
                            pipe: null,
                            lines: 0,
                            states: { no: palette.no, nc: palette.nc, fip: palette.fip },
                            drawing,
                            meta,
                        };
                        const part = { ...item.part, rotation: 0 as const, flip: false, scale: 1 };
                        return (
                            <g key={index} data-legend={item.name}>
                                <g
                                    transform={`translate(${x + CELL / 2} ${middle}) scale(${scale.toFixed(3)}) translate(${-cx} ${-cy})`}
                                >
                                    {kindOf(part.kind).draw(part, context)}
                                </g>
                                {name(text, middle, item.name)}
                            </g>
                        );
                    }
                    case "line": {
                        const style = LINE_STYLES[item.kind];
                        const slashes =
                            item.kind === "pneumatic"
                                ? `M${x + CELL / 2 - 5} ${middle + 4} L${x + CELL / 2 - 1} ${middle - 4} M${
                                      x + CELL / 2 + 1
                                  } ${middle + 4} L${x + CELL / 2 + 5} ${middle - 4}`
                                : null;
                        return (
                            <g key={index} data-legend={item.name}>
                                <path
                                    d={`M${x + 4} ${middle} H${x + CELL - 4}`}
                                    fill="none"
                                    stroke={palette.ink}
                                    strokeWidth={style.width}
                                    strokeDasharray={style.dash}
                                />
                                {slashes && <path d={slashes} fill="none" stroke={palette.ink} strokeWidth={1.2} />}
                                {name(text, middle, item.name)}
                            </g>
                        );
                    }
                    case "fluid":
                        return (
                            <g key={index} data-legend={item.name}>
                                <path
                                    d={`M${x + 4} ${middle} H${x + CELL - 4}`}
                                    stroke={item.fluid.color}
                                    strokeWidth={3}
                                    strokeLinecap="round"
                                />
                                {name(text, middle, item.name)}
                            </g>
                        );
                    case "state": {
                        const color = { NO: palette.no, NC: palette.nc, FIP: palette.fip }[item.state];
                        const [l, r] = [x + CELL / 2 - 9, x + CELL / 2 + 9];
                        return (
                            <g key={index} data-legend={item.name}>
                                <path
                                    d={`M${l} ${middle - 6} L${r} ${middle + 6} L${r} ${middle - 6} L${l} ${middle + 6} Z`}
                                    fill={color}
                                    strokeWidth={1}
                                    {...ink}
                                />
                                {name(text, middle, item.name)}
                            </g>
                        );
                    }
                }
            })}
        </g>
    );
}
