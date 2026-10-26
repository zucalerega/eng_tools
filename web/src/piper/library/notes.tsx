import type { Drawing, Part } from "../drawing";
import { fluidsUsed } from "../fluids";
import { FONT, ink } from "./draw";
import type { DrawContext, Field, Kind } from "./kinds";

// What's written on a drawing rather than built: notes, regions around a part of the system (the vehicle, the GSE),
// off-page connectors, a legend of its fluids and states, and a title block.

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

const linesOf = (part: Part): string[] => (part.text || "Text").split("\n");

/** About how wide words are, without a page to measure them on: a little over half their size a letter. */
const widthOf = (words: string, size: number): number => Math.max(1, words.length) * size * 0.58;

function textBox(part: Part): readonly [number, number, number, number] {
    const size = SIZES[part.props.size ?? ""] ?? 13;
    const lines = linesOf(part);
    const w = Math.max(...lines.map((line) => widthOf(line, size))) / 2 + 4;
    const h = (lines.length * size * 1.25) / 2 + 2;
    return [-w, -h, w, h];
}

export const text: Kind = {
    id: "text",
    name: "Text",
    box: textBox,
    ports: () => [],
    fields: [TEXT_SIZE],
    tag: "none",
    text: "Text",
    draw: (part, context) => {
        const size = SIZES[part.props.size ?? ""] ?? 13;
        const lines = linesOf(part);
        const top = (-(lines.length - 1) * size * 1.25) / 2;
        return (
            <text
                fontSize={size}
                fontFamily={FONT}
                fontWeight={part.props.size === "title" ? 700 : 500}
                textAnchor="middle"
                dominantBaseline="central"
                fill={part.text ? context.ink : context.muted}
            >
                {lines.map((line, index) => (
                    <tspan key={index} x={0} y={top + index * size * 1.25}>
                        {line || " "}
                    </tspan>
                ))}
            </text>
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

/** Where a line goes on to another drawing: an arrow-shaped box saying where. */
export const offpage: Kind = {
    id: "offpage",
    name: "Off-page connector",
    box: () => [-40, -12, 30, 12],
    ports: () => [{ id: "in", x: -40, y: 0, dir: "left", inset: 10 }],
    fields: [],
    tag: "none",
    text: "Goes to",
    draw: (part, context) => (
        <>
            <path d="M-30 -12 H18 L30 0 L18 12 H-30 Z" fill={context.paper} {...ink(context)} />
            <text
                x={-6}
                y={0}
                fontSize={part.text.length > 9 ? 7.5 : 9}
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
                <Cell
                    x={-50}
                    y={-8}
                    label="REVISION"
                    value={value("revision", meta.revision === null ? "" : String(meta.revision))}
                    context={context}
                />
                <Cell x={30} y={-8} label="DATE" value={value("date", date)} context={context} />
                <Cell x={-150} y={16} label="DRAWN" value={value("drawn", meta.by)} context={context} />
                <Cell x={-50} y={16} label="CHECKED" value={value("checked", "")} context={context} />
                <Cell x={30} y={16} label="SHEET" value="1 OF 1" context={context} />
            </>
        );
    },
};

export const NOTE_KINDS: Kind[] = [text, region, offpage, legend, titleblock];
