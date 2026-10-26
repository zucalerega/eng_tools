import type { Drawing, PageSheet } from "./drawing";
import { svgOf } from "./exports";
import type { DiagramMeta } from "./library/kinds";
import type { Box } from "./geometry";

// A diagram as a PDF file: the drawing as the exports draw it (exports.ts' SVG), turned into PDF's own drawing
// operators, so it's vector, crisp printed at any size, its tags text that can be searched and copied. Only what the
// drawing's SVG has is turned: groups and their transforms, paths (arcs and curves as Béziers), rectangles, circles,
// lines, and text, in PDF's standard fonts (Helvetica, and Times and Courier for text blocks in them: nothing is
// embedded, and the file stays small). The page is the paper chosen, turned to the drawing's way, the drawing fitted on
// it; or the drawing's own size.

export interface Paper {
    id: string;
    name: string;
    width: number; // points, upright
    height: number;
}

export const PAPERS: Paper[] = [
    { id: "tabloid", name: "Tabloid (11 × 17 in)", width: 792, height: 1224 },
    { id: "letter", name: "Letter (8.5 × 11 in)", width: 612, height: 792 },
    { id: "ansi-d", name: "ANSI D (22 × 34 in)", width: 1584, height: 2448 },
    { id: "a3", name: "A3", width: 842, height: 1191 },
    { id: "a4", name: "A4", width: 595, height: 842 },
    { id: "fit", name: "The drawing's own size", width: 0, height: 0 },
];

const MARGIN = 36; // half an inch

// Helvetica's and Helvetica-Bold's widths (thousandths of the font's size) for the characters from space to ~, from
// Adobe's metrics: to place text by its middle, as the drawing's labels are.
const WIDTHS = [
    "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584",
    "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584",
].map((row) => row.split(" ").map(Number));

/** Widths of Windows-1252's other characters, where they're not the usual 556. */
const OTHER_WIDTHS: Record<number, number> = {
    0x85: 1000,
    0x91: 222,
    0x92: 222,
    0x93: 333,
    0x94: 333,
    0x95: 350,
    0x96: 556,
    0x97: 1000,
    0xa0: 278,
    0xb0: 400,
    0xb1: 584,
    0xb2: 333,
    0xb3: 333,
    0xb7: 278,
    0xd7: 584,
    0xd8: 778,
};

// What Windows-1252 (PDF's WinAnsiEncoding) has between 0x80 and 0x9F, which Unicode has elsewhere.
const CP1252: Record<string, number> = {
    "€": 0x80,
    "‚": 0x82,
    ƒ: 0x83,
    "„": 0x84,
    "…": 0x85,
    "†": 0x86,
    "‡": 0x87,
    ˆ: 0x88,
    "‰": 0x89,
    Š: 0x8a,
    "‹": 0x8b,
    Œ: 0x8c,
    Ž: 0x8e,
    "‘": 0x91,
    "’": 0x92,
    "“": 0x93,
    "”": 0x94,
    "•": 0x95,
    "–": 0x96,
    "—": 0x97,
    "˜": 0x98,
    "™": 0x99,
    š: 0x9a,
    "›": 0x9b,
    œ: 0x9c,
    ž: 0x9e,
    Ÿ: 0x9f,
    "−": 0x2d, // a minus sign, as a hyphen: Helvetica has no minus of its own here
};

/** Text as WinAnsiEncoding's bytes: what it can't say, as "?". */
function encode(text: string): number[] {
    return [...text].map((char) => {
        const code = char.codePointAt(0)!;
        if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
            return code;
        }
        return CP1252[char] ?? 0x3f;
    });
}

/** The PDF's standard fonts a drawing's words are in: sans serif (Helvetica), serif (Times), and monospace (Courier),
 * each upright or oblique, regular or bold. */
type Family = "sans" | "serif" | "mono";

const FAMILIES: Family[] = ["sans", "serif", "mono"];

