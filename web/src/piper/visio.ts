import {
    emptyDrawing,
    isPortEnd,
    newId,
    newLine,
    newPart,
    PART_SCALES,
    type Document as PiperDocument,
    type Drawing,
    type End,
    type Fluid,
    type LineKind,
    type Page,
    type Point,
    type Rotation,
} from "./drawing";
import { addPart, follow, obstacles, splitLine, updatePart } from "./edit";
import { fluidsOf, isGas, newFluidId } from "./fluids";
import { dirOf, distance, nearestOnPolyline, simplify, type Box, type Dir } from "./geometry";
import { figureOf, type Figure, type FigurePath, type FigureText } from "./library/figures";
import { kindOf, presetOf } from "./library/index";
import { partsById, placeEnd, portsOf } from "./ports";
import {
    cleanName,
    readVsdx,
    VisioError,
    type Lettering,
    type Pen,
    type Step,
    type VisioPage,
    type VisioShape,
    type Words,
} from "./vsdx";

export { VisioError };

// Visio's drawings read into Piper's: vsdx.ts reads the file (each page's shapes as Visio draws them), and each page
// becomes a page of a diagram. What Piper has a part for becomes that part: Visio's P&ID shapes by their masters' names
// ("Powered valve", "Regulator", "3/2 valve"...), wherever they are in a group, worked as their actuator's letter says
// (S a solenoid, P air), and symbols drawn by hand by what their tags say they are (PRV a relief valve, FTPT a pressure
// transducer, FO-1 an orifice), each tagged and given its set pressure as its words say. Everything else is drawn as
// Visio drew it, a figure (its outlines, fills, and words), so nothing on the page is lost or looks other than it did.
// Connectors become lines along the routes they had, on the ports nearest where they were glued (a figure gets a port
// where one was glued to it), carrying the fluid their key, their words, or their color says. A drawing's key (its
// legend) is read for what its colors, dashes, and fills mean, and kept as it was drawn.

/** What became of a page's shapes. */
export interface ImportReport {
    page: string;
    parts: number;
    lines: number;
    notes: number; // words, kept as Piper's text
    figures: number; // shapes drawn as Visio drew them
    drawn: string[]; // symbols Piper has no part for, drawn as Visio drew them: their masters' names, or their tags
    dropped: number; // connectors that joined nothing to nothing
}

export interface ImportedPage {
    name: string; // a diagram's of the page alone: the file's, and the page's if there are more
    page: string; // the page's, as Visio shows it
    drawing: Drawing;
    report: ImportReport;
}

const VALVE_UNITS = 40; // a valve's length, port to port, in Piper's units: what a page is scaled to draw them at
const SYMBOL_INCHES = 1.5; // the most a symbol drawn by hand is across, unless the page's words are big

// --- words ---------------------------------------------------------------------------------------------------------

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

/** Words in capitals that say what something is, not which: no one's tag. */
const COMMON = new Set(
    (
        "TANK TANKS LINE LINES KEY LEGEND VALVE VALVES NOTE NOTES TO FROM IN OUT AND OR THE OF ON OFF OPEN CLOSED " +
        "ENGINE VEHICLE GSE GROUND PAD FUEL OXIDIZER PRESSURANT VENT DRAIN FILL PURGE TEST STAND PAGE REV SHEET DWG " +
        "TITLE DATE SCALE NTS ATM ATMOSPHERE MANIFOLD"
    ).split(" "),
);

/**
 * A tag as teams write them without a number (FBB, PRISO, SV-OVNT), or as P&IDs do with one: a word in capitals that
 * isn't a fluid's name or a common word.
 */
function tagOf(text: string, fluids: Fluid[]): string | null {
    const tag = tagIn(text);
    if (tag) {
        return fluidNamed(tag, fluids) ? null : tag;
    }
    const word = text.replace(/\s+/g, " ").trim();
    if (
        word.length > 16 ||
        !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){0,3}$/.test(word) ||
        (word.match(/[A-Z]/g) ?? []).length < 2 ||
        COMMON.has(word) ||
        fluidNamed(word, fluids)
    ) {
        return null;
    }
    return word;
}

/** A set pressure as P&IDs write one: "S.P. 145 PSI", "R.P. 450 psi", "Set 500 psi", "Cracks at 50 psid". */
function setPressureIn(text: string): string | null {
    const match =
        /(?:\b[SR]\.?\s?P\.?|\bset(?:\s?point)?|\brelief|\bcrack(?:ing|s at)?)\s*[:=@]?\s*(\d+(?:\.\d+)?)\s*(psi[agd]?|bar|kpa|mpa)?/i.exec(
            text,
        );
    return match ? `${match[1]} ${(match[2] ?? "psi").toLowerCase()}` : null;
}

/**
 * What a label says, if each of its lines says something Piper keeps: a tag (PT over 101 is one), and a set pressure
 * ("PNRV" over "S.P. 165 PSI"). Words that say more are words, kept as they're written.
 */
function labelOf(text: string, fluids: Fluid[]): { tag: string | null; set: string | null } | null {
    const whole = tagOf(text, fluids);
    if (whole) {
        return { tag: whole, set: null };
    }
    let tag: string | null = null;
    let set: string | null = null;
    for (const line of text
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        const lineTag: string | null = tag ? null : tagOf(line, fluids);
        const lineSet: string | null = set ? null : setPressureIn(line);
        if (lineTag) {
            tag = lineTag;
        } else if (lineSet) {
            set = lineSet;
        } else {
            return null;
        }
    }
    return tag || set ? { tag, set } : null;
}

/** A line's size as its words write it: 1/2", 0.25 in, 6 mm. */
function sizeIn(text: string): string | null {
    const match = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|\d+\s+\d+\/\d+)\s*(?:"|”|''|in\b|inch(?:es)?\b|mm\b)/i.exec(text);
    if (!match) {
        return null;
    }
    const value = match[1]!.replace(/\s*\/\s*/, "/");
    return /mm/i.test(match[0]) ? `${value} mm` : `${value} in`;
}

/** A fluid a text names (LOX, GN2, Helium...), whole words, label or name. */
function fluidNamed(text: string, fluids: Fluid[]): string {
    const words = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
    const found = fluids.find(
        (fluid) =>
            (fluid.label && words.includes(` ${fluid.label.toLowerCase()} `)) ||
            words.includes(` ${fluid.name.toLowerCase()} `),
    );
    return found?.id ?? "";
}

/** A shape's words as one text: its lines, each on a line of its own. */
const textOf = (words: Words | null): string => (words ? words.lines.map((line) => line.trim()).join("\n") : "");

// --- colors --------------------------------------------------------------------------------------------------------

function rgbOf(hex: string): [number, number, number] {
    return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
}

/** Whether a color is a color, not black, white, or gray: lines colored for what they carry are. */
function colored(hex: string): boolean {
    const [r, g, b] = rgbOf(hex);
    return Math.max(r, g, b) - Math.min(r, g, b) >= 0.15;
}

/** A color's name, roughly, for a fluid named after the color a Visio drawing gave its lines. */
function colorName(hex: string): string {
    const [hue] = hslOf(hex);
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

/** A color's hue (degrees), saturation, and lightness, each of 0 to 1 but the hue. */
function hslOf(hex: string): [number, number, number] {
    const [r, g, b] = rgbOf(hex);
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    const lightness = (high + low) / 2;
    if (high === low) {
        return [0, 0, lightness];
    }
    const chroma = high - low;
    const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    const hue =
        high === r
            ? (60 * ((g - b) / chroma) + 360) % 360
            : high === g
              ? 60 * ((b - r) / chroma) + 120
              : 60 * ((r - g) / chroma) + 240;
    return [hue, saturation, lightness];
}

/**
 * Of a key's colors, the one a line's color is: itself, else the one of its hue nearest it in lightness (a key's red
 * swatch for lines drawn a darker red), if one's near enough to be.
 */
function keyColorOf(color: string, colors: string[]): string | null {
    if (colors.includes(color)) {
        return color;
    }
    const [hue, saturation, lightness] = hslOf(color);
    let best: { color: string; score: number } | null = null;
    for (const other of colors) {
        const [otherHue, otherSaturation, otherLightness] = hslOf(other);
        const turn = Math.min(Math.abs(hue - otherHue), 360 - Math.abs(hue - otherHue));
        if (saturation < 0.25 || otherSaturation < 0.25 || turn > 30) {
            continue;
        }
        const score = turn / 30 + Math.abs(lightness - otherLightness) / 0.25;
        if (score <= 2 && (!best || score < best.score)) {
            best = { color: other, score };
        }
    }
    return best?.color ?? null;
}

// --- shapes --------------------------------------------------------------------------------------------------------

/** A shape and all its members, and theirs. */
function everyShape(shape: VisioShape): VisioShape[] {
    return [shape, ...shape.members.flatMap(everyShape)];
}

/** Whether a shape draws anything of its own: a line, or a fill. */
const draws = (shape: VisioShape): boolean =>
    shape.outlines.some((outline) => (outline.stroked && shape.pen) || (outline.filled && shape.brush));

/** Words alone: a shape (or a group of them) that draws nothing but its words. */
function wordsOnly(shape: VisioShape): boolean {
    const all = everyShape(shape);
    return !all.some(draws) && all.some((member) => member.words !== null);
}

/** The box around what a shape draws (its outlines, and its words' blocks), on the page. */
function boxOfShape(shape: VisioShape, words = true): Box | null {
    let box: Box | null = null;
    const add = (point: Point) => {
        box = box
            ? {
                  x0: Math.min(box.x0, point.x),
                  y0: Math.min(box.y0, point.y),
                  x1: Math.max(box.x1, point.x),
                  y1: Math.max(box.y1, point.y),
              }
            : { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
    };
    for (const member of everyShape(shape)) {
        if (draws(member)) {
            for (const outline of member.outlines) {
                for (const step of outline.steps) {
                    if (step.kind !== "close") {
                        add(step.to);
                    }
                }
            }
        }
        if (words && member.words) {
            const block = textBox(member.words);
            add({ x: block.x0, y: block.y0 });
            add({ x: block.x1, y: block.y1 });
        }
    }
    return box;
}

/** About where words are on the page: around their lines as Visio sets them in their block (at its top, middle, or
 * foot), or, turned, around their block's middle. */
function textBox(words: Words): Box {
    const lines = linesOf(words);
    if (lines.length > 0) {
        return {
            x0: Math.min(...lines.map((line) => line.x0)),
            y0: Math.min(...lines.map((line) => line.y)) - words.size * 0.6,
            x1: Math.max(...lines.map((line) => line.x1)),
            y1: Math.max(...lines.map((line) => line.y)) + words.size * 0.6,
        };
    }
    const reach = Math.max(...words.lines.map((line) => line.trim().length)) * words.size * 0.5;
    const tall = words.lines.length * words.pitch;
    const half = Math.max(reach, tall) / 2;
    return { x0: words.at.x - half, y0: words.at.y - half, x1: words.at.x + half, y1: words.at.y + half };
}

const boxGap = (a: Box, b: Box): number =>
    Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));

