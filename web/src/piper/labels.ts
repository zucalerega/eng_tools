import type { Drawing, LabelSize, Line, Part, Point } from "./drawing";
import { fluidOf } from "./fluids";
import { inBox, segmentsOf, toWorld, type Box } from "./geometry";
import { boxOf, kindOf } from "./library/index";
import { MAWP, type Field } from "./library/kinds";
import { linesOn, portOf } from "./ports";

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
export function textSizes(drawing: Drawing, part?: Part): { tag: number; row: number; line: number; gap: number } {
    const scale = SCALE[part?.labelSize || drawing.style.labels] ?? 1;
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
 * line goes across; beside it, if it goes down), under other wide parts, and beside tall ones, at their top; an
 * instrument's at its side, the side its lines don't leave it from (drawing: where they are). size: its tag's
 * (textSizes), which it's set clear of the part by.
 */
export function labelPlace(
    part: Part,
    box: Box,
    size = 8,
    drawing?: Drawing,
): { at: Point; anchor: "middle" | "start" | "end" } {
    if (part.label) {
        return { at: { x: part.x + part.label.x, y: part.y + part.label.y }, anchor: "middle" };
    }
    const kind = kindOf(part.kind);
    const below = box.y1 + size + 2;
    if (kind.tag === "side") {
        const y = part.y + size / 3;
        const sides = drawing ? tappedSides(drawing, part, box) : new Set<string>();
        return sides.has("right") && !sides.has("left")
            ? { at: { x: box.x0 - 5, y }, anchor: "end" }
            : { at: { x: box.x1 + 5, y }, anchor: "start" };
    }
    if (kind.inline) {
        const across = part.rotation === 0 || part.rotation === 180;
        return across
            ? { at: { x: part.x, y: below }, anchor: "middle" }
            : { at: { x: box.x1 + 6, y: part.y + size / 3 }, anchor: "start" };
    }
    if (kind.tagX !== undefined && (part.rotation === 0 || part.rotation === 180)) {
        return { at: { x: toWorld(part, { x: kind.tagX, y: 0 }).x, y: below }, anchor: "middle" };
    }
    const wide = box.x1 - box.x0 >= box.y1 - box.y0 || kind.tag === "inside";
    return wide
        ? { at: { x: (box.x0 + box.x1) / 2, y: below }, anchor: "middle" }
        : { at: { x: box.x1 + 6, y: box.y0 + size + 2 }, anchor: "start" };
}

/** The sides of a part a line leaves it from, as it's drawn, however it's turned: "left", "right", or both. */
function tappedSides(drawing: Drawing, part: Part, box: Box): Set<string> {
    const sides = new Set<string>();
    for (const { port } of linesOn(drawing, part.id)) {
        const at = portOf(part, port)?.at;
        if (at && at.x >= box.x1) {
            sides.add("right");
        } else if (at && at.x <= box.x0) {
            sides.add("left");
        }
    }
    return sides;
}

/** About where a part's label is: the box around its words, at about 0.6 of their size a letter. */
export function labelBox(drawing: Drawing, part: Part): Box | null {
    const rows = partLabel(drawing, part);
    if (rows.length === 0) {
        return null;
    }
    const sizes = textSizes(drawing, part);
    const { at, anchor } = labelPlace(part, boxOf(part, drawing), sizes.tag, drawing);
    const width = Math.max(...rows.map((row) => row.text.length * (row.tag ? sizes.tag * 0.62 : sizes.row * 0.58)));
    const x0 = anchor === "middle" ? at.x - width / 2 : anchor === "end" ? at.x - width : at.x;
    return {
        x0,
        y0: at.y - sizes.tag * 0.75,
        x1: x0 + width,
        y1: at.y + (rows.length - 1) * sizes.gap + sizes.row * 0.25,
    };
}

/**
 * Where a part's live value is drawn (Test data's, a simulation's): its badge, by its middle and its left edge, or its
 * right edge if it's on the part's left (end); and its leader, the line that ties it to the part, from about the part's
 * outline (toward the corner the badge is off) to the badge's corner nearest the part.
 */
