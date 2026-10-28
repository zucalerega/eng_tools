import { pageOf, type Document, type Drawing, type Part } from "./drawing";
import { fluidOf } from "./fluids";
import { CATEGORIES, kindOf, PRESETS, titleOf } from "./library/index";
import type { Field } from "./library/kinds";
import { linesOn } from "./ports";

// A diagram's parts list: every valve, instrument, tank, and the rest on its pages, each with what it is, the page it's
// on, the fluids on it, and its specs. Not its lines, nor what's only written or drawn on it (notes, regions,
// connectors, the title block, pictures, and a figure, a shape as Visio drew it, unless it's tagged, as a component
// Piper has no part for is). The parts page shows it, sorted and narrowed as asked (PartsPage.tsx); as a CSV, it's a
// valve list and an instrument list, in a spreadsheet.

/** Kinds that aren't parts to list: what's written or drawn on a drawing, and where its lines meet. */
const NOT_PARTS = new Set(["junction", "text", "region", "offpage", "legend", "titleblock", "picture"]);

/** Fields the list has columns of their own for, or none: the fluid it holds is among its fluids. */
const OWN_COLUMNS = new Set(["fluid", "notes", "figure"]);

/** Columns there are for whatever the parts have, even where nothing's said yet: the specs every part has. */
const ALWAYS = new Set(["model", "mawp"]);

/** A part's category in the library (its kind's first preset's): "other" for a kind with none. */
const CATEGORY = new Map<string, string>();
for (const preset of PRESETS) {
    if (!CATEGORY.has(preset.kind)) {
        CATEGORY.set(preset.kind, preset.category);
    }
}

/** The categories parts are in, in the library's order, with anything else last. */
export const PART_CATEGORIES: { id: string; name: string }[] = [...CATEGORIES, { id: "other", name: "Other" }];

export interface PartsColumn {
    key: string; // "tag", "what", "page", "fluids", a field's key, or "notes"
    label: string;
}

/** A part, as the list has it: where it is, what's on it, and its cells, by their columns' keys. */
export interface PartsRow {
    id: string;
    page: number; // which of the diagram's pages it's on
    kind: string; // its kind's id
    category: string;
    fluids: string[]; // the fluids on it, by id: what it holds, and what its lines carry
    cells: Record<string, string>;
    fields: string[]; // the keys of the fields its kind has: columns it would fill, said or not
}

/** How the list is sorted: by a column, either way; null, as the library has them (valves first), then by tag. */
export type PartsSort = { key: string; descending: boolean } | null;

/** The parts on a diagram's pages, as the list has them, in the library's order, then by tag. */
export function partsOf(document: Document): PartsRow[] {
    const rows = document.pages.flatMap((_, index) => {
        const drawing = pageOf(document, index);
        return drawing.parts.filter(isListed).map((part) => rowOf(document, drawing, part, index));
    });
    return sortRows(rows, null);
}

const isListed = (part: Part) => !NOT_PARTS.has(part.kind) && (part.kind !== "figure" || part.tag !== "");

function rowOf(document: Document, drawing: Drawing, part: Part, page: number): PartsRow {
    const kind = kindOf(part.kind);
    const fluids = [part.props.fluid ?? "", ...linesOn(drawing, part.id).map(({ line }) => line.fluid)];
    const cells: Record<string, string> = {
        tag: part.tag,
        what: titleOf(part),
        page: document.pages[page]?.name ?? "",
        fluids: "",
        notes: part.props.notes ?? "",
    };
    for (const [key, value] of Object.entries(part.props)) {
        if (!OWN_COLUMNS.has(key) && value) {
            cells[key] = said(kind.fields, key, value);
        }
    }
    // What a test reads it by: its tag, unless it's given a channel of its own.
    if (kind.reads) {
        cells.channel = part.props.channel || part.tag;
    }
    const row: PartsRow = {
        id: part.id,
        page,
        kind: part.kind,
        category: CATEGORY.get(part.kind) ?? "other",
        fluids: [...new Set(fluids.filter(Boolean))],
        cells,
        fields: kind.fields.filter((field) => !OWN_COLUMNS.has(field.key)).map((field) => field.key),
    };
    row.cells.fluids = row.fluids.map((id) => fluidOf(drawing, id)?.label ?? id).join(", ");
    return row;
}

