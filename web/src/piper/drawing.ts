// A diagram's drawing: its pages, each with its parts and the lines between them (and where its printed sheet sits),
// and the fluids, style, and simulation's units they share. Plain JSON: the server keeps it as it's sent
// (server/src/yjsp_server/piper/schemas.py checks its shape), and readDocument reads it back, filling in what an older
// drawing didn't have (one from before pages is a page of its own), so a drawing never has to be upgraded on the
// server. Its format says what a Piper must know to keep all of it: 2 pages, 3 parts' and lines' simulation settings,
// 4 parts' links.
//
// The editor works on a page at a time: a Drawing, its parts and lines with the fluids and style (pageOf), which is
// what every change (edit.ts) and what's drawn (DiagramView) takes; withPage puts it back in its document.

export interface Point {
    x: number;
    y: number;
}

/** A quarter turn at a time, clockwise, as SVG turns. */
export type Rotation = 0 | 90 | 180 | 270;

export interface Part {
    id: string;
    kind: string; // its kind in the library (library/index.ts): "valve", "tank", "instrument"...
    x: number; // its center
    y: number;
    rotation: Rotation;
    flip: boolean; // mirrored left to right, before it's turned
    tag: string; // its name on the drawing: "PT-101", "MOV-OX"
    props: Record<string, string>; // its properties, as text with their units ("0.062 in"), by key
    shown: string[]; // the properties shown under its tag, by key
    label: Point | null; // where its tag sits, from its center; null: where its kind puts it
    text: string; // what a note, a region, or an off-page connector says
    w: number; // a region's or a box's size, or a text block's set one (0 for everything else)
    h: number;
    scale: number; // how big it's drawn, of its kind's size: within PART_SCALE (1, its own)
    labelSize: number | null; // its tag's and properties' size, of the standard (LABEL_SCALE); null: the diagram's
    sim?: PartSim; // what it is in the diagram's simulation, if that's been set: left out, as its kind makes it
    links?: PartLink[]; // pages about it, opened from it: left out, none
}

/** A link on a part, to a page about it: its Notion page, its spec sheet, someone to ask. */
export interface PartLink {
    label: string; // what it's called ("Notion", "Spec sheet"); "": its address says
    url: string; // http, https, or mailto only (linkUrl), as the server checks it
}

/** The most links a part has, and how long a link's name and address can be, as the server checks them. */
export const MAX_LINKS = 20;
export const MAX_LINK_LABEL = 200;
export const MAX_LINK_URL = 2000;

/**
 * A link's address, if a part can have it: http or https to a host, or mailto to someone, without spaces or control
 * characters; else null. Never javascript: or data:, which would run in the site when someone opened it from the part.
 * The server checks the same (piper/schemas.py), and reading a drawing leaves out what isn't.
 */
