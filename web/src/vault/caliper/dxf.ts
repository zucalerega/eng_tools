import type { Units } from "./model";

// DXF files, as Caliper shows them: read in the browser, what's in model space laid flat (or, with nothing there, the
// paper space of the layout that was open), blocks drawn where they're inserted, in the file's own units. DXF is what
// laser cutters, waterjets, and CNC programs take, and SolidWorks and AutoCAD write; Autodesk publishes it (the DXF
// Reference). What drawings and cutting files have is read: lines, arcs, circles, ellipses, polylines (with their arcs
// and widths), splines, text, dimensions (as the blocks they're drawn with), leaders, hatches, solids, points, and
// blocks. Anything else is counted and left out (AutoCAD's tables too: where their blocks go isn't sure). What comes out
// is what to draw (paths, fills, and text, by layer and color) and what can be measured: the lines, arcs, circles, and
// points among them.

export type Point = [number, number];

/** A color to draw with: a CSS color, or null for the foreground (AutoCAD's color 7: black on white, white on black). */
export type Color = string | null;

/** An affine map of the plane: x' = a x + c y + e, y' = b x + d y + f, as [a, b, c, d, e, f] (as canvases take it). */
export type Affine = [number, number, number, number, number, number];

/**
 * A path, as numbers: MOVE x y, LINE x y, ARC cx cy r from to backwards (backwards: 1 if the angle goes down from one
 * to the other), ELLIPSE cx cy rx ry rotation from to backwards, CLOSE. Angles in radians, counterclockwise from +x.
 */
export const MOVE = 0;
export const LINE = 1;
export const ARC = 2;
export const ELLIPSE = 3;
export const CLOSE = 4;

export interface Layer {
    name: string;
    color: Color;
    shown: boolean; // on and not frozen, as the file was saved
    count: number; // how many things are drawn on it
}

/** A run of lines and curves, drawn with a pen of the layer's color, its line type's dashes, and its weight. */
export interface Stroke {
    layer: number; // in Drawing.layers
    color: Color;
    path: number[];
    dash: number[] | null; // dash, gap, dash, ... in drawing units; null: solid
    weight: number; // in mm, as plotted; 0: the thinnest
    width: number; // a polyline's own width, in drawing units; 0: none
}

/** A filled area (even-odd), solid or hatched: a hatch's lines, as segments x1 y1 x2 y2, are drawn inside it. */
export interface Fill {
    layer: number;
    color: Color;
    path: number[];
    lines: number[] | null; // null: filled solid
}

/** Text: its lines, in a frame of its own (along its baseline and up, in drawing units) that its matrix puts down. */
export interface Label {
    layer: number;
    color: Color;
    lines: string[];
    matrix: Affine; // from the text's frame to the drawing's
    height: number; // its capitals' height
    align: "left" | "center" | "right";
    top: number; // where the first line's baseline is, up from the anchor (negative: below)
    spacing: number; // from one baseline to the next
    fit: number; // the width it's stretched to fill (TEXT's aligned and fit), or 0
    wrap: number; // the width it wraps at (MTEXT's), or 0
    font: string; // a CSS font family
}

/** What can be measured: a straight line, an arc or circle (going counterclockwise), or a point. */
export type Geometry =
    | { kind: "line"; a: Point; b: Point }
    | { kind: "arc"; center: Point; radius: number; start: number; sweep: number } // sweep 2π: a circle
    | { kind: "point"; at: Point };

export type Feature = Geometry & { layer: number };

export interface Drawing {
    units: Units; // what measurements show first: the file's own, where it's one of Caliper's
    mmPerUnit: number | null; // the length of one of its units, null where the file doesn't say
    space: "model" | "paper";
    layers: Layer[];
    strokes: Stroke[];
    fills: Fill[];
    labels: Label[];
    features: Feature[];
    bounds: { min: Point; max: Point } | null;
    left: Record<string, number>; // what isn't shown, by type of entity
}

export class DxfError extends Error {}

// --- reading the file: group codes and values ------------------------------------------------------------------------

const BINARY = "AutoCAD Binary DXF\r\n\u001a\u0000";

/** The file's group codes and values, as text (numbers as the file writes them). */
class Pairs {
    readonly codes: number[] = [];
    readonly values: string[] = [];

    get length(): number {
        return this.codes.length;
    }
}

function decode(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder("windows-1252").decode(bytes); // files from before AutoCAD 2007 are in a code page
    }
}

function textPairs(bytes: Uint8Array): Pairs {
    const text = decode(bytes);
    const pairs = new Pairs();
    let at = 0;
    let line = 1;
    const next = (): string | null => {
        if (at >= text.length) {
            return null;
        }
        let end = text.indexOf("\n", at);
        if (end < 0) {
            end = text.length;
        }
        const found = text.slice(at, end > at && text[end - 1] === "\r" ? end - 1 : end);
        at = end + 1;
        line++;
        return found;
    };
    for (;;) {
        const code = next();
        if (code === null || (code.trim() === "" && at >= text.length)) {
            break;
        }
        const value = next();
        const number = Number(code.trim());
        if (value === null || code.trim() === "" || !Number.isInteger(number)) {
            throw new DxfError(
                `It isn't a DXF file: line ${line - 2} should be a group code (a number), not "${code.slice(0, 30)}"`,
            );
        }
        pairs.codes.push(number);
        // Text keeps its spaces; everything else is a name or a number, which files pad as they like.
        pairs.values.push(number === 1 || number === 3 ? value : value.trim());
        if (number === 0 && value.trim() === "EOF") {
            break;
        }
    }
    return pairs;
}

/** What a group code's value is, in a binary DXF file. */
function binaryType(code: number): "text" | "double" | "int16" | "int32" | "int64" | "bool" | "bytes" {
    if ((code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239)) {
        return "double";
    }
    if ((code >= 460 && code <= 469) || (code >= 1010 && code <= 1059)) {
        return "double";
    }
    if ((code >= 60 && code <= 79) || (code >= 170 && code <= 179) || (code >= 270 && code <= 289)) {
        return "int16";
    }
    if ((code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 1060 && code <= 1070)) {
        return "int16";
    }
    if ((code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459) || code === 1071) {
        return "int32";
    }
    if (code >= 160 && code <= 169) {
        return "int64";
    }
    if (code >= 290 && code <= 299) {
        return "bool";
    }
    if ((code >= 310 && code <= 319) || code === 1004) {
        return "bytes";
    }
    return "text";
}

function binaryPairs(bytes: Uint8Array): Pairs {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pairs = new Pairs();
    // AutoCAD R12's files have one byte for each group code (255, then two, for bigger ones); later ones two.
    const wide = bytes[BINARY.length + 1] === 0;
    const latin = new TextDecoder("windows-1252");
    let at = BINARY.length;
    const need = (n: number) => {
        if (at + n > bytes.length) {
            throw new DxfError("It's a binary DXF file that ends partway through");
        }
    };
    while (at < bytes.length) {
        need(1);
        let code: number;
        if (wide) {
            need(2);
            code = view.getUint16(at, true);
            at += 2;
        } else {
            code = bytes[at++]!;
            if (code === 255) {
                need(2);
                code = view.getUint16(at, true);
                at += 2;
            }
        }
        let value: string;
        switch (binaryType(code)) {
            case "double":
                need(8);
                value = String(view.getFloat64(at, true));
                at += 8;
                break;
            case "int16":
                need(2);
                value = String(view.getInt16(at, true));
                at += 2;
                break;
            case "int32":
                need(4);
                value = String(view.getInt32(at, true));
                at += 4;
                break;
            case "int64":
                need(8);
                value = String(view.getBigInt64(at, true));
                at += 8;
                break;
            case "bool":
                need(1);
                value = String(bytes[at++]);
                break;
            case "bytes": {
                need(1);
                const length = bytes[at++]!;
                need(length);
                at += length;
                value = "";
                break;
            }
            default: {
                const end = bytes.indexOf(0, at);
                if (end < 0) {
                    throw new DxfError("It's a binary DXF file that ends partway through");
                }
                const raw = bytes.subarray(at, end);
                try {
                    value = new TextDecoder("utf-8", { fatal: true }).decode(raw);
                } catch {
                    value = latin.decode(raw);
                }
                at = end + 1;
            }
        }
        pairs.codes.push(code);
        pairs.values.push(value);
        if (code === 0 && value === "EOF") {
            break;
        }
    }
    return pairs;
}