const middleOf = (box: Box): Point => ({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 });

// --- symbols -------------------------------------------------------------------------------------------------------

/** Which library entry a master's name says it is: Visio's P&ID stencils' names, and the words people use. */
const NAMES: [RegExp, string | null][] = [
    [/manifold|title block|legend|\bzones?\b|border/, null],
    [/three.?way|3.?way|four.?way|diverter|\b[35]\/2\b/, "three-way-valve"],
    [/angle valve/, "angle-valve"],
    [/check|non.?return/, "check-valve"],
    [/relief|safety valve|\bpsv\b|\bprv\b/, "relief-valve"],
    [/regulat|pressure.?reducing|reducing valve/, "regulator"],
    [/rupture|burst/, "burst-disc"],
    [/solenoid/, "solenoid-valve"],
    [/motor.*valve|valve.*motor|motori[sz]ed|electric(al)? valve|\bmov\b/, "motor-valve"],
    [
        /pneumatic|actuated|control valve|diaphragm valve|air.?operated|powered valve|remote valve|\b2\/2\b/,
        "pneumatic-valve",
    ],
    [/needle|metering/, "needle-valve"],
    [/butterfly/, "butterfly-valve"],
    [/plug valve|\bcock\b/, "plug-valve"],
    [/globe/, "globe-valve"],
    [/ball valve|manual valve|hand valve|screw.?down/, "ball-valve"],
    [/quick|disconnect|coupling|\bqd\b/, "quick-disconnect"],
    [/gate|valve/, "gate-valve"],
    [/copv/, "copv"],
    [/cylinder|bottle/, "bottle"],
    [/dewar/, "dewar"],
    [/spherical tank|\bsphere\b/, "sphere"],
    [/\btank\b|vessel|\bdrum\b|reservoir|accumulator/, "tank"],
    [/cavitating/, "cavitating-venturi"],
    [/venturi/, "venturi"],
    [/orifice|restrict/, "orifice"],
    [/flow ?meter|rotameter|turbine meter|coriolis/, "flow-meter"],
    [/filter|strainer/, "filter"],
    [/gauge|gage/, "pressure-gauge"],
    [/\bd\s?p\b|differential/, "dp-transducer"],
    [/pressure (transducer|transmitter|sensor)/, "pressure-transducer"],
    [/temperature|thermocouple/, "thermocouple"],
    [/\brtd\b/, "rtd"],
    [/load cell/, "load-cell"],
    [/instrument|indicator|transmitter|transducer|sensor|bubble/, "instrument"],
    [/pump|compressor|blower/, "pump"],
    [/exchanger|cooler|heater|condenser/, "heat-exchanger"],
    [/engine|thrust chamber|combustion chamber|rocket motor/, "engine"],
    [/igniter|ignitor/, "igniter"],
    [/\bvent\b|exhaust|\bstack\b/, "vent"],
    [/reducer|expander/, "reducer"],
    [/hose|flexible/, "hose"],
    [/\bcap\b|blind|end plug/, "cap"],
    [/junction|\btee\b/, "junction"],
];

function presetNamed(name: string): string | null {
    const lower = name.toLowerCase();
    for (const [pattern, preset] of NAMES) {
        if (pattern.test(lower)) {
            return preset;
        }
    }
    return null;
}

/** An instrument's preset by its tag's letters: ISA's first (PT-101), or as teams end theirs (FTPT, OURTD). */
function instrumentFor(tag: string): string | null {
    const letters = tag.toUpperCase().replace(/[^A-Z]/g, "");
    if (/RTD$/.test(letters)) {
        return "rtd";
    }
    if (/^(DP|PD)/.test(letters) || /(DPT|PDT)$/.test(letters)) {
        return "dp-transducer";
    }
    if (letters === "PG" || letters === "PI") {
        return "pressure-gauge";
    }
    if (/^PT|PT$/.test(letters)) {
        return "pressure-transducer";
    }
    if (/^(TC|TT|TE)|(TC|TT|TD)$/.test(letters)) {
        return "thermocouple";
    }
    if (/^PS[HL]?$|PS[HL]?$/.test(letters)) {
        return "pressure-switch";
    }
    if (/^(LC|WT)|LC$/.test(letters)) {
        return "load-cell";
    }
    if (/^F[TE]|FT$/.test(letters)) {
        return "flow-transmitter";
    }
    if (/^L[TI]|LT$/.test(letters)) {
        return "level-sensor";
    }
    if (/^Z[TS]|ZT$/.test(letters)) {
        return "position-sensor";
    }
    return null;
}

/**
 * What a symbol drawn by hand is, by its tag's letters: what P&IDs end a tag with (PRV a relief valve, PNREG a
 * regulator, FCK a check valve, PRQD a quick disconnect, FO-1 an orifice, FSWV or OVNT a valve), or an instrument's.
 */
function presetForTag(tag: string): string | null {
    const letters = tag.toUpperCase().replace(/-?\d+[A-Z]?$/, "");
    if (/(RV|PSV)$/.test(letters)) {
        return "relief-valve";
    }
    if (/REG$/.test(letters)) {
        return "regulator";
    }
    if (/(CK|CHK)$/.test(letters)) {
        return "check-valve";
    }
    if (/QDC?$/.test(letters)) {
        return "quick-disconnect";
    }
    if (/(^|-)O$|^[A-Z]O$|ORF$|ORIF$/.test(letters)) {
        return "orifice";
    }
    if (/(FLT|FILT)$/.test(letters)) {
        return "filter";
    }
    if (/BD$/.test(letters)) {
        return "burst-disc";
    }
    const instrument = instrumentFor(letters);
    if (instrument) {
        return instrument;
    }
    if (/(VNT|VENT|BB|SWV|MV|ISO|VLV|SV|PV|^V|-V)$/.test(letters)) {
        return "gate-valve";
    }
    return null;
}

/** What works a valve, by the letter in its actuator's box, its name, or its tag: S a solenoid, P air, M a motor. */
function actuationOf(letters: string[], name: string, tag: string): string | null {
    for (const letter of letters) {
        const found = {
            S: "solenoid",
            P: "pneumatic",
            D: "pneumatic",
            A: "pneumatic",
            M: "motor",
            E: "motor",
            H: "manual",
        }[letter];
        if (found) {
            return found;
        }
    }
    const lower = name.toLowerCase();
    // ISO 1219's 2/2, 3/2, and 5/2 valves are drawn worked by a solenoid, as a team's pneumatic manifolds are.
    if (/solenoid|\b[235]\/2\b/.test(lower)) {
        return "solenoid";
    }
    if (/motor/.test(lower)) {
        return "motor";
    }
    if (/manual|hand|screw.?down|needle/.test(lower)) {
        return "manual";
    }
    if (/pneumatic|air|powered|remote|actuated/.test(lower)) {
        return "pneumatic";
    }
    if (/^SV-/.test(tag)) {
        return "solenoid";
    }
    if (/^PV-/.test(tag)) {
        return "pneumatic";
    }
    return null;
}

/** A symbol Piper has a part for. */
interface Symbol {
    shape: VisioShape; // it all, its words too
    body: VisioShape; // the symbol itself: what it's placed and turned by
    preset: string;
    props: Record<string, string>;
    tag: string;
    tagWords: Words | null; // where its tag was written
    words: Words[]; // its other words, which say nothing Piper knows: kept beside it
    fill: string | null; // its body's fill: a key may say a fill is a valve's normal state
}

/** What a page tells the import: who's glued to what, how big its words are, and what its key says. */
interface Facts {
    glued: Map<string, { begin?: string; end?: string }>; // a connector's ends: what each is glued to
    gluedTo: Set<string>; // shapes something's glued to
    textSize: number; // its words' usual size, inches
    symbolSize: number; // the most a symbol drawn by hand is across, inches
    fluids: Fluid[];
    memo: Map<string, Symbol | null>;
}