/** A property as the list says it: a choice by its short name (NC) or its name, as it's written otherwise. */
function said(fields: Field[], key: string, value: string): string {
    const option = fields.find((field) => field.key === key)?.options?.find((entry) => entry.value === value);
    return option ? (option.short ?? option.label) : value;
}

/**
 * The columns for some of a diagram's parts: its tag, what it is, its page (if the diagram has more than one), and
 * the fluids on it; then each spec any of them has (but one that only says what each is), in the order the whole list
 * first has them (a valve's, then an instrument's...), and the specs every part has (its model, its MAWP) where any of
 * them could have them; then its test channel, a column only where one's been given that isn't the part's tag; then
 * notes.
 */
export function columnsOf(document: Document, all: PartsRow[], shown: PartsRow[]): PartsColumn[] {
    // Each column as the parts shown name it (an instrument's type is what it measures), else as any part does.
    const labels = new Map<string, string>();
    for (const row of [...shown, ...all]) {
        for (const field of kindOf(row.kind).fields) {
            labels.set(field.key, labels.get(field.key) ?? field.label);
        }
    }
    const order: string[] = [];
    for (const row of all) {
        for (const key of [...row.fields, ...Object.keys(row.cells)]) {
            if (!order.includes(key) && !["tag", "what", "page", "fluids", "notes"].includes(key)) {
                order.push(key);
            }
        }
    }
    const filled = (key: string) =>
        key === "channel"
            ? shown.some((row) => row.cells.channel && row.cells.channel !== row.cells.tag)
            : shown.some((row) => row.cells[key]);
    // A column that only says again what each part is (Pressure transducer, of a pressure transducer) isn't one.
    const named = (key: string) =>
        shown.every((row) => !row.cells[key] || row.cells.what!.toLowerCase().includes(row.cells[key]!.toLowerCase()));
    const specs = order
        .filter(
            (key) => (filled(key) && !named(key)) || (ALWAYS.has(key) && shown.some((row) => row.fields.includes(key))),
        )
        .sort((a, b) => Number(a === "channel") - Number(b === "channel")); // what a test reads it by, after its specs
    return [
        { key: "tag", label: "Tag" },
        { key: "what", label: "What" },
        ...(document.pages.length > 1 ? [{ key: "page", label: "Page" }] : []),
        { key: "fluids", label: "Fluid" },
        ...specs.map((key) => ({ key, label: labels.get(key) ?? key })),
        ...(shown.some((row) => row.cells.notes) ? [{ key: "notes", label: "Notes" }] : []),
    ];
}

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Where a category is in the library's order, for the list's own: valves first, then vessels, instruments... */
const placeOf = (row: PartsRow) => {
    const index = PART_CATEGORIES.findIndex((category) => category.id === row.category);
    return index < 0 ? PART_CATEGORIES.length : index;
};

/**
 * Rows sorted by a column (what's in it, numbers as numbers: 500 psi before 3000 psi), those with nothing in it last
 * either way; or, with no column, by category, then tag. Rows the same in it stay in the list's own order.
 */
export function sortRows(rows: PartsRow[], sort: PartsSort): PartsRow[] {
    const natural = (a: PartsRow, b: PartsRow) =>
        placeOf(a) - placeOf(b) ||
        compare(a.cells.what ?? "", b.cells.what ?? "") ||
        compare(a.cells.tag || "￿", b.cells.tag || "￿");
    if (!sort) {
        return [...rows].sort(natural);
    }
    const sign = sort.descending ? -1 : 1;
    return [...rows].sort((a, b) => {
        const [x, y] = [a.cells[sort.key] ?? "", b.cells[sort.key] ?? ""];
        if (!x !== !y) {
            return x ? -1 : 1; // nothing said, last
        }
        return sign * compare(x, y) || natural(a, b);
    });
}

/** CSV's cell: quoted where it has to be. */
const cell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Rows of the list as a CSV file's text, in these columns. */
export function csvOf(columns: PartsColumn[], rows: PartsRow[]): string {
    const lines = [
        columns.map((column) => column.label),
        ...rows.map((row) => columns.map((c) => row.cells[c.key] ?? "")),
    ];
    return lines.map((line) => line.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** A diagram's whole parts list as a CSV file's text: every part, in the list's order, with every column it has. */
export function partsList(document: Document): string {
    const rows = partsOf(document);
    return csvOf(columnsOf(document, rows, rows), rows);
}