export interface BadgePlace {
    x: number;
    y: number;
    end: boolean;
    from: Point;
    to: Point;
}

// How far a badge stands off its part's corner: room for its leader to show, near enough to read as the part's.
const OFF_X = 8;
const OFF_Y = 6;
// Where a leader starts, of the way from the part's middle to its box's corner: about where a round or a boxed symbol's
// outline is (what's drawn of a part over its leader hides the rest).
const OUTLINE = 0.7;

/** Whether two boxes overlap by more than a unit: a badge just touching a line or a label isn't in its way. */
const overlaps = (a: Box, b: Box): boolean => a.x0 + 1 < b.x1 && b.x0 + 1 < a.x1 && a.y0 + 1 < b.y1 && b.y0 + 1 < a.y1;

/**
 * Where parts' live values go: off a part's top right corner, unless something's in the way there (another part, a
 * label, a line), then off whichever of its other corners has least in the way. It's decided by the drawing and the
 * width a badge usually is, not by what it says, so a badge stays put as its values change.
 */
export function badgePlacer(
    drawing: Drawing,
    paths: ReadonlyMap<string, Point[]>,
): (part: Part, width: number) => BadgePlace {
    // What's in the way, found when a badge is first placed: a drawing without a test shows none.
    let found: { parts: { id: string; box: Box }[]; labels: Box[]; segments: Box[] } | null = null;
    const inTheWayOf = () =>
        (found ??= {
            parts: drawing.parts
                .filter((part) => !kindOf(part.kind).behind) // a region's around what's in it
                .map((part) => ({ id: part.id, box: boxOf(part, drawing) })),
            labels: drawing.parts.flatMap((part) => labelBox(drawing, part) ?? []),
            segments: [...paths.values()].flatMap((path) =>
                segmentsOf(path).map(({ a, b }) => ({
                    x0: Math.min(a.x, b.x),
                    y0: Math.min(a.y, b.y),
                    x1: Math.max(a.x, b.x),
                    y1: Math.max(a.y, b.y),
                })),
            ),
        });
    // Each part's, once for the drawing: the badges are drawn again at every step of a test played.
    const known = new Map<string, BadgePlace>();
    return (part, width) => {
        const key = `${part.id} ${width}`;
        const already = known.get(key);
        if (already) {
            return already;
        }
        const { parts, labels, segments } = inTheWayOf();
        const box = boxOf(part, drawing);
        const middle = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
        // Not the part, nor what it's drawn on (a picture under it).
        const others = parts.filter((one) => one.id !== part.id && !inBox(middle, one.box)).map((one) => one.box);
        // Off its top right, top left, bottom right, and bottom left (sx: which way across, sy: up or down).
        const corners = (
            [
                [1, -1],
                [-1, -1],
                [1, 1],
                [-1, 1],
            ] as const
        ).map(([sx, sy]): BadgePlace => {
            const corner = { x: sx > 0 ? box.x1 : box.x0, y: sy < 0 ? box.y0 : box.y1 };
            const near = { x: corner.x + sx * OFF_X, y: corner.y + sy * OFF_Y }; // the badge's corner nearest the part
            return {
                x: near.x,
                y: sy < 0 ? near.y - 7 : near.y + 8, // a badge is 15 high, from its middle 8 up and 7 down
                end: sx < 0,
                from: {
                    x: middle.x + (corner.x - middle.x) * OUTLINE,
                    y: middle.y + (corner.y - middle.y) * OUTLINE,
                },
                to: { x: near.x + sx * 4, y: near.y }, // along its edge, clear of its rounded corner
            };
        });
        const inTheWay = (place: BadgePlace): number => {
            const badge = {
                x0: place.end ? place.x - width : place.x,
                y0: place.y - 8,
                x1: place.end ? place.x : place.x + width,
                y1: place.y + 7,
            };
            const count = (boxes: Box[]) => boxes.filter((one) => overlaps(badge, one)).length;
            return 2 * count(others) + 2 * count(labels) + count(segments);
        };
        const scores = corners.map(inTheWay);
        const place = corners[scores.indexOf(Math.min(...scores))]!;
        known.set(key, place);
        return place;
    };
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