/** A symbol, as a preset says, with what its words say: its tag, its set pressure, how it's worked. */
function symbolOf(shape: VisioShape, body: VisioShape, preset: string, facts: Facts, name: string): Symbol {
    const letters: string[] = [];
    let tag = "";
    let tagWords: Words | null = null;
    const props: Record<string, string> = {};
    const words: Words[] = [];
    // Its labels' words first (words alone, beside it), then the symbol's own.
    const all = everyShape(shape).filter((member) => member.words);
    const ordered = [...all.filter(wordsOnly), ...all.filter((member) => !wordsOnly(member))];
    const holds = kindOf(presetOf(preset)?.kind ?? "").fields.some((field) => field.key === "fluid");
    for (const member of ordered) {
        const text = textOf(member.words);
        const trimmed = text.trim();
        if (/^[A-Z]$/.test(trimmed) && draws(member)) {
            letters.push(trimmed); // an actuator's letter, in its box
            continue;
        }
        // What a tank holds, where its words are only that (LOX).
        const fluid = holds && !props.fluid ? fluidNamed(trimmed, facts.fluids) : "";
        const named = (entry: Fluid) =>
            [entry.label, entry.name].some((said) => said.toLowerCase() === trimmed.toLowerCase());
        if (fluid && fluidsOf(emptyDrawing()).some(named)) {
            props.fluid = fluid;
            continue;
        }
        const label = labelOf(text, facts.fluids);
        const takesTag = label?.tag && !tag && member.words!.size <= facts.textSize * 2.5;
        if (label && (takesTag || !label.tag) && (!label.set || !props.set)) {
            if (label.tag) {
                tag = label.tag;
                tagWords = member.words;
            }
            if (label.set) {
                props.set = label.set;
            }
        } else if (trimmed) {
            words.push(member.words!);
        }
    }
    const kind = presetOf(preset)?.kind ?? "";
    if (kind === "valve" || kind === "valve3" || kind === "angle") {
        const actuation = actuationOf(letters, name, tag);
        if (actuation) {
            props.actuation = actuation;
        }
        // A plain bowtie, as P&IDs draw a valve whose body isn't said, is Piper's gate valve.
        if (kind === "valve" && !/ball|globe|needle|butterfly|plug/i.test(name)) {
            props.body = "gate";
        }
    }
    const fill = everyShape(body).find(
        (member) => draws(member) && member.brush && member.outlines.some((o) => o.filled),
    )?.brush?.color;
    // An instrument, as its tag's letters say what it measures (PT a pressure transducer, TC a thermocouple).
    const which = preset === "instrument" && tag ? (instrumentFor(tag) ?? preset) : preset;
    return { shape, body, preset: which, props, tag, tagWords, words, fill: fill ?? null };
}

/**
 * What Piper part a shape is, if it's one: by its master's name, as the one symbol in a group of it and its labels, or,
 * drawn by hand, by what its tag says it is. A group of several symbols is none: each is placed for itself.
 */
function recognize(shape: VisioShape, facts: Facts): Symbol | null {
    const known = facts.memo.get(shape.id);
    if (known !== undefined) {
        return known;
    }
    const found = recognizeNow(shape, facts);
    facts.memo.set(shape.id, found);
    return found;
}

function recognizeNow(shape: VisioShape, facts: Facts): Symbol | null {
    if (shape.oneD || !everyShape(shape).some(draws)) {
        return null;
    }
    const name = shape.master || cleanName(shape.name);
    const named = presetNamed(name);
    if (named) {
        return symbolOf(shape, shape, named, facts, name);
    }
    if (shape.kind === "group") {
        const inner = shape.members.map((member) => recognize(member, facts));
        const symbols = inner.filter((symbol) => symbol !== null);
        if (symbols.length === 1) {
            const others = shape.members.filter((_, index) => inner[index] === null);
            if (others.every((member) => wordsOnly(member) || (!member.oneD && tiny(member, symbols[0]!.body)))) {
                const symbol = symbols[0]!;
                const outer = symbolOf(shape, symbol.body, symbol.preset, facts, symbol.body.master || name);
                return { ...outer, props: { ...symbol.props, ...outer.props } };
            }
        }
        if (symbols.length > 0) {
            return null;
        }
    }
    // Drawn by hand: small, and tagged as what it is.
    const box = boxOfShape(shape, false);
    if (!box || Math.max(box.x1 - box.x0, box.y1 - box.y0) > facts.symbolSize) {
        return null;
    }
    const tags = everyShape(shape)
        .map((member) => (member.words ? (labelOf(textOf(member.words), facts.fluids)?.tag ?? null) : null))
        .filter((tag) => tag !== null);
    const preset = tags.length === 1 ? presetForTag(tags[0]!) : null;
    return preset ? symbolOf(shape, shape, preset, facts, name) : null;
}

/** Whether a shape is small beside a symbol: a mark on it (a dot, a tick), not something of its own. */
function tiny(shape: VisioShape, body: VisioShape): boolean {
    const own = boxOfShape(shape, false);
    const other = boxOfShape(body, false);
    if (!own || !other) {
        return true;
    }
    const size = Math.max(own.x1 - own.x0, own.y1 - own.y0);
    return size <= 0.35 * Math.max(other.x1 - other.x0, other.y1 - other.y0) && boxGap(own, other) <= size;
}

// --- the key -------------------------------------------------------------------------------------------------------

/** What a drawing's key says: what its lines' colors carry, what their dashes and weights say they're sized, and which
 * fill means which normal state of a valve. Its own shapes are drawn as they are. */
interface Key {
    shapes: Set<string>; // the page's shapes (top-level) that are its key
    fluids: Map<string, string>; // a line color: what the key calls lines in it ("Liquid Oxygen (LOX)")
    sizes: { pattern: number; weight: number; size: string; material: string }[];
    states: Map<string, string>; // a valve's fill: its normal state ("NO", "NC", "FIP")
}

/**
 * Where a block's first line's baseline is, from the block's middle, y up (inches): its lines set from its top, its
 * middle, or its foot, inside its margins, with the space each line has beyond Visio's single spacing above it.
 */
function firstBaseline(words: Words, count: number): number {
    const lead = Math.max(0, words.pitch - 1.2 * words.size);
    if (words.valign === "top") {
        return words.height / 2 - words.margins.top - lead - 0.9 * words.size;
    }
    if (words.valign === "bottom") {
        return -words.height / 2 + words.margins.bottom + 0.22 * words.size + (count - 1) * words.pitch;
    }
    return ((count - 1) * words.pitch) / 2 - 0.33 * words.size;
}

/** Where each of a block's lines of words is, on the page, about: its middle height, and its left and right. */
function linesOf(words: Words): { text: string; y: number; x0: number; x1: number; size: number }[] {
    if (Math.abs(Math.sin(words.angle)) > 0.2) {
        return [];
    }
    const first = words.at.y + firstBaseline(words, words.lines.length) + 0.33 * words.size;
    return words.lines.map((text, index) => {
        const width = text.trim().length * words.size * 0.5;
        const left = words.at.x - words.width / 2 + words.margins.left;
        const right = words.at.x + words.width / 2 - words.margins.right;
        const [x0, x1] =
            words.align === "left"
                ? [left, left + width]
                : words.align === "right"
                  ? [right - width, right]
                  : [words.at.x - width / 2, words.at.x + width / 2];
        return { text: text.trim(), y: first - index * words.pitch, x0, x1, size: words.size };
    });
}

const KEY_TITLE = /^\s*(?:[\w&/-]+\s+){0,3}(?:key|legend)\s*:?\s*$/i;

/**
 * A drawing's key: the shapes about each of its titles ("Line KEY", "LEGEND"), near one another and joined to nothing
 * on the drawing, and what they say: the words beside each line drawn in it name what lines like it carry (or their
 * size), and those beside a valve, which normal state its fill means.
 */