const FONT_NAMES: Record<Family, [string, string, string, string]> = {
    sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
    serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
    mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

/** A style's font's name on the page: F1 is Helvetica, F2 Helvetica-Bold, then the obliques, Times, and Courier. */
const fontKey = (style: { family: Family; bold: boolean; italic: boolean }): string =>
    `F${FAMILIES.indexOf(style.family) * 4 + (style.bold ? 1 : 0) + (style.italic ? 2 : 0) + 1}`;

/** A font from SVG's font-family: monospace, or serif, else sans serif. */
const familyOf = (family: string): Family =>
    /mono|courier/i.test(family) ? "mono" : /(^|[\s,'"])serif|times|georgia/i.test(family) ? "serif" : "sans";

/**
 * How wide words are, in the font's size: Helvetica's own widths; Courier's every letter 0.6; Times', near enough,
 * nine tenths of Helvetica's (the PDF measures them only to center or end words where they're anchored).
 */
const widthOf = (bytes: number[], bold: boolean, family: Family = "sans"): number => {
    if (family === "mono") {
        return bytes.length * 0.6;
    }
    const helvetica =
        bytes.reduce(
            (total, byte) =>
                total +
                (byte >= 0x20 && byte <= 0x7e ? WIDTHS[bold ? 1 : 0]![byte - 0x20]! : (OTHER_WIDTHS[byte] ?? 556)),
            0,
        ) / 1000;
    return family === "serif" ? helvetica * 0.9 : helvetica;
};

/** Bytes as a PDF string: ( and ) and \ escaped, and what isn't printable as an octal escape. */
function pdfString(bytes: number[]): string {
    return `(${bytes
        .map((byte) => {
            if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
                return `\\${String.fromCharCode(byte)}`;
            }
            return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`;
        })
        .join("")})`;
}

/** A number as PDF writes it: to a thousandth, without trailing zeros. */
const n = (value: number): string => {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
};

// --- colors and style ------------------------------------------------------------------------------------------------

function rgb(color: string | null): [number, number, number] | null {
    if (!color || color === "none" || color === "transparent") {
        return null;
    }
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (hex) {
        const digits = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit).join("") : hex[1]!;
        return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16) / 255) as [number, number, number];
    }
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
    if (fn) {
        return [Number(fn[1]) / 255, Number(fn[2]) / 255, Number(fn[3]) / 255];
    }
    return color === "black" ? [0, 0, 0] : color === "white" ? [1, 1, 1] : null;
}

interface Style {
    fill: string | null;
    stroke: string | null;
    strokeWidth: number;
    dash: string | null;
    cap: string;
    join: string;
    fillOpacity: number;
    strokeOpacity: number;
    fontSize: number;
    bold: boolean;
    italic: boolean;
    family: Family;
    anchor: string;
    baseline: string;
    spacing: string;
    strokeFirst: boolean; // paint-order: stroke, as text's halos are drawn
}

const DEFAULT: Style = {
    fill: "#000000",
    stroke: null,
    strokeWidth: 1,
    dash: null,
    cap: "butt",
    join: "miter",
    fillOpacity: 1,
    strokeOpacity: 1,
    fontSize: 16,
    bold: false,
    italic: false,
    family: "sans",
    anchor: "start",
    baseline: "auto",
    spacing: "0",
    strokeFirst: false,
};

/** An element's style: what it says, else what it inherits, as SVG's presentation attributes are inherited. */
function styleOf(element: Element, parent: Style): Style {
    const get = (name: string) => element.getAttribute(name);
    const weight = get("font-weight");
    return {
        fill: get("fill") ?? parent.fill,
        stroke: get("stroke") ?? parent.stroke,
        strokeWidth: get("stroke-width") !== null ? Number(get("stroke-width")) : parent.strokeWidth,
        dash: get("stroke-dasharray") ?? parent.dash,
        cap: get("stroke-linecap") ?? parent.cap,
        join: get("stroke-linejoin") ?? parent.join,
        fillOpacity: get("fill-opacity") !== null ? Number(get("fill-opacity")) : parent.fillOpacity,
        strokeOpacity: get("stroke-opacity") !== null ? Number(get("stroke-opacity")) : parent.strokeOpacity,
        fontSize: get("font-size") !== null ? Number(get("font-size")) : parent.fontSize,
        bold: weight !== null ? weight === "bold" || Number(weight) >= 600 : parent.bold,
        italic: get("font-style") !== null ? /italic|oblique/.test(get("font-style") ?? "") : parent.italic,
        family: get("font-family") !== null ? familyOf(get("font-family") ?? "") : parent.family,
        anchor: get("text-anchor") ?? parent.anchor,
        baseline: get("dominant-baseline") ?? parent.baseline,
        spacing: get("letter-spacing") ?? parent.spacing,
        strokeFirst: get("paint-order") !== null ? (get("paint-order") ?? "").startsWith("stroke") : parent.strokeFirst,
    };
}

// --- shapes as PDF paths -------------------------------------------------------------------------------------------

type Cubic = [number, number, number, number, number, number];

/** An SVG arc, as the Béziers that draw it (SVG's implementation notes, F.6.5: from its ends to its center). */
function arcToCubics(
    x1: number,
    y1: number,
    rx: number,
    ry: number,
    rotation: number,
    large: boolean,
    sweep: boolean,
    x2: number,
    y2: number,
): Cubic[] {
    if (x1 === x2 && y1 === y2) {
        return [];
    }
    if (rx === 0 || ry === 0) {
        return [[x1, y1, x2, y2, x2, y2]];
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (rotation * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy;
    const y1p = -sin * dx + cos * dy;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        rx *= Math.sqrt(lambda);
        ry *= Math.sqrt(lambda);
    }
    const sign = large === sweep ? -1 : 1;
    const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));
    const cxp = (coefficient * rx * y1p) / ry;
    const cyp = (-coefficient * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && delta > 0) {
        delta -= 2 * Math.PI;
    } else if (sweep && delta < 0) {
        delta += 2 * Math.PI;
    }
    const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
    const step = delta / count;
    const k = (4 / 3) * Math.tan(step / 4);
    const map = (ux: number, uy: number): [number, number] => [
        cx + rx * ux * cos - ry * uy * sin,
        cy + rx * ux * sin + ry * uy * cos,
    ];
    const cubics: Cubic[] = [];
    for (let index = 0; index < count; index++) {
        const a = start + index * step;
        const b = a + step;
        const [c1x, c1y] = map(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a));
        const [c2x, c2y] = map(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b));
        const [ex, ey] = map(Math.cos(b), Math.sin(b));
        cubics.push([c1x, c1y, c2x, c2y, ex, ey]);
    }
    return cubics;
}

/** SVG path data as PDF's path operators (m, l, c, h), every command made absolute and every curve cubic. */
export function pathOperators(d: string): string {
    const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
    const out: string[] = [];
    let at = 0;
    let command = "";
    let [x, y, startX, startY] = [0, 0, 0, 0];
    let lastCubic: [number, number] | null = null; // the last control point, for S
    let lastQuad: [number, number] | null = null; // and Q's, for T
    const next = () => Number(tokens[at++]);
    const more = () => at < tokens.length && !/^[a-zA-Z]$/.test(tokens[at]!);
    const cubic = (c: Cubic) => out.push(`${c.map(n).join(" ")} c`);
    while (at < tokens.length) {
        if (/^[a-zA-Z]$/.test(tokens[at]!)) {
            command = tokens[at++]!;
        } else if (!command) {
            break; // numbers before any command: not a path
        }
        const relative = command === command.toLowerCase();
        const dx = relative ? x : 0;
        const dy = relative ? y : 0;
        const upper = command.toUpperCase();
        let cubicControl: [number, number] | null = null;
        let quadControl: [number, number] | null = null;
        switch (upper) {
            case "M":
                x = next() + dx;
                y = next() + dy;
                [startX, startY] = [x, y];
                out.push(`${n(x)} ${n(y)} m`);
                command = relative ? "l" : "L"; // more pairs after a move are lines
                break;
            case "L":
                x = next() + dx;
                y = next() + dy;
                out.push(`${n(x)} ${n(y)} l`);
                break;
            case "H":
                x = next() + dx;
                out.push(`${n(x)} ${n(y)} l`);
                break;
            case "V":
                y = next() + dy;
                out.push(`${n(x)} ${n(y)} l`);
                break;
            case "C": {
                const c: Cubic = [next() + dx, next() + dy, next() + dx, next() + dy, next() + dx, next() + dy];
                cubic(c);
                cubicControl = [c[2], c[3]];
                [x, y] = [c[4], c[5]];
                break;
            }
            case "S": {
                const first: [number, number] = lastCubic ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]] : [x, y];
                const c: Cubic = [first[0], first[1], next() + dx, next() + dy, next() + dx, next() + dy];
                cubic(c);
                cubicControl = [c[2], c[3]];
                [x, y] = [c[4], c[5]];
                break;
            }
            case "Q":
            case "T": {
                const control: [number, number] =
                    upper === "Q"
                        ? [next() + dx, next() + dy]
                        : lastQuad
                          ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]]
                          : [x, y];
                const [ex, ey] = [next() + dx, next() + dy];
                // A quadratic's control, two thirds of the way from each end: the cubic that draws it.
                cubic([
                    x + ((control[0] - x) * 2) / 3,
                    y + ((control[1] - y) * 2) / 3,
                    ex + ((control[0] - ex) * 2) / 3,
                    ey + ((control[1] - ey) * 2) / 3,
                    ex,
                    ey,
                ]);
                quadControl = control;
                [x, y] = [ex, ey];
                break;
            }
            case "A": {
                const [rx, ry, rotation, large, sweep] = [next(), next(), next(), next(), next()];
                const [ex, ey] = [next() + dx, next() + dy];
                arcToCubics(x, y, rx, ry, rotation, large !== 0, sweep !== 0, ex, ey).forEach(cubic);
                [x, y] = [ex, ey];
                break;
            }
            case "Z":
                out.push("h");
                [x, y] = [startX, startY];
                break;
            default:
                return out.join("\n"); // a command SVG doesn't have: what's read so far
        }
        lastCubic = cubicControl;
        lastQuad = quadControl;
        if (upper === "Z" && more()) {
            command = ""; // numbers after a close: not valid
        }
    }
    return out.join("\n");
}

const num = (element: Element, name: string) => Number(element.getAttribute(name) ?? 0) || 0;

/** A circle as four Béziers. */
function circleOperators(cx: number, cy: number, r: number): string {
    const k = 0.5522847498 * r;
    return [
        `${n(cx + r)} ${n(cy)} m`,
        `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
        `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c`,
        `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
        `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c`,
        "h",
    ].join("\n");
}

function rectOperators(element: Element): string {
    const [x, y, w, h] = [num(element, "x"), num(element, "y"), num(element, "width"), num(element, "height")];
    const r = Math.min(num(element, "rx") || num(element, "ry"), w / 2, h / 2);
    if (r <= 0) {
        return `${n(x)} ${n(y)} ${n(w)} ${n(h)} re`;
    }
    return pathOperators(
        `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
            `H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`,
    );
}

