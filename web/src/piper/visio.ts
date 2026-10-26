import { readZip, ZipError, type ZipEntry } from "../zip";
import {
    emptyDrawing,
    newId,
    type Document as PiperDocument,
    type Drawing,
    type Fluid,
    type LineKind,
    type Page,
    type Point,
    type Rotation,
} from "./drawing";
import { addPart, connect, updateLine, updatePart, type Target } from "./edit";
import { fluidsOf, newFluidId } from "./fluids";
import { distance, GRID, snapPoint } from "./geometry";
import { kindOf, presetOf } from "./library/index";
import { portsOf } from "./ports";

// Visio's drawings read into Piper's. A .vsdx (Visio 2013 on) is a zip of XML: each page's shapes, with the masters
// (stencil shapes) they're instances of, and which connector is glued to which shape. Each page becomes a diagram:
// shapes Piper knows by their masters' names (Visio's P&ID stencils: "Gate valve", "Vessel", "Indicator"...) become
// its parts, tagged with their text when it's a tag; connectors become lines, routed Piper's way between the ports
// nearest where they were glued, carrying the fluid their text or color says; what's only text stays text; and a
// shape Piper has no part for becomes a box with its text, so nothing on the page is lost.

export class VisioError extends Error {}

/** What became of a page's shapes. */
export interface ImportReport {
    page: string;
    parts: number;
    lines: number;
    notes: number; // text, kept as notes
    boxes: string[]; // shapes kept as boxes: their names, as Visio has them
    dropped: number; // connectors that joined nothing to nothing
}

export interface ImportedPage {
    name: string; // a diagram's of the page alone: the file's, and the page's if there are more
    page: string; // the page's, as Visio shows it
    drawing: Drawing;
    report: ImportReport;
}

const MOST_SHAPES = 5000;
const MOST_XML = 32 * 1024 * 1024;

// --- reading the package -------------------------------------------------------------------------------------------

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

/** Where a part's relationships say each of its ids points: "visio/pages/page1.xml" for rId1. */
async function relationships(files: Package, path: string): Promise<Map<string, string>> {
    const folder = path.slice(0, path.lastIndexOf("/") + 1);
    const rels = await xml(files, `${folder}_rels/${path.slice(folder.length)}.rels`);
    const found = new Map<string, string>();
    for (const rel of rels ? [...rels.getElementsByTagName("Relationship")] : []) {
        const target = rel.getAttribute("Target") ?? "";
        const resolved = target.startsWith("/") ? target.slice(1) : resolve(folder, target);
        found.set(rel.getAttribute("Id") ?? "", resolved);
    }
    return found;
}