function readPairs(bytes: Uint8Array): Pairs {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, BINARY.length));
    return head === BINARY ? binaryPairs(bytes) : textPairs(bytes);
}

// --- records: an entity, a table's entry, or a block's start, with its group codes ------------------------------------

/** An entity (or a table's entry): its type, and its group codes and values in order. */
class Entry {
    readonly codes: number[] = [];
    readonly values: string[] = [];

    constructor(readonly type: string) {}

    has(code: number): boolean {
        return this.codes.includes(code);
    }

    text(code: number, otherwise = ""): string {
        const at = this.codes.indexOf(code);
        return at < 0 ? otherwise : this.values[at]!;
    }

    number(code: number, otherwise = 0): number {
        const at = this.codes.indexOf(code);
        const found = at < 0 ? NaN : Number(this.values[at]);
        return Number.isFinite(found) ? found : otherwise;
    }

    point(x: number, otherwise: Point = [0, 0]): Point {
        return [this.number(x, otherwise[0]), this.number(x + 10, otherwise[1])];
    }

    /** Every value of a code, in order. */
    all(code: number): string[] {
        return this.values.filter((_, i) => this.codes[i] === code);
    }

    numbers(code: number): number[] {
        return this.all(code).map(Number);
    }
}

interface Sections {
    header: Map<string, Entry>; // each variable, as a record of its values
    tables: Entry[];
    blocks: Entry[];
    entities: Entry[];
}

function sections(pairs: Pairs): Sections {
    const found: Sections = { header: new Map(), tables: [], blocks: [], entities: [] };
    let section = "";
    let current: Entry | null = null;
    let variable: Entry | null = null;
    for (let i = 0; i < pairs.length; i++) {
        const code = pairs.codes[i]!;
        const value = pairs.values[i]!;
        if (code === 0 && value === "SECTION") {
            section = pairs.codes[i + 1] === 2 ? pairs.values[i + 1]! : "";
            i++;
            current = variable = null;
            continue;
        }
        if (code === 0 && (value === "ENDSEC" || value === "EOF")) {
            section = "";
            current = variable = null;
            continue;
        }
        if (section === "HEADER") {
            if (code === 9) {
                variable = new Entry(value);
                found.header.set(value.toUpperCase(), variable);
            } else if (variable) {
                variable.codes.push(code);
                variable.values.push(value);
            }
            continue;
        }
        const list =
            section === "TABLES"
                ? found.tables
                : section === "BLOCKS"
                  ? found.blocks
                  : section === "ENTITIES"
                    ? found.entities
                    : null;
        if (!list) {
            continue;
        }
        if (code === 0) {
            current = new Entry(value);
            list.push(current);
        } else if (current) {
            current.codes.push(code);
            current.values.push(value);
        }
    }
    if (found.entities.length === 0 && found.blocks.length === 0 && found.tables.length === 0) {
        throw new DxfError("It isn't a DXF file: it has no entities, blocks, or tables");
    }
    return found;
}

// --- colors, line types, styles, and layers ----------------------------------------------------------------------------

const hex = (r: number, g: number, b: number) =>
    "#" +
    [r, g, b]
        .map((v) =>
            Math.max(0, Math.min(255, Math.floor(v)))
                .toString(16)
                .padStart(2, "0"),
        )
        .join("");

/** AutoCAD's 256 colors (ACI): 1 to 9 named, then 24 hues in tens (full and pale, darker and darker), then grays. */
const ACI: string[] = (() => {
    const table = new Array<string>(256).fill("#ffffff");
    const named = ["#000000", "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ffffff"];
    named.forEach((color, i) => (table[i] = color));
    table[8] = "#808080";
    table[9] = "#c0c0c0";
    const values = [1, 0.65, 0.5, 0.3, 0.15];
    for (let i = 10; i < 250; i++) {
        const hue = (Math.floor((i - 10) / 10) * 15) / 60;
        const variant = (i - 10) % 10;
        const value = values[Math.floor(variant / 2)]! * 255;
        const sector = Math.floor(hue);
        const f = hue - sector;
        const rgb = [
            [1, f, 0],
            [1 - f, 1, 0],
            [0, 1, f],
            [0, 1 - f, 1],
            [f, 0, 1],
            [1, 0, 1 - f],
        ][sector % 6]!.map((c) => c * value);
        // The pale ones are halfway to gray of the same value.
        const [r, g, b] = variant % 2 === 0 ? rgb : rgb.map((c) => (c + value) / 2);
        table[i] = hex(r!, g!, b!);
    }
    ["#333333", "#505050", "#696969", "#828282", "#bebebe", "#ffffff"].forEach((color, i) => (table[250 + i] = color));
    return table;
})();

/** An ACI color (1 to 255) as a CSS color; 7 is the foreground. */
export function aciColor(index: number): Color {
    const i = Math.abs(Math.round(index));
    return i === 7 ? null : (ACI[i] ?? null);
}

const trueColor = (value: number): string => hex((value >> 16) & 255, (value >> 8) & 255, value & 255);

interface LayerInfo {
    index: number;
    color: Color;
    linetype: string;
    weight: number; // in mm
}

interface Style {
    widthFactor: number;
    height: number;
    oblique: number; // degrees
    font: string;
}

const SANS = "Arial, Helvetica, sans-serif";
export const CAP = 0.716; // capitals' height in Arial, of its em: text heights in DXF are capitals'

/** A CSS font family for a text style's font file: a TrueType font by its name; AutoCAD's own (SHX) as Arial. */
function fontFamily(file: string, family: string): string {
    if (family) {
        return `"${family.replace(/"/g, "")}", ${SANS}`;
    }
    const stem = file.replace(/^.*[\\/]/, "").replace(/\.(ttf|otf|ttc)$/i, "");
    return /\.(ttf|otf|ttc)$/i.test(file) && stem ? `"${stem.replace(/"/g, "")}", ${SANS}` : SANS;
}

// --- geometry -----------------------------------------------------------------------------------------------------------

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const TAU = 2 * Math.PI;
const RADIANS = Math.PI / 180;

