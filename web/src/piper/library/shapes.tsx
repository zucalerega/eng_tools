import type { Part } from "../drawing";
import { paintOf } from "./figures";
import type { DrawContext, Field, Kind } from "./kinds";

// Shapes: boxes, ellipses, triangles, diamonds, lines, and arrows drawn on a drawing for how it looks, not as part of
// the system, each in a color, an outline, a size, and a transparency of its own. They're drawn over the lines, as
// parts are, but lines route through them and labels sit on them; they have no ports, and the parts list, the legend,
// Find, and the simulation leave them out (Kind.aside). What they look like is in their props, as text, so a drawing
// with them is a drawing as before: a Piper from before them keeps them, drawn as the dashed box it draws a kind it
// doesn't know as.

/** Black, the page's ink: an outline's color until it's given one, and a fill's swatch until it has one. */
const INK = "#000000";

const COLOR = /^#[0-9a-f]{6}$/i;

const choice = (key: string, label: string, options: [string, string][]): Field => ({
    key,
    label,
    type: "select",
    options: options.map(([value, name]) => ({ value, label: name })),
});

const SHAPE = choice("shape", "Shape", [
    ["", "Rectangle"],
    ["rounded", "Rounded rectangle"],
    ["ellipse", "Ellipse"],
    ["triangle", "Triangle"],
    ["diamond", "Diamond"],
]);

const FILL: Field = { key: "fill", label: "Fill", type: "color", placeholder: "No fill", swatch: "#ffffff" };
const OUTLINE: Field = { key: "outline", label: "Outline", type: "color", placeholder: "Ink", swatch: INK };
const COLOR_FIELD: Field = { ...OUTLINE, label: "Color" };

const WEIGHTS: Record<string, number> = { thin: 1, "": 1.6, thick: 3, heavy: 5 };
const WEIGHT = choice("weight", "Weight", [
    ["thin", "Thin"],
    ["", "Normal"],
    ["thick", "Thick"],
    ["heavy", "Heavy"],
]);

const DASHES: [string, string][] = [
    ["", "Solid"],
    ["dashed", "Dashed"],
    ["dotted", "Dotted"],
];
const OUTLINE_STYLE = choice("dash", "Outline style", [...DASHES, ["none", "No outline"]]);
const LINE_STYLE = choice("dash", "Style", DASHES);

const TRANSPARENCY = choice("transparency", "Transparency", [
    ["", "Opaque"],
    ...[10, 25, 50, 75, 90].map((percent): [string, string] => [String(percent), `${percent}%`]),
]);

const HEADS = choice("heads", "Arrowheads", [
    ["", "None (a line)"],
    ["end", "At its end"],
    ["start", "At its start"],
    ["both", "At both ends"],
]);

const SLANT = choice("slant", "Direction", [
    ["", "Level, across its box"],
    ["down", "Down, corner to corner"],
    ["up", "Up, corner to corner"],
]);

/** How see-through it is, as an opacity: 1 opaque, to 0.1 at 90%. Anything else said of it is opaque. */
function opacityOf(part: Part): number {
    const percent = Number(part.props.transparency ?? "");
    return Number.isFinite(percent) && percent > 0 && percent < 100 ? Math.round(100 - percent) / 100 : 1;
}

/** A color it's given, as it's drawn (black and white as the page's ink and paper, as a figure's are), or null. */
function colorOf(value: string | undefined, context: DrawContext): string | null {
    return value && COLOR.test(value) ? paintOf(value, context) : null;
}

const weightOf = (part: Part): number => WEIGHTS[part.props.weight ?? ""] ?? WEIGHTS[""]!;

/** Its outline's dashes, in its weight: dashed, dotted, or solid (undefined). */
function dashOf(part: Part): string | undefined {
    const width = weightOf(part);
    if (part.props.dash === "dashed") {
        return `${Math.max(6, width * 4)} ${Math.max(4, width * 2.5)}`;
    }
    if (part.props.dash === "dotted") {
        return `${width} ${Math.max(3, width * 2)}`;
    }
    return undefined;
}

/** A shape's outline in its box, its half width and height either side of its middle: SVG path data. */
function outlineOf(shape: string, w: number, h: number): string {
    const [x, y] = [w / 2, h / 2];
    switch (shape) {
        case "ellipse":
            return `M${-x} 0 A${x} ${y} 0 0 1 ${x} 0 A${x} ${y} 0 0 1 ${-x} 0 Z`;
        case "triangle":
            return `M0 ${-y} L${x} ${y} L${-x} ${y} Z`;
        case "diamond":
            return `M0 ${-y} L${x} 0 L0 ${y} L${-x} 0 Z`;
        case "rounded": {
            const r = Math.min(10, x, y);
            return (
                `M${-x + r} ${-y} L${x - r} ${-y} A${r} ${r} 0 0 1 ${x} ${-y + r} L${x} ${y - r} ` +
                `A${r} ${r} 0 0 1 ${x - r} ${y} L${-x + r} ${y} A${r} ${r} 0 0 1 ${-x} ${y - r} ` +
                `L${-x} ${-y + r} A${r} ${r} 0 0 1 ${-x + r} ${-y} Z`
            );
        }
        default:
            return `M${-x} ${-y} L${x} ${-y} L${x} ${y} L${-x} ${y} Z`;
    }
}