function resolve(folder: string, target: string): string {
    const parts = (folder + target).split("/");
    const out: string[] = [];
    for (const part of parts) {
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

/** A shape's own cells (not its sections'): name to value. */
function cellsOf(shape: Element): Map<string, string> {
    return new Map(kids(shape, "Cell").map((cell) => [cell.getAttribute("N") ?? "", cell.getAttribute("V") ?? ""]));
}

/** A relationship's id on an element: <Rel r:id="rId1"/>. */
function relId(element: Element): string {
    const rel = kid(element, "Rel");
    return (
        rel?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ??
        rel?.getAttribute("r:id") ??
        ""
    );
}

/** A shape's text, as it reads: its paragraphs on lines of their own. */
function textOf(shape: Element, deep: boolean): string {
    const own = kid(shape, "Text");
    let text = own?.textContent ?? "";
    if (!text.trim() && deep) {
        // A group's words are often its members'.
        text = [...shape.getElementsByTagNameNS("*", "Text")].map((element) => element.textContent ?? "").join("\n");
    }
    return text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
}

interface Master {
    name: string;
    cells: Map<string, string>;
    oneD: boolean;
    outline: boolean;
}

/** Whether a shape draws an outline: a geometry section that's shown (a text box has none). */
function hasOutline(shape: Element): boolean {
    return [...shape.getElementsByTagNameNS("*", "Section")].some(
        (section) =>
            section.getAttribute("N") === "Geometry" &&
            !kids(section, "Cell").some(
                (cell) => cell.getAttribute("N") === "NoShow" && cell.getAttribute("V") === "1",
            ) &&
            kids(section, "Row").length > 0,
    );
}

async function mastersOf(files: Package): Promise<Map<string, Master>> {
    const masters = new Map<string, Master>();
    const document = await xml(files, "visio/masters/masters.xml");
    if (!document) {
        return masters;
    }
    const rels = await relationships(files, "visio/masters/masters.xml");
    for (const master of [...document.getElementsByTagNameNS("*", "Master")]) {
        const path = rels.get(relId(master));
        const contents = path ? await xml(files, path) : null;
        const shape = contents?.getElementsByTagNameNS("*", "Shape")[0] ?? null;
        const cells = shape ? cellsOf(shape) : new Map<string, string>();
        masters.set(master.getAttribute("ID") ?? "", {
            name: cleanName(master.getAttribute("NameU") ?? master.getAttribute("Name") ?? ""),
            cells,
            oneD: cells.has("BeginX"),
            outline: shape ? hasOutline(shape) : true,
        });
    }
    return masters;
}

/** A shape's name without the number Visio adds to the second of a name ("Gate valve.12"). */
const cleanName = (name: string) => name.replace(/\.\d+$/, "").trim();

// --- what a shape is -----------------------------------------------------------------------------------------------

interface Shape {
    id: string;
    name: string; // its master's name, or its own
    text: string;
    x: number; // its pin, in inches, with y up from the page's foot as Visio has it
    y: number;
    width: number;
    height: number;
    angle: number; // radians, counterclockwise
    flipX: boolean;
    flipY: boolean;
    oneD: boolean;
    begin: Point | null;
    end: Point | null;
    lineColor: string;
    linePattern: number;
    arrows: { begin: boolean; end: boolean };
    outline: boolean;
    ellipse: boolean;
}

const number = (value: string | undefined, fallback = 0): number => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
};

function shapeOf(element: Element, masters: Map<string, Master>): Shape {
    const master = masters.get(element.getAttribute("Master") ?? "");
    const own = cellsOf(element);
    const cell = (name: string) => own.get(name) ?? master?.cells.get(name);
    const oneD = own.has("BeginX") || (master?.oneD ?? false);
    const point = (x: string, y: string) =>
        cell(x) !== undefined && cell(y) !== undefined ? { x: number(cell(x)), y: number(cell(y)) } : null;
    return {
        id: element.getAttribute("ID") ?? "",
        name: master?.name || cleanName(element.getAttribute("NameU") ?? element.getAttribute("Name") ?? ""),
        text: textOf(element, element.getAttribute("Type") === "Group"),
        x: number(cell("PinX")),
        y: number(cell("PinY")),
        width: Math.abs(number(cell("Width"))),
        height: Math.abs(number(cell("Height"))),
        angle: number(cell("Angle")),
        flipX: cell("FlipX") === "1",
        flipY: cell("FlipY") === "1",
        oneD,
        begin: oneD ? point("BeginX", "BeginY") : null,
        end: oneD ? point("EndX", "EndY") : null,
        lineColor: cell("LineColor") ?? "",
        linePattern: number(cell("LinePattern"), 1),
        arrows: { begin: number(cell("BeginArrow")) > 0, end: number(cell("EndArrow")) > 0 },
        outline: hasOutline(element) || (master?.outline ?? false),
        ellipse: [...element.getElementsByTagNameNS("*", "Row")].some((row) => row.getAttribute("T") === "Ellipse"),
    };
}

/** A tag in a shape's text: "PT-101", "PT 101", or PT over 101 on two lines, as P&IDs write them. */
export function tagIn(text: string): string | null {
    const words = text.replace(/\n/g, " ").trim();
    const match = /^([A-Za-z]{1,6})[\s_-]*(\d{1,5}[A-Za-z]?(?:[-.]\d{1,3})?)$/.exec(words);
    if (match) {
        return `${match[1]!.toUpperCase()}-${match[2]!.toUpperCase()}`;
    }
    // A tag with a system in it: MOV-OX, NCS-FU-2.
    return /^[A-Za-z]{1,6}(?:-[A-Za-z0-9]{1,6}){1,3}$/.test(words) ? words.toUpperCase() : null;
}

/** An instrument's preset, by its tag's letters, as ISA's letters say: PT, TC, FT, LT, LC, ZT, PS, DPT... */
function instrumentFor(tag: string | null): string {
    const letters = /^[A-Z]+/.exec(tag ?? "")?.[0] ?? "";
    if (letters === "PG" || letters === "PI") {
        return "pressure-gauge";
    }
    if (letters.startsWith("DP") || letters.startsWith("PD")) {
        return "dp-transducer";
    }
    if (letters === "PS" || letters.startsWith("PSH") || letters.startsWith("PSL")) {
        return "pressure-switch";
    }
    if (letters === "LC" || letters.startsWith("W")) {
        return "load-cell";
    }
    switch (letters[0]) {
        case "P":
            return "pressure-transducer";
        case "T":
            return letters === "RTD" ? "rtd" : "thermocouple";
        case "R":
            return letters === "RTD" ? "rtd" : "instrument";
        case "F":
            return "flow-transmitter";
        case "L":
            return "level-sensor";
        case "Z":
            return "position-sensor";
        default:
            return "instrument";
    }
}

/** Which library entry a shape's name says it is, if any: Visio's P&ID stencils' names, and the words people use. */
const NAMES: [RegExp, string][] = [
    [/three.?way|3.?way|four.?way|diverter/, "three-way-valve"],
    [/angle valve/, "angle-valve"],
    [/check|non.?return/, "check-valve"],
    [/relief|safety valve|\bpsv\b|\bprv\b/, "relief-valve"],
    [/regulat|pressure.?reducing|reducing valve/, "regulator"],
    [/rupture|burst/, "burst-disc"],
    [/solenoid/, "solenoid-valve"],
    [/motor.*valve|valve.*motor|motorized|electric(al)? valve|\bmov\b/, "motor-valve"],
    [/pneumatic|actuated|control valve|diaphragm valve|air.?operated/, "pneumatic-valve"],
    [/needle|metering/, "needle-valve"],
    [/butterfly/, "butterfly-valve"],
    [/plug valve|cock/, "plug-valve"],
    [/globe/, "globe-valve"],
    [/ball valve/, "ball-valve"],
    [/quick|disconnect|coupling|\bqd\b/, "quick-disconnect"],
    [/gate|valve/, "gate-valve"],
    [/copv/, "copv"],
    [/cylinder|bottle|k.?bottle/, "bottle"],
    [/dewar/, "dewar"],
    [/sphere|spherical/, "sphere"],
    [/tank|vessel|drum|column|reservoir|accumulator/, "tank"],
    [/cavitating/, "cavitating-venturi"],
    [/venturi/, "venturi"],
    [/orifice|restrict/, "orifice"],
    [/flow ?meter|rotameter|turbine meter|coriolis/, "flow-meter"],
    [/filter|strainer/, "filter"],
    [/gauge|gage/, "pressure-gauge"],
    [/instrument|indicator|transmitter|transducer|sensor|thermocouple|controller|bubble/, "instrument"],
    [/pump|compressor|blower/, "pump"],
    [/exchanger|cooler|heater|condenser/, "heat-exchanger"],
    [/engine|thrust chamber|combustion chamber|rocket motor/, "engine"],
    [/igniter|ignitor/, "igniter"],
    [/vent|exhaust|atmosphere|stack/, "vent"],
    [/reducer|expander/, "reducer"],
    [/hose|flexible/, "hose"],
    [/\bcap\b|blind|end plug/, "cap"],
    [/off.?page|off.?sheet|continuation/, "offpage"],
    [/legend/, "legend"],
    [/title block/, "title-block"],
];

/** Visio's connectors' names, and what kind of line each is. */
const LINE_NAMES: [RegExp, LineKind][] = [
    [/pneumatic/, "pneumatic"],
    [/electric/, "electric"],
    [/data|software|signal|capillary|instrument/, "signal"],
    [/hose|flexible/, "hose"],
    [/secondary|minor|tube|tubing/, "tube"],
];

/** What a 2-D shape becomes: a library entry, a note (only text), a region, or a box. */
function classify(
    shape: Shape,
    tag: string | null,
): { preset: string } | { note: true } | { region: true } | { box: true } | null {
    const name = shape.name.toLowerCase();
    if (/^(text|callout|annotation|label)/.test(name) || (!shape.outline && shape.text)) {
        return { note: true };
    }
    if (/container|boundary|zone|area|frame/.test(name)) {
        return { region: true };
    }
    // A circle tagged as an instrument is one, whatever it's called (basic shapes are used for them).
    if (
        (shape.ellipse || /circle|ellipse/.test(name)) &&
        tag &&
        /^[A-Z]{1,4}-/.test(tag) &&
        Math.abs(shape.width - shape.height) < 0.2 * shape.width
    ) {
        return { preset: instrumentFor(tag) };
    }
    for (const [pattern, preset] of NAMES) {
        if (pattern.test(name)) {
            return { preset: preset === "instrument" ? instrumentFor(tag) : preset };
        }
    }
    if (!shape.outline && !shape.text) {
        return null; // nothing to see
    }
    return { box: true };
}

// --- fluids --------------------------------------------------------------------------------------------------------

/** A fluid a line's text names (LOX, GN2, Helium...), whole words, label or name. */
function fluidNamed(text: string, fluids: Fluid[]): string {
    const words = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
    const found = fluids.find(
        (fluid) =>
            (fluid.label && words.includes(` ${fluid.label.toLowerCase()} `)) ||
            words.includes(` ${fluid.name.toLowerCase()} `),
    );
    return found?.id ?? "";
}

/** Visio's first colors by index, for a line colored by one. */
const INDEXED = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"];

function colorOf(value: string): string | null {
    if (/^#[0-9a-f]{6}$/i.test(value)) {
        return value.toLowerCase();
    }
    const index = Number.parseInt(value, 10);
    return Number.isInteger(index) && INDEXED[index] ? INDEXED[index]! : null;
}

/** A color's name, roughly, for a fluid named after the color a Visio drawing gave its lines. */
function colorName(hex: string): string | null {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
        number,
        number,
        number,
    ];
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    if (high - low < 0.15) {
        return null; // black, white, or gray: no fluid of its own
    }
    const hue =
        high === r
            ? (60 * ((g - b) / (high - low)) + 360) % 360
            : high === g
              ? 60 * ((b - r) / (high - low)) + 120
              : 60 * ((r - g) / (high - low)) + 240;
    const names: [number, string][] = [
        [15, "Red"],
        [40, "Orange"],
        [65, "Yellow"],
        [160, "Green"],
        [195, "Cyan"],
        [255, "Blue"],
        [290, "Purple"],
        [335, "Pink"],
        [360, "Red"],
    ];
    return names.find(([edge]) => hue <= edge)![1];
}

