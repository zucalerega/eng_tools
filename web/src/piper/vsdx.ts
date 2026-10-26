import { readZip, ZipError, type ZipEntry } from "../zip";
import type { Point } from "./drawing";

// Reading a Visio drawing (.vsdx, Visio 2013 on): a zip of XML, each page's shapes (each an instance of a master, a
// stencil's shape, or of none), the masters, and the document's styles. A shape is drawn as its ShapeSheet says, and a
// cell it doesn't set is its master's, else its style's (a line, a fill, and a text style, each based on another),
// else Visio's own default; a group's members are placed in its frame, and an instance's are its master's members'.
// What's read here is what Visio draws, on the page: each shape's outlines (as moves, lines, and Bézier curves), its
// line and fill, its words and where they sit, its connection points, and which shapes its connectors are glued to.
// visio.ts makes a Piper diagram of it.

export class VisioError extends Error {}

/** Part of an outline: a move, a line, or a cubic Bézier curve to a point, or back to where it started. */
export type Step =
    | { kind: "move"; to: Point }
    | { kind: "line"; to: Point }
    | { kind: "curve"; a: Point; b: Point; to: Point }
    | { kind: "close" };

/** One of a shape's outlines (a geometry section): its steps, and whether it's filled and its line drawn. */
export interface Outline {
    steps: Step[];
    filled: boolean;
    stroked: boolean;
}

/** How a shape's lines are drawn. */
export interface Pen {
    color: string; // #rrggbb
    weight: number; // inches
    pattern: number; // Visio's: 1 solid, 2 dashed, 3 dotted, 4 dash-dot...
    opacity: number;
    begin: number; // its arrowheads, as Visio numbers them: 0 for none
    end: number;
    beginSize: number; // 0 (very small) to 6 (colossal), 2 medium
    endSize: number;
}

export interface Brush {
    color: string;
    opacity: number;
}

/** How a run of words is set. */
export interface Lettering {
    size: number; // its letters', inches
    color: string;
    bold: boolean;
    italic: boolean;
    font: string; // its typeface's name: "Calibri"
}

/** A shape's words: what they say, where their block is on the page, and how they're set (as their first words are,
 * and each run of them as it is). */
export interface Words extends Lettering {
    lines: string[]; // its paragraphs, and the lines broken within them
    runs: { text: string; lettering: Lettering }[][]; // each line's runs, each set its own way
    pitch: number; // from one line to the next, inches
    at: Point; // its block's middle
    width: number; // its block's, inches
    height: number;
    angle: number; // radians, counterclockwise: the way it reads
    align: "left" | "center" | "right";
    valign: "top" | "middle" | "bottom";
    margins: { left: number; right: number; top: number; bottom: number };
    background: string; // the color behind it, if it has one: "" for none
}

export interface VisioShape {
    id: string;
    kind: "shape" | "group" | "foreign";
    master: string; // its master's name ("Gate valve"), or for a member of an instance, the instance's; "" for none
    name: string; // its own, as Visio has it ("Sheet.12", or a master's name with a number)
    oneD: boolean; // a connector or a line: it has a beginning and an end
    begin: Point | null; // on the page
    end: Point | null;
    pin: Point; // on the page
    middle: Point; // its frame's middle, on the page
    width: number; // inches
    height: number;
    axes: { x: Point; y: Point }; // the ways its frame's x and y go on the page (turned, flipped): a unit long each
    outlines: Outline[]; // on the page
    pen: Pen | null; // null: its lines aren't drawn
    brush: Brush | null; // null: it isn't filled
    words: Words | null;
    connections: Point[]; // where connectors glue to it, on the page
    members: VisioShape[]; // a group's, bottom first
    front: boolean; // a group's own outline and words drawn over its members (Visio's default), not under
    picture: string | null; // a foreign shape's image: its path in the package
}

export interface Glue {
    connector: string; // a connector's id
    end: "begin" | "end";
    shape: string; // the shape that end is glued to: any shape's, a member of a group's too
}

export interface VisioPage {
    name: string; // as Visio shows it
    width: number; // inches
    height: number;
    shapes: VisioShape[]; // bottom first
    glue: Glue[];
}

const MOST_XML = 32 * 1024 * 1024;
const MOST_SHAPES = 20_000; // on a page, its groups' members included

// --- the package ---------------------------------------------------------------------------------------------------

type Package = Map<string, ZipEntry>;

async function xml(files: Package, path: string): Promise<Document | null> {
    const entry = files.get(path.toLowerCase());
    if (!entry) {
        return null;
    }
    if (entry.size > MOST_XML) {
        throw new VisioError(`Its ${path} is too big to read here`);
    }
    const document = new DOMParser().parseFromString(new TextDecoder().decode(await entry.read()), "application/xml");
    if (document.getElementsByTagName("parsererror").length > 0) {
        throw new VisioError(`Its ${path} isn't XML Piper can read: the file may be damaged`);
    }
    return document;
}

interface Relationship {
    target: string; // its path in the package
    type: string;
}

/** Where a part's relationships point, by their ids: rId1 is "visio/pages/page1.xml". */
async function relationships(files: Package, path: string): Promise<Map<string, Relationship>> {
    const folder = path.slice(0, path.lastIndexOf("/") + 1);
    const rels = await xml(files, `${folder}_rels/${path.slice(folder.length)}.rels`);
    const found = new Map<string, Relationship>();
    for (const rel of rels ? [...rels.getElementsByTagName("Relationship")] : []) {
        const target = rel.getAttribute("Target") ?? "";
        found.set(rel.getAttribute("Id") ?? "", {
            target: target.startsWith("/") ? target.slice(1) : resolve(folder, target),
            type: rel.getAttribute("Type") ?? "",
        });
    }
    return found;
}

function resolve(folder: string, target: string): string {
    const out: string[] = [];
    for (const part of (folder + target).split("/")) {
        if (part === "..") {
            out.pop();
        } else if (part !== "." && part !== "") {
            out.push(part);
        }
    }
    return out.join("/");
}

const kids = (element: Element, name: string): Element[] =>
    [...element.children].filter((child) => child.localName === name);
const kid = (element: Element, name: string): Element | null => kids(element, name)[0] ?? null;

/** A relationship's id on an element: <Rel r:id="rId1"/>. */
function relId(element: Element): string {
    const rel = kid(element, "Rel");
    return (
        rel?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ??
        rel?.getAttribute("r:id") ??
        ""
    );
}

