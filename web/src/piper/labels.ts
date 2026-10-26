import type { Drawing, LabelSize, Line, Part, Point } from "./drawing";
import { fluidOf } from "./fluids";
import type { Box } from "./geometry";
import { kindOf } from "./library/index";
import { MAWP, type Field } from "./library/kinds";

// What's written beside parts and on lines: a part's tag and the properties it shows, a line's tag, fluid, and size.

export const LINE_FIELDS: Field[] = [
    { key: "size", label: "Size", type: "text", placeholder: "1/2 in OD" },
    { key: "wall", label: "Wall", type: "text", placeholder: "0.035 in" },
    { key: "material", label: "Material", type: "text", placeholder: "316 SS" },
    { key: "length", label: "Length", type: "text", placeholder: "36 in" },
    MAWP,
    { key: "notes", label: "Notes", type: "long" },
];

export const LABEL_SIZES: { value: LabelSize; label: string }[] = [
    { value: "small", label: "Small" },
    { value: "normal", label: "Normal" },
    { value: "large", label: "Large" },
];

const SCALE: Record<LabelSize, number> = { small: 0.8, normal: 1, large: 1.3 };

/**
 * The sizes of what's written beside parts and on lines, in the drawing's units, at its label size: well under the
 * parts' own (a valve's body is 20 high), so the symbols read first.
 */
export function textSizes(drawing: Drawing): { tag: number; row: number; line: number; gap: number } {
    const scale = SCALE[drawing.style.labels] ?? 1;
    return { tag: 8 * scale, row: 7 * scale, line: 7 * scale, gap: 9 * scale };
}

/** A property as it reads on the drawing: a choice's short name, a fluid's label, a value with its prefix. */
export function readValue(drawing: Drawing, fields: Field[], key: string, value: string): string {
    if (!value) {
        return "";
    }
    const field = fields.find((entry) => entry.key === key);
    if (!field) {
        return `${key} ${value}`; // one of the team's own: named, since nothing else says what it is
    }
    switch (field.type) {
        case "select": {
            const option = field.options?.find((entry) => entry.value === value);
            return option ? (option.short ?? option.label) : value;
        }
        case "fluid":
            return fluidOf(drawing, value)?.label || value;
        default:
            return `${field.prefix ?? ""}${value}`;
    }
}

/** The lines of a part's label: its tag (unless it's in its symbol), then what it shows. */
export function partLabel(drawing: Drawing, part: Part): { text: string; tag: boolean }[] {
    const kind = kindOf(part.kind);
    if (kind.tag === "none") {
        return [];
    }
    const rows: { text: string; tag: boolean }[] = [];
    if ((kind.tag === "beside" || kind.tag === "side") && part.tag) {
        rows.push({ text: part.tag, tag: true });
    }
    for (const key of part.shown) {
        const text = readValue(drawing, kind.fields, key, part.props[key] ?? "");
        if (text) {
            rows.push({ text, tag: false });
        }
    }
    return rows;
}

/**
 * Where a part's label goes, if it hasn't been dragged there: off the line a part in a line is in (under it, if the
 * line goes across; beside it, if it goes down), under other wide parts, and beside tall ones, at their top. size: its
 * tag's (textSizes), which it's set clear of the part by.
 */
export function labelPlace(part: Part, box: Box, size = 8): { at: Point; anchor: "middle" | "start" } {
    if (part.label) {
        return { at: { x: part.x + part.label.x, y: part.y + part.label.y }, anchor: "middle" };
    }
    const kind = kindOf(part.kind);
    const below = box.y1 + size + 2;
    if (kind.tag === "side") {
        return { at: { x: box.x1 + 5, y: part.y + size / 3 }, anchor: "start" };
    }
    if (kind.inline) {
        const across = part.rotation === 0 || part.rotation === 180;
        return across
            ? { at: { x: part.x, y: below }, anchor: "middle" }
            : { at: { x: box.x1 + 6, y: part.y + size / 3 }, anchor: "start" };
    }
    const wide = box.x1 - box.x0 >= box.y1 - box.y0 || kind.tag === "inside";
    return wide
        ? { at: { x: (box.x0 + box.x1) / 2, y: below }, anchor: "middle" }
        : { at: { x: box.x1 + 6, y: box.y0 + size + 2 }, anchor: "start" };
}

/** What a line's label says: what it shows, of its tag, fluid, and properties. */
export function lineLabel(drawing: Drawing, line: Line): string {
    return line.shown
        .map((key) => {
            if (key === "tag") {
                return line.tag;
            }
            if (key === "fluid") {
                return fluidOf(drawing, line.fluid)?.label ?? "";
            }
            return readValue(drawing, LINE_FIELDS, key, line.props[key] ?? "");
        })
        .filter(Boolean)
        .join(" · ");
}
