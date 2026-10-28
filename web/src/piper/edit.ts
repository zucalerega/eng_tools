import {
    isPortEnd,
    newId,
    newLine,
    newPart,
    readLinks,
    type Drawing,
    type End,
    type Line,
    type Part,
    type Point,
    type Rotation,
} from "./drawing";
import {
    dirOf,
    grow,
    nearestOnPolyline,
    orthogonal,
    samePoint,
    simplify,
    snapPoint,
    snapToGrid,
    union,
    VECTORS,
    type Box,
} from "./geometry";
import { isGas } from "./fluids";
import { boxOf, kindOf } from "./library/index";
import type { Preset } from "./library/kinds";
import { linesOn, partsById, placeEnd, portOf, portsOf, runLines, type PlacedEnd } from "./ports";
import { route, STUB } from "./route";

// The changes the editor makes to a drawing, each a pure function from one drawing to the next: placing parts,
// connecting them, putting one into a line, moving, turning, deleting (and joining a line back up where a part in it
// went), copying and pasting. Lines whose ends move are routed again, or, if they were routed by hand, keep their
// bends and only follow their ends.

// --- routing lines -------------------------------------------------------------------------------------------------

/** What lines route around: every part but regions (around parts themselves) and junctions (on lines). */
export function obstacles(drawing: Drawing): Box[] {
    return drawing.parts
        .filter((part) => {
            const kind = kindOf(part.kind);
            return !kind.behind && part.kind !== "junction";
        })
        .map((part) => boxOf(part, drawing));
}

/** A line's bends, routed for itself in a drawing: around its parts, and off its other lines where it can be. */
export function routeOf(drawing: Drawing, line: Line, parts = partsById(drawing), boxes = obstacles(drawing)): Point[] {
    const from = placeEnd(parts, line.from);
    const to = placeEnd(parts, line.to);
    if (!from || !to) {
        return line.points;
    }
    const others = drawing.lines.filter((other) => other.id !== line.id).map((other) => runOf(parts, other) ?? []);
    return route(from, to, boxes, others).slice(1, -1);
}

/** The route a line runs on, end to end: from the point its route starts at, through its bends, to the other end. */
export function runOf(parts: Map<string, Part>, line: Line): Point[] | null {
    const from = placeEnd(parts, line.from);
    const to = placeEnd(parts, line.to);
    return from && to ? [from.at, ...line.points, to.at] : null;
}

/**
 * A path whose ends leave their ports the way they face: an end its path leaves another way (back through its part, or
 * along its edge) is routed again from its port to the bend after it, around what's in the way.
 */
function mendEnds(path: Point[], from: PlacedEnd, to: PlacedEnd, boxes: Box[]): Point[] {
    let mended = simplify(path);
    if (mended.length >= 3 && from.dir && dirOf(mended[0]!, mended[1]!) !== from.dir) {
        mended = [...route(from, { at: mended[1]!, dir: null }, boxes), ...mended.slice(2)];
    }
    const last = mended.length - 1;
    if (mended.length >= 3 && to.dir && dirOf(mended[last]!, mended[last - 1]!) !== to.dir) {
        mended = [...mended.slice(0, last - 1), ...route({ at: mended[last - 1]!, dir: null }, to, boxes)];
    }
    return simplify(mended);
}

/**
 * A line routed by hand, following its ends to where they are now: its bends stay, but the ones next to an end that
 * moved move with it, along the run they're on, so the line stays orthogonal. An end that now faces away from the
 * line is routed around to it (mendEnds).
 */
export function follow(before: Point[], from: PlacedEnd, to: PlacedEnd, boxes: Box[]): Point[] {
    const bends = before.slice(1, -1).map((point) => ({ ...point }));
    const was = { from: before[0]!, to: before[before.length - 1]! };
    if (bends.length === 0) {
        return [];
    }
    const first = bends[0]!;
    if (bends.length === 1) {
        // One bend, an L: it goes where the two runs from the ends now cross.
        const level = Math.abs(was.from.y - first.y) < 1e-6;
        bends[0] = level ? { x: to.at.x, y: from.at.y } : { x: from.at.x, y: to.at.y };
    } else {
        const last = bends[bends.length - 1]!;
        if (Math.abs(was.from.y - first.y) < 1e-6) {
            first.y = from.at.y;
        } else {
            first.x = from.at.x;
        }
        if (Math.abs(was.to.y - last.y) < 1e-6) {
            last.y = to.at.y;
        } else {
            last.x = to.at.x;
        }
    }
    return mendEnds([from.at, ...bends, to.at], from, to, boxes).slice(1, -1);
}

/**
 * The drawing's lines brought up to date with its parts, after some of them turned, flipped, changed, or were lined
 * up (moved: their ids): a line with an end on one of them is routed again, or follows its end if it was routed by
 * hand. before: the drawing as it was, for where lines' ends were. (Moving by an offset is moveItems'.)
 */