/** An element's transform as PDF's cm operators, one for each of its functions, in order. */
function transformOperators(transform: string): string[] {
    const out: string[] = [];
    for (const [, name, args] of transform.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
        const values = (args ?? "")
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number);
        switch (name) {
            case "translate":
                out.push(`1 0 0 1 ${n(values[0] ?? 0)} ${n(values[1] ?? 0)} cm`);
                break;
            case "scale":
                out.push(`${n(values[0] ?? 1)} 0 0 ${n(values[1] ?? values[0] ?? 1)} 0 0 cm`);
                break;
            case "rotate": {
                const radians = ((values[0] ?? 0) * Math.PI) / 180;
                const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
                const [cx, cy] = [values[1] ?? 0, values[2] ?? 0];
                out.push(
                    `1 0 0 1 ${n(cx)} ${n(cy)} cm`,
                    `${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} 0 0 cm`,
                    `1 0 0 1 ${n(-cx)} ${n(-cy)} cm`,
                );
                break;
            }
            case "matrix":
                out.push(`${values.map(n).join(" ")} cm`);
                break;
        }
    }
    return out;
}

// --- the page --------------------------------------------------------------------------------------------------------

class Writer {
    lines: string[] = [];
    readonly opacities = new Map<string, string>(); // fill and stroke opacity: the graphics state's name

