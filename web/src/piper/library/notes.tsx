import { imageHref } from "../api";
import type { Drawing, Part } from "../drawing";
import { fluidsUsed } from "../fluids";
import { FONT, ink } from "./draw";
import type { DrawContext, Field, Kind } from "./kinds";

// What's written on a drawing rather than built: notes, regions around a part of the system (the vehicle, the GSE),
// off-page connectors, a legend of its fluids and states, a title block, and pictures.

const SIZES: Record<string, number> = { small: 10, "": 13, large: 17, title: 24 };

const TEXT_SIZE: Field = {
    key: "size",
    label: "Size",
    type: "select",
    options: [
        { value: "small", label: "Small" },
        { value: "", label: "Normal" },
        { value: "large", label: "Large" },
        { value: "title", label: "Title" },
    ],
};

const choice = (key: string, label: string, options: [string, string][]): Field => ({
    key,
    label,
    type: "select",
    options: options.map(([value, name]) => ({ value, label: name })),
});

const TEXT_FIELDS: Field[] = [
    TEXT_SIZE,
    choice("weight", "Weight", [
        ["", "Normal"],
        ["bold", "Bold"],
    ]),
    choice("slant", "Slant", [
        ["", "Upright"],
        ["italic", "Italic"],
    ]),
    // As a PDF prints them: its standard Helvetica, Times, and Courier.
    choice("font", "Font", [
        ["", "Sans serif (Helvetica)"],
        ["serif", "Serif (Times)"],
        ["mono", "Monospace (Courier)"],
    ]),
    choice("align", "Align", [
        ["", "Center"],
        ["left", "Left"],
        ["right", "Right"],
    ]),
    choice("border", "Border", [
        ["", "None"],
        ["box", "A box around it"],
    ]),
];

/** The fonts a text block's in on screen, as close to the PDF's as a browser has them. */
const FAMILIES: Record<string, string> = {
    "": FONT,
    serif: "Georgia, 'Times New Roman', Times, serif",
    mono: "'SF Mono', Menlo, Consolas, 'Courier New', monospace",
};

/** About how wide a letter is, of the size, in each font: words are measured without a page to measure them on. */
const LETTER_WIDTH: Record<string, number> = { "": 0.56, serif: 0.5, mono: 0.6 };

const sizeOf = (part: Part) => SIZES[part.props.size ?? ""] ?? 13;
const letterWidth = (part: Part) => (LETTER_WIDTH[part.props.font ?? ""] ?? 0.56) * sizeOf(part);

/** Its words' lines: as they're typed, and, in a block of a set width, wrapped to it at the spaces. */
function linesOf(part: Part): string[] {
    const typed = (part.text || "Text").split("\n");
    if (part.w <= 0) {
        return typed;
    }
    const most = Math.max(1, Math.floor((part.w - 8) / letterWidth(part)));
    return typed.flatMap((line) => {
        const wrapped: string[] = [];
        let now = "";
        for (const word of line.split(" ")) {
            const next = now ? `${now} ${word}` : word;
            if (next.length > most && now) {
                wrapped.push(now);
                now = word;
            } else {
                now = next;
            }
        }
        return [...wrapped, now];
    });
}

/** Its box: a text block's own size, or, until it's given one, its words'. */
function textBox(part: Part): readonly [number, number, number, number] {
    if (part.w > 0) {
        return [-part.w / 2, -part.h / 2, part.w / 2, part.h / 2];
    }
    const size = sizeOf(part);
    const lines = linesOf(part);
    const w = (Math.max(...lines.map((line) => Math.max(1, line.length))) * letterWidth(part)) / 2 + 4;
    const h = (lines.length * size * 1.25) / 2 + 2;
    return [-w, -h, w, h];
}

/**
 * Words on the drawing: a note sized to its words, or a text block of a set width and height (dragged to it), its
 * words wrapped to the width; in a size, weight, slant, and font, aligned, and boxed or not.
 */
export const text: Kind = {
    id: "text",
    name: "Text",
    box: textBox,
    ports: () => [],
    fields: TEXT_FIELDS,
    tag: "none",
    text: "Text",
    resizable: true,
    resize: { step: 10, least: [40, 20] },
    draw: (part, context) => {
        const size = sizeOf(part);
        const lines = linesOf(part);
        const [x0, y0, x1, y1] = textBox(part);
        const align = part.props.align ?? "";
        const set = part.w > 0; // a block of its own size: its words from its top, as aligned
        const x = !set || align === "" ? 0 : align === "left" ? x0 + 4 : x1 - 4;
        const anchor = !set || align === "" ? "middle" : align === "left" ? "start" : "end";
        const top = set ? y0 + 4 + size * 0.9 : (-(lines.length - 1) * size * 1.25) / 2;
        return (
            <>
                {part.props.border === "box" && (
                    <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={context.paper} {...ink(context, 1)} />
                )}
                <text
                    fontSize={size}
                    fontFamily={FAMILIES[part.props.font ?? ""] ?? FONT}
                    fontWeight={part.props.weight === "bold" || part.props.size === "title" ? 700 : 500}
                    fontStyle={part.props.slant === "italic" ? "italic" : undefined}
                    textAnchor={anchor}
                    dominantBaseline={set ? undefined : "central"}
                    fill={part.text ? context.ink : context.muted}
                >
                    {lines.map((line, index) => (
                        <tspan key={index} x={x} y={top + index * size * 1.25}>
                            {line || " "}
                        </tspan>
                    ))}
                </text>
            </>
        );
    },
};