export function followParts(before: Drawing, after: Drawing, moved: Set<string>): Drawing {
    const wasParts = partsById(before);
    const parts = partsById(after);
    const boxes = obstacles(after);
    const touches = (end: End) => isPortEnd(end) && moved.has(end.part);
    const lines = after.lines.map((line) => {
        const from = touches(line.from);
        const to = touches(line.to);
        if (!from && !to) {
            return line;
        }
        if (line.auto) {
            return { ...line, points: routeOf(after, line, parts, boxes) };
        }
        const was = runOf(wasParts, line);
        const fromNow = placeEnd(parts, line.from);
        const toNow = placeEnd(parts, line.to);
        if (!was || !fromNow || !toNow) {
            return line;
        }
        return { ...line, points: follow(was, fromNow, toNow, boxes) };
    });
    return { ...after, lines };
}

/** Each of these lines routed for itself again. */
export function rerouteLines(drawing: Drawing, ids: Set<string>): Drawing {
    const parts = partsById(drawing);
    const boxes = obstacles(drawing);
    return {
        ...drawing,
        lines: drawing.lines.map((line) =>
            ids.has(line.id) ? { ...line, auto: true, points: routeOf(drawing, line, parts, boxes) } : line,
        ),
    };
}

// --- tags ----------------------------------------------------------------------------------------------------------

