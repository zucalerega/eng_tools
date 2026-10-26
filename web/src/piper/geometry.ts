import type { Part, Point } from "./drawing";

// The drawing's geometry: a 10-unit grid that parts' centers, ports, and lines' bends sit on; parts' own frames (each
// kind is drawn centered, unturned) and the drawing's; boxes; and the orthogonal polylines lines are.

export const GRID = 10;

export type Dir = "left" | "right" | "up" | "down";

export const VECTORS: Record<Dir, Point> = {
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
};

export const OPPOSITE: Record<Dir, Dir> = { left: "right", right: "left", up: "down", down: "up" };

export const isLevel = (dir: Dir): boolean => dir === "left" || dir === "right";

export const snapToGrid = (value: number, grid = GRID): number => Math.round(value / grid) * grid;

export const snapPoint = (point: Point, grid = GRID): Point => ({
    x: snapToGrid(point.x, grid),
    y: snapToGrid(point.y, grid),
});

export const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The way from a to b along an axis (the larger of its two moves), or null where they're the same point. */
export function dirOf(a: Point, b: Point): Dir | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
        return null;
    }
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx > 0 ? "right" : "left";
    }
    return dy > 0 ? "down" : "up";
}

type Placed = Pick<Part, "x" | "y" | "rotation" | "flip"> & { scale?: number };

/** A point of a part's own frame (centered, unturned) in the drawing: flipped, turned clockwise, then moved there. */
export function toWorld(part: Placed, local: Point): Point {
    const scale = part.scale ?? 1;
    const x = (part.flip ? -local.x : local.x) * scale;
    const y = local.y * scale;
    switch (part.rotation) {
        case 90:
            return { x: part.x - y, y: part.y + x };
        case 180:
            return { x: part.x - x, y: part.y - y };
        case 270:
            return { x: part.x + y, y: part.y - x };
        default:
            return { x: part.x + x, y: part.y + y };
    }
}

/** A point of the drawing in a part's own frame: toWorld undone. */
export function toLocal(part: Placed, world: Point): Point {
    const dx = world.x - part.x;
    const dy = world.y - part.y;
    let x: number;
    let y: number;
    switch (part.rotation) {
        case 90:
            [x, y] = [dy, -dx];
            break;
        case 180:
            [x, y] = [-dx, -dy];
            break;
        case 270:
            [x, y] = [-dy, dx];
            break;
        default:
            [x, y] = [dx, dy];
    }
    const scale = part.scale ?? 1;
    return { x: (part.flip ? -x : x) / scale, y: y / scale };
}

/** A way a part's frame faces, in the drawing. */
export function turnDir(part: Placed, dir: Dir): Dir {
    const at = toWorld({ x: 0, y: 0, rotation: part.rotation, flip: part.flip }, VECTORS[dir]);
    return dirOf({ x: 0, y: 0 }, at) ?? dir;
}

/** The SVG transform that draws a part's own frame where it is. */
export const partTransform = (part: Placed): string =>
    `translate(${part.x} ${part.y}) rotate(${part.rotation})${part.flip ? " scale(-1 1)" : ""}${
        (part.scale ?? 1) !== 1 ? ` scale(${part.scale})` : ""
    }`;

/**
 * The transform for something drawn in a part's frame at (x, y) that should read upright however the part is turned
 * or flipped: its letters, a gauge's numbers. It undoes the part's turn and flip around that point.
 */
export const upright = (part: Pick<Part, "rotation" | "flip">, x: number, y: number): string =>
    `translate(${x} ${y})${part.flip ? " scale(-1 1)" : ""} rotate(${-part.rotation}) translate(${-x} ${-y})`;

/** A box: left, top, right, bottom. */
export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** A box in a part's own frame, in the drawing (the box around its turned corners). */
export function worldBox(part: Placed, [x0, y0, x1, y1]: readonly [number, number, number, number]): Box {
    const corners = [
        toWorld(part, { x: x0, y: y0 }),
        toWorld(part, { x: x1, y: y0 }),
        toWorld(part, { x: x1, y: y1 }),
        toWorld(part, { x: x0, y: y1 }),
    ];
    return {
        x0: Math.min(...corners.map((corner) => corner.x)),
        y0: Math.min(...corners.map((corner) => corner.y)),
        x1: Math.max(...corners.map((corner) => corner.x)),
        y1: Math.max(...corners.map((corner) => corner.y)),
    };
}