    /** The graphics state for an opacity, made once. */
    opacity(fill: number, stroke: number): string {
        const key = `${n(fill)} ${n(stroke)}`;
        let name = this.opacities.get(key);
        if (!name) {
            name = `GS${this.opacities.size}`;
            this.opacities.set(key, name);
        }
        return name;
    }

    /** A shape filled and stroked as its style says (or left out, if it's neither). */
    paint(operators: string, style: Style, closedForFill = true): void {
        const fill = closedForFill ? rgb(style.fill) : null;
        const stroke = rgb(style.stroke);
        if ((!fill && !stroke) || !operators) {
            return;
        }
        this.lines.push("q");
        if (style.fillOpacity < 1 || style.strokeOpacity < 1) {
            this.lines.push(`/${this.opacity(style.fillOpacity, style.strokeOpacity)} gs`);
        }
        if (fill) {
            this.lines.push(`${fill.map(n).join(" ")} rg`);
        }
        if (stroke) {
            this.lines.push(`${stroke.map(n).join(" ")} RG`, `${n(style.strokeWidth)} w`);
            this.lines.push(
                `${{ round: 1, square: 2 }[style.cap] ?? 0} J`,
                `${{ round: 1, bevel: 2 }[style.join] ?? 0} j`,
            );
            const dash = (style.dash ?? "")
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number);
            if (dash.length > 0 && dash.some((value) => value > 0)) {
                this.lines.push(`[${dash.map(n).join(" ")}] 0 d`);
            }
        }
        this.lines.push(operators, fill && stroke ? "B" : fill ? "f" : "S", "Q");
    }

    text(element: Element, inherited: Style): void {
        const style = styleOf(element, inherited);
        let x = num(element, "x");
        let y = num(element, "y");
        const runs: { text: string; x: number; y: number; style: Style; chunk: boolean }[] = [];
        for (const node of [...element.childNodes]) {
            if (node.nodeType === 3) {
                if (node.textContent?.trim()) {
                    runs.push({ text: node.textContent, x, y, style, chunk: false });
                }
            } else if (node instanceof Element && node.localName === "tspan") {
                const own = styleOf(node, style);
                const chunk = node.hasAttribute("x") || node.hasAttribute("y");
                x = node.hasAttribute("x") ? num(node, "x") : x;
                y = node.hasAttribute("y") ? num(node, "y") : y;
                x += num(node, "dx");
                y += num(node, "dy");
                runs.push({ text: node.textContent ?? "", x, y, style: own, chunk });
            }
            // Text without its own place carries on from the last run's end.
            const last = runs[runs.length - 1];
            if (last) {
                x = last.x + this.width(last.text, last.style);
            }
        }
        for (const run of runs) {
            const bytes = encode(run.text.replace(/\s+/g, " "));
            if (bytes.length === 0) {
                continue;
            }
            const size = run.style.fontSize;
            const spacing = this.spacing(run.style);
            const width = widthOf(bytes, run.style.bold, run.style.family) * size + spacing * bytes.length;
            const left = run.x - (run.style.anchor === "middle" ? width / 2 : run.style.anchor === "end" ? width : 0);
            const base =
                run.y + (run.style.baseline === "central" || run.style.baseline === "middle" ? 0.35 * size : 0);
            const fill = rgb(run.style.fill);
            const stroke = rgb(run.style.stroke);
            const show = (mode: number, color: [number, number, number]) => {
                this.lines.push(
                    "BT",
                    `/${fontKey(run.style)} ${n(size)} Tf`,
                    `${n(spacing)} Tc`,
                    `${mode} Tr`,
                    mode === 1
                        ? `${color.map(n).join(" ")} RG ${n(run.style.strokeWidth)} w 1 j`
                        : `${color.map(n).join(" ")} rg`,
                    // Upright: the page's y runs down, so the text's own is flipped back.
                    `1 0 0 -1 ${n(left)} ${n(base)} Tm`,
                    `${pdfString(bytes)} Tj`,
                    "ET",
                );
            };
            if (stroke && run.style.strokeFirst) {
                // A halo behind the letters, as paint-order: stroke draws it; its own words said to be none, so the
                // words are read (searched, copied) once.
                this.lines.push("/Span << /ActualText () >> BDC");
                show(1, stroke);
                this.lines.push("EMC");
            }
            if (fill) {
                show(0, fill);
            }
        }
    }

    private spacing(style: Style): number {
        const match = /^(-?[\d.]+)(em)?$/.exec(style.spacing.trim());
        return match ? Number(match[1]) * (match[2] ? style.fontSize : 1) : 0;
    }

    private width(text: string, style: Style): number {
        const bytes = encode(text.replace(/\s+/g, " "));
        return widthOf(bytes, style.bold, style.family) * style.fontSize + this.spacing(style) * bytes.length;
    }

    walk(element: Element, inherited: Style): void {
        const name = element.localName;
        if (["defs", "title", "pattern", "clipPath", "desc", "metadata"].includes(name)) {
            return;
        }
        const style = styleOf(element, inherited);
        const transform = element.getAttribute("transform");
        const moves = transform ? transformOperators(transform) : [];
        if (moves.length > 0) {
            this.lines.push("q", ...moves);
        }
        switch (name) {
            case "svg":
            case "g":
                for (const child of [...element.children]) {
                    this.walk(child, style);
                }
                break;
            case "path":
                this.paint(pathOperators(element.getAttribute("d") ?? ""), style);
                break;
            case "rect":
                this.paint(rectOperators(element), style);
                break;
            case "circle":
                this.paint(circleOperators(num(element, "cx"), num(element, "cy"), num(element, "r")), style);
                break;
            case "line":
                this.paint(
                    `${n(num(element, "x1"))} ${n(num(element, "y1"))} m ${n(num(element, "x2"))} ${n(num(element, "y2"))} l`,
                    style,
                    false,
                );
                break;
            case "polyline":
            case "polygon": {
                const values = (element.getAttribute("points") ?? "")
                    .split(/[\s,]+/)
                    .filter(Boolean)
                    .map(Number);
                const points: string[] = [];
                for (let index = 0; index + 1 < values.length; index += 2) {
                    points.push(`${n(values[index]!)} ${n(values[index + 1]!)} ${index === 0 ? "m" : "l"}`);
                }
                this.paint(points.join(" ") + (name === "polygon" ? " h" : ""), style);
                break;
            }
            case "text":
                this.text(element, inherited);
                break;
        }
        if (moves.length > 0) {
            this.lines.push("Q");
        }
    }
}