/** A region: a dashed box around a part of the system, named at its top left. Drawn under everything. */
export const region: Kind = {
    id: "region",
    name: "Region",
    box: (part) => [-part.w / 2, -part.h / 2, part.w / 2, part.h / 2],
    ports: () => [],
    fields: [],
    tag: "none",
    text: "Title",
    resizable: true,
    behind: true,
    draw: (part, context) => (
        <>
            <rect
                x={-part.w / 2}
                y={-part.h / 2}
                width={part.w}
                height={part.h}
                rx={8}
                fill="none"
                strokeDasharray="10 5"
                {...ink({ ...context, ink: context.muted }, 1.4)}
            />
            {part.text && (
                <text
                    x={-part.w / 2 + 10}
                    y={-part.h / 2 + 18}
                    fontSize={12}
                    fontFamily={FONT}
                    fontWeight={700}
                    letterSpacing="0.08em"
                    fill={context.muted}
                >
                    {part.text.toUpperCase()}
                </text>
            )}
        </>
    ),
};

/** A picture's shape, width over height, as its pixels are: its box keeps it as it's sized. */
export function pictureAspect(part: Part): number | null {
    const width = Number(part.props.imageWidth);
    const height = Number(part.props.imageHeight);
    return width > 0 && height > 0 ? width / height : null;
}

/**
 * A picture of the team's own (an injector, a TCA), drawn to its box in its own proportions: a PNG or a JPEG added to
 * Piper (server/.../piper/images.py), named by its SHA-256. Until it has one, a box saying to choose one.
 */
export const picture: Kind = {
    id: "picture",
    name: "Picture",
    box: (part) => [-part.w / 2, -part.h / 2, part.w / 2, part.h / 2],
    ports: () => [],
    fields: [],
    tag: "beside",
    resizable: true,
    resize: { step: 5, least: [20, 20], aspect: pictureAspect },
    draw: (part, context) =>
        part.props.image ? (
            <image
                href={imageHref(part.props.image)}
                x={-part.w / 2}
                y={-part.h / 2}
                width={part.w}
                height={part.h}
                preserveAspectRatio="xMidYMid meet"
            />
        ) : (
            <>
                <rect
                    x={-part.w / 2}
                    y={-part.h / 2}
                    width={part.w}
                    height={part.h}
                    fill="none"
                    strokeDasharray="6 4"
                    {...ink({ ...context, ink: context.muted }, 1.2)}
                />
                <text
                    x={0}
                    y={0}
                    fontSize={11}
                    fontFamily={FONT}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={context.muted}
                >
                    Choose a picture
                </text>
            </>
        ),
};

/**
 * How wide an off-page connector's box is, to its point: 48, or wider for its words (a page's name, TO VEHICLE
 * STAND), at about two thirds of their size a letter, as bold capitals are.
 */
const connectorWidth = (part: Part) => Math.max(48, Math.ceil((part.text || "TO").length * 0.68 * 9) + 8);

/** Where a line goes on to another drawing: an arrow-shaped box saying where, as wide as its words. */
export const offpage: Kind = {
    id: "offpage",
    name: "Off-page connector",
    box: (part) => [-40, -12, -30 + connectorWidth(part) + 12, 12],
    ports: () => [{ id: "in", x: -40, y: 0, dir: "left", inset: 10 }],
    fields: [],
    tag: "none",
    text: "Goes to",
    draw: (part, context) => (
        <>
            <path
                d={`M-30 -12 H${-30 + connectorWidth(part)} l12 12 l-12 12 H-30 Z`}
                fill={context.paper}
                {...ink(context)}
            />
            <text
                x={-30 + connectorWidth(part) / 2}
                y={0}
                fontSize={9}
                fontFamily={FONT}
                fontWeight={600}
                textAnchor="middle"
                dominantBaseline="central"
                fill={context.ink}
            >
                {part.text || "TO"}
            </text>
        </>
    ),
};

interface LegendRow {
    label: string;
    color: string;
    valve: boolean; // a valve's state, rather than a fluid's line
}

function legendRows(drawing: Drawing, context?: DrawContext): LegendRow[] {
    const rows: LegendRow[] = fluidsUsed(drawing).map((fluid) => ({
        label: fluid.label && fluid.label !== fluid.name ? `${fluid.label}: ${fluid.name}` : fluid.name,
        color: fluid.color,
        valve: false,
    }));
    const normal = new Set(drawing.parts.map((part) => part.props.normal ?? ""));
    if (normal.has("NO")) {
        rows.push({ label: "Normally open", color: context?.states.no ?? "", valve: true });
    }
    if (normal.has("NC")) {
        rows.push({ label: "Normally closed", color: context?.states.nc ?? "", valve: true });
    }
    if (normal.has("FIP")) {
        rows.push({ label: "Fails in place", color: context?.states.fip ?? "", valve: true });
    }
    return rows;
}

