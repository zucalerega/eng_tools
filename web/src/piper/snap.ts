import { isPortEnd, type Drawing, type Point } from "./drawing";
import { snapToGrid } from "./geometry";
import { partsById, placeEnd, portsOf } from "./ports";

// Snapping a drag: parts move on the grid, and, near enough, line their ports up with the ports their lines go to and
// their centers with other parts' centers, showing the guide they snapped to.

/** A guide drawn while dragging: a line across (y) or down (x) the drawing, through what it lined up with. */
export interface Guide {
    x?: number;
    y?: number;
    from: number; // where it starts and ends along its line
    to: number;
}

export interface Snapped {
    by: Point;
    guides: Guide[];
}

/**
 * Where a drag of parts snaps: by, their move as the pointer has it; reach, how near (in the drawing's units) a line-up
 * has to be to take it; anchor: the part the drag started on, whose center snaps to the grid.
 */
export function snapMove(drawing: Drawing, moving: Set<string>, anchor: string, by: Point, reach: number): Snapped {
    const parts = partsById(drawing);
    const start = parts.get(anchor);
    if (!start) {
        return { by, guides: [] };
    }
    // The grid first: the anchor's center on it, so everything moving with it stays where the grid had it.
    const grid = { x: snapToGrid(start.x + by.x) - start.x, y: snapToGrid(start.y + by.y) - start.y };
    let best: { x: { at: number; guide: Guide } | null; y: { at: number; guide: Guide } | null } = { x: null, y: null };
    const consider = (axis: "x" | "y", moved: number, target: number, guide: Guide) => {
        const shift = target - moved; // what the drag's move along the axis would be, to line up
        const now = best[axis];
        if (Math.abs(shift - by[axis]) <= reach && (!now || Math.abs(shift - by[axis]) < Math.abs(now.at - by[axis]))) {
            best = { ...best, [axis]: { at: shift, guide } };
        }
    };
    // Ports their lines go to, on parts that stay: lined up, the lines between them run straight.
    for (const line of drawing.lines) {
        for (const [near, far] of [
            [line.from, line.to],
            [line.to, line.from],
        ] as const) {
            if (!isPortEnd(near) || !moving.has(near.part) || (isPortEnd(far) && moving.has(far.part))) {
                continue;
            }
            const mine = placeEnd(parts, near);
            const theirs = placeEnd(parts, far);
            if (!mine || !theirs) {
                continue;
            }
            consider("x", mine.at.x, theirs.at.x, { x: theirs.at.x, from: mine.at.y + by.y, to: theirs.at.y });
            consider("y", mine.at.y, theirs.at.y, { y: theirs.at.y, from: mine.at.x + by.x, to: theirs.at.x });
        }
    }
    // Other parts' centers, and their ports: things lined up with each other read as one system.
    const others = drawing.parts.filter((part) => !moving.has(part.id) && part.kind !== "junction").slice(0, 400);
    for (const other of others) {
        consider("x", start.x, other.x, { x: other.x, from: start.y + by.y, to: other.y });
        consider("y", start.y, other.y, { y: other.y, from: start.x + by.x, to: other.x });
    }
    const theirPorts = others.flatMap(portsOf);
    for (const port of portsOf(start)) {
        for (const theirs of theirPorts) {
            consider("x", port.at.x, theirs.at.x, { x: theirs.at.x, from: port.at.y + by.y, to: theirs.at.y });
            consider("y", port.at.y, theirs.at.y, { y: theirs.at.y, from: port.at.x + by.x, to: theirs.at.x });
        }
    }
    const snapped = { x: best.x?.at ?? grid.x, y: best.y?.at ?? grid.y };
    const guides = [best.x?.guide, best.y?.guide].filter((guide) => guide !== undefined);
    // A guide runs from the moved thing to what it lined up with, wherever the other axis snapped to.
    return {
        by: snapped,
        guides: guides.map((guide) =>
            guide.x !== undefined
                ? { ...guide, from: guide.from - by.y + snapped.y }
                : { ...guide, from: guide.from - by.x + snapped.x },
        ),
    };
}