// --- the file ------------------------------------------------------------------------------------------------------

/** Bytes compressed as PDF's FlateDecode reads them: zlib's deflate (CompressionStream's "deflate"). */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const reader = input.pipeThrough(new CompressionStream("deflate")).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value);
        size += read.value.byteLength;
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.byteLength;
    }
    return all;
}

/** Text as bytes, one a character: PDF's own words are all ASCII. */
const ascii = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** A PDF's text string in UTF-16, for its title, which may say anything. */
function textString(text: string): string {
    let hex = "FEFF";
    for (let index = 0; index < text.length; index++) {
        hex += text.charCodeAt(index).toString(16).padStart(4, "0").toUpperCase();
    }
    return `<${hex}>`;
}

/** The page a drawing goes on: the paper's, turned to the drawing's way, and where the drawing goes on it. */
// --- the sheet -----------------------------------------------------------------------------------------------------

/**
 * A drawing sheet, as engineering drawings are on (and Visio's P&ID template draws): a border, with the zones' numbers
 * and letters between its two lines to say where on the sheet something is, and in its corner a title block and the
 * diagram's releases (or, before it has any, its named revisions).
 */
export interface Sheet {
    project: string; // the diagram's folder
    diagram: number | null; // its number in Piper
    // Its releases, the latest first: each one's letter, what it was for, when, and who approved it. Before it has any,
    // its named revisions, by number, and who made each.
    revisions: { rev: string; note: string; date: string; by: string }[];
    titleBlock: boolean; // the sheet's title block: not when the drawing has one of its own
}

const BORDER = 18; // the outer line, in from the paper's edge
const FRAME = 36; // the inner line: the zones' references between the two
const ROOM = 12; // between the inner line and the drawing
const BLOCK = 288; // the title block's width: four inches
const TITLE_HEIGHT = 86;
const ROW = 12; // a revision's row
const MOST_REVISIONS = 5;
const ZONE = 306; // about how wide (and tall) a zone is: 4.25 inches, as ANSI's sheets have them

/** How much of the sheet's corner its title block and revisions take, if any of it. */
function cornerOf(sheet: Sheet): { width: number; height: number } | null {
    const revisions = Math.min(sheet.revisions.length, MOST_REVISIONS);
    const height = (sheet.titleBlock ? TITLE_HEIGHT : 0) + (revisions > 0 ? (revisions + 2) * ROW : 0);
    return height > 0 ? { width: BLOCK, height } : null;
}

/**
 * The page a drawing goes on: the paper's, turned to the drawing's way (or the drawing's own size), and where the
 * drawing goes on it, as big as fits: inside the sheet's border, and clear of its corner (above it, or beside it,
 * whichever leaves the drawing bigger), if it's on a sheet.
 */