const legendHeight = (rows: number) => 30 + Math.max(1, rows) * 18;

/** The legend: the fluids the drawing's lines carry, and the colors of its valves' states. */
export const legend: Kind = {
    id: "legend",
    name: "Legend",
    box: (_part, drawing) => {
        const h = legendHeight(legendRows(drawing).length);
        return [-90, -h / 2, 90, h / 2];
    },
    ports: () => [],
    fields: [],
    tag: "none",
    draw: (_part, context) => {
        const rows = legendRows(context.drawing, context);
        const h = legendHeight(rows.length);
        return (
            <>
                <rect x={-90} y={-h / 2} width={180} height={h} fill={context.paper} {...ink(context, 1.2)} />
                <text
                    x={-80}
                    y={-h / 2 + 18}
                    fontSize={10}
                    fontFamily={FONT}
                    fontWeight={700}
                    letterSpacing="0.1em"
                    fill={context.ink}
                >
                    LEGEND
                </text>
                {rows.length === 0 && (
                    <text x={-80} y={-h / 2 + 39} fontSize={9.5} fontFamily={FONT} fill={context.muted}>
                        Lines' fluids show here
                    </text>
                )}
                {rows.map((row, index) => {
                    const y = -h / 2 + 39 + index * 18;
                    return (
                        <g key={row.label}>
                            {row.valve ? (
                                <path
                                    d={`M-78 ${y - 6} L-62 ${y + 6} L-62 ${y - 6} L-78 ${y + 6} Z`}
                                    fill={row.color}
                                    {...ink(context, 1)}
                                />
                            ) : (
                                <path d={`M-80 ${y} H-58`} stroke={row.color} strokeWidth={3} strokeLinecap="round" />
                            )}
                            <text
                                x={-50}
                                y={y}
                                fontSize={9.5}
                                fontFamily={FONT}
                                dominantBaseline="central"
                                fill={context.ink}
                            >
                                {row.label}
                            </text>
                        </g>
                    );
                })}
            </>
        );
    },
};

const BLOCK_FIELDS: Field[] = [
    { key: "title", label: "Title", type: "text", placeholder: "The diagram's name" },
    { key: "number", label: "Drawing number", type: "text", placeholder: "YJSP-PID-001" },
    { key: "revision", label: "Revision", type: "text", placeholder: "The latest revision" },
    { key: "drawn", label: "Drawn by", type: "text", placeholder: "Whoever made the diagram" },
    { key: "checked", label: "Checked by", type: "text" },
    { key: "date", label: "Date", type: "text", placeholder: "The last save's" },
];

function Cell({
    x,
    y,
    label,
    value,
    context,
    size = 10,
}: {
    x: number;
    y: number;
    label: string;
    value: string;
    context: DrawContext;
    size?: number;
}) {
    return (
        <>
            <text x={x + 5} y={y + 9} fontSize={6.5} fontFamily={FONT} letterSpacing="0.08em" fill={context.muted}>
                {label}
            </text>
            <text x={x + 5} y={y + 11 + size} fontSize={size} fontFamily={FONT} fontWeight={600} fill={context.ink}>
                {value}
            </text>
        </>
    );
}

/** A title block: what the drawing is, its number and revision, and who drew and checked it. */
export const titleblock: Kind = {
    id: "titleblock",
    name: "Title block",
    box: () => [-150, -40, 150, 40],
    ports: () => [],
    fields: BLOCK_FIELDS,
    tag: "none",
    draw: (part, context) => {
        const meta = context.meta;
        const value = (key: string, fallback: string) => part.props[key] || fallback;
        const date = meta.savedAt ? new Date(meta.savedAt).toLocaleDateString("en-CA") : "";
        return (
            <>
                <rect x={-150} y={-40} width={300} height={80} fill={context.paper} {...ink(context, 1.4)} />
                <path d="M-150 -8 H150 M-150 16 H150 M80 -40 V-8 M-50 -8 V40 M30 -8 V40" {...ink(context, 1)} />
                <Cell x={-150} y={-40} label="TITLE" value={value("title", meta.name)} context={context} size={12} />
                <text
                    x={115}
                    y={-24}
                    fontSize={14}
                    fontFamily={FONT}
                    fontWeight={800}
                    letterSpacing="0.2em"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={context.ink}
                >
                    YJSP
                </text>
                <Cell x={-150} y={-8} label="DRAWING" value={value("number", "")} context={context} />
                <Cell x={-50} y={-8} label="REVISION" value={value("revision", meta.revision)} context={context} />
                <Cell x={30} y={-8} label="DATE" value={value("date", date)} context={context} />
                <Cell x={-150} y={16} label="DRAWN" value={value("drawn", meta.by)} context={context} />
                <Cell x={-50} y={16} label="CHECKED" value={value("checked", "")} context={context} />
                <Cell x={30} y={16} label="SHEET" value={meta.sheet ?? "1 OF 1"} context={context} />
            </>
        );
    },
};

export const NOTE_KINDS: Kind[] = [text, region, offpage, legend, titleblock, picture];