const apply = (m: Affine, x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** m after n: n first, then m. */
export function compose(m: Affine, n: Affine): Affine {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
const rotate = (angle: number): Affine => [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
const scaling = (x: number, y: number): Affine => [x, 0, 0, y, 0, 0];

/**
 * Where an entity's own coordinates (its OCS, set by its extrusion direction) land on XY: by AutoCAD's arbitrary axis
 * rule. Entities drawn on the other side of the page (extrusion 0 0 -1, as mirrored ones often are) come out mirrored.
 */
function ocs(record: Entry): Affine {
    const n = [record.number(210, 0), record.number(220, 0), record.number(230, 1)];
    const length = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (length === 0) {
        return IDENTITY;
    }
    const [nx, ny, nz] = n.map((v) => v / length) as [number, number, number];
    if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) {
        return IDENTITY;
    }
    const cross = (a: number[], b: number[]) => [
        a[1]! * b[2]! - a[2]! * b[1]!,
        a[2]! * b[0]! - a[0]! * b[2]!,
        a[0]! * b[1]! - a[1]! * b[0]!,
    ];
    const unit = (v: number[]) => {
        const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
        return v.map((c) => c / l);
    };
    const ax = unit(
        Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64
            ? cross([0, 1, 0], [nx, ny, nz])
            : cross([0, 0, 1], [nx, ny, nz]),
    );
    const ay = unit(cross([nx, ny, nz], ax));
    const elevation = record.number(38, 0);
    return [ax[0]!, ax[1]!, ay[0]!, ay[1]!, elevation * nx, elevation * ny];
}

/** How a map turns, scales, and mirrors, where it does only that (a similarity); null where it stretches. */
function similarity(m: Affine): { scale: number; angle: number; mirrored: boolean } | null {
    const p = Math.hypot(m[0], m[1]);
    const q = Math.hypot(m[2], m[3]);
    if (p === 0 || Math.abs(p - q) > 1e-9 * Math.max(p, q) || Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 * p * q) {
        return null;
    }
    return { scale: p, angle: Math.atan2(m[1], m[0]), mirrored: m[0] * m[3] - m[1] * m[2] < 0 };
}

/** Draws paths in an entity's own coordinates, into the drawing's: curves stay curves wherever the map keeps them. */
class Pen {
    readonly path: number[] = [];
    private readonly kept: ReturnType<typeof similarity>;

    constructor(readonly m: Affine) {
        this.kept = similarity(m);
    }

    move(x: number, y: number): void {
        this.path.push(MOVE, ...apply(this.m, x, y));
    }

    line(x: number, y: number): void {
        this.path.push(LINE, ...apply(this.m, x, y));
    }

    close(): void {
        this.path.push(CLOSE);
    }

    /** An arc from one angle to the other, going down if backwards; drawn from where the pen is (or moved to). */
    arc(cx: number, cy: number, r: number, from: number, to: number, backwards: boolean, move = false): void {
        if (move) {
            this.move(cx + r * Math.cos(from), cy + r * Math.sin(from));
        }
        const kept = this.kept;
        if (!kept) {
            this.sampled((t) => [cx + r * Math.cos(t), cy + r * Math.sin(t)], from, to, backwards);
            return;
        }
        const [x, y] = apply(this.m, cx, cy);
        const turn = (t: number) => (kept.mirrored ? kept.angle - t : kept.angle + t);
        this.path.push(ARC, x, y, r * kept.scale, turn(from), turn(to), backwards !== kept.mirrored ? 1 : 0);
    }

    /** An ellipse's arc, by its parameter (as DXF's), from one value to the other. */
    ellipse(
        cx: number,
        cy: number,
        rx: number,
        ry: number,
        rotation: number,
        from: number,
        to: number,
        backwards: boolean,
        move = false,
    ): void {
        const at = (t: number): Point => [
            cx + rx * Math.cos(t) * Math.cos(rotation) - ry * Math.sin(t) * Math.sin(rotation),
            cy + rx * Math.cos(t) * Math.sin(rotation) + ry * Math.sin(t) * Math.cos(rotation),
        ];
        if (move) {
            this.move(...at(from));
        }
        const kept = this.kept;
        if (!kept) {
            this.sampled(at, from, to, backwards);
            return;
        }
        const [x, y] = apply(this.m, cx, cy);
        const s = kept.scale;
        if (kept.mirrored) {
            this.path.push(ELLIPSE, x, y, rx * s, ry * s, kept.angle - rotation, -from, -to, backwards ? 0 : 1);
        } else {
            this.path.push(ELLIPSE, x, y, rx * s, ry * s, kept.angle + rotation, from, to, backwards ? 1 : 0);
        }
    }

    /** A curve as short lines, two degrees of its parameter each, where the map stretches it. */
    private sampled(at: (t: number) => Point, from: number, to: number, backwards: boolean): void {
        const sweep = sweepOf(from, to, backwards);
        const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (2 * RADIANS)));
        for (let i = 1; i <= steps; i++) {
            this.line(...at(from + (sweep * i) / steps));
        }
    }
}

/** How far an arc goes from one angle to the other, signed: positive counterclockwise. */
function sweepOf(from: number, to: number, backwards: boolean): number {
    let sweep = backwards ? from - to : to - from;
    sweep = ((sweep % TAU) + TAU) % TAU;
    if (sweep === 0) {
        sweep = TAU; // all the way round
    }
    return backwards ? -sweep : sweep;
}

/** A polyline's segment with a bulge (the tangent of a quarter of its arc's angle) as an arc: its center and radius. */
function bulgeArc(a: Point, b: Point, bulge: number): { center: Point; radius: number; from: number; to: number } {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const chord = Math.hypot(dx, dy);
    const angle = 4 * Math.atan(bulge);
    const h = chord / 2 / Math.tan(angle / 2); // from the chord's middle to the center, to its left
    const center: Point = [(a[0] + b[0]) / 2 - (dy / chord) * h, (a[1] + b[1]) / 2 + (dx / chord) * h];
    return {
        center,
        radius: Math.abs(chord / 2 / Math.sin(angle / 2)),
        from: Math.atan2(a[1] - center[1], a[0] - center[0]),
        to: Math.atan2(b[1] - center[1], b[0] - center[0]),
    };
}

/** Points along a NURBS curve (de Boor's algorithm), a few for each span of its knots. */
function nurbs(degree: number, knots: number[], points: Point[], weights: number[]): Point[] {
    const n = points.length;
    if (degree < 1 || n <= degree || knots.length !== n + degree + 1) {
        return points; // not a curve this reads: its control points, joined
    }
    const w = weights.length === n ? weights : points.map(() => 1);
    const at = (t: number): Point => {
        let k = degree;
        while (k < n - 1 && t >= knots[k + 1]!) {
            k++;
        }
        const d = Array.from({ length: degree + 1 }, (_, j) => {
            const i = j + k - degree;
            const p = points[i]!;
            return [p[0] * w[i]!, p[1] * w[i]!, w[i]!];
        });
        for (let r = 1; r <= degree; r++) {
            for (let j = degree; j >= r; j--) {
                const i = j + k - degree;
                const span = knots[i + degree - r + 1]! - knots[i]!;
                const alpha = span === 0 ? 0 : (t - knots[i]!) / span;
                d[j] = d[j]!.map((v, c) => (1 - alpha) * d[j - 1]![c]! + alpha * v);
            }
        }
        const [x, y, h] = d[degree]!;
        return h ? [x! / h, y! / h] : [x!, y!];
    };
    const out: Point[] = [];
    for (let k = degree; k < n; k++) {
        const [a, b] = [knots[k]!, knots[k + 1]!];
        if (b <= a) {
            continue;
        }
        for (let s = 0; s < 16; s++) {
            out.push(at(a + ((b - a) * s) / 16));
        }
    }
    out.push(at(knots[n]! - 1e-12 * Math.abs(knots[n]! || 1)));
    return out;
}

// --- text ---------------------------------------------------------------------------------------------------------------

/** AutoCAD's codes in text: %%c ⌀, %%d °, %%p ±, %%nnn by number, \U+XXXX; underlines and overlines (%%u, %%o) go. */
function specials(text: string): string {
    return text
        .replace(/%%(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code)))
        .replace(/%%[cC]/g, "⌀")
        .replace(/%%[dD]/g, "°")
        .replace(/%%[pP]/g, "±")
        .replace(/%%[uUoOkK]/g, "")
        .replace(/%%%/g, "%")
        .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