// --- a page into a drawing -----------------------------------------------------------------------------------------

/** A quarter turn, as Piper turns (clockwise, y down), from Visio's angle (counterclockwise, y up). */
function rotationOf(angle: number, flipY: boolean): Rotation {
    const degrees = (((-angle * 180) / Math.PI) % 360) + 360 + (flipY ? 180 : 0);
    return ((Math.round(degrees / 90) * 90) % 360) as Rotation;
}

function pageDrawing(
    page: Element,
    size: { width: number; height: number },
    masters: Map<string, Master>,
    title: string,
) {
    const report: ImportReport = { page: title, parts: 0, lines: 0, notes: 0, boxes: [], dropped: 0 };
    const top = kid(page, "Shapes");
    const elements = top ? kids(top, "Shape") : [];
    if (elements.length > MOST_SHAPES) {
        throw new VisioError(`${title} has ${elements.length} shapes: Piper takes up to ${MOST_SHAPES} a page`);
    }
    const shapes = elements.map((element) => shapeOf(element, masters));
    const twoD = shapes.filter((shape) => !shape.oneD);
    const kinds = new Map(twoD.map((shape) => [shape.id, classify(shape, tagIn(shape.text))]));

    // How big a unit of Piper's is in Visio's inches: its valves drawn as big as Piper's (40 units), where there are
    // any to go by, else a hundred to the inch.
    const valves = twoD
        .filter((shape) => {
            const kind = kinds.get(shape.id);
            return kind && "preset" in kind && kindOf(presetOf(kind.preset)?.kind ?? "").inline && shape.width > 0;
        })
        .map((shape) => Math.max(shape.width, shape.height))
        .sort((a, b) => a - b);
    const scale = valves.length > 0 ? Math.min(200, Math.max(60, 40 / valves[Math.floor(valves.length / 2)]!)) : 100;
    const at = (point: Point): Point => ({ x: point.x * scale, y: (size.height - point.y) * scale });

    let drawing = emptyDrawing();
    const placed = new Map<string, string>(); // a Visio shape's id: its part's
    const taken = new Set<string>();
    for (const shape of twoD) {
        const kind = kinds.get(shape.id);
        if (!kind) {
            continue;
        }
        const center = snapPoint(at(shape));
        const tag = tagIn(shape.text);
        if ("note" in kind) {
            const added = addPart(drawing, presetOf("text")!, center);
            drawing = updatePart(added.drawing, added.id, (part) => ({ ...part, text: shape.text }));
            report.notes += 1;
            continue;
        }
        if ("region" in kind || "box" in kind) {
            const step = "box" in kind ? 2 * GRID : GRID;
            const size = (inches: number, least: number) => Math.max(least, Math.round((inches * scale) / step) * step);
            const added = addPart(drawing, presetOf("region" in kind ? "region" : "box")!, center);
            drawing = updatePart(added.drawing, added.id, (part) => ({
                ...part,
                text: shape.text || ("box" in kind ? shape.name : ""),
                w: size(shape.width, "box" in kind ? 40 : 60),
                h: size(shape.height, 40),
            }));
            placed.set(shape.id, added.id);
            if ("box" in kind) {
                report.boxes.push(shape.name || "(no name)");
            } else {
                report.notes += 1;
            }
            continue;
        }
        const preset = presetOf(kind.preset)!;
        const added = addPart(drawing, preset, center);
        const own = tag && !taken.has(tag) ? tag : null;
        drawing = updatePart(added.drawing, added.id, (part) => {
            const kindOfPart = kindOf(part.kind);
            const fluid = kindOfPart.fields.some((field) => field.key === "fluid")
                ? fluidNamed(shape.text, fluidsOf(drawing))
                : "";
            return {
                ...part,
                rotation:
                    kindOfPart.id === "legend" || kindOfPart.id === "titleblock"
                        ? 0
                        : rotationOf(shape.angle, shape.flipY),
                flip: shape.flipX !== shape.flipY,
                tag: own ?? part.tag,
                text: kindOfPart.text && !own ? shape.text : part.text,
                props: fluid ? { ...part.props, fluid } : part.props,
            };
        });
        if (own) {
            taken.add(own);
        }
        // Words that aren't its tag (a valve's "MAIN OX") stay, as a note under it.
        if (shape.text && !own && !kindOf(preset.kind).text && !fluidNamed(shape.text, fluidsOf(drawing))) {
            const note = addPart(drawing, presetOf("text")!, { x: center.x, y: center.y + 40 });
            drawing = updatePart(note.drawing, note.id, (part) => ({
                ...part,
                text: shape.text,
                props: { size: "small" },
            }));
            report.notes += 1;
        }
        placed.set(shape.id, added.id);
        report.parts += 1;
    }

    // Lines: each connector between the ports nearest where its ends were glued (or nearest its ends, within reach).
    const glue = new Map<string, { begin?: string; end?: string }>();
    for (const element of [...page.getElementsByTagNameNS("*", "Connect")]) {
        const from = element.getAttribute("FromSheet") ?? "";
        const cell = element.getAttribute("FromCell") ?? "";
        const to = element.getAttribute("ToSheet") ?? "";
        const ends = glue.get(from) ?? {};
        if (cell.startsWith("Begin")) {
            ends.begin = to;
        } else if (cell.startsWith("End")) {
            ends.end = to;
        }
        glue.set(from, ends);
    }
    const connectors = shapes.filter((shape) => shape.oneD && shape.begin && shape.end);
    const lineOf = new Map<string, string>(); // a connector's id: its line's
    const used = new Map<string, number>(); // part:port: lines on it so far
    const colors = new Map<string, string>(); // a color: the fluid made for it

    const targetFor = (where: Point, glued: string | undefined): Target | null => {
        const point = at(where);
        const partId = glued ? placed.get(glued) : undefined;
        const line = glued ? lineOf.get(glued) : undefined;
        if (line) {
            return { line, at: point };
        }
        const candidates = partId ? drawing.parts.filter((part) => part.id === partId) : drawing.parts;
        let best: { part: string; port: string; score: number } | null = null;
        for (const part of candidates) {
            for (const port of portsOf(part)) {
                const away = distance(port.at, point);
                // Glued: its nearest port, a free one before one taken. Not glued: one close by, if there's one.
                const score = away + (used.get(`${part.id}:${port.id}`) && !port.many ? 30 : 0);
                if ((partId || away <= 15) && (!best || score < best.score)) {
                    best = { part: part.id, port: port.id, score };
                }
            }
        }
        return best ? { part: best.part, port: best.port } : snapPoint(point);
    };

    // Connectors glued to other connectors (tees) after the ones they're glued to.
    const order = [...connectors].sort((a, b) => {
        const onLine = (shape: Shape) =>
            [glue.get(shape.id)?.begin, glue.get(shape.id)?.end].some(
                (id) => id && connectors.some((other) => other.id === id),
            );
        return Number(onLine(a)) - Number(onLine(b));
    });
    for (const shape of order) {
        const ends = glue.get(shape.id) ?? {};
        const source = targetFor(shape.begin!, ends.begin);
        const target = targetFor(shape.end!, ends.end);
        const made = source && target ? connect(drawing, source, target) : null;
        if (!made) {
            report.dropped += 1;
            continue;
        }
        drawing = made.drawing;
        for (const end of [
            made.drawing.lines.find((entry) => entry.id === made.id)!.from,
            made.drawing.lines.find((entry) => entry.id === made.id)!.to,
        ]) {
            if ("part" in end) {
                used.set(`${end.part}:${end.port}`, (used.get(`${end.part}:${end.port}`) ?? 0) + 1);
            }
        }
        const name = shape.name.toLowerCase();
        const kind =
            LINE_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? (shape.linePattern > 1 ? "signal" : "pipe");
        // What it carries: what its text says, else what it was drawn from (a tank of LOX), else its color's.
        let fluid =
            fluidNamed(shape.text, fluidsOf(drawing)) || drawing.lines.find((line) => line.id === made.id)!.fluid;
        const color = colorOf(shape.lineColor);
        const named = color ? colorName(color) : null;
        if (!fluid && color && named) {
            // A drawing that colors its lines by what they carry: a fluid of the diagram's own for each color, named
            // after it, to be renamed for what it is.
            fluid = colors.get(color) ?? "";
            if (!fluid) {
                fluid = newFluidId(drawing, `${named} lines`);
                colors.set(color, fluid);
                drawing = {
                    ...drawing,
                    fluids: [...drawing.fluids, { id: fluid, name: `${named} lines`, label: "", color }],
                };
            }
        }
        // Its words: its tag (L-101), its size (1/2 in), the fluid it carries, or else notes.
        const tag = tagIn(shape.text);
        const size = /^\d+(?:\.\d+)?(?:\/\d+)?\s*(?:"|in\b|inch|mm\b)/i.test(shape.text.trim())
            ? shape.text.trim()
            : "";
        const rest = !tag && !size && shape.text && !fluidNamed(shape.text, fluidsOf(drawing)) ? shape.text : "";
        drawing = updateLine(drawing, made.id, (line) => ({
            ...line,
            kind,
            fluid: fluid || line.fluid,
            tag: tag ?? "",
            arrow: shape.arrows.end ? "forward" : shape.arrows.begin ? "backward" : "none",
            shown: [...(tag ? ["tag"] : []), ...(size ? ["size"] : [])],
            props: { ...line.props, ...(size ? { size } : {}), ...(rest ? { notes: rest } : {}) },
        }));
        lineOf.set(shape.id, made.id);
        report.lines += 1;
    }
    return { drawing, report };
}

// --- the file ------------------------------------------------------------------------------------------------------

/** What's in a Visio drawing: each of its pages (but its backgrounds), as a drawing. */
export async function readVisio(file: Blob, fileName: string): Promise<ImportedPage[]> {
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
    const pages = await xml(files, "visio/pages/pages.xml");
    if (!pages) {
        throw new VisioError(`${fileName} isn't a Visio drawing: it has no pages. Piper reads .vsdx files.`);
    }
    const masters = await mastersOf(files);
    const rels = await relationships(files, "visio/pages/pages.xml");
    const base = visioName(fileName);
    const shown = [...pages.getElementsByTagNameNS("*", "Page")].filter(
        (page) => page.getAttribute("Background") !== "1",
    );
    const imported: ImportedPage[] = [];
    for (const page of shown) {
        const sheet = kid(page, "PageSheet");
        const cells = sheet ? cellsOf(sheet) : new Map<string, string>();
        const size = { width: number(cells.get("PageWidth"), 8.5), height: number(cells.get("PageHeight"), 11) };
        const path = rels.get(relId(page));
        const contents = path ? await xml(files, path) : null;
        const root = contents?.documentElement;
        if (!root) {
            continue;
        }
        // Its name as Visio shows it (Name), not the universal one it keeps for code (NameU, "Page-1").
        const title =
            (page.getAttribute("Name") ?? page.getAttribute("NameU") ?? "").trim() || `Page ${imported.length + 1}`;
        const { drawing, report } = pageDrawing(root, size, masters, title);
        imported.push({ name: shown.length > 1 ? `${base} - ${title}` : base, page: title, drawing, report });
    }
    if (imported.length === 0) {
        throw new VisioError(`${fileName} has no pages Piper could read.`);
    }
    return imported;
}

/** A diagram's name for a Visio drawing: its file's. */
export const visioName = (fileName: string) => fileName.replace(/\.[^.]+$/, "") || "Visio drawing";

/**
 * A Visio drawing's pages as one diagram's pages, as they were in Visio. The fluids each page made for its colors are
 * the diagram's: one for each, and a page's that's named as another page's but colored otherwise is its own.
 */
export function visioDocument(imported: ImportedPage[]): PiperDocument {
    const fluids: Fluid[] = [];
    const pages: Page[] = imported.map(({ page, drawing }) => {
        const renamed = new Map<string, string>();
        for (const fluid of drawing.fluids) {
            const same = fluids.find((entry) => entry.id === fluid.id);
            if (!same) {
                fluids.push(fluid);
            } else if (same.color !== fluid.color || same.name !== fluid.name) {
                const like = fluids.find((entry) => entry.color === fluid.color && entry.name === fluid.name);
                const id = like?.id ?? newFluidId({ ...emptyDrawing(), fluids }, fluid.name);
                if (!like) {
                    fluids.push({ ...fluid, id });
                }
                renamed.set(fluid.id, id);
            }
        }
        const fluidOf = (id: string) => renamed.get(id) ?? id;
        return {
            id: newId("g"),
            name: page,
            parts: drawing.parts.map((part) =>
                part.props.fluid ? { ...part, props: { ...part.props, fluid: fluidOf(part.props.fluid) } } : part,
            ),
            lines: drawing.lines.map((line) => ({ ...line, fluid: fluidOf(line.fluid) })),
            sheet: null,
        };
    });
    return { format: 2, pages, fluids, style: imported[0]?.drawing.style ?? emptyDrawing().style };
}