/** A name without the number Visio adds to the second of a name ("Gate valve.12"). */
export const cleanName = (name: string) => name.replace(/\.\d+$/, "").trim();

// --- ShapeSheets ---------------------------------------------------------------------------------------------------

interface Row {
    ix: number;
    type: string; // a geometry row's: "MoveTo", "LineTo"... ("" when an instance's row takes its master's)
    deleted: boolean;
    cells: Map<string, string>;
    formulas: Map<string, string>; // the few whose value is a formula's list (POLYLINE, NURBS)
}

interface Section {
    ix: number; // a geometry section's (there can be several); 0 for the others
    deleted: boolean;
    cells: Map<string, string>;
    rows: Row[];
}

/** A ShapeSheet as it's written: a shape's, a master's shape's, or a style's. */
interface Sheet {
    cells: Map<string, string>;
    sections: Map<string, Section[]>;
    text: Element | null;
    styles: { line: string | null; fill: string | null; text: string | null };
}

/** A cell's value as written. "Themed" (the theme's, which Piper doesn't read) counts as not set. */
function cellsIn(element: Element): Map<string, string> {
    const found = new Map<string, string>();
    for (const cell of kids(element, "Cell")) {
        const value = cell.getAttribute("V");
        if (value !== null && value !== "Themed") {
            found.set(cell.getAttribute("N") ?? "", value);
        }
    }
    return found;
}

function sheetOf(element: Element): Sheet {
    const sections = new Map<string, Section[]>();
    for (const section of kids(element, "Section")) {
        const name = section.getAttribute("N") ?? "";
        const rows = kids(section, "Row").map((row, index) => ({
            // A row named rather than numbered (a user cell's) is kept in its order.
            ix: Number.parseInt(row.getAttribute("IX") ?? "", 10) || (row.getAttribute("IX") === "0" ? 0 : index),
            type: row.getAttribute("T") ?? "",
            deleted: row.getAttribute("Del") === "1",
            cells: cellsIn(row),
            formulas: new Map(
                kids(row, "Cell")
                    .filter((cell) => /^(POLYLINE|NURBS)\(/i.test(cell.getAttribute("F") ?? ""))
                    .map((cell) => [cell.getAttribute("N") ?? "", cell.getAttribute("F") ?? ""]),
            ),
        }));
        const list = sections.get(name) ?? [];
        list.push({
            ix: Number.parseInt(section.getAttribute("IX") ?? "0", 10) || 0,
            deleted: section.getAttribute("Del") === "1",
            cells: cellsIn(section),
            rows,
        });
        sections.set(name, list);
    }
    return {
        cells: cellsIn(element),
        sections,
        text: kid(element, "Text"),
        styles: {
            line: element.getAttribute("LineStyle"),
            fill: element.getAttribute("FillStyle"),
            text: element.getAttribute("TextStyle"),
        },
    };
}

/** A section's rows, an instance's over its master's: the same row (by its index) changed, added, or deleted. */
function mergeRows(own: Row[], inherited: Row[]): Row[] {
    const rows = new Map<number, Row>();
    for (const row of inherited) {
        rows.set(row.ix, row);
    }
    for (const row of own) {
        const base = rows.get(row.ix);
        rows.set(
            row.ix,
            base
                ? {
                      ix: row.ix,
                      type: row.type || base.type,
                      deleted: row.deleted,
                      cells: new Map([...base.cells, ...row.cells]),
                      formulas: new Map([...base.formulas, ...row.formulas]),
                  }
                : row,
        );
    }
    return [...rows.values()].filter((row) => !row.deleted).sort((a, b) => a.ix - b.ix);
}

/** A shape's sections of a name, its own over its master's, matched by their index. */
function mergeSections(own: Section[], inherited: Section[]): Section[] {
    const sections = new Map<number, Section>();
    for (const section of inherited) {
        sections.set(section.ix, section);
    }
    for (const section of own) {
        const base = sections.get(section.ix);
        sections.set(
            section.ix,
            base
                ? {
                      ix: section.ix,
                      deleted: section.deleted,
                      cells: new Map([...base.cells, ...section.cells]),
                      rows: mergeRows(section.rows, base.rows),
                  }
                : { ...section, rows: mergeRows(section.rows, []) },
        );
    }
    return [...sections.values()].filter((section) => !section.deleted).sort((a, b) => a.ix - b.ix);
}

// Which style a cell is read from, when neither the shape nor its master sets it.
const LINE_CELLS = new Set([
    "LineWeight",
    "LineColor",
    "LinePattern",
    "Rounding",
    "EndArrowSize",
    "BeginArrow",
    "EndArrow",
    "LineCap",
    "BeginArrowSize",
    "LineColorTrans",
]);
const FILL_CELLS = new Set(["FillForegnd", "FillBkgnd", "FillPattern", "FillForegndTrans", "FillBkgndTrans"]);

/** The document's styles, by id, each a ShapeSheet based on others. */
type Styles = Map<string, Sheet>;

/** What Visio has when nothing sets a cell: a thin black line, a white fill, and 12-point black Calibri. */
const DEFAULTS: Record<string, string> = {
    LineWeight: "0.01041666666666667",
    LineColor: "0",
    LinePattern: "1",
    LineColorTrans: "0",
    BeginArrow: "0",
    EndArrow: "0",
    BeginArrowSize: "2",
    EndArrowSize: "2",
    FillForegnd: "1",
    FillBkgnd: "0",
    FillPattern: "1",
    FillForegndTrans: "0",
    VerticalAlign: "1",
    TextBkgnd: "0",
    LeftMargin: "0.05555555555555555",
    RightMargin: "0.05555555555555555",
    TopMargin: "0.05555555555555555",
    BottomMargin: "0.05555555555555555",
};

const CHARACTER_DEFAULTS: Record<string, string> = { Size: "0.1666666666666667", Color: "0", Style: "0", Font: "" };

/** A shape's cells and sections as Visio reads them: its own, else its master's shape's, else its styles'. */
class ShapeSheet {
    private readonly sheets: Sheet[];

    constructor(
        own: Sheet,
        master: Sheet | null,
        private readonly styles: Styles,
    ) {
        this.sheets = master ? [own, master] : [own];
    }

    private styleChain(which: "line" | "fill" | "text"): Sheet[] {
        const chain: Sheet[] = [];
        let id = this.sheets.map((sheet) => sheet.styles[which]).find((value) => value !== null) ?? null;
        const seen = new Set<string>();
        while (id !== null && !seen.has(id)) {
            seen.add(id);
            const style = this.styles.get(id);
            if (!style) {
                break;
            }
            chain.push(style);
            id = style.styles[which];
        }
        return chain;
    }

    /** A cell's value: the shape's, its master's, or its style's. */
    get(name: string): string | undefined {
        for (const sheet of this.sheets) {
            const value = sheet.cells.get(name);
            if (value !== undefined) {
                return value;
            }
        }
        const which = LINE_CELLS.has(name) ? "line" : FILL_CELLS.has(name) ? "fill" : DEFAULTS[name] ? "text" : null;
        if (which) {
            for (const style of this.styleChain(which)) {
                const value = style.cells.get(name);
                if (value !== undefined) {
                    return value;
                }
            }
        }
        return DEFAULTS[name];
    }

    has(name: string): boolean {
        return this.sheets.some((sheet) => sheet.cells.has(name));
    }

    num(name: string, fallback = 0): number {
        return number(this.get(name), fallback);
    }

    sections(name: string): Section[] {
        const own = this.sheets[0]!.sections.get(name) ?? [];
        const master = this.sheets[1]?.sections.get(name) ?? [];
        return mergeSections(own, master);
    }

    /** A text row's cell (a character's or a paragraph's): the shape's row, its master's, else its text style's. */
    textCell(section: "Character" | "Paragraph", ix: number, name: string): string | undefined {
        for (const found of this.sections(section)) {
            const row = found.rows.find((entry) => entry.ix === ix) ?? found.rows[0];
            const value = row?.cells.get(name);
            if (value !== undefined) {
                return value;
            }
        }
        for (const style of this.styleChain("text")) {
            const row = style.sections.get(section)?.[0]?.rows[0];
            const value = row?.cells.get(name);
            if (value !== undefined) {
                return value;
            }
        }
        return section === "Character" ? CHARACTER_DEFAULTS[name] : undefined;
    }

    get text(): Element | null {
        return this.sheets.find((sheet) => sheet.text)?.text ?? null;
    }
}

const number = (value: string | undefined, fallback = 0): number => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
};