export function pageFor(
    width: number,
    height: number,
    paperId: string,
    sheet: Sheet | null = null,
    landscape: boolean | null = null,
) {
    const paper = PAPERS.find((entry) => entry.id === paperId) ?? PAPERS[0]!;
    const inset = sheet ? FRAME + ROOM : MARGIN;
    const corner = sheet ? cornerOf(sheet) : null;
    const cornerHeight = corner ? corner.height + ROOM : 0;
    if (paper.width === 0) {
        const pageWidth = Math.max(width + 2 * inset, corner ? corner.width + 2 * FRAME + 2 * ROOM : 0);
        return {
            width: pageWidth,
            height: height + 2 * inset + cornerHeight,
            scale: 1,
            x: (pageWidth - width) / 2,
            y: inset,
        };
    }
    // Landscape, as P&IDs mostly are, unless the drawing's plainly taller than it's wide (or it's turned as asked).
    const wide = landscape ?? height <= width * 1.2;
    const [pageWidth, pageHeight] = wide
        ? [Math.max(paper.width, paper.height), Math.min(paper.width, paper.height)]
        : [paper.width, paper.height];
    const areas = [{ x0: inset, y0: inset, x1: pageWidth - inset, y1: pageHeight - inset - cornerHeight }];
    if (corner) {
        areas.push({ x0: inset, y0: inset, x1: pageWidth - inset - corner.width - ROOM, y1: pageHeight - inset });
    }
    const fits = areas.map((area) => ({
        area,
        scale: Math.min((area.x1 - area.x0) / width, (area.y1 - area.y0) / height),
    }));
    const { area, scale } = fits.reduce((best, fit) => (fit.scale > best.scale ? fit : best));
    return {
        width: pageWidth,
        height: pageHeight,
        scale,
        x: (area.x0 + area.x1 - width * scale) / 2,
        y: (area.y0 + area.y1 - height * scale) / 2,
    };
}

const escapeXml = (text: string) =>
    text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);

/** Text cut to fit a width at a size, with an ellipsis where it's cut. */
function clip(text: string, width: number, size: number, bold: boolean): string {
    const fits = (words: string) => widthOf(encode(words), bold) * size <= width;
    if (fits(text)) {
        return text;
    }
    let kept = text;
    while (kept.length > 0 && !fits(`${kept}…`)) {
        kept = kept.slice(0, -1);
    }
    return `${kept.trimEnd()}…`;
}

/** The sheet's frame, title block, and revisions, as SVG on the page (in points, y down): drawn as the drawing is. */
function sheetSvg(page: { width: number; height: number }, sheet: Sheet, meta: DiagramMeta): string {
    const { width: w, height: h } = page;
    const ink = "#1b2433";
    const muted = "#6b7686";
    const out: string[] = [];
    const text = (
        x: number,
        y: number,
        words: string,
        size: number,
        options: { bold?: boolean; anchor?: string; fill?: string; spacing?: string } = {},
    ) =>
        out.push(
            `<text x="${n(x)}" y="${n(y)}" font-size="${size}" font-weight="${options.bold ? 700 : 400}" text-anchor="${options.anchor ?? "start"}"` +
                ` letter-spacing="${options.spacing ?? "0"}" fill="${options.fill ?? ink}">${escapeXml(words)}</text>`,
        );
    const rule = (x1: number, y1: number, x2: number, y2: number, width = 0.6) =>
        out.push(
            `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${ink}" stroke-width="${width}"/>`,
        );

    // The border: two lines, the zones between them, numbered from the right and lettered from the foot, as ANSI's are.
    out.push(
        `<rect x="${BORDER}" y="${BORDER}" width="${n(w - 2 * BORDER)}" height="${n(h - 2 * BORDER)}" fill="none" stroke="${ink}" stroke-width="1.6"/>`,
    );
    out.push(
        `<rect x="${FRAME}" y="${FRAME}" width="${n(w - 2 * FRAME)}" height="${n(h - 2 * FRAME)}" fill="none" stroke="${ink}" stroke-width="0.9"/>`,
    );
    const columns = Math.min(8, Math.max(2, Math.round((w - 2 * FRAME) / ZONE)));
    const rows = Math.min(6, Math.max(2, Math.round((h - 2 * FRAME) / ZONE)));
    const zoneWidth = (w - 2 * FRAME) / columns;
    const zoneHeight = (h - 2 * FRAME) / rows;
    const band = (FRAME + BORDER) / 2; // the middle of the space between the lines
    for (let index = 0; index < columns; index++) {
        const x = FRAME + index * zoneWidth;
        if (index > 0) {
            rule(x, BORDER, x, FRAME);
            rule(x, h - FRAME, x, h - BORDER);
        }
        const label = String(columns - index);
        text(x + zoneWidth / 2, band + 3, label, 8, { anchor: "middle" });
        text(x + zoneWidth / 2, h - band + 3, label, 8, { anchor: "middle" });
    }
    for (let index = 0; index < rows; index++) {
        const y = FRAME + index * zoneHeight;
        if (index > 0) {
            rule(BORDER, y, FRAME, y);
            rule(w - FRAME, y, w - BORDER, y);
        }
        const label = String.fromCharCode(65 + rows - 1 - index);
        text(band, y + zoneHeight / 2 + 3, label, 8, { anchor: "middle" });
        text(w - band, y + zoneHeight / 2 + 3, label, 8, { anchor: "middle" });
    }

    const corner = cornerOf(sheet);
    if (!corner) {
        return `<svg xmlns="http://www.w3.org/2000/svg">${out.join("")}</svg>`;
    }
    const x0 = w - FRAME - BLOCK;
    let y = h - FRAME - corner.height;
    const cell = (x: number, top: number, cellWidth: number, label: string, value: string, size = 9, bold = false) => {
        text(x + 4, top + 6.5, label, 5.5, { fill: muted, spacing: "0.06em" });
        text(x + 4, top + 7.5 + size, clip(value, cellWidth - 8, size, bold), size, { bold });
    };
    out.push(
        `<rect x="${n(x0)}" y="${n(y)}" width="${BLOCK}" height="${n(corner.height)}" fill="#ffffff" stroke="${ink}" stroke-width="1.2"/>`,
    );

    // The releases (or named revisions), the latest first, over the title block.
    const revisions = sheet.revisions.slice(0, MOST_REVISIONS);
    if (revisions.length > 0) {
        const columnsAt = [0, 30, 180, 238, BLOCK];
        text(x0 + 4, y + 9, "REVISIONS", 6.5, { bold: true, spacing: "0.08em" });
        rule(x0, y + ROW, x0 + BLOCK, y + ROW);
        ["REV", "DESCRIPTION", "DATE", "BY"].forEach((head, index) =>
            text(x0 + columnsAt[index]! + 4, y + ROW + 8.5, head, 5.5, { fill: muted }),
        );
        rule(x0, y + 2 * ROW, x0 + BLOCK, y + 2 * ROW);
        revisions.forEach((revision, index) => {
            const top = y + (index + 2) * ROW;
            const values = [revision.rev, revision.note, revision.date, revision.by];
            values.forEach((value, column) =>
                text(
                    x0 + columnsAt[column]! + 4,
                    top + 8.5,
                    clip(value, columnsAt[column + 1]! - columnsAt[column]! - 8, 7, false),
                    7,
                ),
            );
            rule(x0, top + ROW, x0 + BLOCK, top + ROW, 0.4);
        });
        for (const at of columnsAt.slice(1, -1)) {
            rule(x0 + at, y + ROW, x0 + at, y + (revisions.length + 2) * ROW, 0.4);
        }
        y += (revisions.length + 2) * ROW;
        rule(x0, y, x0 + BLOCK, y, 1.2);
    }

    // The title block: who it's for, what it is, and its particulars.
    if (sheet.titleBlock) {
        text(x0 + 6, y + 12, "YELLOW JACKET SPACE PROGRAM", 8, { bold: true, spacing: "0.08em" });
        text(x0 + BLOCK - 6, y + 12, "P&ID", 8, { bold: true, anchor: "end", fill: muted });
        rule(x0, y + 18, x0 + BLOCK, y + 18);
        cell(x0, y + 18, BLOCK, "TITLE", meta.name, 13, true);
        rule(x0, y + 46, x0 + BLOCK, y + 46);
        const date = meta.savedAt ? new Date(meta.savedAt).toLocaleDateString("en-CA") : "";
        const widths = [128, 80, 80];
        const lines: [string, string][][] = [
            [
                ["PROJECT", sheet.project || "—"],
                ["DIAGRAM", sheet.diagram === null ? "" : `No. ${sheet.diagram}`],
                ["REVISION", meta.revision],
            ],
            [
                ["DRAWN", meta.by],
                ["DATE", date],
                ["SHEET", meta.sheet ?? "1 OF 1"],
            ],
        ];
        lines.forEach((row, index) => {
            const top = y + 46 + index * 20;
            let x = x0;
            row.forEach(([label, value], column) => {
                cell(x, top, widths[column]!, label, value);
                x += widths[column]!;
                if (column < row.length - 1) {
                    rule(x, top, x, top + 20);
                }
            });
            if (index === 0) {
                rule(x0, top + 20, x0 + BLOCK, top + 20);
            }
        });
    }
    return `<svg xmlns="http://www.w3.org/2000/svg">${out.join("")}</svg>`;
}

