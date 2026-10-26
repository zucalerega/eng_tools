import type { Part } from "../drawing";
import { upright, type Dir } from "../geometry";
import { FONT } from "./draw";
import { NOTES, type DrawContext, type Kind, type Port } from "./kinds";

// A figure: a shape drawn as it was in Visio, for what Piper has no part of its own for (a drawing's vehicle and its
// tanks, a title block, a symbol of the team's own): its outlines, fills, and words as Visio drew them, so an imported
// drawing looks as it did. What it draws is kept in its props (figure: JSON, in its own frame, centered, at the size it
// was imported at), with ports where lines were glued to it. Black and white are drawn in the page's ink and paper, as
// Piper's own parts are, so a figure reads on a dark page too.

/** An outline: an SVG path's data, filled and stroked (or not). */
export interface FigurePath {
    d: string; // in the figure's frame
    fill?: string; // #rrggbb; left out: not filled
    opacity?: number; // its fill's, where it's see-through
    stroke?: string; // left out: no line
    width?: number;
    dash?: string; // an SVG dash array
}

/** A run of words set otherwise than their text's first: in a size, color, or weight of its own. */
export interface FigureRun {
    text: string;
    size?: number; // left out: the text's
    color?: string;
    bold?: boolean;
    italic?: boolean;
}

/** Words: their lines, from where the first one's anchored (its baseline), turned about it. */
export interface FigureText {
    x: number;
    y: number;
    lines: string[];
    runs?: FigureRun[][]; // each line's runs, where they're set otherwise than its first words
    size: number;
    pitch?: number; // from one line to the next; left out: 1.2 of its size
    color?: string; // left out: ink
    bold?: boolean;
    italic?: boolean;
    font?: "serif" | "mono"; // left out: sans serif
    anchor?: "start" | "end"; // left out: centered on x
    angle?: number; // degrees, clockwise
    halo?: string; // the color behind them, where Visio put one
}

export interface FigurePort {
    id: string;
    x: number;
    y: number;
    dir: Dir | null;
}

export interface Figure {
    w: number; // the size it was drawn at: a part sized otherwise draws it bigger or smaller
    h: number;
    paths: FigurePath[];
    texts: FigureText[];
    ports: FigurePort[];
}

const EMPTY: Figure = { w: 0, h: 0, paths: [], texts: [], ports: [] };

const COLOR = /^#[0-9a-f]{6}$/i;
const PATH = /^[MLCZmlcz0-9.\-\s]*$/;
const DIRS: readonly string[] = ["left", "right", "up", "down"];

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const color = (value: unknown): string | undefined =>
    typeof value === "string" && COLOR.test(value) ? value : undefined;

/** A figure's drawing as its part keeps it, whatever was sent: what isn't a figure's left out. */
function parseFigure(text: string | undefined): Figure {
    let value: unknown;
    try {
        value = JSON.parse(text ?? "");
    } catch {
        return EMPTY;
    }
    if (typeof value !== "object" || value === null) {
        return EMPTY;
    }
    const raw = value as Record<string, unknown>;
    const list = (key: string): Record<string, unknown>[] =>
        Array.isArray(raw[key])
            ? (raw[key] as unknown[]).filter(
                  (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
              )
            : [];
    return {
        w: finite(raw.w) ? Math.max(0, raw.w) : 0,
        h: finite(raw.h) ? Math.max(0, raw.h) : 0,
        paths: list("paths")
            .filter((path) => typeof path.d === "string" && PATH.test(path.d))
            .map((path) => ({
                d: path.d as string,
                fill: color(path.fill),
                opacity: finite(path.opacity) ? path.opacity : undefined,
                stroke: color(path.stroke),
                width: finite(path.width) ? path.width : undefined,
                dash: typeof path.dash === "string" && /^[\d.\s]*$/.test(path.dash) ? path.dash : undefined,
            })),
        texts: list("texts")
            .filter((text) => finite(text.x) && finite(text.y) && finite(text.size) && Array.isArray(text.lines))
            .map((text) => ({
                x: text.x as number,
                y: text.y as number,
                lines: (text.lines as unknown[]).map((line) => (typeof line === "string" ? line : "")),
                runs: Array.isArray(text.runs)
                    ? (text.runs as unknown[]).map((line) =>
                          Array.isArray(line)
                              ? line
                                    .filter(
                                        (run): run is Record<string, unknown> =>
                                            typeof run === "object" && run !== null && typeof run.text === "string",
                                    )
                                    .map((run) => ({
                                        text: run.text as string,
                                        size: finite(run.size) ? run.size : undefined,
                                        color: color(run.color),
                                        bold: typeof run.bold === "boolean" ? run.bold : undefined,
                                        italic: typeof run.italic === "boolean" ? run.italic : undefined,
                                    }))
                              : [],
                      )
                    : undefined,
                size: text.size as number,
                pitch: finite(text.pitch) ? text.pitch : undefined,
                color: color(text.color),
                bold: text.bold === true,
                italic: text.italic === true,
                font: text.font === "serif" || text.font === "mono" ? text.font : undefined,
                anchor: text.anchor === "start" || text.anchor === "end" ? text.anchor : undefined,
                angle: finite(text.angle) ? text.angle : undefined,
                halo: color(text.halo),
            })),
        ports: list("ports")
            .filter((port) => typeof port.id === "string" && finite(port.x) && finite(port.y))
            .map((port) => ({
                id: port.id as string,
                x: port.x as number,
                y: port.y as number,
                dir: typeof port.dir === "string" && DIRS.includes(port.dir) ? (port.dir as Dir) : null,
            })),
    };
}

const read = new WeakMap<Part, Figure>();

/** A figure part's drawing (each part read once: a part is never changed, only replaced). */
export function figureOf(part: Part): Figure {
    let found = read.get(part);
    if (!found) {
        found = parseFigure(part.props.figure);
        read.set(part, found);
    }
    return found;
}

/**
 * A color as a figure draws it: black and white (and the grays a drawing's white often is, #fefefe) in the page's ink
 * and paper; any other as it is.
 */
function paintOf(value: string, context: DrawContext): string {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as [number, number, number];
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 12) {
        if (Math.min(r, g, b) >= 240) {
            return context.paper;
        }
        if (Math.max(r, g, b) <= 24) {
            return context.ink;
        }
    }
    return value;
}