export const grow = (box: Box, by: number): Box => ({
    x0: box.x0 - by,
    y0: box.y0 - by,
    x1: box.x1 + by,
    y1: box.y1 + by,
});

export function union(boxes: Box[]): Box | null {
    if (boxes.length === 0) {
        return null;
    }
    return {
        x0: Math.min(...boxes.map((box) => box.x0)),
        y0: Math.min(...boxes.map((box) => box.y0)),
        x1: Math.max(...boxes.map((box) => box.x1)),
        y1: Math.max(...boxes.map((box) => box.y1)),
    };
}

export const boxOfPoints = (points: Point[]): Box | null =>
    union(points.map((point) => ({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })));

export const inBox = (point: Point, box: Box): boolean =>
    point.x >= box.x0 && point.x <= box.x1 && point.y >= box.y0 && point.y <= box.y1;

/** Whether two boxes overlap (touching counts). */
export const meets = (a: Box, b: Box): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

// --- polylines ---------------------------------------------------------------------------------------------------

/** The nearest point to p on the segment from a to b, and how far along it (0 at a, 1 at b). */
export function nearestOnSegment(p: Point, a: Point, b: Point): { at: Point; t: number } {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
    return { at: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

/** Points with the ones repeated, and those in a straight run between two others, left out. */
export function simplify(points: Point[]): Point[] {
    const kept: Point[] = [];
    for (const point of points) {
        const last = kept[kept.length - 1];
        if (last && samePoint(last, point)) {
            continue;
        }
        const before = kept[kept.length - 2];
        if (before && last && collinear(before, last, point)) {
            kept[kept.length - 1] = point;
        } else {
            kept.push(point);
        }
    }
    return kept;
}

/** Whether b is on the straight run from a to c, going on the same way (not doubling back). */
function collinear(a: Point, b: Point, c: Point): boolean {
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    return Math.abs(cross) < 1e-6 && dot >= 0;
}

/**
 * A polyline made orthogonal: where two points aren't on a line across or down, a bend between them, turning the way
 * the run comes from (so a line leaving a port goes on out of it first). first: the way the polyline starts out.
 */
export function orthogonal(points: Point[], first: Dir | null = null): Point[] {
    const made: Point[] = [];
    let heading: Dir | null = first;
    for (const point of points) {
        const last = made[made.length - 1];
        if (last && Math.abs(last.x - point.x) > 1e-6 && Math.abs(last.y - point.y) > 1e-6) {
            // Go on the way it's heading, then turn: across first if it was going across (or hadn't started).
            const across = heading === null || isLevel(heading);
            made.push(across ? { x: point.x, y: last.y } : { x: last.x, y: point.y });
        }
        const before = made[made.length - 1];
        made.push(point);
        heading = before ? (dirOf(before, point) ?? heading) : heading;
    }
    return simplify(made);
}

export interface Segment {
    a: Point;
    b: Point;
    index: number; // its place in the polyline: from point index to index + 1
}

export function segmentsOf(points: Point[]): Segment[] {
    const found: Segment[] = [];
    for (let index = 0; index + 1 < points.length; index++) {
        found.push({ a: points[index]!, b: points[index + 1]!, index });
    }
    return found;
}

export const lengthOf = (points: Point[]): number =>
    segmentsOf(points).reduce((total, segment) => total + distance(segment.a, segment.b), 0);

/** The middle of a polyline's longest segment, whether it goes across, and how long it is: where a line's label goes. */
export function middleOfLongest(points: Point[]): { at: Point; level: boolean; length: number } | null {
    let best: Segment | null = null;
    for (const segment of segmentsOf(points)) {
        if (!best || distance(segment.a, segment.b) > distance(best.a, best.b) + 1e-6) {
            best = segment;
        }
    }
    if (!best) {
        return null;
    }
    return {
        at: { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 },
        level: Math.abs(best.a.y - best.b.y) < 1e-6,
        length: distance(best.a, best.b),
    };
}

/** The nearest point to p on a polyline, its distance, and the segment it's on. */
export function nearestOnPolyline(p: Point, points: Point[]): { at: Point; distance: number; segment: number } | null {
    let best: { at: Point; distance: number; segment: number } | null = null;
    for (const segment of segmentsOf(points)) {
        const { at } = nearestOnSegment(p, segment.a, segment.b);
        const away = distance(p, at);
        if (!best || away < best.distance) {
            best = { at, distance: away, segment: segment.index };
        }
    }
    return best;
}