const boxed = (part: Part) => [-part.w / 2, -part.h / 2, part.w / 2, part.h / 2] as const;

/** A closed shape: a rectangle (rounded or not), an ellipse, a triangle, or a diamond, filled or not. */
export const shape: Kind = {
    id: "shape",
    name: "Shape",
    title: (part) => SHAPE.options!.find((option) => option.value === (part.props.shape ?? ""))?.label ?? "Shape",
    box: boxed,
    ports: () => [],
    fields: [SHAPE, FILL, OUTLINE, OUTLINE_STYLE, WEIGHT, TRANSPARENCY],
    tag: "none",
    resizable: true,
    resize: { step: 5, least: [10, 10] },
    aside: true,
    draw: (part, context) => {
        const fill = colorOf(part.props.fill, context);
        const outlined = part.props.dash !== "none";
        const opacity = opacityOf(part);
        return (
            <path
                d={outlineOf(part.props.shape ?? "", part.w, part.h)}
                fill={fill ?? "none"}
                fillOpacity={fill && opacity < 1 ? opacity : undefined}
                stroke={outlined ? (colorOf(part.props.outline, context) ?? context.ink) : "none"}
                strokeOpacity={outlined && opacity < 1 ? opacity : undefined}
                strokeWidth={outlined ? weightOf(part) : undefined}
                strokeDasharray={outlined ? dashOf(part) : undefined}
                strokeLinejoin="round"
            />
        );
    },
};

/** Where a line or an arrow runs in its box: level across its middle, or from one corner to the other. */
function endsOf(part: Part): [{ x: number; y: number }, { x: number; y: number }] {
    const [x, y] = [part.w / 2, part.h / 2];
    if (part.props.slant === "down") {
        return [
            { x: -x, y: -y },
            { x, y },
        ];
    }
    if (part.props.slant === "up") {
        return [
            { x: -x, y },
            { x, y: -y },
        ];
    }
    return [
        { x: -x, y: 0 },
        { x, y: 0 },
    ];
}

/** An arrowhead's length, in its line's weight, and how much of it is across, either side. */
const headLength = (width: number) => 6 + width * 3;
const HEAD_SPREAD = 0.45;

/**
 * A line, or an arrow (its heads at its end, its start, or both): straight, level or corner to corner across its box,
 * so its box's size sets its length and its angle, and turning it sets which way it goes.
 */
export const arrow: Kind = {
    id: "arrow",
    name: "Line",
    title: (part) => ({ end: "Arrow", start: "Arrow", both: "Double arrow" })[part.props.heads ?? ""] ?? "Line",
    box: boxed,
    ports: () => [],
    fields: [HEADS, SLANT, COLOR_FIELD, LINE_STYLE, WEIGHT, TRANSPARENCY],
    tag: "none",
    resizable: true,
    resize: { step: 5, least: [10, 10] },
    aside: true,
    hit: (part) => {
        const [a, b] = endsOf(part);
        return `M${a.x} ${a.y} L${b.x} ${b.y}`;
    },
    draw: (part, context) => {
        const [a, b] = endsOf(part);
        const color = colorOf(part.props.outline, context) ?? context.ink;
        const width = weightOf(part);
        const opacity = opacityOf(part);
        const heads = part.props.heads ?? "";
        const atEnd = heads === "end" || heads === "both";
        const atStart = heads === "start" || heads === "both";
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        // Along the line, and across it; and each head no longer than half of it, so two don't cross.
        const along = length > 0 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : { x: 1, y: 0 };
        const across = { x: -along.y, y: along.x };
        const head = Math.min(headLength(width), length / (atEnd && atStart ? 2 : 1));
        const headAt = (tip: { x: number; y: number }, back: number) => {
            const base = { x: tip.x - along.x * head * back, y: tip.y - along.y * head * back };
            const spread = head * HEAD_SPREAD;
            const left = `${base.x + across.x * spread} ${base.y + across.y * spread}`;
            const right = `${base.x - across.x * spread} ${base.y - across.y * spread}`;
            return `M${tip.x} ${tip.y} L${left} L${right} Z`;
        };
        // The line runs to each head's base, not under it, so a see-through arrow isn't darker where they'd overlap.
        const from = atStart ? { x: a.x + along.x * head, y: a.y + along.y * head } : a;
        const to = atEnd ? { x: b.x - along.x * head, y: b.y - along.y * head } : b;
        const tips = [atStart && headAt(a, -1), atEnd && headAt(b, 1)].filter(Boolean).join(" ");
        return (
            <>
                <path
                    d={`M${from.x} ${from.y} L${to.x} ${to.y}`}
                    fill="none"
                    stroke={color}
                    strokeOpacity={opacity < 1 ? opacity : undefined}
                    strokeWidth={width}
                    strokeDasharray={dashOf(part)}
                    strokeLinecap="butt"
                />
                {tips && <path d={tips} fill={color} fillOpacity={opacity < 1 ? opacity : undefined} stroke="none" />}
            </>
        );
    },
};

export const SHAPE_KINDS: Kind[] = [shape, arrow];