function keyOf(page: VisioPage, facts: Facts): Key {
    const key: Key = { shapes: new Set(), fluids: new Map(), sizes: [], states: new Map() };
    const joined = (shape: VisioShape) =>
        everyShape(shape).some((member) => facts.glued.has(member.id) || facts.gluedTo.has(member.id));
    const boxes = new Map(page.shapes.map((shape) => [shape.id, boxOfShape(shape)]));
    // A frame, or a border's line: not a key's, though keys are often beside one. (A key's words can be long.)
    const big = (shape: VisioShape, box: Box) =>
        !wordsOnly(shape) && (box.x1 - box.x0 > 0.4 * page.width || box.y1 - box.y0 > 0.4 * page.height);
    const gap = Math.max(0.3, facts.textSize * 2.5);
    const titles = page.shapes.filter(
        (shape) => wordsOnly(shape) && KEY_TITLE.test(textOf(shape.words).replace(/\n/g, " ")),
    );
    for (const title of titles) {
        const found = new Set([title.id]);
        const queue = [title];
        while (queue.length > 0) {
            const from = boxes.get(queue.shift()!.id);
            if (!from) {
                continue;
            }
            for (const shape of page.shapes) {
                const box = boxes.get(shape.id);
                if (!found.has(shape.id) && box && !big(shape, box) && !joined(shape) && boxGap(from, box) <= gap) {
                    found.add(shape.id);
                    queue.push(shape);
                }
            }
        }
        for (const id of found) {
            key.shapes.add(id);
        }
    }
    if (key.shapes.size === 0) {
        return key;
    }
    const inKey = page.shapes.filter((shape) => key.shapes.has(shape.id)).flatMap(everyShape);
    const texts = inKey.flatMap((shape) => (shape.words ? linesOf(shape.words) : [])).filter((line) => line.text);
    // A line drawn in the key, and the words just right of it, about as high.
    for (const sample of inKey.filter((shape) => shape.oneD && shape.pen && shape.begin && shape.end)) {
        const [a, b] = [sample.begin!, sample.end!];
        if (Math.abs(a.y - b.y) > 0.05) {
            continue;
        }
        const right = Math.max(a.x, b.x);
        const said = texts
            .filter((line) => Math.abs(line.y - a.y) <= Math.max(0.06, line.size * 0.6) && line.x0 >= right - 0.1)
            .sort((one, other) => one.x0 - other.x0)[0];
        if (!said || said.x0 - right > 2) {
            continue;
        }
        const size = sizeIn(said.text);
        if (size) {
            // Its size, and what it's of where the key says ("1/4" Polyurethane Line").
            const material = said.text
                .replace(/(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*(?:"|”|''|in\b|inch(?:es)?\b|mm\b)/i, "")
                .replace(/\b(lines?|tub(?:e|es|ing)|pip(?:e|es|ing)|hoses?)\b/gi, "")
                .replace(/[^\w\s/-]+/g, "")
                .trim();
            key.sizes.push({ pattern: sample.pen!.pattern, weight: sample.pen!.weight, size, material });
        } else if (colored(sample.pen!.color) && !key.fluids.has(sample.pen!.color)) {
            key.fluids.set(sample.pen!.color, said.text);
        }
    }
    // A valve drawn in the key, and the words beside it saying which normal state its fill is.
    for (const line of texts) {
        const state = /normally\s+open|^n\.?\s?o\.?$/i.test(line.text)
            ? "NO"
            : /normally\s+closed|^n\.?\s?c\.?$/i.test(line.text)
              ? "NC"
              : /fail.*place|^fip$/i.test(line.text)
                ? "FIP"
                : null;
        if (!state) {
            continue;
        }
        // The valve in its row (beside it, as a key's are), else the nearest.
        const nearest = inKey
            .map((shape) => ({ shape, symbol: recognize(shape, facts) }))
            .filter((entry) => entry.symbol?.fill && presetOf(entry.symbol.preset)?.kind === "valve")
            .map((entry) => ({ ...entry, box: boxOfShape(entry.shape, false)! }))
            .map((entry) => ({
                ...entry,
                beside: entry.box.y0 - 0.1 <= line.y && line.y <= entry.box.y1 + 0.1,
                away: boxGap(entry.box, {
                    x0: line.x0,
                    y0: line.y - line.size / 2,
                    x1: line.x1,
                    y1: line.y + line.size / 2,
                }),
            }))
            .sort((one, other) => Number(other.beside) - Number(one.beside) || one.away - other.away)[0];
        if (nearest && nearest.away <= 2 && !key.states.has(nearest.symbol!.fill!)) {
            key.states.set(nearest.symbol!.fill!, state);
        }
    }
    return key;
}

// --- figures -------------------------------------------------------------------------------------------------------

/** Visio's line patterns as dashes and gaps, in its line's widths. */
const DASHES: Record<number, number[]> = {
    2: [6, 3],
    3: [1, 3],
    4: [6, 3, 1, 3],
    5: [6, 3, 1, 3, 1, 3],
    6: [6, 3, 6, 3, 1, 3],
    7: [14, 2, 6, 2],
    8: [14, 2, 6, 2, 6, 2],
    9: [14, 2],
    10: [1, 1],
    11: [3, 1],
    12: [3, 1, 1, 1],
    13: [3, 1, 1, 1, 1, 1],
    14: [3, 1, 3, 1, 1, 1],
    15: [7, 1, 3, 1],
    16: [7, 1, 3, 1, 3, 1],
    17: [7, 1],
    18: [12, 6],
    19: [1, 6],
    20: [12, 6, 1, 6],
    21: [12, 6, 1, 6, 1, 6],
    22: [12, 6, 12, 6, 1, 6],
    23: [1, 1.5],
};

const round = (value: number) => Math.round(value * 10) / 10;
const fine = (value: number) => Math.round(value * 100) / 100;

/** A typeface as the drawing's words are set in it, near enough: serif, monospace, or sans serif. */
function familyOf(font: string): "serif" | "mono" | undefined {
    if (/courier|consolas|mono|lucida console/i.test(font)) {
        return "mono";
    }
    return /times|georgia|garamond|cambria|book|serif/i.test(font) && !/sans/i.test(font) ? "serif" : undefined;
}

/** Whether two runs of words are set alike. */
const alike = (a: Lettering, b: Lettering): boolean =>
    a.size === b.size && a.color === b.color && a.bold === b.bold && a.italic === b.italic;

/** Lines too wide for their block wrapped at its spaces, about as Visio wraps them (those set in one way only). */
function wrapped(words: Words): string[] {
    // About how many letters fit: Visio's usual Calibri is narrow, and a line only somewhat over is likely one it
    // didn't wrap (letters' widths aren't known here), so only lines well over are.
    const room = words.width - words.margins.left - words.margins.right;
    const most = Math.floor(room / (words.size * 0.46));
    if (room <= words.size * 2 || most < 4) {
        return words.lines;
    }
    return words.lines.flatMap((line) => {
        if (line.length <= most * 1.2) {
            return [line];
        }
        const out: string[] = [];
        let now = "";
        for (const word of line.split(" ")) {
            const next = now ? `${now} ${word}` : word;
            if (next.length > most && now) {
                out.push(now);
                now = word;
            } else {
                now = next;
            }
        }
        return [...out, now];
    });
}

/** Turns a page point into Piper's: units, from the page's top left, y down. */
type Place = (point: Point) => Point;

/**
 * A shape's words as a figure draws them, in Piper's units on the page: from their first line's anchor, set as Visio
 * sets them in their block (aligned, at its top, middle, or foot, inside its margins, spaced as it spaces them),
 * turned as their block is, and each run of them set its own way where it is.
 */
function figureText(words: Words, at: Place, k: number): FigureText {
    const mixed = words.runs.some((line) => line.some((run) => !alike(run.lettering, words)));
    const lines = mixed ? words.lines : wrapped(words);
    const size = words.size * k;
    const w = words.width * k;
    const x =
        words.align === "left"
            ? -w / 2 + words.margins.left * k
            : words.align === "right"
              ? w / 2 - words.margins.right * k
              : 0;
    const y = -firstBaseline(words, lines.length) * k;
    const angle = (-words.angle * 180) / Math.PI; // clockwise, as y goes down
    const turn = (angle * Math.PI) / 180;
    const middle = at(words.at);
    const degrees = ((((Math.round(angle * 10) / 10) % 360) + 540) % 360) - 180;
    const pitch = fine(words.pitch * k);
    return {
        x: middle.x + x * Math.cos(turn) - y * Math.sin(turn),
        y: middle.y + x * Math.sin(turn) + y * Math.cos(turn),
        lines,
        ...(mixed
            ? {
                  runs: words.runs.map((line) =>
                      line.map(({ text, lettering }) => ({
                          text,
                          ...(lettering.size !== words.size ? { size: fine(lettering.size * k) } : {}),
                          ...(lettering.color !== words.color ? { color: lettering.color } : {}),
                          ...(lettering.bold !== words.bold ? { bold: lettering.bold } : {}),
                          ...(lettering.italic !== words.italic ? { italic: lettering.italic } : {}),
                      })),
                  ),
              }
            : {}),
        size: fine(size) || 1,
        ...(Math.abs(pitch - size * 1.2) > 0.05 ? { pitch } : {}),
        ...(words.color !== "#000000" ? { color: words.color } : {}),
        ...(words.bold ? { bold: true } : {}),
        ...(words.italic ? { italic: true } : {}),
        ...(familyOf(words.font) ? { font: familyOf(words.font) } : {}),
        ...(words.align === "left"
            ? { anchor: "start" as const }
            : words.align === "right"
              ? { anchor: "end" as const }
              : {}),
        ...(Math.abs(degrees) > 0.05 ? { angle: degrees } : {}),
        ...(words.background ? { halo: words.background } : {}),
    };
}

/** What a figure draws, before it's placed: an outline (Visio's, on the page) or a polygon (Piper's, an arrowhead),
 * how it's painted, and where it reaches, in Piper's units. */
interface DrawnPath {
    style: Omit<FigurePath, "d">;
    steps: Step[] | null;
    polygon: Point[] | null;
    reach: Point[];
}

interface Drawn {
    paths: DrawnPath[];
    texts: FigureText[];
}

/** An arrowhead at a line's end, pointing the way its last run goes, as big as Visio's size for it says. */
function arrowhead(tip: Point, from: Point, pen: Pen, size: number, k: number): Point[] | null {
    const length = Math.hypot(tip.x - from.x, tip.y - from.y);
    if (length < 1e-9) {
        return null;
    }
    const along = { x: (tip.x - from.x) / length, y: (tip.y - from.y) / length };
    const long = (0.06 + 0.02 * size) * k + pen.weight * k * 2;
    const half = long * 0.4;
    const base = { x: tip.x - along.x * long, y: tip.y - along.y * long };
    return [
        tip,
        { x: base.x - along.y * half, y: base.y + along.x * half },
        { x: base.x + along.y * half, y: base.y - along.x * half },
    ];
}

/**
 * What shapes draw, in Visio's order: a group's members, and its own outline over them (or under, as Visio has it).
 * own: only what the shapes draw themselves, not their members. Words left out: those Piper writes itself (a tag).
 */
function drawnOf(shapes: VisioShape[], at: Place, k: number, own: boolean, leaveOut: Set<Words>): Drawn {
    const drawn: Drawn = { paths: [], texts: [] };
    const draw = (shape: VisioShape) => {
        for (const outline of shape.outlines) {
            const pen = outline.stroked ? shape.pen : null;
            const brush = outline.filled ? shape.brush : null;
            if (!pen && !brush) {
                continue;
            }
            const width = pen ? Math.max(0.3, fine(pen.weight * k)) : 0;
            const dash = pen ? DASHES[pen.pattern] : undefined;
            drawn.paths.push({
                style: {
                    ...(brush ? { fill: brush.color } : {}),
                    ...(brush && brush.opacity < 1 ? { opacity: Math.round(brush.opacity * 100) / 100 } : {}),
                    ...(pen ? { stroke: pen.color, width } : {}),
                    ...(dash ? { dash: dash.map((part) => round(part * Math.max(1, width))).join(" ") } : {}),
                },
                steps: outline.steps,
                polygon: null,
                reach: outline.steps.flatMap((step) =>
                    step.kind === "curve"
                        ? [at(step.a), at(step.b), at(step.to)]
                        : step.kind === "close"
                          ? []
                          : [at(step.to)],
                ),
            });
            // Arrowheads, at an open line's ends.
            if (pen && !outline.steps.some((step) => step.kind === "close")) {
                const ends = outline.steps.flatMap((step) => (step.kind === "close" ? [] : [at(step.to)]));
                const heads =
                    ends.length > 1
                        ? [
                              pen.begin > 0 ? arrowhead(ends[0]!, ends[1]!, pen, pen.beginSize, k) : null,
                              pen.end > 0
                                  ? arrowhead(ends[ends.length - 1]!, ends[ends.length - 2]!, pen, pen.endSize, k)
                                  : null,
                          ]
                        : [];
                for (const head of heads) {
                    if (head) {
                        drawn.paths.push({ style: { fill: pen.color }, steps: null, polygon: head, reach: head });
                    }
                }
            }
        }
        if (shape.words && !leaveOut.has(shape.words)) {
            drawn.texts.push(figureText(shape.words, at, k));
        }
    };
    const walk = (shape: VisioShape, deep: boolean) => {
        if (!shape.front) {
            draw(shape);
        }
        if (deep) {
            shape.members.forEach((member) => walk(member, true));
        }
        if (shape.front) {
            draw(shape);
        }
    };
    shapes.forEach((shape) => walk(shape, !own));
    return drawn;
}

/** Where a text block reaches, about, in Piper's units: for a figure's box. */
function textReach(text: FigureText): Point[] {
    const wide = Math.max(...text.lines.map((line) => line.length)) * text.size * 0.55;
    const tall = text.lines.length * text.size * 1.2;
    if (text.angle) {
        const most = Math.max(wide, tall);
        return [
            { x: text.x - most, y: text.y - most },
            { x: text.x + most, y: text.y + most },
        ];
    }
    const left = text.anchor === "start" ? text.x : text.anchor === "end" ? text.x - wide : text.x - wide / 2;
    return [
        { x: left, y: text.y - text.size },
        { x: left + wide, y: text.y + tall - text.size },
    ];
}

/** A figure of what was drawn: its drawing in its own frame (its middle at 0, 0), and where its middle is. */
function figureFrom(drawn: Drawn, at: Place): { figure: Figure; middle: Point } | null {
    const points = [...drawn.paths.flatMap((path) => path.reach), ...drawn.texts.flatMap(textReach)];
    if (points.length === 0) {
        return null;
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const middle = { x: round((box.x0 + box.x1) / 2), y: round((box.y0 + box.y1) / 2) };
    const local = (point: Point) => `${round(point.x - middle.x)} ${round(point.y - middle.y)}`;
    const data = (path: DrawnPath): string =>
        path.steps
            ? path.steps
                  .map((step) =>
                      step.kind === "move"
                          ? `M${local(at(step.to))}`
                          : step.kind === "line"
                            ? `L${local(at(step.to))}`
                            : step.kind === "curve"
                              ? `C${local(at(step.a))} ${local(at(step.b))} ${local(at(step.to))}`
                              : "Z",
                  )
                  .join("")
            : `M${path.polygon!.map(local).join("L")}Z`;
    return {
        figure: {
            w: Math.max(1, round(box.x1 - box.x0)),
            h: Math.max(1, round(box.y1 - box.y0)),
            paths: drawn.paths.map((path) => ({ d: data(path), ...path.style })),
            texts: drawn.texts.map((text) => ({ ...text, x: round(text.x - middle.x), y: round(text.y - middle.y) })),
            ports: [],
        },
        middle,
    };
}

// --- a page into a drawing -----------------------------------------------------------------------------------------

/** What a page's shape becomes: a part, Piper's text, a figure, or a line (or a figure, if it joins nothing). */
type Item =
    | { kind: "part"; symbol: Symbol }
    | { kind: "text"; shape: VisioShape }
    | { kind: "figure"; shapes: VisioShape[]; own: boolean }
    | { kind: "line"; shape: VisioShape };

/** Whether a group is opened, for what's in it to be placed for itself: it has a symbol in it, or a connector glued. */
function opens(group: VisioShape, facts: Facts): boolean {
    return group.members.some(
        (member) =>
            recognize(member, facts) !== null ||
            (member.oneD && facts.glued.has(member.id)) ||
            (member.kind === "group" && opens(member, facts)),
    );
}

function plan(shape: VisioShape, facts: Facts, items: Item[]): void {
    if (shape.oneD && shape.members.length === 0) {
        items.push({ kind: "line", shape });
        return;
    }
    const symbol = recognize(shape, facts);
    if (symbol) {
        items.push({ kind: "part", symbol });
    } else if (wordsOnly(shape)) {
        // Words, or a group of them (a tag and a set pressure together): each its own, to be a symbol's or stay words.
        everyShape(shape)
            .filter((member) => member.words)
            .forEach((member) => items.push({ kind: "text", shape: member }));
    } else if (shape.kind === "group" && opens(shape, facts)) {
        const own: Item = { kind: "figure", shapes: [shape], own: true };
        if (!shape.front) {
            items.push(own);
        }
        shape.members.forEach((member) => plan(member, facts, items));
        if (shape.front) {
            items.push(own);
        }
    } else {
        items.push({ kind: "figure", shapes: [shape], own: false });
    }
}

/**
 * Tags and set pressures written beside a symbol rather than grouped with it, as Visio's labels often are: each the
 * nearest untagged symbol's (or regulator's, or relief valve's, without one), if it's close enough to be its. A tag
 * beside a small shape drawn by hand says what the shape is, if it says (PNQD a quick disconnect): it's that part.
 */
function attachLabels(items: Item[], facts: Facts): Item[] {
    const symbols = items.flatMap((item) => (item.kind === "part" ? [item.symbol] : []));
    const drawnByHand = items.filter((item): item is Item & { kind: "figure" } => {
        // A drawing alone, without words of its own: what a tag beside it would name.
        if (
            item.kind !== "figure" ||
            item.own ||
            item.shapes.length !== 1 ||
            everyShape(item.shapes[0]!).some((shape) => shape.words)
        ) {
            return false;
        }
        const box = boxOfShape(item.shapes[0]!, false);
        return box !== null && Math.max(box.x1 - box.x0, box.y1 - box.y0) <= facts.symbolSize;
    });
    type Pair = { text: Item & { kind: "text" }; away: number } & (
        { what: "tag" | "set"; symbol: Symbol } | { what: "name"; figure: Item & { kind: "figure" }; preset: string }
    );
    const pairs: Pair[] = [];
    for (const item of items) {
        // A tag is written about as small as a drawing's words are: a bigger one is a title (an inset's "PV-OVNT").
        if (item.kind !== "text" || !item.shape.words || item.shape.words.size > facts.textSize * 1.75) {
            continue;
        }
        const label = labelOf(textOf(item.shape.words), facts.fluids);
        const tag = label?.tag ?? null;
        const what = tag ? "tag" : label?.set ? "set" : null;
        const box = boxOfShape(item.shape);
        if (!what || !box) {
            continue;
        }
        const reach = Math.max(0.15, item.shape.words.size * 2);
        for (const symbol of symbols) {
            const wants =
                what === "tag" ? !symbol.tag : ["regulator", "relief"].includes(presetOf(symbol.preset)?.kind ?? "");
            const body = boxOfShape(symbol.body, false);
            const away = body ? boxGap(box, body) : Infinity;
            if (wants && away <= reach) {
                pairs.push({ text: item, symbol, away, what });
            }
        }
        const preset = tag ? presetForTag(tag) : null;
        for (const figure of preset ? drawnByHand : []) {
            const away = boxGap(box, boxOfShape(figure.shapes[0]!, false)!);
            if (away <= Math.max(0.15, item.shape.words.size * 1.5)) {
                pairs.push({ text: item, figure, preset: preset!, away, what: "name" });
            }
        }
    }
    const used = new Set<Item>();
    const named = new Map<Item, Item>();
    for (const pair of pairs.sort((a, b) => a.away - b.away)) {
        if (used.has(pair.text)) {
            continue;
        }
        const words = pair.text.shape.words!;
        const label = labelOf(textOf(words), facts.fluids)!;
        const set: Record<string, string> = label.set ? { set: label.set } : {};
        if (pair.what === "name") {
            if (!named.has(pair.figure)) {
                const shape = pair.figure.shapes[0]!;
                const symbol = symbolOf(shape, shape, pair.preset, facts, shape.master || cleanName(shape.name));
                named.set(pair.figure, {
                    kind: "part",
                    symbol: { ...symbol, tag: label.tag!, tagWords: words, props: { ...symbol.props, ...set } },
                });
                used.add(pair.text);
            }
        } else if (pair.what === "tag" && !pair.symbol.tag) {
            pair.symbol.tag = label.tag!;
            pair.symbol.tagWords = words;
            pair.symbol.props = { ...pair.symbol.props, ...set };
            used.add(pair.text);
        } else if (pair.what === "set" && !pair.symbol.props.set) {
            pair.symbol.props.set = label.set!;
            used.add(pair.text);
        }
    }
    return items.filter((item) => !used.has(item)).map((item) => named.get(item) ?? item);
}

/**
 * How many of Piper's units to an inch: as many as draw the page's valves as long as Piper's (40), where it has any,
 * else a hundred (which sets a drawing's 8 to 12 point words at about Piper's own sizes).
 */
function scaleOf(items: Item[]): number {
    const valves = items
        .flatMap((item) =>
            item.kind === "part" && presetOf(item.symbol.preset)?.kind === "valve" ? [item.symbol.body.width] : [],
        )
        .filter((width) => width > 0.05)
        .sort((a, b) => a - b);
    const scale = valves.length > 0 ? VALVE_UNITS / valves[Math.floor(valves.length / 2)]! : 100;
    return Math.min(200, Math.max(40, scale));
}

/** A shape's turn and flip as a Piper part's: the quarter turn that puts its frame's foot where it is on the page,
 * and flipped if its frame's x then goes the other way. */
function orientation(shape: VisioShape): { rotation: Rotation; flip: boolean } {
    // On Piper's page y goes down: a frame's down is its y the other way, and the page's y the other way too.
    const down = { x: -shape.axes.y.x, y: shape.axes.y.y };
    const across = { x: shape.axes.x.x, y: -shape.axes.x.y };
    const turns: [Rotation, Point, Point][] = [
        [0, { x: 0, y: 1 }, { x: 1, y: 0 }],
        [90, { x: -1, y: 0 }, { x: 0, y: 1 }],
        [180, { x: 0, y: -1 }, { x: -1, y: 0 }],
        [270, { x: 1, y: 0 }, { x: 0, y: -1 }],
    ];
    const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
    const [rotation, , x] = turns.reduce((best, turn) => (dot(down, turn[1]) > dot(down, best[1]) ? turn : best));
    return { rotation, flip: dot(across, x) < 0 };
}

/** The scale nearest a ratio of the ones a part can be drawn at. */
const nearestScale = (ratio: number): number =>
    PART_SCALES.reduce((best, scale) =>
        Math.abs(Math.log(scale / ratio)) < Math.abs(Math.log(best / ratio)) ? scale : best,
    );

/** The size of Piper's labels nearest a tag's as Visio wrote it (units): small, the diagram's own, or large. */
function labelSizeOf(units: number): "small" | "" | "large" {
    const sizes: [number, "small" | "" | "large"][] = [
        [6.4, "small"],
        [8, ""],
        [10.4, "large"],
    ];
    return sizes.reduce((best, entry) => (Math.abs(entry[0] - units) < Math.abs(best[0] - units) ? entry : best))[1];
}

/** Words Piper's own text can say as Visio set them: dark, not see-through, level or a quarter turned. */
function plainText(words: Words): boolean {
    const quarter = (words.angle / (Math.PI / 2)) % 1;
    const level = Math.abs(quarter) < 0.01 || Math.abs(Math.abs(quarter) - 1) < 0.01;
    const [r, g, b] = rgbOf(words.color);
    return level && !words.background && Math.max(r, g, b) < 0.35;
}

/** What a page's connectors are glued to, how big its words are, and so how big its hand-drawn symbols can be. */
function factsOf(page: VisioPage): Facts {
    const glued = new Map<string, { begin?: string; end?: string }>();
    const gluedTo = new Set<string>();
    for (const glue of page.glue) {
        glued.set(glue.connector, { ...glued.get(glue.connector), [glue.end]: glue.shape });
        gluedTo.add(glue.shape);
    }
    const sizes = page.shapes
        .flatMap(everyShape)
        .flatMap((shape) => (shape.words ? [shape.words.size] : []))
        .sort((a, b) => a - b);
    const textSize = sizes[Math.floor(sizes.length / 2)] ?? 0.12;
    return {
        glued,
        gluedTo,
        textSize,
        symbolSize: Math.max(SYMBOL_INCHES, textSize * 12),
        fluids: fluidsOf(emptyDrawing()),
        memo: new Map(),
    };
}

/** What a shape of the page became, for what's glued to it: a part, a figure, or a line. */
interface Owner {
    part?: string;
    figure?: string;
    line?: string;
}

/** A line route's runs made exactly level or upright where they're nearly so, and its doubled points left out. */
function straighten(points: Point[], tolerance: number): Point[] {
    const out = points.map((point) => ({ ...point }));
    for (let index = 1; index < out.length; index++) {
        const a = out[index - 1]!;
        const b = out[index]!;
        if (Math.abs(b.y - a.y) < tolerance && Math.abs(b.x - a.x) >= tolerance) {
            b.y = a.y;
        } else if (Math.abs(b.x - a.x) < tolerance && Math.abs(b.y - a.y) >= tolerance) {
            b.x = a.x;
        }
    }
    return simplify(out);
}

const orthogonalRoute = (points: Point[]): boolean =>
    points.every(
        (point, index) =>
            index === 0 ||
            Math.abs(point.x - points[index - 1]!.x) < 1e-6 ||
            Math.abs(point.y - points[index - 1]!.y) < 1e-6,
    );

/** Visio's connectors' names, and what kind of line each is. */
const LINE_NAMES: [RegExp, LineKind][] = [
    [/pneumatic/, "pneumatic"],
    [/electric/, "electric"],
    [/data|software|signal|capillary|instrument/, "signal"],
    [/hose|flexible/, "hose"],
    [/secondary|minor|tube|tubing/, "tube"],
];

const CONNECTOR = /connector|pipe|pipeline|process|flow line/i;

/** Visio's basic shapes' masters: what a figure drawn with one is says nothing about what it is. */
const BASIC_SHAPES =
    /^(rectangle|square|circle|ellipse|triangle|rotated triangle|rounded rectangle|round corner rectangle|trapezoid|parallelogram|diagonal stripe|line|text|sheet|dynamic connector)$/i;

function pageDrawing(page: VisioPage, title: string): { drawing: Drawing; report: ImportReport } {
    const facts = factsOf(page);
    const key = keyOf(page, facts);
    const report: ImportReport = { page: title, parts: 0, lines: 0, notes: 0, figures: 0, drawn: [], dropped: 0 };
    let items: Item[] = [];
    const keyShapes = page.shapes.filter((shape) => key.shapes.has(shape.id));
    for (const shape of page.shapes) {
        if (!key.shapes.has(shape.id)) {
            plan(shape, facts, items);
        } else if (shape === keyShapes[0]) {
            items.push({ kind: "figure", shapes: keyShapes, own: false }); // the key, drawn as one
        }
    }
    items = attachLabels(items, facts);
    const k = scaleOf(items);
    const at: Place = (point) => ({ x: point.x * k, y: (page.height - point.y) * k });

    let drawing = emptyDrawing();
    const owners = new Map<string, Owner>();
    const owned = (shapes: VisioShape[], owner: Owner, deep = true) => {
        for (const shape of deep ? shapes.flatMap(everyShape) : shapes) {
            owners.set(shape.id, owner);
        }
    };
    // Where lines meet each symbol (glued to it, or ending on it): an in-line part goes on them, along their way.
    const lineEnds = items.flatMap((item) => {
        if (item.kind !== "line") {
            return [];
        }
        const glue = facts.glued.get(item.shape.id) ?? {};
        return [
            { point: item.shape.begin, glued: glue.begin },
            { point: item.shape.end, glued: glue.end },
        ].flatMap((end) => (end.point ? [{ point: end.point, glued: end.glued }] : []));
    });
    const endsAt = (symbol: Symbol): Point[] => {
        const ids = new Set(everyShape(symbol.shape).map((shape) => shape.id));
        const box = boxOfShape(symbol.body, false);
        const near = 0.08;
        return lineEnds
            .filter((end) =>
                end.glued
                    ? ids.has(end.glued)
                    : box !== null &&
                      end.point.x >= box.x0 - near &&
                      end.point.x <= box.x1 + near &&
                      end.point.y >= box.y0 - near &&
                      end.point.y <= box.y1 + near,
            )
            .map((end) => at(end.point));
    };
    const textPart = (words: Words): void => {
        const lines = words.lines.map((line) => line.trim());
        const size = words.size * k;
        const extent = linesOf(words);
        const placed =
            extent.length > 0
                ? at({
                      x: (Math.min(...extent.map((line) => line.x0)) + Math.max(...extent.map((line) => line.x1))) / 2,
                      y: (extent[0]!.y + extent[extent.length - 1]!.y) / 2,
                  })
                : at(words.at);
        const turns = Math.round((-words.angle * 2) / Math.PI);
        const part = newPart("text", placed, {
            text: lines.join("\n"),
            rotation: ((((turns % 4) + 4) % 4) * 90) as Rotation,
            props: {
                ...(size <= 11.5
                    ? { size: "small" }
                    : size <= 15
                      ? {}
                      : size <= 20.5
                        ? { size: "large" }
                        : { size: "title" }),
                ...(words.bold ? { weight: "bold" } : {}),
                ...(words.italic ? { slant: "italic" } : {}),
                ...(familyOf(words.font) ? { font: familyOf(words.font)! } : {}),
                ...(lines.length > 1 && words.align !== "center" ? { align: words.align } : {}),
            },
        });
        if (lines.length > 1 && words.align !== "center") {
            // A block of its own width, as Visio's was, for its lines to line up at its side.
            const widest = Math.max(...lines.map((line) => line.length)) * 0.6 * Math.max(10, size) + 12;
            part.w = Math.ceil(Math.max(widest, words.width * k) / 10) * 10;
            part.h = Math.ceil((lines.length * Math.max(10, size) * 1.25 + 8) / 10) * 10;
        }
        drawing = { ...drawing, parts: [...drawing.parts, part] };
        report.notes += 1;
    };
    const figurePart = (shapes: VisioShape[], own: boolean): string | null => {
        const box = shapes.length === 1 && !own ? boxOfShape(shapes[0]!, false) : null;
        const small = box !== null && Math.max(box.x1 - box.x0, box.y1 - box.y0) <= facts.symbolSize;
        // A symbol Piper has no part for, tagged beside it (by words alone, not a box's own words): its tag is
        // Piper's, written where it was.
        const tagged = small
            ? shapes
                  .flatMap(everyShape)
                  .filter((shape) => wordsOnly(shape) && shape.words && tagOf(textOf(shape.words), facts.fluids))
            : [];
        const tagShape = tagged.length === 1 ? tagged[0]! : null;
        const made = figureFrom(drawnOf(shapes, at, k, own, new Set(tagShape?.words ? [tagShape.words] : [])), at);
        if (!made) {
            return null;
        }
        const words = shapes
            .flatMap((shape) => (own ? [shape] : everyShape(shape)))
            .map((shape) => textOf(shape.words))
            .filter(Boolean);
        const tag = tagShape ? tagOf(textOf(tagShape.words), facts.fluids)! : "";
        const part = newPart("figure", made.middle, {
            w: made.figure.w,
            h: made.figure.h,
            tag,
            text: words.join("\n"),
            props: { figure: JSON.stringify(made.figure) },
        });
        if (tagShape?.words) {
            const where = at(tagShape.words.at);
            part.label = { x: round(where.x - part.x), y: round(where.y - part.y + 8 * 0.35) };
            part.labelSize = labelSizeOf(tagShape.words.size * k);
        }
        drawing = { ...drawing, parts: [...drawing.parts, part] };
        owned(shapes, { figure: part.id }, !own);
        report.figures += 1;
        const name = shapes[0]?.master ?? "";
        const named = name !== "" && !BASIC_SHAPES.test(name);
        if (small && (tag || named)) {
            report.drawn.push(named && tag ? `${name} (${tag})` : tag || name);
        }
        return part.id;
    };

    // Each part in Visio's order (a figure over what's under it), whenever it's made: the order of what it was made of.
    const layer = new Map<string, number>();
    const stamp = (index: number) => {
        for (const part of drawing.parts) {
            if (!layer.has(part.id)) {
                layer.set(part.id, index);
            }
        }
    };
    const itemIndex = new Map(items.map((item, index) => [item, index]));
    for (const item of items) {
        if (item.kind === "text") {
            const words = item.shape.words!;
            if (plainText(words)) {
                textPart(words);
            } else {
                figurePart([item.shape], false);
            }
        } else if (item.kind === "figure") {
            figurePart(item.shapes, item.own);
        } else if (item.kind === "part") {
            const id = placeSymbol(item.symbol);
            if (id) {
                owned([item.symbol.shape], { part: id });
                report.parts += 1;
            }
        }
        stamp(itemIndex.get(item)!);
    }

    function placeSymbol(symbol: Symbol): string | null {
        const preset = presetOf(symbol.preset);
        const box = boxOfShape(symbol.body, false);
        if (!preset || !box) {
            return null;
        }
        const kind = kindOf(preset.kind);
        const upright = ["instrument", "gauge", "junction"].includes(kind.id);
        let { rotation, flip } = upright ? { rotation: 0 as Rotation, flip: false } : orientation(symbol.body);
        // In the middle of its frame (its outline may be only part of it: a stencil's actuator, or a tank's foot).
        let center = at(symbol.body.width > 0 && symbol.body.height > 0 ? symbol.body.middle : middleOf(box));
        if (kind.inline) {
            // On its line. Turned as its frame is, unless none of its lines meet it along that way and some do across it
            // (a symbol drawn by hand is turned however it was drawn, and stencils draw some standing up); and across
            // its way where those lines met it, and along it between them, where they met it each side (not where an
            // actuator's air line met its box).
            const points = endsAt(symbol);
            const level = (point: Point) => Math.abs(point.x - center.x) >= Math.abs(point.y - center.y);
            if (points.length > 0 && !points.some((point) => level(point) === (rotation === 0 || rotation === 180))) {
                rotation = rotation === 0 || rotation === 180 ? 90 : 0;
                flip = false;
            }
            const across = rotation === 0 || rotation === 180;
            const onWay = points.filter((point) => level(point) === across);
            const sideways = onWay.map((point) => (across ? point.y : point.x)).sort((a, b) => a - b);
            if (sideways.length > 0) {
                const middle = sideways[Math.floor(sideways.length / 2)]!;
                center = across ? { x: center.x, y: middle } : { x: middle, y: center.y };
            }
            const along = onWay.map((point) => (across ? point.x : point.y));
            const here = across ? center.x : center.y;
            if (along.length >= 2 && Math.min(...along) < here && Math.max(...along) > here) {
                const middle = (Math.min(...along) + Math.max(...along)) / 2;
                center = across ? { x: middle, y: center.y } : { x: center.x, y: middle };
            }
        }
        const added = addPart(drawing, preset, center, true);
        drawing = updatePart(added.drawing, added.id, (part) => {
            const [x0, y0, x1, y1] = kind.box({ ...part, rotation: 0, scale: 1 }, drawing);
            // As big as it was drawn (its outline, not its words), of its kind's own size.
            const drawnSize = Math.max(box.x1 - box.x0, box.y1 - box.y0) * k;
            const scale = kind.id === "junction" ? 1 : nearestScale(drawnSize / Math.max(1, x1 - x0, y1 - y0));
            // Its normal state as the drawing's key says its fill means, else not set: a preset's own (a solenoid
            // valve's NC) is no more than a guess the drawing didn't make.
            const normal = symbol.fill && kind.state ? (key.states.get(symbol.fill) ?? "") : "";
            // Its tag where it was written, unless that was in it (an instrument's in its bubble): Piper writes it
            // beside it, as its kind does.
            const written = symbol.tagWords?.at;
            const inside =
                written !== undefined &&
                written.x > box.x0 &&
                written.x < box.x1 &&
                written.y > box.y0 &&
                written.y < box.y1;
            const tagAt = written && !inside ? at(written) : null;
            return {
                ...part,
                rotation,
                flip,
                scale,
                tag: symbol.tag,
                props: { ...part.props, ...symbol.props, ...(kind.state ? { normal } : {}) },
                labelSize: tagAt ? labelSizeOf(symbol.tagWords!.size * k) : "",
                shown: part.shown.filter((key) => (symbol.props[key] ?? part.props[key] ?? "") !== ""),
                label: tagAt ? { x: round(tagAt.x - part.x), y: round(tagAt.y - part.y + 8 * 0.35) } : null,
            };
        });
        // Its words that say nothing Piper knows stay beside it.
        for (const words of symbol.words) {
            if (plainText(words)) {
                textPart(words);
            }
        }
        return added.id;
    }

    // --- lines ---
    const lineItems = items.flatMap((item) => (item.kind === "line" ? [item.shape] : []));
    const routes = new Map(
        lineItems.map((shape) => {
            const outline = shape.outlines.find((entry) => entry.stroked) ?? shape.outlines[0];
            const points = (outline?.steps ?? []).flatMap((step) => (step.kind === "close" ? [] : [at(step.to)]));
            if (shape.begin) {
                points[0] = at(shape.begin);
            }
            if (shape.end && points.length > 1) {
                points[points.length - 1] = at(shape.end);
            }
            return [shape.id, straighten(points, Math.max(0.6, 0.006 * k))] as const;
        }),
    );
    const near = Math.max(4, 0.06 * k); // how near an end has to be to something to be on it
    const portNear = (point: Point): { part: string; port: string } | null => {
        let best: { part: string; port: string; away: number } | null = null;
        for (const part of drawing.parts) {
            if (part.kind === "figure" || part.kind === "text") {
                continue;
            }
            for (const port of portsOf(part)) {
                const away = distance(port.at, point);
                if (away <= near && (!best || away < best.away)) {
                    best = { part: part.id, port: port.id, away };
                }
            }
        }
        return best;
    };
    // Lines: glued, a connector, or colored or ending on a part's port, and level and upright where they're not glued.
    const pipes = lineItems.filter((shape) => {
        const route = routes.get(shape.id) ?? [];
        const glue = facts.glued.get(shape.id);
        if (route.length < 2) {
            return false;
        }
        if (glue?.begin || glue?.end) {
            // Glued, it's a pipe: drawn level and upright, or, slanted, glued to a part (not a vehicle's outline,
            // glued to its nose).
            return (
                orthogonalRoute(route) ||
                [glue.begin, glue.end].some((id) => id !== undefined && owners.get(id)?.part !== undefined)
            );
        }
        // Joined to nothing, a line is a pipe drawn level and upright (Piper's are): a connector's, one colored for what
        // it carries, or one ending on a part's port. Else it's drawing (a vehicle's outline, a border).
        return (
            orthogonalRoute(route) &&
            (CONNECTOR.test(shape.master) ||
                (shape.pen !== null && colored(shape.pen.color)) ||
                portNear(route[0]!) !== null ||
                portNear(route[route.length - 1]!) !== null)
        );
    });
    const lineIndex = new Map(
        items.flatMap((item, index) => (item.kind === "line" ? [[item.shape, index] as const] : [])),
    );
    for (const shape of lineItems.filter((entry) => !pipes.includes(entry))) {
        if ((routes.get(shape.id) ?? []).length >= 2 || shape.outlines.length > 0) {
            figurePart([shape], false);
            stamp(lineIndex.get(shape)!);
        } else {
            report.dropped += 1;
        }
    }

    const fluidFor = new Map<string, string>(); // a color: the fluid made for lines in it
    const fluidOfColor = (color: string): string => {
        const made = fluidFor.get(color);
        if (made !== undefined) {
            return made;
        }
        const keyColor = keyColorOf(color, [...key.fluids.keys()]);
        const said = keyColor ? key.fluids.get(keyColor) : undefined;
        const fluids = fluidsOf(drawing);
        let id = "";
        if (said && keyColor && keyColor !== color) {
            id = fluidOfColor(keyColor); // a shade of a key's color: the key's fluid
        } else if (said) {
            // What the key calls it: a standard fluid if it names one no other color's lines are said to carry, else a
            // fluid of the diagram's own, named as the key names it, in its color.
            const standard = fluidNamed(said, fluids);
            const shared = [...key.fluids.entries()].filter(
                ([other, text]) => other !== color && fluidNamed(text, fluids) === standard,
            );
            const label = /\(([^)]{1,12})\)/.exec(said)?.[1]?.trim() ?? "";
            if (standard && shared.length === 0) {
                const base = fluids.find((fluid) => fluid.id === standard)!;
                id = standard;
                drawing = { ...drawing, fluids: [...drawing.fluids.filter((f) => f.id !== id), { ...base, color }] };
            } else {
                id = newFluidId(drawing, said);
                const gas = standard ? fluids.find((fluid) => fluid.id === standard)?.gas : undefined;
                drawing = {
                    ...drawing,
                    fluids: [
                        ...drawing.fluids,
                        { id, name: said, label: label || said, color, ...(gas !== undefined ? { gas } : {}) },
                    ],
                };
            }
        } else if (colored(color)) {
            // A drawing that colors its lines by what they carry: a fluid of the diagram's own for each color, named
            // after it, to be renamed for what it is.
            const name = `${colorName(color)} lines`;
            id = newFluidId(drawing, name);
            drawing = { ...drawing, fluids: [...drawing.fluids, { id, name, label: "", color }] };
        }
        fluidFor.set(color, id);
        return id;
    };
    /** What a key says a line drawn so is: the size (and what it's of) of the line it draws like it, if any. */
    const sizeOfLook = (pen: Pen): { size: string; material: string } | null => {
        const ratio = (weight: number) => Math.abs(Math.log((weight + 1e-3) / (pen.weight + 1e-3)));
        const nearest = key.sizes
            .filter((entry) => entry.pattern === pen.pattern)
            .sort((a, b) => ratio(a.weight) - ratio(b.weight))[0];
        return nearest && ratio(nearest.weight) < Math.log(1.6) ? nearest : null;
    };

    // Each line's ends: on a part's port, a figure's (made where it was glued), another line (a tee), or a point.
    const figurePort = (figureId: string, point: Point, next: Point | undefined): { part: string; port: string } => {
        const part = drawing.parts.find((entry) => entry.id === figureId)!;
        const figure = figureOf(part);
        const local = { x: round(point.x - part.x), y: round(point.y - part.y) };
        const same = figure.ports.find((port) => Math.abs(port.x - local.x) < 0.5 && Math.abs(port.y - local.y) < 0.5);
        if (same) {
            return { part: part.id, port: same.id };
        }
        const dir: Dir | null = next ? dirOf(point, next) : null;
        const port = { id: `p${figure.ports.length + 1}`, ...local, dir };
        const changed = { ...figure, ports: [...figure.ports, port] };
        drawing = updatePart(drawing, part.id, (entry) => ({
            ...entry,
            props: { ...entry.props, figure: JSON.stringify(changed) },
        }));
        return { part: part.id, port: port.id };
    };
    const freePort = (partId: string, point: Point, avoid: End | null): { part: string; port: string } | null => {
        const part = drawing.parts.find((entry) => entry.id === partId);
        if (!part) {
            return null;
        }
        const taken = new Set(
            drawing.lines.flatMap((line) =>
                [line.from, line.to].flatMap((end) => ("part" in end && end.part === partId ? [end.port] : [])),
            ),
        );
        const ports = portsOf(part);
        const best = ports
            .map((port) => {
                // A free port before one taken, and not the one its other end is on.
                const busy =
                    (taken.has(port.id) && !port.many) ||
                    (avoid !== null && "part" in avoid && avoid.part === partId && avoid.port === port.id);
                return { port, score: distance(port.at, point) + (busy ? 30 : 0) };
            })
            .sort((a, b) => a.score - b.score)[0];
        return best ? { part: partId, port: best.port.id } : null;
    };
    const lineIds = new Map<string, string[]>(); // a connector: the lines it became (one, or more if it was split)
    const endOf = (
        point: Point,
        gluedTo: string | undefined,
        next: Point | undefined,
        self: string,
        other: End | null,
    ): End => {
        const owner = gluedTo ? owners.get(gluedTo) : undefined;
        if (owner?.part) {
            return freePort(owner.part, point, other) ?? point;
        }
        if (owner?.figure) {
            return figurePort(owner.figure, point, next);
        }
        const onLine = owner?.line ? owner.line : null;
        const tee = (lineId: string | null): End | null => {
            const candidates = lineId
                ? (lineIds.get(lineId) ?? [])
                : [...lineIds.entries()].filter(([id]) => id !== self).flatMap(([, ids]) => ids);
            const parts = partsById(drawing);
            let best: { line: string; away: number } | null = null;
            for (const id of candidates) {
                const line = drawing.lines.find((entry) => entry.id === id);
                const from = line ? placeEnd(parts, line.from) : null;
                const to = line ? placeEnd(parts, line.to) : null;
                if (!line || !from || !to) {
                    continue;
                }
                const found = nearestOnPolyline(point, [from.at, ...line.points, to.at]);
                if (
                    found &&
                    found.distance <= (lineId ? near * 2 : near / 2) &&
                    (!best || found.distance < best.away)
                ) {
                    best = { line: id, away: found.distance };
                }
            }
            if (!best) {
                return null;
            }
            const was = new Set(drawing.lines.map((line) => line.id));
            const split = splitLine(drawing, best.line, point);
            if (!split) {
                return null;
            }
            drawing = split.drawing;
            // The line's second half is a line of its own now, the connector's too: a later tee may be on it.
            const owner = [...lineIds.entries()].find(([, ids]) => ids.includes(best!.line));
            const added = split.drawing.lines.find((line) => !was.has(line.id));
            if (owner && added) {
                lineIds.set(owner[0], [...owner[1], added.id]);
            }
            return { part: split.junction, port: "c" };
        };
        if (onLine) {
            return tee(onLine) ?? point;
        }
        if (!gluedTo) {
            const port = portNear(point);
            if (port) {
                return port;
            }
            const teed = tee(null);
            if (teed) {
                return teed;
            }
            // On a figure's outline: a port of its own there.
            for (const part of drawing.parts) {
                if (part.kind !== "figure") {
                    continue;
                }
                const box = {
                    x0: part.x - part.w / 2,
                    y0: part.y - part.h / 2,
                    x1: part.x + part.w / 2,
                    y1: part.y + part.h / 2,
                };
                const onEdge =
                    point.x >= box.x0 - 1 &&
                    point.x <= box.x1 + 1 &&
                    point.y >= box.y0 - 1 &&
                    point.y <= box.y1 + 1 &&
                    Math.min(
                        Math.abs(point.x - box.x0),
                        Math.abs(point.x - box.x1),
                        Math.abs(point.y - box.y0),
                        Math.abs(point.y - box.y1),
                    ) <= 1.5;
                if (onEdge) {
                    return figurePort(part.id, point, next);
                }
            }
        }
        return point;
    };

    // Lines glued to other lines after those they're glued to.
    const onLines = (shape: VisioShape) => {
        const glue = facts.glued.get(shape.id) ?? {};
        return [glue.begin, glue.end].some((id) => id && pipes.some((other) => other.id === id));
    };
    const ordered = [...pipes.filter((shape) => !onLines(shape)), ...pipes.filter(onLines)];
    for (const shape of ordered) {
        const route = routes.get(shape.id)!;
        const glue = facts.glued.get(shape.id) ?? {};
        const from = endOf(route[0]!, glue.begin, route[1], shape.id, null);
        const to = endOf(route[route.length - 1]!, glue.end, route[route.length - 2], shape.id, from);
        const parts = partsById(drawing);
        const fromPlaced = placeEnd(parts, from);
        const toPlaced = placeEnd(parts, to);
        if (
            !fromPlaced ||
            !toPlaced ||
            ("part" in from && "part" in to && from.part === to.part && from.port === to.port)
        ) {
            // Nowhere for it to go as a line of Piper's (both its ends on the one port): drawn as it was.
            figurePart([shape], false);
            continue;
        }
        const points = follow(route, fromPlaced, toPlaced, obstacles(drawing));
        const name = shape.master.toLowerCase();
        const pen = shape.pen;
        const look = pen ? sizeOfLook(pen) : null;
        // What kind of line it is, as its master's name says: dashes alone say nothing a key doesn't (a drawing's
        // dashed lines can be its smaller tubing, or its pressurant's).
        const kind: LineKind = LINE_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? "pipe";
        const text = textOf(shape.words);
        const fluids = fluidsOf(drawing);
        // What it carries: what its words say, else what a tank it's drawn from holds (from its top, its ullage: not
        // its liquid), else what the key says lines in its color carry, else its color's.
        const held = (end: End): string => {
            if (!isPortEnd(end)) {
                return "";
            }
            const part = drawing.parts.find((entry) => entry.id === end.part);
            const holds = part?.props.fluid ?? "";
            const vessel = part !== undefined && kindOf(part.kind).fields.some((field) => field.key === "fluid");
            return vessel && holds && !(end.port === "top" && !isGas(drawing, holds)) ? holds : "";
        };
        const fluid = fluidNamed(text, fluids) || held(from) || held(to) || (pen ? fluidOfColor(pen.color) : "");
        // Its words: its tag (L-101), its size (1/2 in), the fluid it carries, or else notes.
        const tag = tagIn(text);
        const said = sizeIn(text);
        const rest = !tag && !said && text && !fluidNamed(text, fluids) ? text : "";
        const line = newLine(from, to, {
            points,
            auto: false,
            kind,
            fluid,
            tag: tag ?? "",
            arrow: pen && pen.end > 0 ? "forward" : pen && pen.begin > 0 ? "backward" : "none",
            shown: [...(tag ? ["tag"] : []), ...(said ? ["size"] : [])],
            props: {
                ...(said || look ? { size: said ?? look!.size } : {}),
                ...(look?.material ? { material: look.material } : {}),
                ...(rest ? { notes: rest } : {}),
            },
        });
        drawing = { ...drawing, lines: [...drawing.lines, line] };
        lineIds.set(shape.id, [line.id]);
        owners.set(shape.id, { line: shape.id });
        report.lines += 1;
    }
    stamp(Infinity);
    drawing = {
        ...drawing,
        parts: drawing.parts
            .map((part, index) => ({ part, index }))
            .sort((a, b) => layer.get(a.part.id)! - layer.get(b.part.id)! || a.index - b.index)
            .map(({ part }) => part),
    };
    report.drawn = [...new Set(report.drawn)].sort();
    return { drawing, report };
}

// --- the file ------------------------------------------------------------------------------------------------------

/** What's in a Visio drawing: each of its pages (but its backgrounds), as a drawing. */
export async function readVisio(file: Blob, fileName: string): Promise<ImportedPage[]> {
    const pages = await readVsdx(file, fileName);
    if (pages.length === 0) {
        throw new VisioError(`${fileName} has no pages Piper could read.`);
    }
    const base = visioName(fileName);
    return pages.map((page) => {
        const { drawing, report } = pageDrawing(page, page.name);
        return { name: pages.length > 1 ? `${base} - ${page.name}` : base, page: page.name, drawing, report };
    });
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
    return { format: 4, pages, fluids, style: imported[0]?.drawing.style ?? emptyDrawing().style };
}