/** The drawing as a PDF file, on a page of the paper chosen: on a drawing sheet (a border, a title block) if it's given one. */
export async function pdfOf(
    drawing: Drawing,
    meta: DiagramMeta,
    paperId = "tabloid",
    sheet: Sheet | null = null,
): Promise<Blob> {
    return pdfOfPages([{ drawing, meta, sheet }], paperId);
}

/** A paper's size in points, turned its way: landscape is the wider way across. */
export function paperSize(paperId: string, landscape: boolean): { width: number; height: number } {
    const paper = PAPERS.find((entry) => entry.id === paperId && entry.width > 0) ?? PAPERS[0]!;
    const [long, short] = [Math.max(paper.width, paper.height), Math.min(paper.width, paper.height)];
    return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** As much of a sheet's corner as its title block and revisions can take: the drawing keeps clear of it. */
const FULL_CORNER: Sheet = {
    project: "",
    diagram: null,
    revisions: Array.from({ length: MOST_REVISIONS }, () => ({ rev: "", note: "", date: "", by: "" })),
    titleBlock: true,
};

/**
 * Where a page's printed sheet is, in its own units, as the canvas outlines it: the paper's edge, the sheet's border
 * inside it, and the corner its title block and revisions can take, as a PDF on a drawing sheet prints them.
 */
export function sheetOutline(sheet: PageSheet): { paper: Box; frame: Box; corner: Box } {
    const { width, height } = paperSize(sheet.paper, sheet.landscape);
    const corner = cornerOf(FULL_CORNER)!;
    const box = (x0: number, y0: number, x1: number, y1: number): Box => ({
        x0: sheet.x + x0 / sheet.scale,
        y0: sheet.y + y0 / sheet.scale,
        x1: sheet.x + x1 / sheet.scale,
        y1: sheet.y + y1 / sheet.scale,
    });
    return {
        paper: box(0, 0, width, height),
        frame: box(FRAME, FRAME, width - FRAME, height - FRAME),
        corner: box(width - FRAME - corner.width, height - FRAME - corner.height, width - FRAME, height - FRAME),
    };
}

/**
 * A page's sheet set to fit what's on it (its box): on a paper, turned its way, as big as fits inside the sheet's
 * border and clear of its corner, as a PDF fits a page that hasn't one.
 */
export function fitSheet(box: Box, paperId: string, landscape: boolean): PageSheet {
    const fit = pageFor(box.x1 - box.x0, box.y1 - box.y0, paperId, FULL_CORNER, landscape);
    return {
        paper: paperId,
        landscape,
        scale: fit.scale,
        x: box.x0 - fit.x / fit.scale,
        y: box.y0 - fit.y / fit.scale,
    };
}

/**
 * The drawing's pages as a PDF, a page for each: each on its printed sheet's paper, where its outline shows, if it has
 * one; else on the paper chosen, fitted to it (pageFor). On a drawing sheet, if it's given one: its border, the
 * revisions, and its title block, which says which sheet of how many it is.
 */
export async function pdfOfPages(
    drawn: { drawing: Drawing; meta: DiagramMeta; sheet: Sheet | null }[],
    paperId = "tabloid",
): Promise<Blob> {
    const writer = new Writer();
    const contents: { content: Uint8Array<ArrayBuffer>; width: number; height: number }[] = [];
    for (const { drawing, meta, sheet: framed } of drawn) {
        const { svg } = await svgOf(drawing, meta);
        const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
        const [vx, vy, vw, vh] = (root.getAttribute("viewBox") ?? "0 0 100 100").split(/\s+/).map(Number) as [
            number,
            number,
            number,
            number,
        ];
        // Where its sheet is, if it has one: the paper at its point, so many points to a unit. Else fitted on.
        const fixed = drawing.sheet;
        const page = fixed
            ? {
                  ...paperSize(fixed.paper, fixed.landscape),
                  scale: fixed.scale,
                  x: -fixed.x * fixed.scale,
                  y: -fixed.y * fixed.scale,
              }
            : (() => {
                  const fit = pageFor(vw, vh, paperId, framed);
                  return { ...fit, x: fit.x - vx * fit.scale, y: fit.y - vy * fit.scale };
              })();
        writer.lines = [];
        // The page's y runs up from its foot; the drawing's, and the sheet's, run down from the top: flipped.
        writer.lines.push("q", `1 0 0 -1 0 ${n(page.height)} cm`);
        if (framed) {
            const frame = new DOMParser().parseFromString(
                sheetSvg(page, framed, meta),
                "image/svg+xml",
            ).documentElement;
            for (const child of [...frame.children]) {
                writer.walk(child, DEFAULT);
            }
        }
        // Then the drawing, where it goes.
        writer.lines.push("q", `${n(page.scale)} 0 0 ${n(page.scale)} ${n(page.x)} ${n(page.y)} cm`);
        for (const child of [...root.children]) {
            writer.walk(child, DEFAULT);
        }
        writer.lines.push("Q", "Q");
        contents.push({
            content: await deflate(ascii(writer.lines.join("\n"))),
            width: page.width,
            height: page.height,
        });
    }

    const objects: (string | Uint8Array<ArrayBuffer>)[][] = [];
    const add = (...parts: (string | Uint8Array<ArrayBuffer>)[]) => objects.push(parts) && objects.length;
    const states = [...writer.opacities].map(([key, name]) => {
        const [fill, stroke] = key.split(" ");
        return [name, add(`<< /Type /ExtGState /ca ${fill} /CA ${stroke} >>`)] as const;
    });
    // Every standard font a drawing's words can be in, F1 to F12 as fontKey names them: none embedded.
    const fonts = FAMILIES.flatMap((family) => FONT_NAMES[family]).map((name) =>
        add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`),
    );
    const resources = `<< /Font << ${fonts.map((id, index) => `/F${index + 1} ${id} 0 R`).join(" ")} >> /ExtGState << ${states.map(([name, id]) => `/${name} ${id} 0 R`).join(" ")} >> >>`;
    const pages = add(""); // the pages' object: written once its pages are
    const kids = contents.map(({ content, width, height }) => {
        const stream = add(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, content, "\nendstream");
        return add(
            `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${n(width)} ${n(height)}] /Resources ${resources} /Contents ${stream} 0 R >>`,
        );
    });
    objects[pages - 1] = [
        `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`,
    ];
    const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
    const meta = drawn[0]?.meta ?? { name: "Diagram", revision: "", savedAt: null, by: "" };
    const now = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const info = add(`<< /Title ${textString(meta.name)} /Creator (YJSP Piper) /CreationDate (D:${now}Z) >>`);

    const chunks: Uint8Array<ArrayBuffer>[] = [ascii("%PDF-1.4\n%âãÏÓ\n")];
    let length = chunks[0]!.length;
    const offsets: number[] = [];
    objects.forEach((parts, index) => {
        offsets.push(length);
        for (const part of [`${index + 1} 0 obj\n`, ...parts, "\nendobj\n"]) {
            const bytes = typeof part === "string" ? ascii(part) : part;
            chunks.push(bytes);
            length += bytes.length;
        }
    });
    const xref = [
        "xref",
        `0 ${objects.length + 1}`,
        "0000000000 65535 f ",
        ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
        "trailer",
        `<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>`,
        "startxref",
        String(length),
        "%%EOF\n",
    ].join("\n");
    chunks.push(ascii(xref));
    return new Blob(chunks, { type: "application/pdf" });
}