/** MTEXT's text, without its formatting: its lines. Stacked fractions and tolerances (\S1/2;) come out as 1/2. */
export function mtextLines(raw: string): string[] {
    let out = "";
    for (let i = 0; i < raw.length;) {
        const ch = raw[i]!;
        if (ch === "{" || ch === "}") {
            i++;
            continue;
        }
        if (ch !== "\\") {
            out += ch;
            i++;
            continue;
        }
        const code = raw[i + 1] ?? "";
        if (code === "P" || code === "X") {
            out += "\n";
            i += 2;
        } else if (code === "~") {
            out += " ";
            i += 2;
        } else if (code === "\\" || code === "{" || code === "}") {
            out += code;
            i += 2;
        } else if ("LlOoKkN".includes(code)) {
            i += 2; // underline, overline, and strikethrough on and off; a column break
        } else if (code === "U" && /^\+[0-9a-fA-F]{4}/.test(raw.slice(i + 2, i + 7))) {
            out += String.fromCharCode(parseInt(raw.slice(i + 3, i + 7), 16));
            i += 7;
        } else if (code === "S") {
            const end = raw.indexOf(";", i);
            const stacked = raw.slice(i + 2, end < 0 ? raw.length : end);
            out += stacked.replace(/[\^#]/, "/");
            i = end < 0 ? raw.length : end + 1;
        } else if ("fFHhWwQqTtAaCcp".includes(code) && code !== "") {
            const end = raw.indexOf(";", i); // a font, height, width, slant, spacing, alignment, or color, to ;
            i = end < 0 ? raw.length : end + 1;
        } else {
            out += code;
            i += 2;
        }
    }
    return specials(out.replace(/\^I/g, "\t").replace(/\^J/g, "\n")).split("\n");
}

// --- the drawing ---------------------------------------------------------------------------------------------------------

/** Where a block's entities are drawn: how they're placed, and what BYBLOCK and layer 0 mean in it. */
interface Place {
    m: Affine;
    layer: string | null; // the inserting entity's layer, for entities on layer 0
    color: Color;
    linetype: string;
    weight: number;
    depth: number;
    within: Set<string>; // the blocks it's inside, so a block that inserts itself stops
}

const UNITS: Record<number, [Units, number]> = {
    1: ["in", 25.4],
    2: ["ft", 304.8],
    4: ["mm", 1],
    5: ["cm", 10],
    6: ["m", 1000],
};
// $INSUNITS that aren't Caliper's units: their length in mm.
const OTHER_UNITS: Record<number, number> = {
    3: 1609344,
    7: 1e6,
    8: 25.4e-6,
    9: 0.0254,
    10: 914.4,
    11: 1e-7,
    12: 1e-6,
    13: 1e-3,
    14: 100,
    15: 1e4,
    16: 1e5,
};
const MAX_DEPTH = 32;
const MAX_HATCH_LINES = 20_000; // more than this, and a hatch is shaded instead
// How many entities a file draws at most, its blocks' as often as they're inserted: a drawing has thousands, and a block
// arrayed in a block arrayed in another could make more than a browser can hold.
const MAX_DRAWN = 2_000_000;

class Builder {
    readonly layers: Layer[] = [];
    readonly strokes: Stroke[] = [];
    readonly fills: Fill[] = [];
    readonly labels: Label[] = [];
    readonly features: Feature[] = [];
    readonly left: Record<string, number> = {};
    private readonly layerInfo = new Map<string, LayerInfo>();
    private readonly linetypes = new Map<string, number[]>();
    private readonly styles = new Map<string, Style>();
    private readonly blocks = new Map<string, { base: Point; entities: Entry[] }>();
    private readonly ltscale: number;
    private readonly textSize: number;
    private readonly arrow: number;
    private drawn = 0;

    constructor(private readonly found: Sections) {
        const header = (name: string, code: number, otherwise: number) =>
            found.header.get(name)?.number(code, otherwise) ?? otherwise;
        const metric = header("$MEASUREMENT", 70, 1) === 1;
        this.ltscale = header("$LTSCALE", 40, 1) || 1;
        this.textSize = header("$TEXTSIZE", 40, metric ? 2.5 : 0.2) || 2.5;
        this.arrow = (header("$DIMASZ", 40, metric ? 2.5 : 0.18) || 2.5) * (header("$DIMSCALE", 40, 1) || 1);
        this.readTables();
        this.readBlocks();
    }

    private readTables(): void {
        for (const record of this.found.tables) {
            if (record.type === "LTYPE") {
                const dashes = record.numbers(49);
                if (dashes.some((d) => d !== 0) && dashes.length > 0) {
                    this.linetypes.set(record.text(2).toUpperCase(), dashes);
                }
            } else if (record.type === "STYLE") {
                const xdata = record.text(1000);
                this.styles.set(record.text(2).toUpperCase(), {
                    widthFactor: record.number(41, 1) || 1,
                    height: record.number(40, 0),
                    oblique: record.number(50, 0),
                    font: fontFamily(record.text(3), record.has(1001) && xdata ? xdata : ""),
                });
            } else if (record.type === "LAYER") {
                const name = record.text(2, "0");
                const color = record.number(62, 7);
                const off = color < 0 || (record.number(70, 0) & 1) === 1;
                const info = this.layer(name);
                info.color = record.has(420) ? trueColor(record.number(420)) : aciColor(color);
                info.linetype = record.text(6, "CONTINUOUS").toUpperCase();
                const weight = record.number(370, -3);
                info.weight = weight >= 0 ? weight / 100 : 0;
                this.layers[info.index]!.color = info.color;
                this.layers[info.index]!.shown = !off;
            }
        }
    }

    private readBlocks(): void {
        let current: { base: Point; entities: Entry[] } | null = null;
        for (const record of this.found.blocks) {
            if (record.type === "BLOCK") {
                current = { base: record.point(10), entities: [] };
                // External references are files of their own: there's nothing here to draw.
                if ((record.number(70, 0) & 4) === 0) {
                    this.blocks.set(record.text(2).toUpperCase(), current);
                }
            } else if (record.type === "ENDBLK") {
                current = null;
            } else {
                current?.entities.push(record);
            }
        }
    }

    /** A layer's information, made as the file would have it if its table doesn't list it. */
    private layer(name: string): LayerInfo {
        const key = name.toUpperCase();
        let info = this.layerInfo.get(key);
        if (!info) {
            info = { index: this.layers.length, color: null, linetype: "CONTINUOUS", weight: 0 };
            this.layerInfo.set(key, info);
            this.layers.push({ name, color: null, shown: true, count: 0 });
        }
        return info;
    }

    /** An entity's layer, color, dashes, and weight, with BYLAYER and BYBLOCK settled. */
    private look(
        record: Entry,
        place: Place,
    ): { layer: number; color: Color; dash: number[] | null; weight: number; layerName: string } {
        let layerName = record.text(8, "0");
        if (layerName === "0" && place.layer !== null) {
            layerName = place.layer;
        }
        const info = this.layer(layerName);
        const aci = record.number(62, 256);
        const color = record.has(420)
            ? trueColor(record.number(420))
            : aci === 256
              ? info.color
              : aci === 0
                ? place.color
                : aciColor(aci);
        let linetype = record.text(6, "BYLAYER").toUpperCase();
        if (linetype === "BYLAYER") {
            linetype = info.linetype;
        } else if (linetype === "BYBLOCK") {
            linetype = place.linetype;
        }
        const pattern = this.linetypes.get(linetype);
        const scale = this.ltscale * (record.number(48, 1) || 1);
        const total = pattern ? pattern.reduce((sum, d) => sum + Math.abs(d), 0) : 0;
        const dash = pattern ? pattern.map((d) => (d === 0 ? total / 50 : Math.abs(d)) * scale) : null;
        const lineweight = record.number(370, -1);
        const weight =
            lineweight === -1 ? info.weight : lineweight === -2 ? place.weight : lineweight >= 0 ? lineweight / 100 : 0;
        return { layer: info.index, color, dash: dash && dash.some((d) => d > 0) ? dash : null, weight, layerName };
    }

    private stroke(record: Entry, place: Place, path: number[], width = 0): void {
        if (path.length === 0) {
            return;
        }
        const { layer, color, dash, weight } = this.look(record, place);
        this.strokes.push({ layer, color, path, dash, weight, width });
        this.layers[layer]!.count++;
    }

    private fill(record: Entry, place: Place, path: number[], lines: number[] | null = null): void {
        const { layer, color } = this.look(record, place);
        this.fills.push({ layer, color, path, lines });
        this.layers[layer]!.count++;
    }

    private feature(record: Entry, place: Place, geometry: Geometry): void {
        this.features.push({ ...geometry, layer: this.look(record, place).layer });
    }

    private lineFeature(record: Entry, place: Place, m: Affine, a: Point, b: Point): void {
        this.feature(record, place, { kind: "line", a: apply(m, ...a), b: apply(m, ...b) });
    }

    /** An arc to measure, where the map keeps it an arc; turned counterclockwise if the map mirrors it. */
    private arcFeature(
        record: Entry,
        place: Place,
        m: Affine,
        center: Point,
        radius: number,
        from: number,
        sweep: number,
    ): void {
        const kept = similarity(m);
        if (!kept) {
            return;
        }
        let start = kept.mirrored ? kept.angle - from : kept.angle + from;
        if (kept.mirrored) {
            start -= sweep;
        }
        this.feature(record, place, {
            kind: "arc",
            center: apply(m, ...center),
            radius: radius * kept.scale,
            start,
            sweep,
        });
    }

    private skip(type: string): void {
        this.left[type] = (this.left[type] ?? 0) + 1;
    }

    /** Draw entities, in order: a POLYLINE takes the VERTEXes after it, and an INSERT its ATTRIBs. */
    draw(entities: Entry[], place: Place): void {
        for (let i = 0; i < entities.length; i++) {
            const record = entities[i]!;
            const after: Entry[] = [];
            if (record.type === "POLYLINE" || (record.type === "INSERT" && record.number(66, 0) === 1)) {
                while (
                    i + 1 < entities.length &&
                    entities[i + 1]!.type !== "SEQEND" &&
                    ["VERTEX", "ATTRIB"].includes(entities[i + 1]!.type)
                ) {
                    after.push(entities[++i]!);
                }
                if (entities[i + 1]?.type === "SEQEND") {
                    i++;
                }
            }
            if (record.number(60, 0) === 1) {
                continue; // invisible
            }
            if (++this.drawn > MAX_DRAWN) {
                this.skip(`entity past the first ${MAX_DRAWN.toLocaleString("en-US")}`);
                continue;
            }
            try {
                this.entity(record, after, place);
            } catch (error) {
                if (!(error instanceof RangeError || error instanceof TypeError)) {
                    throw error;
                }
                this.skip(`${record.type} that doesn't read`);
            }
        }
    }

    private entity(record: Entry, after: Entry[], place: Place): void {
        const m = place.m;
        switch (record.type) {
            case "LINE": {
                const [a, b] = [record.point(10), record.point(11)];
                const pen = new Pen(m);
                pen.move(...a);
                pen.line(...b);
                this.stroke(record, place, pen.path);
                this.lineFeature(record, place, m, a, b);
                return;
            }
            case "POINT":
                this.feature(record, place, { kind: "point", at: apply(m, ...record.point(10)) });
                this.layers[this.look(record, place).layer]!.count++;
                return;
            case "CIRCLE":
            case "ARC": {
                const local = compose(m, ocs(record));
                const center = record.point(10);
                const radius = record.number(40);
                const circle = record.type === "CIRCLE";
                const from = circle ? 0 : record.number(50) * RADIANS;
                const to = circle ? TAU : record.number(51) * RADIANS;
                const sweep = circle ? TAU : sweepOf(from, to, false);
                const pen = new Pen(local);
                pen.arc(center[0], center[1], radius, from, from + sweep, false, true);
                if (circle) {
                    pen.close();
                }
                this.stroke(record, place, pen.path);
                this.arcFeature(record, place, local, center, radius, from, sweep);
                return;
            }
            case "ELLIPSE": {
                const center = record.point(10);
                const major = record.point(11);
                const ratio = record.number(40, 1);
                const rx = Math.hypot(...major);
                const rotation = Math.atan2(major[1], major[0]);
                let from = record.number(41, 0);
                let to = record.number(42, TAU);
                // Drawn from the other side of the page, it goes the other way round.
                const flipped = record.number(230, 1) < 0;
                if (flipped) {
                    [from, to] = [-from, -to];
                }
                const pen = new Pen(m);
                const whole = Math.abs(Math.abs(to - from) - TAU) < 1e-9;
                pen.ellipse(
                    center[0],
                    center[1],
                    rx,
                    rx * ratio,
                    rotation,
                    from,
                    whole ? from + (flipped ? -TAU : TAU) : to,
                    flipped,
                    true,
                );
                this.stroke(record, place, pen.path);
                if (Math.abs(ratio - 1) < 1e-9) {
                    const sweep = whole ? TAU : sweepOf(from, to, flipped);
                    this.arcFeature(
                        record,
                        place,
                        m,
                        center,
                        rx,
                        rotation + (sweep < 0 ? from + sweep : from),
                        Math.abs(sweep),
                    );
                }
                return;
            }
            case "LWPOLYLINE": {
                const vertices: { at: Point; bulge: number }[] = [];
                for (let i = 0; i < record.codes.length; i++) {
                    const code = record.codes[i];
                    if (code === 10) {
                        vertices.push({ at: [Number(record.values[i]), Number(record.values[i + 1])], bulge: 0 });
                    } else if (code === 42 && vertices.length > 0) {
                        vertices[vertices.length - 1]!.bulge = Number(record.values[i]) || 0;
                    }
                }
                this.polyline(
                    record,
                    place,
                    compose(m, ocs(record)),
                    vertices,
                    (record.number(70, 0) & 1) === 1,
                    record.number(43, 0),
                );
                return;
            }
            case "POLYLINE":
                this.oldPolyline(record, after, place);
                return;
            case "SPLINE": {
                const control: Point[] = [];
                const fit: Point[] = [];
                for (let i = 0; i < record.codes.length; i++) {
                    if (record.codes[i] === 10) {
                        control.push([Number(record.values[i]), Number(record.values[i + 1])]);
                    } else if (record.codes[i] === 11) {
                        fit.push([Number(record.values[i]), Number(record.values[i + 1])]);
                    }
                }
                const points =
                    control.length > 1
                        ? nurbs(record.number(71, 3), record.numbers(40), control, record.numbers(41))
                        : fit;
                if (points.length < 2) {
                    this.skip("SPLINE without points");
                    return;
                }
                const pen = new Pen(m);
                pen.move(...points[0]!);
                points.slice(1).forEach((p) => pen.line(...p));
                if ((record.number(70, 0) & 1) === 1) {
                    pen.close();
                }
                this.stroke(record, place, pen.path);
                return;
            }
            case "SOLID":
            case "TRACE": {
                const local = compose(m, ocs(record));
                const [a, b, c, d] = [
                    record.point(10),
                    record.point(11),
                    record.point(12),
                    record.point(13, record.point(12)),
                ];
                const pen = new Pen(local);
                pen.move(...a);
                pen.line(...b);
                pen.line(...d); // corners go 1, 2, 4, 3
                pen.line(...c);
                pen.close();
                this.fill(record, place, pen.path);
                return;
            }
            case "3DFACE": {
                const corners = [
                    record.point(10),
                    record.point(11),
                    record.point(12),
                    record.point(13, record.point(12)),
                ];
                const hidden = record.number(70, 0);
                const pen = new Pen(m);
                corners.forEach((corner, i) => {
                    if ((hidden & (1 << i)) === 0) {
                        pen.move(...corner);
                        pen.line(...corners[(i + 1) % 4]!);
                    }
                });
                this.stroke(record, place, pen.path);
                return;
            }
            case "TEXT":
            case "ATTRIB":
            case "ATTDEF":
                // An attribute's definition shows in its block only when it's constant (its value never changes).
                if (
                    (record.type === "ATTDEF" && (record.number(70, 0) & 2) === 0) ||
                    (record.number(70, 0) & 1) === 1
                ) {
                    return;
                }
                this.text(record, place);
                return;
            case "MTEXT":
                this.mtext(record, place);
                return;
            case "INSERT":
                this.insert(record, place);
                after.forEach((attribute) => this.entity(attribute, [], place));
                return;
            case "LEADER":
                this.leader(record, place);
                return;
            case "MULTILEADER":
            case "MLEADER":
                this.multileader(record, place);
                return;
            case "HATCH":
                this.hatch(record, place);
                return;
            case "DIMENSION":
            case "ARC_DIMENSION":
            case "LARGE_RADIAL_DIMENSION": {
                // Drawn by the block it keeps (an anonymous one, *D1), already where it goes; or, without one, its text.
                const block = this.blocks.get(record.text(2).toUpperCase());
                if (block) {
                    this.drawBlock(record, place, block, compose(m, ocs(record)));
                } else {
                    this.dimensionText(record, place);
                }
                return;
            }
            case "SEQEND":
            case "VERTEX":
            case "VIEWPORT":
                return;
            default:
                this.skip(record.type);
        }
    }

    private polyline(
        record: Entry,
        place: Place,
        m: Affine,
        vertices: { at: Point; bulge: number }[],
        closed: boolean,
        width: number,
    ): void {
        if (vertices.length === 0) {
            return;
        }
        const pen = new Pen(m);
        pen.move(...vertices[0]!.at);
        const count = closed ? vertices.length : vertices.length - 1;
        for (let i = 0; i < count; i++) {
            const { at: a, bulge } = vertices[i]!;
            const b = vertices[(i + 1) % vertices.length]!.at;
            if (bulge !== 0 && (a[0] !== b[0] || a[1] !== b[1])) {
                const arc = bulgeArc(a, b, bulge);
                pen.arc(arc.center[0], arc.center[1], arc.radius, arc.from, arc.to, bulge < 0);
                const sweep = 4 * Math.atan(bulge);
                this.arcFeature(
                    record,
                    place,
                    m,
                    arc.center,
                    arc.radius,
                    bulge < 0 ? arc.to : arc.from,
                    Math.abs(sweep),
                );
            } else {
                pen.line(...b);
                if (a[0] !== b[0] || a[1] !== b[1]) {
                    this.lineFeature(record, place, m, a, b);
                }
            }
        }
        if (closed) {
            pen.close();
        }
        const kept = similarity(m);
        this.stroke(record, place, pen.path, width * (kept?.scale ?? 1));
    }

    /** A POLYLINE and its VERTEXes: a 2D or 3D polyline, or a mesh's edges. */
    private oldPolyline(record: Entry, vertices: Entry[], place: Place): void {
        const flags = record.number(70, 0);
        const points = vertices.filter((v) => (v.number(70, 0) & 128) === 0 || (v.number(70, 0) & 64) !== 0);
        if ((flags & 64) !== 0) {
            // A polyface mesh: its faces' visible edges, by their corners' numbers (negative: hidden).
            const corners = vertices.filter((v) => (v.number(70, 0) & 192) === 192);
            const faces = vertices.filter((v) => (v.number(70, 0) & 192) === 128);
            const pen = new Pen(place.m);
            for (const face of faces) {
                const numbers = [71, 72, 73, 74].map((code) => face.number(code, 0)).filter((n) => n !== 0);
                numbers.forEach((n, i) => {
                    const next = numbers[(i + 1) % numbers.length]!;
                    const [a, b] = [corners[Math.abs(n) - 1], corners[Math.abs(next) - 1]];
                    if (n > 0 && a && b) {
                        pen.move(...a.point(10));
                        pen.line(...b.point(10));
                    }
                });
            }
            this.stroke(record, place, pen.path);
            return;
        }
        if ((flags & 16) !== 0) {
            // A polygon mesh: m rows of n vertices, joined along rows and down columns.
            const [rows, columns] = [record.number(71, 0), record.number(72, 0)];
            const pen = new Pen(place.m);
            const at = (r: number, c: number) => points[r * columns + c]?.point(10);
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < columns; c++) {
                    const here = at(r, c);
                    const [right, down] = [at(r, c + 1), at(r + 1, c)];
                    if (here && right && c + 1 < columns) {
                        pen.move(...here);
                        pen.line(...right);
                    }
                    if (here && down && r + 1 < rows) {
                        pen.move(...here);
                        pen.line(...down);
                    }
                }
            }
            this.stroke(record, place, pen.path);
            return;
        }
        const flat = (flags & 8) === 0; // a 3D polyline's points are the drawing's own
        const m = flat ? compose(place.m, ocs(record)) : place.m;
        const vertexList = points.map((v) => ({ at: v.point(10), bulge: flat ? v.number(42, 0) : 0 }));
        this.polyline(record, place, m, vertexList, (flags & 1) === 1, record.number(40, 0));
    }

    private insert(record: Entry, place: Place): void {
        const name = record.text(2).toUpperCase();
        const block = this.blocks.get(name);
        if (!block) {
            this.skip("INSERT of a block that isn't there");
            return;
        }
        if (place.depth >= MAX_DEPTH || place.within.has(name)) {
            this.skip("INSERT of a block inside itself");
            return;
        }
        const local = compose(place.m, ocs(record));
        const [x, y] = record.point(10);
        const [sx, sy] = [record.number(41, 1) || 1, record.number(42, 1) || 1];
        const turn = record.number(50, 0) * RADIANS;
        const [columns, rows] = [Math.max(1, record.number(70, 1)), Math.max(1, record.number(71, 1))];
        const [dx, dy] = [record.number(44, 0), record.number(45, 0)];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < columns; c++) {
                if (this.drawn > MAX_DRAWN) {
                    return; // what isn't drawn is counted (draw)
                }
                const m = [
                    translate(x, y),
                    rotate(turn),
                    translate(c * dx, r * dy),
                    scaling(sx, sy),
                    translate(-block.base[0], -block.base[1]),
                ].reduce(compose);
                this.drawBlock(record, place, block, compose(local, m), name);
            }
        }
    }

    private drawBlock(record: Entry, place: Place, block: { entities: Entry[] }, m: Affine, name = ""): void {
        const look = this.look(record, place);
        let linetype = record.text(6, "BYLAYER").toUpperCase();
        if (linetype === "BYLAYER") {
            linetype = this.layer(look.layerName).linetype;
        } else if (linetype === "BYBLOCK") {
            linetype = place.linetype;
        }
        const inner: Place = {
            m,
            layer: look.layerName,
            color: look.color,
            linetype,
            weight: look.weight,
            depth: place.depth + 1,
            within: name ? new Set([...place.within, name]) : place.within,
        };
        this.draw(block.entities, inner);
    }

    /** TEXT, and attributes: one line, placed by its justification. */
    private text(record: Entry, place: Place): void {
        const value = specials(record.text(1));
        if (!value.trim()) {
            return;
        }
        const style = this.styles.get(record.text(7, "STANDARD").toUpperCase());
        const height = record.number(40, 0) || style?.height || this.textSize;
        const widthFactor = record.number(41, 0) || style?.widthFactor || 1;
        const oblique = record.number(51, style?.oblique ?? 0) * RADIANS;
        const horizontal = record.number(72, 0);
        const vertical = record.number(record.type === "TEXT" ? 73 : 74, 0);
        const first = record.point(10);
        const second = record.has(11) ? record.point(11) : first;
        let anchor = horizontal === 0 && vertical === 0 ? first : second;
        let turn = record.number(50, 0) * RADIANS;
        let fit = 0;
        if (horizontal === 3 || horizontal === 5) {
            // Aligned or fit: along from the first point to the second, filling the distance between.
            anchor = first;
            turn = Math.atan2(second[1] - first[1], second[0] - first[0]);
            fit = Math.hypot(second[0] - first[0], second[1] - first[1]);
        }
        const generation = record.number(71, 0); // 2: backwards, 4: upside down
        const flip = scaling(generation & 2 ? -1 : 1, generation & 4 ? -1 : 1);
        const frame = [
            translate(...anchor),
            rotate(turn),
            flip,
            [widthFactor, 0, Math.tan(oblique), 1, 0, 0] as Affine,
        ].reduce(compose);
        const top =
            horizontal === 4
                ? -height / 2
                : vertical === 1
                  ? 0.29 * height
                  : vertical === 2
                    ? -height / 2
                    : vertical === 3
                      ? -height
                      : 0;
        this.label(record, place, compose(compose(place.m, ocs(record)), frame), {
            lines: [value],
            height,
            align:
                fit > 0
                    ? "left"
                    : horizontal === 1 || horizontal === 4
                      ? "center"
                      : horizontal === 2
                        ? "right"
                        : "left",
            top,
            spacing: height,
            fit: fit > 0 ? fit / widthFactor : 0,
            wrap: 0,
            font: style?.font ?? SANS,
        });
    }

    private mtext(record: Entry, place: Place): void {
        const lines = mtextLines([...record.all(3), record.text(1)].join(""));
        if (lines.every((line) => !line.trim())) {
            return;
        }
        const style = this.styles.get(record.text(7, "STANDARD").toUpperCase());
        const height = record.number(40, 0) || style?.height || this.textSize;
        const attachment = record.number(71, 1);
        const turn = record.has(11)
            ? Math.atan2(record.number(21, 0), record.number(11, 1))
            : record.number(50, 0) * RADIANS;
        const spacing = (5 / 3) * height * (record.number(44, 1) || 1);
        const row = Math.floor((attachment - 1) / 3); // top, middle, bottom
        const block = (lines.length - 1) * spacing + height;
        const top = row === 0 ? -height : row === 1 ? block / 2 - height : block - height;
        const widthFactor = style?.widthFactor ?? 1;
        const frame = [translate(...record.point(10)), rotate(turn), scaling(widthFactor, 1)].reduce(compose);
        this.label(record, place, compose(place.m, frame), {
            lines,
            height,
            align: (["left", "center", "right"] as const)[(attachment - 1) % 3] ?? "left",
            top,
            spacing,
            fit: 0,
            wrap: record.number(41, 0) / widthFactor,
            font: style?.font ?? SANS,
        });
    }

    private label(record: Entry, place: Place, matrix: Affine, text: Omit<Label, "layer" | "color" | "matrix">): void {
        const { layer, color } = this.look(record, place);
        this.labels.push({ layer, color, matrix, ...text });
        this.layers[layer]!.count++;
    }

    /** A dimension without the block it's drawn with: its text, where it goes. */
    private dimensionText(record: Entry, place: Place): void {
        const measured = record.number(42, NaN);
        const value = record
            .text(1, "<>")
            .replace("<>", Number.isFinite(measured) ? String(Number(measured.toFixed(4))) : "");
        if (!value.trim() || !record.has(11)) {
            this.skip(record.type);
            return;
        }
        const frame = compose(compose(place.m, ocs(record)), translate(...record.point(11)));
        this.label(record, place, compose(frame, rotate(record.number(53, 0) * RADIANS)), {
            lines: mtextLines(value),
            height: this.textSize,
            align: "center",
            top: -this.textSize / 2,
            spacing: (5 / 3) * this.textSize,
            fit: 0,
            wrap: 0,
            font: SANS,
        });
    }

    /** An arrowhead: a filled triangle with its point at tip, pointing away from from. */
    private arrowhead(record: Entry, place: Place, tip: Point, from: Point, size: number): void {
        const [dx, dy] = [tip[0] - from[0], tip[1] - from[1]];
        const length = Math.hypot(dx, dy);
        if (length === 0 || size <= 0) {
            return;
        }
        const [ux, uy] = [dx / length, dy / length];
        const back: Point = [tip[0] - ux * size, tip[1] - uy * size];
        const half = size / 6;
        const pen = new Pen(place.m);
        pen.move(...tip);
        pen.line(back[0] - uy * half, back[1] + ux * half);
        pen.line(back[0] + uy * half, back[1] - ux * half);
        pen.close();
        this.fill(record, place, pen.path);
    }

    private leader(record: Entry, place: Place): void {
        const points: Point[] = [];
        for (let i = 0; i < record.codes.length; i++) {
            if (record.codes[i] === 10) {
                points.push([Number(record.values[i]), Number(record.values[i + 1])]);
            }
        }
        if (points.length < 2) {
            return;
        }
        const pen = new Pen(place.m);
        pen.move(...points[0]!);
        points.slice(1).forEach((p) => pen.line(...p));
        this.stroke(record, place, pen.path);
        if (record.number(71, 1) !== 0) {
            this.arrowhead(record, place, points[0]!, points[1]!, this.arrow);
        }
    }

    /** A multileader, as far as it reads: its leaders' lines, with arrowheads, and its text. */
    private multileader(record: Entry, place: Place): void {
        const lines: Point[][] = [];
        let line: Point[] | null = null;
        let landing: Point | null = null; // where a leader's lines end, at its text
        let inLeader = false;
        let text = "";
        let textAt: Point | null = null;
        let height = 0;
        let arrow = 0;
        const { codes, values } = record;
        for (let i = 0; i < codes.length; i++) {
            const [code, value] = [codes[i]!, values[i]!];
            const point = (): Point => [Number(value), Number(values[i + 1])];
            if (code === 302 && value === "LEADER{") {
                [inLeader, landing] = [true, null];
            } else if (code === 303) {
                inLeader = false;
            } else if (code === 304 && value === "LEADER_LINE{") {
                line = [];
            } else if (code === 305 && line) {
                lines.push(landing ? [...line, landing] : line);
                line = null;
            } else if (code === 10 && line) {
                line.push(point());
            } else if (code === 10 && inLeader && !landing) {
                landing = point();
            } else if (code === 304) {
                text = value;
            } else if (code === 12 && !textAt) {
                textAt = point();
            } else if (code === 41 && !height) {
                height = Number(value);
            } else if (code === 140 && !arrow) {
                arrow = Number(value);
            }
        }
        height ||= this.textSize;
        const pen = new Pen(place.m);
        for (const points of lines.filter((l) => l.length >= 2)) {
            pen.move(...points[0]!);
            points.slice(1).forEach((p) => pen.line(...p));
            this.arrowhead(record, place, points[0]!, points[1]!, arrow || this.arrow);
        }
        this.stroke(record, place, pen.path);
        if (text && textAt) {
            this.label(record, place, compose(place.m, translate(...textAt)), {
                lines: mtextLines(text),
                height,
                align: "left",
                top: -height,
                spacing: (5 / 3) * height,
                fit: 0,
                wrap: 0,
                font: SANS,
            });
        }
    }

    /** A hatch: its boundary paths, filled solid, or with its pattern's lines across them. */
    private hatch(record: Entry, place: Place): void {
        const m = compose(place.m, ocs(record));
        const pen = new Pen(m);
        const local: Point[] = []; // the boundary's points, in the hatch's own coordinates, for its pattern's extent
        const { codes, values } = record;
        let i = codes.indexOf(91);
        if (i < 0) {
            this.skip("HATCH without a boundary");
            return;
        }
        const paths = Number(values[i]);
        i++;
        const take = (code: number): number => {
            // The next value of this code, at most a few codes on: what's between is what this reader doesn't need.
            for (let j = i; j < Math.min(codes.length, i + 8); j++) {
                if (codes[j] === code) {
                    i = j + 1;
                    return Number(values[j]);
                }
            }
            throw new RangeError(`a HATCH without its group ${code}`);
        };
        const point = (x: number): Point => [take(x), take(x + 10)];
        for (let p = 0; p < paths; p++) {
            const flags = take(92);
            if ((flags & 2) !== 0) {
                const bulged = take(72) !== 0;
                const closed = take(73);
                void closed;
                const count = take(93);
                const vertices: { at: Point; bulge: number }[] = [];
                for (let v = 0; v < count; v++) {
                    const at = point(10);
                    const bulge = bulged && codes[i] === 42 ? take(42) : 0;
                    vertices.push({ at, bulge });
                    local.push(at);
                }
                vertices.forEach(({ at, bulge }, v) => {
                    const next = vertices[(v + 1) % vertices.length]!.at;
                    if (v === 0) {
                        pen.move(...at);
                    }
                    if (bulge !== 0 && (at[0] !== next[0] || at[1] !== next[1])) {
                        const arc = bulgeArc(at, next, bulge);
                        pen.arc(arc.center[0], arc.center[1], arc.radius, arc.from, arc.to, bulge < 0);
                    } else {
                        pen.line(...next);
                    }
                });
                pen.close();
            } else {
                const edges = take(93);
                let started = false;
                for (let e = 0; e < edges; e++) {
                    const type = take(72);
                    if (type === 1) {
                        const [a, b] = [point(10), point(11)];
                        if (!started) {
                            pen.move(...a);
                        }
                        pen.line(...b);
                        local.push(a, b);
                    } else if (type === 2) {
                        const center = point(10);
                        const radius = take(40);
                        let [from, to] = [take(50) * RADIANS, take(51) * RADIANS];
                        const counterclockwise = take(73) !== 0;
                        if (!counterclockwise) {
                            [from, to] = [-from, -to]; // clockwise edges keep their angles as if counterclockwise
                        }
                        pen.arc(
                            center[0],
                            center[1],
                            radius,
                            from,
                            from + sweepOf(from, to, !counterclockwise),
                            !counterclockwise,
                            !started,
                        );
                        local.push([center[0] - radius, center[1] - radius], [center[0] + radius, center[1] + radius]);
                    } else if (type === 3) {
                        const center = point(10);
                        const major = point(11);
                        const ratio = take(40);
                        let [from, to] = [take(50) * RADIANS, take(51) * RADIANS];
                        const counterclockwise = take(73) !== 0;
                        if (!counterclockwise) {
                            [from, to] = [-from, -to];
                        }
                        const rx = Math.hypot(...major);
                        pen.ellipse(
                            center[0],
                            center[1],
                            rx,
                            rx * ratio,
                            Math.atan2(major[1], major[0]),
                            from,
                            from + sweepOf(from, to, !counterclockwise),
                            !counterclockwise,
                            !started,
                        );
                        local.push([center[0] - rx, center[1] - rx], [center[0] + rx, center[1] + rx]);
                    } else if (type === 4) {
                        const degree = take(94);
                        take(73);
                        take(74);
                        const [knotCount, controlCount] = [take(95), take(96)];
                        const knots = Array.from({ length: knotCount }, () => take(40));
                        const control: Point[] = [];
                        const weights: number[] = [];
                        for (let c = 0; c < controlCount; c++) {
                            control.push(point(10));
                            if (codes[i] === 42) {
                                weights.push(take(42));
                            }
                        }
                        const curve = nurbs(degree, knots, control, weights);
                        if (!started && curve[0]) {
                            pen.move(...curve[0]);
                        }
                        curve.forEach((c) => pen.line(...c));
                        local.push(...control);
                        if (codes[i] === 97) {
                            const fit = take(97);
                            for (let f = 0; f < fit; f++) {
                                point(11);
                            }
                        }
                    } else {
                        throw new RangeError(`a HATCH edge of type ${type}`);
                    }
                    started = true;
                }
                pen.close();
            }
            if (codes[i] === 97) {
                const sources = take(97);
                i += sources; // their handles (330s)
            }
        }
        const solid = record.number(70, 0) === 1;
        this.fill(record, place, pen.path, solid ? null : this.pattern(record, i, local, m));
    }

    /** A hatch's pattern lines (from code 53 on), across its boundary's extent, as segments in the drawing. */
    private pattern(record: Entry, from: number, boundary: Point[], m: Affine): number[] | null {
        if (boundary.length === 0) {
            return [];
        }
        const xs = boundary.map((p) => p[0]);
        const ys = boundary.map((p) => p[1]);
        const corners: Point[] = [
            [Math.min(...xs), Math.min(...ys)],
            [Math.max(...xs), Math.min(...ys)],
            [Math.max(...xs), Math.max(...ys)],
            [Math.min(...xs), Math.max(...ys)],
        ];
        const segments: number[] = [];
        const { codes, values } = record;
        for (let i = codes.indexOf(53, from); i >= 0 && i < codes.length; i = codes.indexOf(53, i + 1)) {
            const read = (offset: number, code: number) =>
                codes[i + offset] === code ? Number(values[i + offset]) : NaN;
            const angle = Number(values[i]) * RADIANS;
            const [bx, by, ox, oy] = [read(1, 43), read(2, 44), read(3, 45), read(4, 46)];
            const dashCount = read(5, 79) || 0;
            const dashes = Array.from({ length: dashCount }, (_, d) => read(6 + d, 49)).filter(Number.isFinite);
            if (![bx, by, ox, oy].every(Number.isFinite)) {
                continue;
            }
            const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
            const [nx, ny] = [-uy, ux];
            const gap = ox * nx + oy * ny; // between one line and the next
            if (Math.abs(gap) < 1e-12) {
                continue;
            }
            const across = corners.map(([x, y]) => ((x - bx) * nx + (y - by) * ny) / gap);
            const along = corners.map(([x, y]) => (x - bx) * ux + (y - by) * uy);
            const [k0, k1] = [Math.floor(Math.min(...across)), Math.ceil(Math.max(...across))];
            if (k1 - k0 > MAX_HATCH_LINES) {
                return null;
            }
            const period = dashes.reduce((sum, d) => sum + Math.abs(d), 0);
            for (let k = k0; k <= k1; k++) {
                const [x0, y0] = [bx + k * ox, by + k * oy];
                // Where this line crosses the extent, along it: its points are x0 + t u.
                const shift = (x0 - bx) * ux + (y0 - by) * uy;
                const [t0, t1] = [Math.min(...along) - shift, Math.max(...along) - shift];
                if (period <= 0 || dashes.length === 0) {
                    segments.push(...apply(m, x0 + t0 * ux, y0 + t0 * uy), ...apply(m, x0 + t1 * ux, y0 + t1 * uy));
                } else {
                    let t = Math.floor(t0 / period) * period;
                    while (t < t1) {
                        for (const dash of dashes) {
                            const length = Math.abs(dash);
                            if (dash >= 0) {
                                const [a, b] = [t, t + Math.max(dash, period * 1e-3)]; // a dot, as a short dash
                                segments.push(
                                    ...apply(m, x0 + a * ux, y0 + a * uy),
                                    ...apply(m, x0 + b * ux, y0 + b * uy),
                                );
                            }
                            t += length;
                        }
                        if (segments.length / 4 > MAX_HATCH_LINES * 4) {
                            return null;
                        }
                    }
                }
                if (segments.length / 4 > MAX_HATCH_LINES * 4) {
                    return null;
                }
            }
        }
        return segments;
    }

    finish(entities: Entry[]): Drawing {
        const paper = entities.filter((e) => e.number(67, 0) === 1);
        const model = entities.filter((e) => e.number(67, 0) !== 1);
        const space = model.length > 0 || paper.length === 0 ? "model" : "paper";
        this.draw(space === "model" ? model : paper, {
            m: IDENTITY,
            layer: null,
            color: null,
            linetype: "CONTINUOUS",
            weight: 0,
            depth: 0,
            within: new Set(),
        });
        const header = this.found.header;
        const insunits = header.get("$INSUNITS")?.number(70, 0) ?? 0;
        const measurement = header.get("$MEASUREMENT")?.number(70, -1) ?? -1;
        const known =
            UNITS[insunits] ??
            (insunits === 0 && measurement === 0
                ? UNITS[1]
                : insunits === 0 && measurement === 1
                  ? UNITS[4]
                  : undefined);
        const other = OTHER_UNITS[insunits];
        return {
            units: known?.[0] ?? "mm",
            mmPerUnit: known?.[1] ?? other ?? null,
            space,
            layers: this.layers,
            strokes: this.strokes,
            fills: this.fills,
            labels: this.labels,
            features: this.features,
            bounds: bounds(this.strokes, this.fills, this.labels, this.features),
            left: this.left,
        };
    }
}