/** The next tag free with a prefix: after the highest number any part's tag with it has (PT-3 after PT-2). */
export function nextTag(drawing: Drawing, prefix: string, taken: Set<string> = new Set()): string {
    if (!prefix) {
        return "";
    }
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`, "i");
    let highest = 0;
    for (const tag of [...drawing.parts.map((part) => part.tag), ...(drawing.elsewhere ?? []), ...taken]) {
        const match = pattern.exec(tag);
        if (match) {
            highest = Math.max(highest, Number(match[1]));
        }
    }
    return `${prefix}-${highest + 1}`;
}

/** A tag's prefix: what's before its number ("PT" of PT-12, "MOV-OX" of MOV-OX). */
export const prefixOf = (tag: string): string => /^(.*?)-?\d+$/.exec(tag)?.[1] ?? tag;

/** The tags two or more parts share: on this page, or on it and another of the diagram's. */
export function sharedTags(drawing: Drawing): Set<string> {
    const seen = new Set((drawing.elsewhere ?? []).map((tag) => tag.trim().toUpperCase()));
    const shared = new Set<string>();
    for (const part of drawing.parts) {
        const tag = part.tag.trim().toUpperCase();
        if (!tag) {
            continue;
        }
        if (seen.has(tag)) {
            shared.add(tag);
        }
        seen.add(tag);
    }
    return shared;
}

// --- placing and connecting ----------------------------------------------------------------------------------------

/** A part from the library, at a point (on the grid, unless free), tagged with the next number free. */
export function addPart(drawing: Drawing, preset: Preset, at: Point, free = false): { drawing: Drawing; id: string } {
    const part = newPart(preset.kind, free ? at : snapPoint(at), {
        tag: nextTag(drawing, preset.prefix),
        props: { ...preset.props },
        shown: [...(preset.shown ?? [])],
        text: preset.text ?? "",
        w: preset.w ?? 0,
        h: preset.h ?? 0,
    });
    return { drawing: { ...drawing, parts: [...drawing.parts, part] }, id: part.id };
}

/** Where a line being drawn ends up: a part's port, a point on another line (a tee), or a point of its own. */
export type Target = { part: string; port: string } | { line: string; at: Point } | Point;

const onLine = (target: Target): target is { line: string; at: Point } => "line" in target;

/** The fluid a new line from an end carries: what the lines already there carry, or the part there holds. */
function fluidAt(drawing: Drawing, end: End): string {
    if (!isPortEnd(end)) {
        return "";
    }
    const part = drawing.parts.find((entry) => entry.id === end.part);
    const kind = part ? kindOf(part.kind) : null;
    for (const { line, port } of linesOn(drawing, end.part)) {
        // A run's fluid carries on through what it flows through, and from the same port of anything.
        if (line.fluid && (port === end.port || kind?.through)) {
            return line.fluid;
        }
    }
    const holds = part?.props.fluid ?? "";
    // A tank's top is its ullage: what's drawn from there is its pressurant, not its liquid.
    if (!holds || kind?.through || (end.port === "top" && !isGas(drawing, holds))) {
        return "";
    }
    return holds;
}

/** What the second half of a split line shows: not its tag or fluid again, which the first half says. */
const once = (shown: string[]): string[] => shown.filter((key) => key !== "tag" && key !== "fluid");

/**
 * What the rest of a line split in two keeps of its simulation: the settings of the gas node it's in, but not its model
 * as a line, which the line up to the split keeps whole, so the model doesn't have its length twice.
 */
const restOf = (line: Line): Pick<Line, "sim"> => (line.sim ? { sim: { line: null, node: line.sim.node } } : {});

/**
 * A line split in two where a point is on it, at a new junction there (on the grid, along its segment): the line up
 * to it keeps its id, and the rest is a new line, the same but for its tag.
 */
export function splitLine(drawing: Drawing, lineId: string, at: Point): { drawing: Drawing; junction: string } | null {
    const parts = partsById(drawing);
    const line = drawing.lines.find((entry) => entry.id === lineId);
    const run = line ? runOf(parts, line) : null;
    const nearest = run ? nearestOnPolyline(at, run) : null;
    if (!line || !run || !nearest) {
        return null;
    }
    const a = run[nearest.segment]!;
    const b = run[nearest.segment + 1]!;
    const level = Math.abs(a.y - b.y) < 1e-6;
    // On the grid along its segment, and on the segment.
    const along = level ? snapToGrid(nearest.at.x) : snapToGrid(nearest.at.y);
    const [lo, hi] = level ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const clamped = Math.min(hi, Math.max(lo, along));
    const junction = newPart("junction", level ? { x: clamped, y: a.y } : { x: a.x, y: clamped });
    const end = { part: junction.id, port: "c" };
    const withJunction = new Map(parts).set(junction.id, junction);
    const tidy = (entry: Line): Line => ({ ...entry, points: simplify(runOf(withJunction, entry) ?? []).slice(1, -1) });
    const first = tidy({ ...line, to: end, points: run.slice(1, nearest.segment + 1) });
    const second = tidy({
        ...line,
        id: newId("l"),
        tag: "",
        from: end,
        points: run.slice(nearest.segment + 1, -1),
        shown: once(line.shown),
        ...restOf(line),
    });
    const lines = drawing.lines.flatMap((entry) => (entry.id === lineId ? [first, second] : [entry]));
    return { drawing: { ...drawing, parts: [...drawing.parts, junction], lines }, junction: junction.id };
}

/**
 * A new line from one target to another, routed for itself, carrying the fluid of what it's drawn from (or to). An end
 * on another line makes a tee there, and the new line carries what that line does. Its id and the drawing with it, or
 * null if it would go nowhere.
 */
export function connect(drawing: Drawing, source: Target, target: Target): { drawing: Drawing; id: string } | null {
    let next = drawing;
    const endOf = (at: Target): End | null => {
        if (!onLine(at)) {
            return at;
        }
        const split = splitLine(next, at.line, at.at);
        if (!split) {
            return null;
        }
        next = split.drawing;
        return { part: split.junction, port: "c" };
    };
    const from = endOf(source);
    const to = from ? endOf(target) : null;
    if (!from || !to) {
        return null;
    }
    if (
        isPortEnd(from) && isPortEnd(to)
            ? from.part === to.part && from.port === to.port
            : samePoint(endPoint(from), endPoint(to))
    ) {
        return null;
    }
    const tapped = [source, target].filter(onLine).map((at) => drawing.lines.find((line) => line.id === at.line));
    const fluid = fluidAt(next, from) || fluidAt(next, to) || (tapped.find((line) => line?.fluid)?.fluid ?? "");
    const line = newLine(from, to, { fluid, kind: tapped[0]?.kind ?? "pipe" });
    line.points = routeOf(next, line);
    return { drawing: { ...next, lines: [...next.lines, line] }, id: line.id };
}

/** A free end's point (a port's isn't known without its part: never the same as a free one's). */
const endPoint = (end: End): Point => (isPortEnd(end) ? { x: Number.NaN, y: Number.NaN } : end);

/**
 * A part (with no lines yet) put into a line where it was dropped: turned to the line's way (its first port toward
 * where the line comes from), centered on it (moved along it as far as it takes to fit on its segment), and the line
 * split between its two ports. On a segment too short for it, the two lines are routed around it.
 */
export function insertIntoLine(drawing: Drawing, partId: string, lineId: string, at: Point): Drawing | null {
    const parts = partsById(drawing);
    const part = parts.get(partId);
    const line = drawing.lines.find((entry) => entry.id === lineId);
    const kind = part ? kindOf(part.kind) : null;
    const run = line ? runOf(parts, line) : null;
    const nearest = run ? nearestOnPolyline(at, run) : null;
    if (!part || !line || !kind?.inline || !run || !nearest || linesOn(drawing, partId).length > 0) {
        return null;
    }
    const a = run[nearest.segment]!;
    const b = run[nearest.segment + 1]!;
    const way = dirOf(a, b);
    if (!way) {
        return null;
    }
    const [inPort, outPort] = kind.inline;
    const local = kind.ports(part);
    const half =
        Math.max(...[inPort, outPort].map((id) => Math.abs(local.find((port) => port.id === id)?.x ?? 20))) *
        part.scale;
    const level = way === "left" || way === "right";
    const [lo, hi] = level ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const fits = hi - lo >= 2 * half;
    const along = snapToGrid(level ? nearest.at.x : nearest.at.y);
    const middle = fits ? Math.min(hi - half, Math.max(lo + half, along)) : along;
    const rotation: Rotation = ({ right: 0, down: 90, left: 180, up: 270 } as const)[way];
    const placed: Part = { ...part, ...(level ? { x: middle, y: a.y } : { x: a.x, y: middle }), rotation, flip: false };
    const entering = portOf(placed, inPort)!.at;
    const leaving = portOf(placed, outPort)!.at;
    // Each keeps the bends on its side of the part; the segment it's on runs on into the part's ports.
    const first: Line = {
        ...line,
        to: { part: partId, port: inPort },
        points: simplify([run[0]!, ...run.slice(1, nearest.segment + 1), entering]).slice(1, -1),
    };
    const second: Line = {
        ...line,
        id: newId("l"),
        tag: "",
        shown: once(line.shown),
        ...restOf(line),
        from: { part: partId, port: outPort },
        points: simplify([leaving, ...run.slice(nearest.segment + 1, -1), run[run.length - 1]!]).slice(1, -1),
    };
    const next: Drawing = {
        ...drawing,
        parts: drawing.parts.map((entry) => (entry.id === partId ? placed : entry)),
        lines: drawing.lines.flatMap((entry) => (entry.id === lineId ? [first, second] : [entry])),
    };
    return fits ? next : rerouteLines(next, new Set([first.id, second.id]));
}

/** The line nearest a point, if one's within reach, and where on it. */
export function lineNear(
    drawing: Drawing,
    at: Point,
    reach: number,
    except: Set<string> = new Set(),
): { line: Line; at: Point } | null {
    const parts = partsById(drawing);
    let best: { line: Line; at: Point; distance: number } | null = null;
    for (const line of drawing.lines) {
        if (except.has(line.id)) {
            continue;
        }
        const run = runOf(parts, line);
        const nearest = run ? nearestOnPolyline(at, run) : null;
        if (nearest && nearest.distance <= reach && (!best || nearest.distance < best.distance)) {
            best = { line, at: nearest.at, distance: nearest.distance };
        }
    }
    return best ? { line: best.line, at: best.at } : null;
}

/** A line's end moved to a target (another port, a point on a line, a point of its own), and the line routed again. */
export function reconnect(drawing: Drawing, lineId: string, end: "from" | "to", target: Target): Drawing {
    let next = drawing;
    let to: End;
    if (onLine(target)) {
        const split = target.line === lineId ? null : splitLine(drawing, target.line, target.at);
        if (!split) {
            return drawing;
        }
        next = split.drawing;
        to = { part: split.junction, port: "c" };
    } else {
        to = target;
    }
    const line = next.lines.find((entry) => entry.id === lineId);
    if (!line) {
        return drawing;
    }
    const moved: Line = { ...line, [end]: to, auto: true };
    moved.points = routeOf(next, moved);
    // A junction the end left may now join just two lines, or one: tidied as a deletion tidies them.
    const left = line[end];
    const after = updateLine(next, lineId, () => moved);
    const fromJunction =
        isPortEnd(left) && after.parts.some((part) => part.id === left.part && part.kind === "junction");
    return fromJunction ? deleteItems(after, new Set()) : after;
}

/**
 * A line's segment dragged across its way (a level one up or down, an upright one sideways), on the grid: routed by
 * hand from then on. Its first or last segment, dragged, leaves its port straight first, and turns.
 */
export function moveSegment(drawing: Drawing, lineId: string, index: number, by: Point): Drawing {
    const parts = partsById(drawing);
    const line = drawing.lines.find((entry) => entry.id === lineId);
    const from = line ? placeEnd(parts, line.from) : null;
    const to = line ? placeEnd(parts, line.to) : null;
    if (!line || !from || !to) {
        return drawing;
    }
    let points = orthogonal([from.at, ...line.points, to.at], from.dir);
    if (index < 0 || index + 1 >= points.length) {
        return drawing;
    }
    const stub = (end: PlacedEnd): Point =>
        end.dir ? { x: end.at.x + VECTORS[end.dir].x * STUB, y: end.at.y + VECTORS[end.dir].y * STUB } : end.at;
    let at = index;
    if (at === 0) {
        const out = stub(from);
        points = [points[0]!, out, out, ...points.slice(1)];
        at += 2;
    }
    if (at + 2 === points.length) {
        const back = stub(to);
        points = [...points.slice(0, -1), back, back, points[points.length - 1]!];
    }
    const a = points[at]!;
    const b = points[at + 1]!;
    if (Math.abs(a.y - b.y) < 1e-6) {
        const y = snapToGrid(a.y + by.y);
        points[at] = { x: a.x, y };
        points[at + 1] = { x: b.x, y };
    } else {
        const x = snapToGrid(a.x + by.x);
        points[at] = { x, y: a.y };
        points[at + 1] = { x, y: b.y };
    }
    const mended = mendEnds(points, from, to, obstacles(drawing));
    return updateLine(drawing, lineId, (entry) => ({ ...entry, auto: false, points: mended.slice(1, -1) }));
}

// --- moving and changing -------------------------------------------------------------------------------------------

/**
 * Parts and lines moved by an offset. A line whose ends both move (on parts that moved, or free ends of a line that's
 * selected) moves with them, once, as it was; one with an end that stays is routed again, or follows its end if it was
 * routed by hand. A junction comes along when every line through it goes to what's moving, so a tee picked up with
 * what's around it stays a tee.
 */
export function moveItems(drawing: Drawing, ids: Set<string>, by: Point): Drawing {
    if (by.x === 0 && by.y === 0) {
        return drawing;
    }
    const shift = (point: Point) => ({ x: point.x + by.x, y: point.y + by.y });
    const moving = new Set(drawing.parts.filter((part) => ids.has(part.id)).map((part) => part.id));
    // A free end moves with its line, and only if the line's moving too.
    const endMoves = (line: Line, end: End) => (isPortEnd(end) ? moving.has(end.part) : ids.has(line.id));
    const farEnd = (line: Line, part: string): End =>
        isPortEnd(line.from) && line.from.part === part ? line.to : line.from;
    // Junctions whose every line goes to something moving, or to another such junction (a run of tees comes along
    // whole): every junction to begin with, then none that has a line to something staying, until none's left to drop.
    const junctions = new Map(
        drawing.parts
            .filter((part) => part.kind === "junction" && !moving.has(part.id))
            .map((part) => [part.id, linesOn(drawing, part.id).map(({ line }) => line)]),
    );
    const through = (part: string) => junctions.get(part) ?? [];
    const coming = new Set([...junctions].filter(([, lines]) => lines.length > 0).map(([id]) => id));
    const goes = (line: Line, end: End) =>
        isPortEnd(end) ? moving.has(end.part) || coming.has(end.part) : ids.has(line.id);
    for (let dropped = true; dropped;) {
        dropped = false;
        for (const id of coming) {
            if (!through(id).every((line) => goes(line, farEnd(line, id)))) {
                coming.delete(id);
                dropped = true;
            }
        }
    }
    // Of those, the ones joined to what's moving for itself: two tees on nothing but each other stay where they are.
    for (let joined = true; joined;) {
        joined = false;
        for (const id of coming) {
            if (through(id).some((line) => endMoves(line, farEnd(line, id)))) {
                coming.delete(id);
                moving.add(id);
                joined = true;
            }
        }
    }
    const after: Drawing = {
        ...drawing,
        parts: drawing.parts.map((part) => (moving.has(part.id) ? { ...part, ...shift(part) } : part)),
    };
    const wasParts = partsById(drawing);
    const parts = partsById(after);
    const boxes = obstacles(after);
    const lines = drawing.lines.map((line) => {
        const fromMoves = endMoves(line, line.from);
        const toMoves = endMoves(line, line.to);
        if (!fromMoves && !toMoves) {
            return line;
        }
        const ends = {
            from: isPortEnd(line.from) || !fromMoves ? line.from : shift(line.from),
            to: isPortEnd(line.to) || !toMoves ? line.to : shift(line.to),
        };
        if (fromMoves && toMoves) {
            return { ...line, ...ends, points: line.points.map(shift) };
        }
        const moved: Line = { ...line, ...ends };
        if (line.auto) {
            return { ...moved, points: routeOf(after, moved, parts, boxes) };
        }
        const was = runOf(wasParts, line);
        const fromNow = placeEnd(parts, moved.from);
        const toNow = placeEnd(parts, moved.to);
        return was && fromNow && toNow ? { ...moved, points: follow(was, fromNow, toNow, boxes) } : moved;
    });
    return { ...after, lines };
}

/** Kinds that keep upright: regions, legends, and title blocks don't turn or flip. */
const keepsUpright = (part: Part) => ["region", "legend", "titleblock"].includes(part.kind);

/** Parts turned a quarter, each about its own center (clockwise, or back). */
export function turnParts(drawing: Drawing, ids: Set<string>, clockwise: boolean): Drawing {
    const turned: Drawing = {
        ...drawing,
        parts: drawing.parts.map((part) =>
            ids.has(part.id) && !keepsUpright(part)
                ? { ...part, rotation: ((part.rotation + (clockwise ? 90 : 270)) % 360) as Rotation, label: null }
                : part,
        ),
    };
    return followParts(drawing, turned, ids);
}

/** Parts mirrored, left to right as they're drawn now. */
export function flipParts(drawing: Drawing, ids: Set<string>): Drawing {
    const flipped: Drawing = {
        ...drawing,
        parts: drawing.parts.map((part) => {
            if (!ids.has(part.id) || keepsUpright(part)) {
                return part;
            }
            // Mirrored across its vertical as drawn: a part turned a quarter flips top to bottom in its own frame.
            const sideways = part.rotation === 90 || part.rotation === 270;
            const rotation = (sideways ? (part.rotation + 180) % 360 : part.rotation) as Rotation;
            return { ...part, flip: !part.flip, rotation };
        }),
    };
    return followParts(drawing, flipped, ids);
}

/**
 * A picture part showing a picture added to Piper: as wide as it was (or, if it had no picture yet, as its pixels, up
 * to 240), as tall as the picture's shape makes that.
 */
export function withPicture(part: Part, image: { sha256: string; width: number; height: number }): Part {
    const wide = part.props.image ? part.w : Math.min(240, Math.max(40, image.width));
    const w = Math.max(20, Math.round(wide / 5) * 5);
    const h = Math.max(5, Math.round((w * image.height) / image.width));
    return {
        ...part,
        w,
        h,
        props: {
            ...part.props,
            image: image.sha256,
            imageWidth: String(image.width),
            imageHeight: String(image.height),
        },
    };
}

export function updatePart(drawing: Drawing, id: string, change: (part: Part) => Part): Drawing {
    const before = drawing.parts.find((part) => part.id === id);
    if (!before) {
        return drawing;
    }
    const after = change(before);
    // A port it no longer has (a manifold with fewer outlets): a line on it ends where it was, to be drawn on to another.
    const kept = new Set(portsOf(after).map((port) => port.id));
    const was = new Map(portsOf(before).map((port) => [port.id, port.at]));
    const loose = (end: End): End => {
        if (!isPortEnd(end) || end.part !== id || kept.has(end.port)) {
            return end;
        }
        const at = was.get(end.port) ?? before;
        return { x: at.x, y: at.y };
    };
    const lines = drawing.lines.map((line) => {
        const [from, to] = [loose(line.from), loose(line.to)];
        return from === line.from && to === line.to ? line : { ...line, from, to };
    });
    const next = { ...drawing, parts: drawing.parts.map((part) => (part.id === id ? after : part)), lines };
    // What it is, how big, or how many it is may have moved its ports (a valve's body is the same size whatever it is,
    // but a region's isn't, nor a duplicated transducer's): its lines follow.
    const at = (part: Part) =>
        portsOf(part)
            .map((port) => `${port.id}:${port.at.x},${port.at.y}`)
            .join(" ");
    const moved = after.kind !== before.kind || at(after) !== at(before);
    return moved ? followParts(drawing, next, new Set([id])) : next;
}

export function updateLine(drawing: Drawing, id: string, change: (line: Line) => Line): Drawing {
    return { ...drawing, lines: drawing.lines.map((line) => (line.id === id ? change(line) : line)) };
}

/**
 * A fluid carried along a line's run: onto every line it reaches through what fluid flows through (valves, fittings,
 * instruments' taps), up to what holds or uses it (tanks, engines).
 */
export function carryFluid(drawing: Drawing, lineId: string, fluid: string): Drawing {
    const reached = runLines(drawing, lineId);
    return { ...drawing, lines: drawing.lines.map((line) => (reached.has(line.id) ? { ...line, fluid } : line)) };
}

// --- deleting ------------------------------------------------------------------------------------------------------

/**
 * Two lines that met at a part joined into one where it was: the first keeps its id, tag, and what it carries, and
 * runs on through where the part's ports were.
 */
function join(drawing: Drawing, first: { line: Line; end: "from" | "to" }, second: { line: Line; end: "from" | "to" }) {
    const parts = partsById(drawing);
    const a = runOf(parts, first.line);
    const b = runOf(parts, second.line);
    if (!a || !b) {
        return null;
    }
    const into = first.end === "to" ? a : [...a].reverse(); // toward the part
    const out = second.end === "from" ? b : [...b].reverse(); // away from it
    const far = (line: Line, end: "from" | "to") => (end === "to" ? line.from : line.to);
    const joined = simplify([...into, ...out]);
    return {
        ...first.line,
        from: far(first.line, first.end),
        to: far(second.line, second.end),
        points: joined.slice(1, -1),
        auto: first.line.auto && second.line.auto,
        fluid: first.line.fluid || second.line.fluid,
    };
}

/**
 * Parts and lines deleted. Where a part went from the middle of a line (two lines on its two inline ports), the line's
 * joined up again; other lines on a deleted part stay, ending where its port was, to be drawn on to something else. A
 * junction left with two lines joins them, one with one is that line's end, and one with none goes.
 */
export function deleteItems(drawing: Drawing, ids: Set<string>): Drawing {
    let next: Drawing = { ...drawing, lines: drawing.lines.filter((line) => !ids.has(line.id)) };
    const deleting = drawing.parts.filter((part) => ids.has(part.id));
    for (const part of deleting) {
        next = heal(next, part, true);
    }
    const parts = partsById(drawing);
    const gone = new Set(deleting.map((part) => part.id));
    const loose = (end: End): End => {
        if (!isPortEnd(end) || !gone.has(end.part)) {
            return end;
        }
        const at = placeEnd(parts, end)?.at ?? { x: 0, y: 0 };
        return { x: at.x, y: at.y };
    };
    next = {
        ...next,
        parts: next.parts.filter((part) => !gone.has(part.id)),
        lines: next.lines.map((line) => ({ ...line, from: loose(line.from), to: loose(line.to) })),
    };
    // Junctions the deletion left with too few lines.
    for (const part of next.parts.filter((entry) => entry.kind === "junction")) {
        next = heal(next, part, false);
    }
    return next;
}

/**
 * Lines through a part that's going, joined up: two on a part's two inline ports (or any two on a junction). deleting:
 * the part's being deleted anyway; otherwise (a junction) it goes only if it's left joining nothing.
 */
function heal(drawing: Drawing, part: Part, deleting: boolean): Drawing {
    const on = linesOn(drawing, part.id);
    const kind = kindOf(part.kind);
    if (part.kind === "junction" && !deleting) {
        if (on.length >= 3) {
            return drawing;
        }
        if (on.length === 1) {
            const { line, end } = on[0]!;
            const loose = { ...line, [end]: { x: part.x, y: part.y } };
            return {
                ...drawing,
                parts: drawing.parts.filter((entry) => entry.id !== part.id),
                lines: drawing.lines.map((entry) => (entry.id === line.id ? loose : entry)),
            };
        }
        if (on.length === 0) {
            return { ...drawing, parts: drawing.parts.filter((entry) => entry.id !== part.id) };
        }
    }
    const inline = kind.inline;
    const pair =
        on.length === 2 &&
        on[0]!.line.id !== on[1]!.line.id &&
        (part.kind === "junction" ||
            (inline && new Set(on.map((entry) => entry.port)).size === 2 && on.every((e) => inline.includes(e.port))));
    if (!pair) {
        return drawing;
    }
    // The line on its first port (the way flow comes in) keeps its id.
    const [first, second] = inline && on[0]!.port !== inline[0] ? [on[1]!, on[0]!] : [on[0]!, on[1]!];
    const joined = join(drawing, first, second);
    if (!joined) {
        return drawing;
    }
    return {
        ...drawing,
        parts: part.kind === "junction" ? drawing.parts.filter((entry) => entry.id !== part.id) : drawing.parts,
        lines: drawing.lines.flatMap((line) =>
            line.id === first.line.id ? [joined] : line.id === second.line.id ? [] : [line],
        ),
    };
}

// --- copying -------------------------------------------------------------------------------------------------------

/** What's copied: parts, and lines (those to parts left behind end where they were). */
export interface Clip {
    piper: 1;
    parts: Part[];
    lines: Line[];
}

/** The parts and lines chosen, with the lines between the parts chosen, ready to paste anywhere. */
export function copyItems(drawing: Drawing, ids: Set<string>): Clip | null {
    const parts = drawing.parts.filter((part) => ids.has(part.id));
    const kept = new Set(parts.map((part) => part.id));
    const placed = partsById(drawing);
    const inClip = (end: End) => isPortEnd(end) && kept.has(end.part);
    const lines = drawing.lines
        .filter((line) => ids.has(line.id) || (inClip(line.from) && inClip(line.to)))
        .map((line) => {
            const loose = (end: End): End => {
                if (!isPortEnd(end) || kept.has(end.part)) {
                    return end;
                }
                const at = placeEnd(placed, end)?.at ?? { x: 0, y: 0 };
                return { x: at.x, y: at.y };
            };
            return { ...line, from: loose(line.from), to: loose(line.to) };
        });
    return parts.length + lines.length > 0 ? { piper: 1, parts, lines } : null;
}

/** Where a clip's things are, together. */
export function clipBox(clip: Clip, drawing: Drawing): Box | null {
    const parts = partsById({ ...drawing, parts: clip.parts });
    const runs = clip.lines.flatMap((line) => runOf(parts, line) ?? []);
    return union([
        ...clip.parts.map((part) => boxOf(part, drawing)),
        ...runs.map((point) => ({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })),
    ]);
}

/**
 * A clip pasted: its things given new ids, moved by an offset (on the grid), and their tags kept where they're free,
 * else given the next number free. Their ids, to select.
 */
export function pasteClip(drawing: Drawing, clip: Clip, by: Point): { drawing: Drawing; ids: string[] } {
    const offset = snapPoint(by);
    const ids = new Map<string, string>();
    const taken = new Set(
        [...drawing.parts.map((part) => part.tag), ...(drawing.elsewhere ?? [])]
            .map((tag) => tag.toUpperCase())
            .filter(Boolean),
    );
    const fresh = new Set<string>();
    const parts = clip.parts.map((part) => {
        const id = newId("p");
        ids.set(part.id, id);
        let tag = part.tag;
        if (tag && taken.has(tag.toUpperCase())) {
            tag = nextTag(drawing, prefixOf(tag), fresh);
        }
        if (tag) {
            taken.add(tag.toUpperCase());
            fresh.add(tag);
        }
        return { ...part, id, tag, x: part.x + offset.x, y: part.y + offset.y };
    });
    const shift = (point: Point) => ({ x: point.x + offset.x, y: point.y + offset.y });
    const end = (value: End): End =>
        isPortEnd(value) ? { part: ids.get(value.part)!, port: value.port } : shift(value);
    const lines = clip.lines
        .filter(
            (line) =>
                (!isPortEnd(line.from) || ids.has(line.from.part)) && (!isPortEnd(line.to) || ids.has(line.to.part)),
        )
        .map((line) => ({
            ...line,
            id: newId("l"),
            from: end(line.from),
            to: end(line.to),
            points: line.points.map(shift),
        }));
    return {
        drawing: { ...drawing, parts: [...drawing.parts, ...parts], lines: [...drawing.lines, ...lines] },
        ids: [...parts.map((part) => part.id), ...lines.map((line) => line.id)],
    };
}

/** A clip read back from the clipboard's text, if it's one: its parts' links only those a part can have (readLinks),
 * as anything can be on a clipboard. */
export function readClip(text: string): Clip | null {
    try {
        const value = JSON.parse(text) as Partial<Clip>;
        if (value.piper === 1 && Array.isArray(value.parts) && Array.isArray(value.lines)) {
            const parts = value.parts.map((part) => {
                const { links, ...rest } = part;
                const kept = readLinks(links);
                return kept.length > 0 ? { ...rest, links: kept } : rest;
            });
            return { ...(value as Clip), parts };
        }
    } catch {
        // not a clip: something else on the clipboard
    }
    return null;
}

// --- lining up -----------------------------------------------------------------------------------------------------

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom" | "across" | "down";

/** Parts lined up by their boxes (left edges, centers...), or spread evenly across or down by their centers. */
export function alignParts(drawing: Drawing, ids: Set<string>, how: Alignment): Drawing {
    const parts = drawing.parts.filter((part) => ids.has(part.id));
    if (parts.length < 2) {
        return drawing;
    }
    const boxes = new Map(parts.map((part) => [part.id, boxOf(part, drawing)]));
    const all = union([...boxes.values()])!;
    const offsets = new Map<string, Point>();
    if (how === "across" || how === "down") {
        const level = how === "across";
        const center = (part: Part) => (level ? part.x : part.y);
        const sorted = [...parts].sort((a, b) => center(a) - center(b));
        const first = center(sorted[0]!);
        const step = (center(sorted[sorted.length - 1]!) - first) / (sorted.length - 1);
        sorted.forEach((part, index) => {
            const to = snapToGrid(first + step * index);
            offsets.set(part.id, level ? { x: to - part.x, y: 0 } : { x: 0, y: to - part.y });
        });
    } else {
        for (const part of parts) {
            const box = boxes.get(part.id)!;
            const middle = (box: Box) => ({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 });
            const dx = { left: all.x0 - box.x0, center: middle(all).x - middle(box).x, right: all.x1 - box.x1 }[
                how as "left" | "center" | "right"
            ];
            const dy = { top: all.y0 - box.y0, middle: middle(all).y - middle(box).y, bottom: all.y1 - box.y1 }[
                how as "top" | "middle" | "bottom"
            ];
            offsets.set(part.id, { x: snapToGrid(dx ?? 0), y: snapToGrid(dy ?? 0) });
        }
    }
    const moved: Drawing = {
        ...drawing,
        parts: drawing.parts.map((part) => {
            const by = offsets.get(part.id);
            return by ? { ...part, x: part.x + by.x, y: part.y + by.y } : part;
        }),
    };
    return followParts(drawing, moved, new Set(offsets.keys()));
}

/** The box around everything drawn (or just these parts and lines), a little room around it. */
export function drawingBox(drawing: Drawing, only: Set<string> | null = null): Box | null {
    const parts = partsById(drawing);
    const lines = only ? drawing.lines.filter((line) => only.has(line.id)) : drawing.lines;
    const points = lines.flatMap((line) => runOf(parts, line) ?? []);
    const box = union([
        ...drawing.parts.filter((part) => !only || only.has(part.id)).map((part) => boxOf(part, drawing)),
        ...points.map((point) => ({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })),
    ]);
    return box ? grow(box, 40) : null;
}