// --- colors --------------------------------------------------------------------------------------------------------

/** Visio's first 24 colors, by index: a drawing's own come after them (its document's Colors). */
const PALETTE = [
    "#000000",
    "#ffffff",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#ffff00",
    "#ff00ff",
    "#00ffff",
    "#800000",
    "#008000",
    "#000080",
    "#808000",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#e6e6e6",
    "#cdcdcd",
    "#b3b3b3",
    "#9a9a9a",
    "#808080",
    "#666666",
    "#4d4d4d",
    "#333333",
    "#1a1a1a",
];

function colorOf(value: string | undefined, palette: string[]): string | null {
    if (value === undefined) {
        return null;
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
    if (hex) {
        return `#${hex[1]!.toLowerCase()}`;
    }
    const rgb = /^RGB\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value.trim());
    if (rgb) {
        return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`;
    }
    const index = Number.parseInt(value, 10);
    return Number.isInteger(index) && index >= 0 ? (palette[index] ?? null) : null;
}

// --- placing shapes on the page ------------------------------------------------------------------------------------

/** An affine map of the plane: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m after n: n applied first. */
const times = (m: Matrix, n: Matrix): Matrix => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
];

const apply = (m: Matrix, p: Point): Point => ({
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
});

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const rotate = (angle: number): Matrix => [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];

/**
 * Where a shape's own frame (its bottom left at 0, 0) is in its parent's: its local pin put on its pin, flipped about
 * it, and turned about it, as Visio places a shape.
 */
function placement(sheet: ShapeSheet, width: number, height: number): Matrix {
    const flip = scale(sheet.get("FlipX") === "1" ? -1 : 1, sheet.get("FlipY") === "1" ? -1 : 1);
    return [
        translate(sheet.num("PinX"), sheet.num("PinY")),
        rotate(sheet.num("Angle")),
        flip,
        translate(-sheet.num("LocPinX", width / 2), -sheet.num("LocPinY", height / 2)),
    ].reduce((all, next) => times(all, next), IDENTITY);
}

/**
 * How a shape is turned on the page, for its words: flipping a shape moves its words but never mirrors them or turns
 * them over (a valve flipped upside down keeps its actuator's P upright), so they turn only as its frame and its
 * groups' are turned, each the other way inside an odd number of flips.
 */
interface Turn {
    angle: number; // radians, counterclockwise
    sign: 1 | -1; // -1: mirrored, by an odd number of flips
}

function turnOf(parent: Turn, sheet: ShapeSheet): Turn {
    const flips = Number(sheet.get("FlipX") === "1") + Number(sheet.get("FlipY") === "1");
    return {
        angle: parent.angle + parent.sign * sheet.num("Angle"),
        sign: flips % 2 === 1 ? (-parent.sign as 1 | -1) : parent.sign,
    };
}

/** A direction on the page, as long as it is: where a frame's axis goes. */
const along = (m: Matrix, x: number, y: number): Point => {
    const length = Math.hypot(m[0] * x + m[2] * y, m[1] * x + m[3] * y) || 1;
    return { x: (m[0] * x + m[2] * y) / length, y: (m[1] * x + m[3] * y) / length };
};

// --- outlines ------------------------------------------------------------------------------------------------------

const KAPPA = 0.5522847498; // a quarter circle's Bézier control points, along its tangents, of its radius

/** A circular arc from its start through a point on it to its end, as Bézier curves (each at most a quarter turn). */
function arcThrough(from: Point, through: Point, to: Point): Step[] {
    // The circle's center: where the perpendicular bisectors of the two chords meet.
    const ax = through.x - from.x;
    const ay = through.y - from.y;
    const bx = to.x - from.x;
    const by = to.y - from.y;
    const cross = 2 * (ax * by - ay * bx);
    if (Math.abs(cross) < 1e-12) {
        return [{ kind: "line", to }];
    }
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const center = { x: from.x + (by * a2 - ay * b2) / cross, y: from.y + (ax * b2 - bx * a2) / cross };
    const radius = Math.hypot(from.x - center.x, from.y - center.y);
    const angleOf = (p: Point) => Math.atan2(p.y - center.y, p.x - center.x);
    const start = angleOf(from);
    const counter = cross > 0; // through lies to the left of the way to the end: counterclockwise, y up
    let sweep = angleOf(to) - start;
    if (counter && sweep <= 0) {
        sweep += 2 * Math.PI;
    } else if (!counter && sweep >= 0) {
        sweep -= 2 * Math.PI;
    }
    return arcSteps(center, radius, radius, 0, start, sweep, to);
}

/** An elliptical arc around a center, from an angle through a sweep (radians), as Bézier curves. */
function arcSteps(
    center: Point,
    rx: number,
    ry: number,
    tilt: number,
    start: number,
    sweep: number,
    end: Point | null = null,
): Step[] {
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const each = sweep / pieces;
    const k = (4 / 3) * Math.tan(each / 4);
    const on = (t: number): Point => {
        const x = rx * Math.cos(t);
        const y = ry * Math.sin(t);
        return {
            x: center.x + x * Math.cos(tilt) - y * Math.sin(tilt),
            y: center.y + x * Math.sin(tilt) + y * Math.cos(tilt),
        };
    };
    const along = (t: number): Point => {
        const x = -rx * Math.sin(t);
        const y = ry * Math.cos(t);
        return { x: x * Math.cos(tilt) - y * Math.sin(tilt), y: x * Math.sin(tilt) + y * Math.cos(tilt) };
    };
    const steps: Step[] = [];
    for (let piece = 0; piece < pieces; piece++) {
        const t0 = start + piece * each;
        const t1 = t0 + each;
        const p0 = on(t0);
        const p1 = piece === pieces - 1 && end ? end : on(t1);
        const d0 = along(t0);
        const d1 = along(t1);
        steps.push({
            kind: "curve",
            a: { x: p0.x + k * d0.x, y: p0.y + k * d0.y },
            b: { x: p1.x - k * d1.x, y: p1.y - k * d1.y },
            to: p1,
        });
    }
    return steps;
}

/** The numbers in a POLYLINE() or NURBS() formula, after its name. */
function formulaNumbers(formula: string): number[] {
    const inside = /\(([^)]*)\)/.exec(formula)?.[1] ?? "";
    return inside.split(",").map((value) => number(value.trim(), Number.NaN));
}

/**
 * A NURBS curve's points, sampled: from where the path is, through its control points (each weighted) to its end, by
 * its knots (de Boor's algorithm).
 */
function nurbsPoints(start: Point, end: Point, row: Row, width: number, height: number): Point[] {
    const values = formulaNumbers(row.formulas.get("E") ?? "");
    const [lastKnot, degree, xType, yType] = values;
    if (values.length < 4 || !Number.isFinite(degree) || degree === undefined || degree < 1) {
        return [end];
    }
    const control: Point[] = [start];
    const knots: number[] = [];
    const weights: number[] = [number(row.cells.get("D"), 1)];
    knots.push(number(row.cells.get("C"), 0));
    for (let at = 4; at + 3 < values.length; at += 4) {
        const x = values[at]!;
        const y = values[at + 1]!;
        control.push({ x: xType === 0 ? x * width : x, y: yType === 0 ? y * height : y });
        knots.push(values[at + 2]!);
        weights.push(values[at + 3]!);
    }
    control.push(end);
    knots.push(number(row.cells.get("A"), lastKnot ?? 1));
    weights.push(number(row.cells.get("B"), 1));
    // The knot vector: the first knot repeated to its degree, the knots, and the last repeated likewise.
    const p = Math.round(degree);
    const vector = [...Array(p).fill(knots[0]!), ...knots, ...Array(p).fill(lastKnot ?? knots[knots.length - 1]!)];
    const n = control.length - 1;
    if (vector.length !== n + p + 2 || control.some((point) => !Number.isFinite(point.x + point.y))) {
        return control.slice(1);
    }
    const lo = vector[p]!;
    const hi = vector[n + 1]!;
    const samples: Point[] = [];
    const count = Math.min(200, 12 * n);
    for (let index = 1; index <= count; index++) {
        const u = Math.min(hi - 1e-9, lo + ((hi - lo) * index) / count);
        let span = p;
        while (span < n && u >= vector[span + 1]!) {
            span++;
        }
        const d = Array.from({ length: p + 1 }, (_, j) => {
            const point = control[span - p + j]!;
            const weight = weights[span - p + j] ?? 1;
            return { x: point.x * weight, y: point.y * weight, w: weight };
        });
        for (let r = 1; r <= p; r++) {
            for (let j = p; j >= r; j--) {
                const i = span - p + j;
                const denominator = vector[i + p - r + 1]! - vector[i]!;
                const alpha = denominator === 0 ? 0 : (u - vector[i]!) / denominator;
                const a = d[j - 1]!;
                const b = d[j]!;
                d[j] = {
                    x: (1 - alpha) * a.x + alpha * b.x,
                    y: (1 - alpha) * a.y + alpha * b.y,
                    w: (1 - alpha) * a.w + alpha * b.w,
                };
            }
        }
        const found = d[p]!;
        samples.push(found.w === 0 ? { x: found.x, y: found.y } : { x: found.x / found.w, y: found.y / found.w });
    }
    samples[samples.length - 1] = end;
    return samples;
}

/** Where a geometry row ends, in the shape's frame: a relative row's point is of its width and height. */
function rowEnd(row: Row, width: number, height: number): Point {
    const x = number(row.cells.get("X"));
    const y = number(row.cells.get("Y"));
    return row.type.startsWith("Rel") ? { x: x * width, y: y * height } : { x, y };
}

/** A geometry section's path, in the shape's frame (inches, from its bottom left). */
function pathOf(rows: Row[], width: number, height: number): Step[] {
    const steps: Step[] = [];
    let at: Point | null = null;
    let start: Point | null = null;
    let spline: Point[] | null = null;
    const close = () => {
        if (at && start && Math.hypot(at.x - start.x, at.y - start.y) < 1e-6 && steps.length > 1) {
            steps.push({ kind: "close" });
        }
    };
    const move = (to: Point) => {
        close();
        steps.push({ kind: "move", to });
        at = start = to;
    };
    const line = (to: Point) => {
        steps.push({ kind: "line", to });
        at = to;
    };
    const last = rows[rows.length - 1];
    // A path that doesn't start with a move starts where it ends, as a closed shape's would.
    const from = (): Point => {
        if (!at) {
            move(last ? rowEnd(last, width, height) : { x: 0, y: 0 });
        }
        return at!;
    };
    for (const row of rows) {
        const value = (name: string) => number(row.cells.get(name));
        const point = rowEnd(row, width, height);
        if (spline && row.type !== "SplineKnot") {
            spline.forEach(line);
            spline = null;
        }
        switch (row.type) {
            case "MoveTo":
            case "RelMoveTo":
                move(point);
                break;
            case "LineTo":
            case "RelLineTo":
                from();
                line(point);
                break;
            case "ArcTo": {
                const begin = from();
                const bow = value("A");
                const chord = Math.hypot(point.x - begin.x, point.y - begin.y);
                if (Math.abs(bow) < 1e-9 || chord < 1e-9) {
                    line(point);
                    break;
                }
                // Its bow is how far its middle is from its chord's, to the right of the way it goes (y up).
                const middle = {
                    x: (begin.x + point.x) / 2 + (bow * (point.y - begin.y)) / chord,
                    y: (begin.y + point.y) / 2 - (bow * (point.x - begin.x)) / chord,
                };
                steps.push(...arcThrough(begin, middle, point));
                at = point;
                break;
            }
            case "EllipticalArcTo":
            case "RelEllipticalArcTo": {
                const begin = from();
                const through =
                    row.type === "RelEllipticalArcTo"
                        ? { x: value("A") * width, y: value("B") * height }
                        : { x: value("A"), y: value("B") };
                const tilt = value("C");
                const ratio = value("D") || 1;
                // Turned so its major axis is level, and squeezed along it, the ellipse is a circle.
                const into = times(scale(1 / ratio, 1), rotate(-tilt));
                const back = times(rotate(tilt), scale(ratio, 1));
                const pieces = arcThrough(apply(into, begin), apply(into, through), apply(into, point));
                pieces.forEach((step, index) => {
                    const end = index === pieces.length - 1 ? point : null;
                    if (step.kind === "curve") {
                        steps.push({
                            kind: "curve",
                            a: apply(back, step.a),
                            b: apply(back, step.b),
                            to: end ?? apply(back, step.to),
                        });
                    } else if (step.kind === "line") {
                        steps.push({ kind: "line", to: end ?? apply(back, step.to) });
                    }
                });
                at = point;
                break;
            }
            case "RelCubBezTo":
                from();
                steps.push({
                    kind: "curve",
                    a: { x: value("A") * width, y: value("B") * height },
                    b: { x: value("C") * width, y: value("D") * height },
                    to: point,
                });
                at = point;
                break;
            case "RelQuadBezTo": {
                const begin = from();
                const control = { x: value("A") * width, y: value("B") * height };
                steps.push({
                    kind: "curve",
                    a: { x: begin.x + (2 / 3) * (control.x - begin.x), y: begin.y + (2 / 3) * (control.y - begin.y) },
                    b: { x: point.x + (2 / 3) * (control.x - point.x), y: point.y + (2 / 3) * (control.y - point.y) },
                    to: point,
                });
                at = point;
                break;
            }
            case "Ellipse": {
                // Its middle (X, Y), and a point at the end of each of its axes (A, B and C, D): a closed path.
                const u = { x: value("A") - point.x, y: value("B") - point.y };
                const v = { x: value("C") - point.x, y: value("D") - point.y };
                const on = (t: number) => ({
                    x: point.x + u.x * Math.cos(t) + v.x * Math.sin(t),
                    y: point.y + u.y * Math.cos(t) + v.y * Math.sin(t),
                });
                const along = (t: number) => ({
                    x: -u.x * Math.sin(t) + v.x * Math.cos(t),
                    y: -u.y * Math.sin(t) + v.y * Math.cos(t),
                });
                move(on(0));
                for (let quarter = 0; quarter < 4; quarter++) {
                    const t0 = (quarter * Math.PI) / 2;
                    const t1 = t0 + Math.PI / 2;
                    const [p0, p1, d0, d1] = [on(t0), on(t1), along(t0), along(t1)];
                    steps.push({
                        kind: "curve",
                        a: { x: p0.x + KAPPA * d0.x, y: p0.y + KAPPA * d0.y },
                        b: { x: p1.x - KAPPA * d1.x, y: p1.y - KAPPA * d1.y },
                        to: quarter === 3 ? on(0) : p1,
                    });
                }
                steps.push({ kind: "close" });
                at = start = null;
                break;
            }
            case "PolylineTo": {
                from();
                const values = formulaNumbers(row.formulas.get("A") ?? "");
                const [xType, yType] = values;
                for (let index = 2; index + 1 < values.length; index += 2) {
                    const [x, y] = [values[index]!, values[index + 1]!];
                    if (Number.isFinite(x) && Number.isFinite(y)) {
                        line({ x: xType === 0 ? x * width : x, y: yType === 0 ? y * height : y });
                    }
                }
                line(point);
                break;
            }
            case "NURBSTo":
                nurbsPoints(from(), point, row, width, height).forEach(line);
                break;
            case "SplineStart":
                from();
                spline = [point];
                break;
            case "SplineKnot":
                // A spline drawn through its control points: near enough for the few drawings that have one.
                (spline ??= []).push(point);
                break;
            default:
                break; // an infinite line (a guide's), or a row Piper doesn't know
        }
    }
    (spline ?? []).forEach(line);
    close();
    return steps;
}

/** A path's pieces, each from a move: whether each is closed, which only a closed one is filled if it is. */
function piecesOf(steps: Step[]): { steps: Step[]; closed: boolean }[] {
    const pieces: { steps: Step[]; closed: boolean }[] = [];
    for (const step of steps) {
        if (step.kind === "move" || pieces.length === 0) {
            pieces.push({ steps: [], closed: false });
        }
        const piece = pieces[pieces.length - 1]!;
        piece.steps.push(step);
        piece.closed ||= step.kind === "close";
    }
    return pieces.filter((piece) => piece.steps.some((step) => step.kind !== "move"));
}

/**
 * A shape's outlines in its own frame (inches, from its bottom left): each geometry section's, and, where a section
 * has open pieces beside closed ones, those apart, as Visio fills only what's closed.
 */
function outlinesOf(sheet: ShapeSheet, width: number, height: number): Outline[] {
    const outlines: Outline[] = [];
    for (const section of sheet.sections("Geometry")) {
        if (section.cells.get("NoShow") === "1") {
            continue;
        }
        const filled = section.cells.get("NoFill") !== "1";
        const stroked = section.cells.get("NoLine") !== "1";
        const pieces = piecesOf(pathOf(section.rows, width, height));
        for (const closed of [true, false]) {
            const steps = pieces.filter((piece) => piece.closed === closed).flatMap((piece) => piece.steps);
            if (steps.length > 0) {
                outlines.push({ steps, filled: filled && closed, stroked });
            }
        }
    }
    return outlines;
}

function placeOutline(outline: Outline, m: Matrix): Outline {
    return {
        ...outline,
        steps: outline.steps.map((step) => {
            switch (step.kind) {
                case "move":
                case "line":
                    return { kind: step.kind, to: apply(m, step.to) };
                case "curve":
                    return { kind: "curve", a: apply(m, step.a), b: apply(m, step.b), to: apply(m, step.to) };
                default:
                    return step;
            }
        }),
    };
}

// --- words ---------------------------------------------------------------------------------------------------------

/** A shape's text as it reads: its lines (its paragraphs, and the breaks within them), each a run of words in each
 * character format (cp) it changes to, a field as what it shows; and which paragraph format (pp) its first is in. */
function textOf(text: Element): { lines: { text: string; format: number }[][]; paragraph: number } {
    const lines: { text: string; format: number }[][] = [[]];
    let format = 0;
    let paragraph = -1;
    let current = 0;
    const add = (value: string) => {
        const pieces = value
            .replace(/\r\n?/g, "\n")
            .replace(/[\u2028\u2029\u000b]/g, "\n")
            .replace(/\t/g, " ")
            .split("\n");
        pieces.forEach((piece, index) => {
            if (index > 0) {
                lines.push([]);
            }
            if (piece) {
                lines[lines.length - 1]!.push({ text: piece, format });
                if (paragraph < 0 && piece.trim()) {
                    paragraph = current;
                }
            }
        });
    };
    const walk = (node: Node) => {
        for (const child of [...node.childNodes]) {
            if (child.nodeType === 3) {
                add(child.nodeValue ?? "");
            } else if (child.nodeType === 1) {
                const element = child as Element;
                const ix = Number.parseInt(element.getAttribute("IX") ?? "0", 10) || 0;
                switch (element.localName) {
                    case "cp":
                        format = ix;
                        break;
                    case "pp":
                        current = ix;
                        break;
                    case "tp":
                        add(" ");
                        break;
                    case "fld":
                        add(element.textContent ?? "");
                        break;
                    default:
                        walk(element);
                }
            }
        }
    };
    walk(text);
    // Spaces at a line's end, and empty lines before and after the words, are nothing to draw.
    for (const line of lines) {
        while (line.length > 0 && !line[line.length - 1]!.text.trim()) {
            line.pop();
        }
        const last = line[line.length - 1];
        if (last) {
            last.text = last.text.replace(/\s+$/, "");
        }
    }
    while (lines.length > 0 && lines[lines.length - 1]!.length === 0) {
        lines.pop();
    }
    while (lines.length > 0 && lines[0]!.length === 0) {
        lines.shift();
    }
    return { lines, paragraph: Math.max(0, paragraph) };
}

function wordsOf(
    sheet: ShapeSheet,
    m: Matrix,
    turn: Turn,
    width: number,
    height: number,
    palette: string[],
): Words | null {
    const text = sheet.text;
    if (!text || sheet.get("HideText") === "1") {
        return null;
    }
    const { lines, paragraph } = textOf(text);
    if (lines.length === 0) {
        return null;
    }
    // Its block, in the shape's frame: the whole shape unless it says otherwise, turned about its own pin.
    const blockWidth = Math.abs(sheet.num("TxtWidth", width));
    const blockHeight = Math.abs(sheet.num("TxtHeight", height));
    const block = times(
        m,
        [
            translate(sheet.num("TxtPinX", width / 2), sheet.num("TxtPinY", height / 2)),
            rotate(sheet.num("TxtAngle")),
            translate(-sheet.num("TxtLocPinX", blockWidth / 2), -sheet.num("TxtLocPinY", blockHeight / 2)),
        ].reduce((all, next) => times(all, next), IDENTITY),
    );
    const letterings = new Map<number, Lettering>();
    const lettering = (format: number): Lettering => {
        let found = letterings.get(format);
        if (!found) {
            const character = (name: string) => sheet.textCell("Character", format, name);
            const style = number(character("Style"));
            found = {
                size: Math.abs(number(character("Size"), 0.1667)) || 0.1667,
                color: colorOf(character("Color"), palette) ?? "#000000",
                bold: (style & 1) !== 0,
                italic: (style & 2) !== 0,
                font: character("Font") ?? "",
            };
            letterings.set(format, found);
        }
        return found;
    };
    const runs = lines.map((line) => line.map((run) => ({ text: run.text, lettering: lettering(run.format) })));
    const first = runs.flat().find((run) => run.text.trim())?.lettering ?? lettering(0);
    const paragraphCell = (name: string) => number(sheet.textCell("Paragraph", paragraph, name));
    const align = number(sheet.textCell("Paragraph", paragraph, "HorzAlign"), 1);
    const valign = sheet.num("VerticalAlign", 1);
    // Its line spacing: a size of its own, or (negative) a share of its letters' size; Visio's single, if neither.
    const spacing = paragraphCell("SpLine");
    const pitch =
        (spacing > 0 ? spacing : spacing < 0 ? -spacing * first.size : 1.2 * first.size) +
        paragraphCell("SpBefore") +
        paragraphCell("SpAfter");
    return {
        ...first,
        lines: runs.map((line) => line.map((run) => run.text).join("")),
        runs,
        pitch,
        at: apply(block, { x: blockWidth / 2, y: blockHeight / 2 }),
        width: blockWidth,
        height: blockHeight,
        angle: turn.angle + turn.sign * sheet.num("TxtAngle"),
        align: align === 0 || align === 3 ? "left" : align === 2 ? "right" : "center",
        valign: valign === 0 ? "top" : valign === 2 ? "bottom" : "middle",
        margins: {
            left: sheet.num("LeftMargin"),
            right: sheet.num("RightMargin"),
            top: sheet.num("TopMargin"),
            bottom: sheet.num("BottomMargin"),
        },
        background: textBackground(sheet.get("TextBkgnd"), palette),
    };
}

/** The color behind a shape's words: none (0), a color by its index after the first, or one of its own. */
function textBackground(value: string | undefined, palette: string[]): string {
    if (!value || value === "0") {
        return "";
    }
    if (value.startsWith("#")) {
        return colorOf(value, palette) ?? "";
    }
    const index = Number.parseInt(value, 10);
    return Number.isInteger(index) && index > 0 ? (palette[index - 1] ?? "") : "";
}

// --- shapes --------------------------------------------------------------------------------------------------------

interface Master {
    name: string;
    shapes: Map<string, Element>; // every shape in it, by its id
    top: Element | null; // its shape (an instance is one of it)
}

interface Context {
    styles: Styles;
    palette: string[];
    masters: Map<string, Master>;
    hiddenLayers: Set<string>;
    images: Map<string, Relationship>; // the page's relationships: a foreign shape's picture is one
    count: { shapes: number };
}

function shapeOf(
    element: Element,
    parent: Matrix,
    parentTurn: Turn,
    instance: Master | null, // the master the group it's a member of is an instance of, if it's one's member
    context: Context,
): VisioShape | null {
    context.count.shapes += 1;
    if (context.count.shapes > MOST_SHAPES) {
        throw new VisioError(`A page has more than ${MOST_SHAPES} shapes: Piper takes up to ${MOST_SHAPES} a page`);
    }
    const type = element.getAttribute("Type") ?? "Shape";
    if (type === "Guide") {
        return null;
    }
    const own = context.masters.get(element.getAttribute("Master") ?? "") ?? null;
    const master = own ?? instance;
    const masterShapeId = element.getAttribute("MasterShape");
    const masterShape = own
        ? masterShapeId
            ? (own.shapes.get(masterShapeId) ?? own.top)
            : own.top
        : master && masterShapeId
          ? (master.shapes.get(masterShapeId) ?? null)
          : null;
    const sheet = new ShapeSheet(sheetOf(element), masterShape ? sheetOf(masterShape) : null, context.styles);
    const layers = (sheet.get("LayerMember") ?? "").split(";").filter(Boolean);
    if (layers.length > 0 && layers.every((layer) => context.hiddenLayers.has(layer))) {
        return null;
    }
    const width = Math.abs(sheet.num("Width"));
    const height = Math.abs(sheet.num("Height"));
    const local = placement(sheet, sheet.num("Width"), sheet.num("Height"));
    const m = times(parent, local);
    const turn = turnOf(parentTurn, sheet);
    const oneD = sheet.has("BeginX");
    const point = (x: string, y: string) =>
        sheet.get(x) !== undefined && sheet.get(y) !== undefined
            ? apply(parent, { x: sheet.num(x), y: sheet.num(y) })
            : null;
    const linePattern = sheet.num("LinePattern", 1);
    const fillPattern = sheet.num("FillPattern", 1);
    const pen: Pen | null =
        linePattern === 0
            ? null
            : {
                  color: colorOf(sheet.get("LineColor"), context.palette) ?? "#000000",
                  weight: Math.max(0, sheet.num("LineWeight", 0.0104)),
                  pattern: linePattern,
                  opacity: 1 - Math.min(1, Math.max(0, sheet.num("LineColorTrans"))),
                  begin: sheet.num("BeginArrow"),
                  end: sheet.num("EndArrow"),
                  beginSize: sheet.num("BeginArrowSize", 2),
                  endSize: sheet.num("EndArrowSize", 2),
              };
    const brush: Brush | null =
        fillPattern === 0
            ? null
            : {
                  color: colorOf(sheet.get("FillForegnd"), context.palette) ?? "#ffffff",
                  opacity: 1 - Math.min(1, Math.max(0, sheet.num("FillForegndTrans"))),
              };
    const shown = sheet.num("DisplayMode", 2) !== 0;
    const members = kid(element, "Shapes");
    const shape: VisioShape = {
        id: element.getAttribute("ID") ?? "",
        kind: type === "Group" ? "group" : type === "Foreign" ? "foreign" : "shape",
        master: master ? master.name : "",
        name: element.getAttribute("NameU") ?? element.getAttribute("Name") ?? "",
        oneD,
        begin: oneD ? point("BeginX", "BeginY") : null,
        end: oneD ? point("EndX", "EndY") : null,
        pin: apply(parent, { x: sheet.num("PinX"), y: sheet.num("PinY") }),
        middle: apply(m, { x: sheet.num("Width") / 2, y: sheet.num("Height") / 2 }),
        width,
        height,
        axes: { x: along(m, 1, 0), y: along(m, 0, 1) },
        outlines: shown
            ? outlinesOf(sheet, sheet.num("Width"), sheet.num("Height")).map((o) => placeOutline(o, m))
            : [],
        pen,
        brush,
        words: shown ? wordsOf(sheet, m, turn, width, height, context.palette) : null,
        connections: sheet
            .sections("Connection")
            .flatMap((section) => section.rows)
            .map((row) => apply(m, { x: number(row.cells.get("X")), y: number(row.cells.get("Y")) })),
        members: members
            ? kids(members, "Shape")
                  .map((member) => shapeOf(member, m, turn, master, context))
                  .filter((found) => found !== null)
            : [],
        front: sheet.num("DisplayMode", 2) !== 1,
        picture: null,
    };
    if (type === "Foreign") {
        const data = kid(element, "ForeignData");
        const rel = data ? context.images.get(relId(data)) : undefined;
        shape.picture = rel?.target ?? null;
        // Drawn as its box, where the picture is: Piper keeps the place, not the picture.
        if (shape.outlines.length === 0) {
            const corners = [
                { x: 0, y: 0 },
                { x: sheet.num("Width"), y: 0 },
                { x: sheet.num("Width"), y: sheet.num("Height") },
                { x: 0, y: sheet.num("Height") },
            ].map((corner) => apply(m, corner));
            shape.outlines = [
                {
                    steps: [
                        { kind: "move", to: corners[0]! },
                        ...corners.slice(1).map((to) => ({ kind: "line" as const, to })),
                        { kind: "close" },
                    ],
                    filled: false,
                    stroked: true,
                },
            ];
        }
    }
    return shape;
}

// --- the document --------------------------------------------------------------------------------------------------

async function mastersOf(files: Package, path: string): Promise<Map<string, Master>> {
    const masters = new Map<string, Master>();
    const document = await xml(files, path);
    if (!document) {
        return masters;
    }
    const rels = await relationships(files, path);
    for (const entry of [...document.getElementsByTagNameNS("*", "Master")]) {
        const target = rels.get(relId(entry))?.target;
        const contents = target ? await xml(files, target) : null;
        const shapes = new Map<string, Element>();
        for (const shape of contents ? [...contents.getElementsByTagNameNS("*", "Shape")] : []) {
            shapes.set(shape.getAttribute("ID") ?? "", shape);
        }
        const top = contents?.documentElement ? kid(contents.documentElement, "Shapes") : null;
        masters.set(entry.getAttribute("ID") ?? "", {
            name: cleanName(entry.getAttribute("NameU") ?? entry.getAttribute("Name") ?? ""),
            shapes,
            top: top ? (kids(top, "Shape")[0] ?? null) : null,
        });
    }
    return masters;
}

/** The document's styles and colors, from its document.xml. */
async function documentOf(files: Package, path: string): Promise<{ styles: Styles; palette: string[] }> {
    const styles: Styles = new Map();
    const palette = [...PALETTE];
    const document = await xml(files, path);
    if (!document) {
        return { styles, palette };
    }
    for (const color of [...document.getElementsByTagNameNS("*", "ColorEntry")]) {
        const index = Number.parseInt(color.getAttribute("IX") ?? "", 10);
        const rgb = colorOf(color.getAttribute("RGB") ?? "", PALETTE);
        if (Number.isInteger(index) && index >= 0 && index < 10_000 && rgb) {
            palette[index] = rgb;
        }
    }
    for (const style of [...document.getElementsByTagNameNS("*", "StyleSheet")]) {
        styles.set(style.getAttribute("ID") ?? "", sheetOf(style));
    }
    return { styles, palette };
}

/** Where the package's document is, and its pages and masters, by its relationships (or where Visio puts them). */
async function partsOf(files: Package): Promise<{ document: string; pages: string; masters: string }> {
    const top = await xml(files, "_rels/.rels");
    let document = "visio/document.xml";
    for (const rel of top ? [...top.getElementsByTagName("Relationship")] : []) {
        if ((rel.getAttribute("Type") ?? "").endsWith("/document")) {
            document = (rel.getAttribute("Target") ?? document).replace(/^\//, "");
        }
    }
    const rels = await relationships(files, document);
    const of = (type: string, fallback: string) =>
        [...rels.values()].find((rel) => rel.type.endsWith(`/${type}`))?.target ?? fallback;
    return {
        document,
        pages: of("pages", "visio/pages/pages.xml"),
        masters: of("masters", "visio/masters/masters.xml"),
    };
}

/** A Visio drawing's foreground pages (not its backgrounds), each with its shapes as Visio draws them. */
export async function readVsdx(file: Blob, fileName: string): Promise<VisioPage[]> {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
        throw new VisioError(
            `${fileName} is a Visio drawing from before 2013 (.vsd). Open it in Visio, save it as a .vsdx (File > Save As > Visio Drawing), and import that.`,
        );
    }
    if (head[0] === 0x3c) {
        throw new VisioError(
            `${fileName} is a Visio XML drawing (.vdx). Open it in Visio, save it as a .vsdx (File > Save As > Visio Drawing), and import that.`,
        );
    }
    let files: Package;
    try {
        const zip = await readZip(file, fileName);
        files = new Map(zip.entries.map((entry) => [entry.path.toLowerCase(), entry]));
    } catch (error) {
        if (error instanceof ZipError) {
            throw new VisioError(`${fileName} isn't a Visio drawing (.vsdx), or it's damaged.`);
        }
        throw error;
    }
    const parts = await partsOf(files);
    const pagesXml = await xml(files, parts.pages);
    if (!pagesXml) {
        throw new VisioError(`${fileName} isn't a Visio drawing: it has no pages. Piper reads .vsdx files.`);
    }
    const { styles, palette } = await documentOf(files, parts.document);
    const masters = await mastersOf(files, parts.masters);
    const rels = await relationships(files, parts.pages);
    const pages: VisioPage[] = [];
    const shown = [...pagesXml.getElementsByTagNameNS("*", "Page")].filter(
        (page) => page.getAttribute("Background") !== "1",
    );
    for (const page of shown) {
        const pageSheet = kid(page, "PageSheet");
        const sheet = pageSheet ? sheetOf(pageSheet) : null;
        const cell = (name: string, fallback: number) => number(sheet?.cells.get(name), fallback);
        // A drawing to a scale (a quarter inch to the foot) has its shapes in the drawing's units: put on paper.
        const ratio = cell("PageScale", 1) / (cell("DrawingScale", 1) || 1) || 1;
        const hiddenLayers = new Set(
            (sheet?.sections.get("Layer") ?? [])
                .flatMap((section) => section.rows)
                .filter((row) => row.cells.get("Visible") === "0")
                .map((row) => String(row.ix)),
        );
        const target = rels.get(relId(page))?.target;
        const contents = target ? await xml(files, target) : null;
        const root = contents?.documentElement;
        if (!root || !target) {
            continue;
        }
        const context: Context = {
            styles,
            palette,
            masters,
            hiddenLayers,
            images: await relationships(files, target),
            count: { shapes: 0 },
        };
        const top = kid(root, "Shapes");
        const shapes = (top ? kids(top, "Shape") : [])
            .map((element) => shapeOf(element, scale(ratio, ratio), { angle: 0, sign: 1 }, null, context))
            .filter((found) => found !== null);
        const glue: Glue[] = [];
        for (const connect of [...root.getElementsByTagNameNS("*", "Connect")]) {
            const from = connect.getAttribute("FromCell") ?? "";
            const end = from.startsWith("Begin") ? "begin" : from.startsWith("End") ? "end" : null;
            if (end) {
                glue.push({
                    connector: connect.getAttribute("FromSheet") ?? "",
                    end,
                    shape: connect.getAttribute("ToSheet") ?? "",
                });
            }
        }
        pages.push({
            // Its name as Visio shows it (Name), not the universal one it keeps for code (NameU, "Page-1").
            name: (page.getAttribute("Name") ?? page.getAttribute("NameU") ?? "").trim() || `Page ${pages.length + 1}`,
            width: cell("PageWidth", 8.5) * ratio,
            height: cell("PageHeight", 11) * ratio,
            shapes,
            glue,
        });
    }
    return pages;
}