// --- extents ----------------------------------------------------------------------------------------------------------

/** The box a path's points and curves keep within. */
export function pathBounds(path: number[], box: { min: Point; max: Point } | null): { min: Point; max: Point } | null {
    let found = box;
    const add = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        found = found
            ? {
                  min: [Math.min(found.min[0], x), Math.min(found.min[1], y)],
                  max: [Math.max(found.max[0], x), Math.max(found.max[1], y)],
              }
            : { min: [x, y], max: [x, y] };
    };
    for (let i = 0; i < path.length;) {
        switch (path[i]) {
            case MOVE:
            case LINE:
                add(path[i + 1]!, path[i + 2]!);
                i += 3;
                break;
            case ARC: {
                const [cx, cy, r, from, to, backwards] = path.slice(i + 1, i + 7) as [
                    number,
                    number,
                    number,
                    number,
                    number,
                    number,
                ];
                const sweep = sweepOf(from, to, backwards === 1);
                const start = sweep < 0 ? from + sweep : from;
                const visit = (t: number) => add(cx + r * Math.cos(t), cy + r * Math.sin(t));
                visit(start);
                visit(start + Math.abs(sweep));
                for (let k = Math.ceil(start / (Math.PI / 2)); k * (Math.PI / 2) <= start + Math.abs(sweep); k++) {
                    visit(k * (Math.PI / 2));
                }
                i += 7;
                break;
            }
            case ELLIPSE: {
                const [cx, cy, rx, ry, rotation] = path.slice(i + 1, i + 6) as [number, number, number, number, number];
                // The box of the whole ellipse: near enough for fitting the view.
                const [c, s] = [Math.cos(rotation), Math.sin(rotation)];
                const [hx, hy] = [Math.hypot(rx * c, ry * s), Math.hypot(rx * s, ry * c)];
                add(cx - hx, cy - hy);
                add(cx + hx, cy + hy);
                i += 9;
                break;
            }
            default:
                i += 1;
        }
    }
    return found;
}