export function linkUrl(text: string): string | null {
    const url = text.trim();
    if (!url || url.length > MAX_LINK_URL || /[\s\u0000-\u001f\u007f-\u009f]/.test(url)) {
        return null;
    }
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    if (scheme === "mailto") {
        return url.length > "mailto:".length ? url : null;
    }
    // Its host after the two slashes, as the server reads it: a browser would read "https:host" as a host too.
    if ((scheme !== "http" && scheme !== "https") || !/^https?:\/\/[^/?#]/i.test(url)) {
        return null;
    }
    try {
        return new URL(url).hostname ? url : null;
    } catch {
        return null;
    }
}

/** What a link without a name of its own is called: its host and path ("notion.so/yjsp/FMV"), or its email address. */
export function linkName(url: string): string {
    if (/^mailto:/i.test(url)) {
        return url.slice("mailto:".length);
    }
    try {
        const parsed = new URL(url);
        return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch {
        return url;
    }
}

/** Settings in the simulation, in SI units, by the keys of Yorg's system models' catalog (sim/api.ts). */
export type SimValues = Record<string, number | string>;

/**
 * What a part is in the diagram's simulation (Simulation mode, sim/model.ts): its settings there, and, where its kind
 * could be more than one thing in the model (a bottle: a gas supply, or a vessel that blows down), which. What's left
 * out is as its kind and the P&ID make it, at the catalog's defaults.
 */
export interface PartSim {
    as: string; // "": what its kind makes it; else one of sim/model.ts's ROLES
    settings: SimValues;
    // Its channel kept out of the simulation (a valve's command, an instrument's reading): what it would set is the
    // settings' instead, your own conditions. Without it, its channel's in, where the test has it.
    unlinked?: boolean;
}

/** How big a part can be drawn, of its kind's own: a quarter (where its ports are still a grid apart) to four times. */
export const PART_SCALE = { min: 0.25, max: 4 } as const;

/** How big what's written beside parts and on lines can be, of its standard size (labels.ts): half to three times. */
export const LABEL_SCALE = { min: 0.5, max: 3 } as const;

const within = (value: number, { min, max }: { min: number; max: number }): number =>
    Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;

/** A size a part can be drawn at: within PART_SCALE, to the hundredth. */
export const partScale = (value: number): number => within(value, PART_SCALE);

/** A size labels can be: within LABEL_SCALE, to the hundredth. */
export const labelScale = (value: number): number => within(value, LABEL_SCALE);

/** The sizes labels could be before they were numbers, as numbers. */
const NAMED_LABEL_SIZES: Record<string, number> = { small: 0.8, normal: 1, large: 1.3 };

/** A label size as it was saved: a number, or a name from before numbers; null if it's neither. */
function readLabelSize(value: unknown): number | null {
    const size = typeof value === "string" ? NAMED_LABEL_SIZES[value] : value;
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? labelScale(size) : null;
}

/** Where a line ends: on a part's port, or at a point of its own. */
export type End = { part: string; port: string } | Point;

export type LineKind = "pipe" | "tube" | "hose" | "pneumatic" | "electric" | "signal";

export const LINE_KINDS: { value: LineKind; label: string }[] = [
    { value: "pipe", label: "Pipe" },
    { value: "tube", label: "Tubing" },
    { value: "hose", label: "Flex hose" },
    { value: "pneumatic", label: "Pneumatic signal" },
    { value: "electric", label: "Electrical signal" },
    { value: "signal", label: "Data link" },
];

/** Which way a line's arrows point: from its first end to its second (forward), or back. */
export type Arrow = "none" | "forward" | "backward";

export interface Line {
    id: string;
    from: End;
    to: End;
    points: Point[]; // its bends, between its ends
    auto: boolean; // routed for itself (route.ts), so routed again when an end moves; false once routed by hand
    tag: string;
    fluid: string; // a fluid's id (fluids.ts), or "" for none
    kind: LineKind;
    arrow: Arrow;
    props: Record<string, string>; // size, wall, material, length...
    shown: string[]; // what its label shows: "tag", "fluid", and property keys
    sim?: LineSim; // what it is in the diagram's simulation, if that's been set
}

/**
 * A line in the diagram's simulation: a liquid line modeled as a line (its friction and its liquid's inertia), with its
 * settings; and the settings of the gas node its lines make between gas parts (tubing, with its volume and what it
 * holds at the start), which each of them keeps a copy of.
 */
export interface LineSim {
    line: SimValues | null; // null: not modeled as a line, so its two ends are one point in the model
    node: SimValues;
}

/** A fluid lines carry: a standard one (fluids.ts), changed by the diagram, or one of its own. */
export interface Fluid {
    id: string;
    name: string; // "Liquid oxygen"
    label: string; // what's written on its lines: "LOX"
    color: string; // #rrggbb
    gas?: boolean; // a tank of it is full of it; left out, a standard fluid's own (fluids.ts), else a liquid
}

export interface Style {
    no: string; // normally open valves' color: "" for the standard one
    nc: string; // normally closed valves'
    fip: string; // fail-in-place (double-acting) valves'
    labels: number; // how big what's written beside parts and on lines is, of its standard size (labels.ts)
    // The team's color scheme its colors were taken from (fluids.ts applyScheme), by id, and when that scheme had
    // last changed then, to see it's changed since. "": none.
    scheme: string;
    schemeAt: string;
}

/**
 * The diagram's simulation, shared by its pages: the units its settings are shown in, with pressures above the
 * atmosphere (gauge) or not; and so how a test's channels without units, or in psi, are read.
 */
export interface SimUnits {
    units: "us" | "si";
    gauge: boolean;
    ambient: number; // Pa: the atmosphere, for gauge pressures
}

export const STANDARD_SIM_UNITS: SimUnits = { units: "us", gauge: true, ambient: 101325 };

/** A page as it'd be printed: on a paper, turned its way, its top left at a point of the page, so many points to a
 * unit. The canvas shows its outline; a PDF prints the page there, as it shows. */
export interface PageSheet {
    paper: string; // a paper's id (pdf.ts PAPERS): "tabloid", "letter", "ansi-d", "a3", "a4"
    landscape: boolean;
    x: number; // the paper's top left, in the page's units
    y: number;
    scale: number; // points of paper to a unit of the page
}

export interface Page {
    id: string;
    name: string; // "P&ID", "GSE", "Sheet 2"
    parts: Part[];
    lines: Line[];
    sheet: PageSheet | null; // where it's printed, if it's been set: else a PDF fits it to its paper
}

/** A diagram's drawing as it's saved: its pages, and the fluids, style, and simulation's units all of them share. */
export interface Document {
    format: 4;
    pages: Page[];
    fluids: Fluid[]; // the diagram's own fluids, and its changes to the standard ones (by id)
    style: Style;
    sim?: SimUnits; // left out: STANDARD_SIM_UNITS
}

/** A page of a drawing, as the editor works on it: its parts and lines, with the fluids and style it shares. */
export interface Drawing {
    format: 1;
    parts: Part[];
    lines: Line[];
    fluids: Fluid[]; // the diagram's own fluids, and its changes to the standard ones (by id)
    style: Style;
    sheet?: PageSheet | null; // its page's printed sheet, if it's in a document
    sim?: SimUnits; // its document's simulation's units, if they've been set
    // The tags on the diagram's other pages, not saved with it: a part placed here is numbered after them, and a tag
    // taken there is said to be (pageOf fills it in).
    elsewhere?: string[];
}

export const STANDARD_STYLE: Style = { no: "", nc: "", fip: "", labels: 1, scheme: "", schemeAt: "" };

export const emptyDrawing = (): Drawing => ({
    format: 1,
    parts: [],
    lines: [],
    fluids: [],
    style: { ...STANDARD_STYLE },
});

export const isPortEnd = (end: End): end is { part: string; port: string } => "part" in end;

/** A document of one page, from a page's drawing: a new diagram's, or one from before pages. */
export function documentOf(drawing: Drawing, name = "Page 1"): Document {
    return {
        format: 4,
        pages: [{ id: newId("g"), name, parts: drawing.parts, lines: drawing.lines, sheet: drawing.sheet ?? null }],
        fluids: drawing.fluids,
        style: drawing.style,
        ...(drawing.sim ? { sim: drawing.sim } : {}),
    };
}

export const emptyDocument = (): Document => documentOf(emptyDrawing());

/** A page of a document, as a drawing to work on (the last, if there's no such page). */
export function pageOf(document: Document, index: number): Drawing {
    const page = document.pages[Math.min(Math.max(0, index), document.pages.length - 1)]!;
    return {
        format: 1,
        parts: page.parts,
        lines: page.lines,
        fluids: document.fluids,
        style: document.style,
        sheet: page.sheet,
        ...(document.sim ? { sim: document.sim } : {}),
        elsewhere: document.pages
            .filter((other) => other !== page)
            .flatMap((other) => other.parts.map((part) => part.tag).filter(Boolean)),
    };
}

/** A document with a page's drawing put back: its parts, lines, and sheet, and the fluids, style, and simulation's
 * units all share. */
export function withPage(document: Document, index: number, drawing: Drawing): Document {
    return {
        format: document.format,
        pages: document.pages.map((page, at) =>
            at === index ? { ...page, parts: drawing.parts, lines: drawing.lines, sheet: drawing.sheet ?? null } : page,
        ),
        fluids: drawing.fluids,
        style: drawing.style,
        ...(drawing.sim ? { sim: drawing.sim } : {}),
    };
}

let counter = 0;

/** An id for a new part or line, unique in any drawing it's pasted into too. */
export function newId(prefix: string): string {
    counter += 1;
    return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newPart(kind: string, at: Point, fields: Partial<Part> = {}): Part {
    return {
        id: newId("p"),
        kind,
        x: at.x,
        y: at.y,
        rotation: 0,
        flip: false,
        tag: "",
        props: {},
        shown: [],
        label: null,
        text: "",
        w: 0,
        h: 0,
        scale: 1,
        labelSize: null,
        ...fields,
    };
}

export function newLine(from: End, to: End, fields: Partial<Line> = {}): Line {
    return {
        id: newId("l"),
        from,
        to,
        points: [],
        auto: true,
        tag: "",
        fluid: "",
        kind: "pipe",
        arrow: "none",
        props: {},
        shown: [], // a fluid's color says what it is: its label, on every line, crowds a P&ID
        ...fields,
    };
}

// --- reading what the server sent --------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
const strings = (value: unknown): string[] => list(value).filter((item) => typeof item === "string");

function texts(value: unknown): Record<string, string> {
    const found: Record<string, string> = {};
    if (isObject(value)) {
        for (const [key, entry] of Object.entries(value)) {
            if (typeof entry === "string" || typeof entry === "number") {
                found[key] = String(entry);
            }
        }
    }
    return found;
}

function point(value: unknown): Point | null {
    return isObject(value) && typeof value.x === "number" && typeof value.y === "number"
        ? { x: num(value.x), y: num(value.y) }
        : null;
}

function end(value: unknown): End | null {
    if (isObject(value) && typeof value.part === "string" && typeof value.port === "string") {
        return { part: value.part, port: value.port };
    }
    return point(value);
}

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

/** Settings in the simulation: numbers (finite) and choices, by key. */
function simValues(value: unknown): SimValues {
    const found: SimValues = {};
    if (isObject(value)) {
        for (const [key, entry] of Object.entries(value)) {
            if (typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry))) {
                found[key] = entry;
            }
        }
    }
    return found;
}

/** A part's links as they were sent or pasted, each to a page a part can link to (linkUrl): any other is left out,
 * never shown or opened. */
export function readLinks(value: unknown): PartLink[] {
    return list(value)
        .flatMap((entry) => {
            const url = isObject(entry) ? linkUrl(str(entry.url)) : null;
            return url ? [{ label: str((entry as Raw).label).slice(0, MAX_LINK_LABEL), url }] : [];
        })
        .slice(0, MAX_LINKS);
}

function partLinks(value: unknown): { links?: PartLink[] } {
    const links = readLinks(value);
    return links.length > 0 ? { links } : {};
}

const partSim = (value: unknown): { sim?: PartSim } =>
    isObject(value)
        ? {
              sim: {
                  as: str(value.as),
                  settings: simValues(value.settings),
                  ...(value.unlinked === true ? { unlinked: true } : {}),
              },
          }
        : {};

const lineSim = (value: unknown): { sim?: LineSim } =>
    isObject(value)
        ? { sim: { line: isObject(value.line) ? simValues(value.line) : null, node: simValues(value.node) } }
        : {};

function simUnits(value: unknown): { sim?: SimUnits } {
    if (!isObject(value)) {
        return {};
    }
    const ambient = num(value.ambient, STANDARD_SIM_UNITS.ambient);
    return {
        sim: {
            units: value.units === "si" ? "si" : "us",
            gauge: value.gauge !== false,
            ambient: ambient > 0 && ambient < 2e5 ? ambient : STANDARD_SIM_UNITS.ambient,
        },
    };
}

/**
 * Properties and what's shown of them, with a pressure rating read as the MAWP it is: drawings before MAWP called it
 * "rating" (a filter's rating is its microns, and stays).
 */
function withMawp(props: Record<string, string>, shown: string[], filter: boolean) {
    if (filter || props.rating === undefined || props.mawp !== undefined) {
        return { props, shown };
    }
    const { rating, ...rest } = props;
    return { props: { ...rest, mawp: rating }, shown: shown.map((key) => (key === "rating" ? "mawp" : key)) };
}

function part(value: unknown): Part | null {
    if (!isObject(value) || typeof value.id !== "string" || typeof value.kind !== "string") {
        return null;
    }
    const rotation = num(value.rotation);
    const { props, shown } = withMawp(texts(value.props), strings(value.shown), value.kind === "filter");
    return {
        id: value.id,
        kind: value.kind,
        x: num(value.x),
        y: num(value.y),
        rotation: ROTATIONS.includes(rotation as Rotation) ? (rotation as Rotation) : 0,
        flip: value.flip === true,
        tag: str(value.tag),
        props,
        shown,
        label: point(value.label),
        text: str(value.text),
        w: Math.max(0, num(value.w)),
        h: Math.max(0, num(value.h)),
        scale: num(value.scale, 1) > 0 ? partScale(num(value.scale, 1)) : 1,
        labelSize: readLabelSize(value.labelSize),
        ...partSim(value.sim),
        ...partLinks(value.links),
    };
}

function line(value: unknown, parts: Set<string>): Line | null {
    if (!isObject(value) || typeof value.id !== "string") {
        return null;
    }
    const from = end(value.from);
    const to = end(value.to);
    if (!from || !to) {
        return null;
    }
    // A line to a part that's gone (it can't be, as the editor saves them, but a drawing is anyone's to send) is left
    // out rather than drawn to nowhere.
    if ((isPortEnd(from) && !parts.has(from.part)) || (isPortEnd(to) && !parts.has(to.part))) {
        return null;
    }
    const kind = LINE_KINDS.find((entry) => entry.value === value.kind)?.value ?? "pipe";
    const arrow = value.arrow === "forward" || value.arrow === "backward" ? value.arrow : "none";
    const { props, shown } = withMawp(texts(value.props), strings(value.shown), false);
    return {
        id: value.id,
        from,
        to,
        points: list(value.points)
            .map(point)
            .filter((entry) => entry !== null),
        auto: value.auto !== false,
        tag: str(value.tag),
        fluid: str(value.fluid),
        kind,
        arrow,
        props,
        shown,
        ...lineSim(value.sim),
    };
}

function fluid(value: unknown): Fluid | null {
    if (!isObject(value) || typeof value.id !== "string" || !value.id) {
        return null;
    }
    const color = str(value.color);
    return {
        id: value.id,
        name: str(value.name, value.id),
        label: str(value.label),
        color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#7f8c9a",
        ...(typeof value.gas === "boolean" ? { gas: value.gas } : {}),
    };
}

function sheetOf(value: unknown): PageSheet | null {
    if (!isObject(value) || typeof value.paper !== "string") {
        return null;
    }
    const scale = num(value.scale, 1);
    return {
        paper: value.paper,
        landscape: value.landscape !== false,
        x: num(value.x),
        y: num(value.y),
        scale: scale > 0 ? scale : 1,
    };
}

/** A page's parts and lines as they were sent: a line to a part that isn't on the page left out. */
function pageParts(value: Raw): { parts: Part[]; lines: Line[] } {
    const parts = list(value.parts)
        .map(part)
        .filter((entry) => entry !== null);
    const ids = new Set(parts.map((entry) => entry.id));
    return {
        parts,
        lines: list(value.lines)
            .map((entry) => line(entry, ids))
            .filter((entry) => entry !== null),
    };
}

/**
 * A diagram's drawing as the server sent it, whatever its age: its pages (a drawing from before pages is one), with
 * what they lack filled in and what can't be read left out.
 */
export function readDocument(value: unknown): Document {
    const found = isObject(value) ? value : {};
    const pages = list(found.pages).filter(isObject);
    if (pages.length === 0) {
        return documentOf(readDrawing(found));
    }
    const shared = readDrawing({ fluids: found.fluids, style: found.style, sim: found.sim });
    return {
        format: 4,
        pages: pages.map((page, index) => ({
            id: str(page.id) || newId("g"),
            name: str(page.name) || `Page ${index + 1}`,
            ...pageParts(page),
            sheet: sheetOf(page.sheet),
        })),
        fluids: shared.fluids,
        style: shared.style,
        ...(shared.sim ? { sim: shared.sim } : {}),
    };
}

/** A page's drawing as the server sent it (or a drawing from before pages), whatever its age: what it lacks is filled
 * in, and what can't be read left out. A document's first page, if it's one with pages. */
export function readDrawing(value: unknown): Drawing {
    const found = isObject(value) ? value : {};
    if (Array.isArray(found.pages)) {
        return pageOf(readDocument(found), 0);
    }
    const { parts, lines } = pageParts(found);
    const style = isObject(found.style) ? found.style : {};
    const labels = readLabelSize(style.labels) ?? 1;
    return {
        format: 1,
        parts,
        lines,
        fluids: list(found.fluids)
            .map(fluid)
            .filter((entry) => entry !== null),
        style: {
            no: str(style.no),
            nc: str(style.nc),
            fip: str(style.fip),
            labels,
            scheme: str(style.scheme),
            schemeAt: str(style.schemeAt),
        },
        ...simUnits(found.sim),
    };
}