/** How much bigger or smaller a figure's part is drawn than its drawing, across and down. */
function stretch(part: Part, figure: Figure): { x: number; y: number } {
    return {
        x: figure.w > 0 && part.w > 0 ? part.w / figure.w : 1,
        y: figure.h > 0 && part.h > 0 ? part.h / figure.h : 1,
    };
}

const FAMILIES = {
    sans: FONT,
    serif: "Georgia, 'Times New Roman', Times, serif",
    mono: "'SF Mono', Menlo, Consolas, 'Courier New', monospace",
};

export const figure: Kind = {
    id: "figure",
    name: "Figure",
    box: (part) => [-part.w / 2, -part.h / 2, part.w / 2, part.h / 2],
    ports: (part): Port[] => {
        const drawn = figureOf(part);
        const by = stretch(part, drawn);
        return drawn.ports.map((port) => ({
            id: port.id,
            x: port.x * by.x,
            y: port.y * by.y,
            dir: port.dir,
            inset: 0,
        }));
    },
    fields: [NOTES],
    tag: "beside",
    resizable: true,
    resize: { step: 5, least: [10, 10] },
    // Under the lines, as a P&ID's vehicle and tanks are under its pipes, and clicked only at its edge, so what's on
    // it (its pipes, its valves) can be.
    behind: true,
    draw: (part, context) => {
        const drawn = figureOf(part);
        const by = stretch(part, drawn);
        const paint = (value: string) => paintOf(value, context);
        const size = Math.min(by.x, by.y);
        return (
            <>
                <g transform={by.x !== 1 || by.y !== 1 ? `scale(${by.x} ${by.y})` : undefined}>
                    {drawn.paths.map((path, index) => (
                        <path
                            key={index}
                            d={path.d}
                            fill={path.fill ? paint(path.fill) : "none"}
                            fillOpacity={path.opacity}
                            stroke={path.stroke ? paint(path.stroke) : "none"}
                            strokeWidth={path.width}
                            strokeDasharray={path.dash}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                        />
                    ))}
                </g>
                {drawn.texts.map((text, index) => {
                    const x = text.x * by.x;
                    const y = text.y * by.y;
                    const letters = text.size * size;
                    return (
                        <text
                            key={index}
                            x={x}
                            y={y}
                            transform={`${upright(part, x, y)}${text.angle ? ` rotate(${text.angle} ${x} ${y})` : ""}`}
                            fontSize={letters}
                            fontFamily={FAMILIES[text.font ?? "sans"]}
                            fontWeight={text.bold ? 700 : 400}
                            fontStyle={text.italic ? "italic" : undefined}
                            textAnchor={text.anchor ?? "middle"}
                            fill={paint(text.color ?? "#000000")}
                            stroke={text.halo ? paint(text.halo) : undefined}
                            strokeWidth={text.halo ? letters * 0.3 : undefined}
                            paintOrder={text.halo ? "stroke" : undefined}
                        >
                            {text.lines.map((line, row) => {
                                const dy = row === 0 ? 0 : (text.pitch ?? text.size * 1.2) * size;
                                const runs = text.runs?.[row];
                                if (!runs || runs.length === 0) {
                                    return (
                                        <tspan key={row} x={x} dy={dy}>
                                            {line || " "}
                                        </tspan>
                                    );
                                }
                                // Each run of a line after its first carries on from where the one before ended.
                                return runs.map((run, index) => (
                                    <tspan
                                        key={`${row}:${index}`}
                                        x={index === 0 ? x : undefined}
                                        dy={index === 0 ? dy : undefined}
                                        fontSize={run.size !== undefined ? run.size * size : undefined}
                                        fill={run.color ? paint(run.color) : undefined}
                                        fontWeight={run.bold === undefined ? undefined : run.bold ? 700 : 400}
                                        fontStyle={
                                            run.italic === undefined ? undefined : run.italic ? "italic" : "normal"
                                        }
                                    >
                                        {run.text}
                                    </tspan>
                                ));
                            })}
                        </text>
                    );
                })}
            </>
        );
    },
};