function bounds(
    strokes: Stroke[],
    fills: Fill[],
    labels: Label[],
    features: Feature[],
): { min: Point; max: Point } | null {
    let box: { min: Point; max: Point } | null = null;
    strokes.forEach((stroke) => (box = pathBounds(stroke.path, box)));
    fills.forEach((fill) => (box = pathBounds(fill.path, box)));
    labels.forEach((label) => {
        const width = label.fit || label.wrap || label.height * Math.max(...label.lines.map((l) => l.length)) * 0.6;
        const left = label.align === "left" ? 0 : label.align === "center" ? -width / 2 : -width;
        const [top, bottom] = [label.top + label.height, label.top - (label.lines.length - 1) * label.spacing];
        const corners = [apply(label.matrix, left, top), apply(label.matrix, left + width, bottom)];
        box = pathBounds(
            corners.flatMap((p) => [LINE, ...p]),
            box,
        );
    });
    features.forEach((feature) => {
        if (feature.kind === "point") {
            box = pathBounds([MOVE, ...feature.at], box);
        }
    });
    return box;
}

// --- reading ------------------------------------------------------------------------------------------------------------

/** A DXF file (text or binary) as Caliper draws it. DxfError says why one can't be read. */
export function readDxf(bytes: Uint8Array): Drawing {
    const found = sections(readPairs(bytes));
    return new Builder(found).finish(found.entities);
}

/** A drawing's length (in its own units) in millimeters, taking millimeters where the file doesn't say. */
export const inMillimeters = (drawing: Drawing, length: number): number => length * (drawing.mmPerUnit ?? 1);
