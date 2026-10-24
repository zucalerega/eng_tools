import type { Point } from "./drawing";
import {
    dirOf,
    GRID,
    isLevel,
    OPPOSITE,
    samePoint,
    simplify,
    snapToGrid,
    VECTORS,
    type Box,
    type Dir,
} from "./geometry";

// Routing a line: out of each port the way it faces, then the shortest way with the fewest bends that doesn't cross a
// part. A* over the lines a route could take: those through its ends, and those just clear of each part's sides (an
// orthogonal visibility graph), where a bend costs as much as three grid squares of length. Its bends are kept in the
// drawing, so a line stays as it was routed until its ends move.

/** Where a route starts or ends: a point, and the way the line leaves it (null: any way, as from a junction). */
export interface RouteEnd {
    at: Point;
    dir: Dir | null;
}

export const STUB = 20; // how far a line goes straight out of a port before it may turn
const CLEAR = 10; // how far a route keeps from a part's side
const BEND = 30; // a bend's cost, in units of length
const ALONG = 3; // what running along another line costs, on top of its length: a detour of up to three times as far
const AROUND = 200; // how far beyond its ends a route looks for its way

const HEADINGS: Dir[] = ["right", "left", "down", "up"];

/** Whether an axis-aligned segment passes through a box's inside (along its edge is fine). */
function crosses(a: Point, b: Point, box: Box): boolean {
    if (Math.abs(a.y - b.y) < 1e-6) {
        const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
        return a.y > box.y0 + 1e-6 && a.y < box.y1 - 1e-6 && x0 < box.x1 - 1e-6 && x1 > box.x0 + 1e-6;
    }
    const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
    return a.x > box.x0 + 1e-6 && a.x < box.x1 - 1e-6 && y0 < box.y1 - 1e-6 && y1 > box.y0 + 1e-6;
}

const inside = (point: Point, box: Box): boolean =>
    point.x > box.x0 + 1e-6 && point.x < box.x1 - 1e-6 && point.y > box.y0 + 1e-6 && point.y < box.y1 - 1e-6;

const stubOf = (end: RouteEnd): Point =>
    end.dir ? { x: end.at.x + VECTORS[end.dir].x * STUB, y: end.at.y + VECTORS[end.dir].y * STUB } : end.at;

/**
 * A route from one end to the other, around the boxes: its points, both ends included. busy: the other lines' routes,
 * which it keeps off of where it can (running along one would read as one line), though it may cross them.
 */
export function route(from: RouteEnd, to: RouteEnd, boxes: Box[], busy: Point[][] = []): Point[] {
    if (samePoint(from.at, to.at)) {
        return [from.at];
    }
    const straight = dirOf(from.at, to.at);
    const aligned = Math.abs(from.at.x - to.at.x) < 1e-6 || Math.abs(from.at.y - to.at.y) < 1e-6;
    if (
        straight &&
        aligned &&
        (from.dir === null || from.dir === straight) &&
        (to.dir === null || to.dir === OPPOSITE[straight]) &&
        !boxes.some((box) => crosses(from.at, to.at, box)) &&
        overlap(from.at, to.at, runsAlong(busy)) === 0
    ) {
        return [from.at, to.at];
    }
    const start = stubOf(from);
    const end = stubOf(to);
    const found = search(start, from.dir, end, to.dir ? OPPOSITE[to.dir] : null, boxes, runsAlong(busy));
    return simplify([from.at, ...(found ?? elbow(start, end, from.dir)), to.at]);
}

/** Where other lines run: their level segments by the y they're at, and their upright ones by their x. */
interface Runs {
    level: Map<number, [number, number][]>;
    upright: Map<number, [number, number][]>;
}

function runsAlong(lines: Point[][]): Runs {
    const runs: Runs = { level: new Map(), upright: new Map() };
    for (const points of lines) {
        for (let index = 0; index + 1 < points.length; index++) {
            const a = points[index]!;
            const b = points[index + 1]!;
            if (Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) > 1e-6) {
                const key = lane(a.y);
                runs.level.set(key, [...(runs.level.get(key) ?? []), [Math.min(a.x, b.x), Math.max(a.x, b.x)]]);
            } else if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
                const key = lane(a.x);
                runs.upright.set(key, [...(runs.upright.get(key) ?? []), [Math.min(a.y, b.y), Math.max(a.y, b.y)]]);
            }
        }
    }
    return runs;
}

/** How much of an axis-aligned segment runs along other lines. */
function overlap(a: Point, b: Point, runs: Runs): number {
    const level = Math.abs(a.y - b.y) < 1e-6;
    const along = level ? runs.level.get(lane(a.y)) : runs.upright.get(lane(a.x));
    if (!along) {
        return 0;
    }
    const [lo, hi] = level ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return along.reduce((total, [x0, x1]) => total + Math.max(0, Math.min(hi, x1) - Math.max(lo, x0)), 0);
}

/** The plainest way between two points: one bend, or two if both ends go the same way. */
function elbow(start: Point, end: Point, heading: Dir | null): Point[] {
    if (Math.abs(start.x - end.x) < 1e-6 || Math.abs(start.y - end.y) < 1e-6) {
        return [start, end];
    }
    return heading === null || isLevel(heading)
        ? [start, { x: end.x, y: start.y }, end]
        : [start, { x: start.x, y: end.y }, end];
}

interface Step {
    cost: number; // so far
    guess: number; // cost + what's left at the least
    node: number; // i + j * xs.length
    heading: number; // an index into HEADINGS, or 4 for none yet
    from: Step | null;
    done: boolean; // it's at the end, its cost counting the bend to arrive the right way
}

/** A binary heap of steps, the cheapest guess first. */
class Queue {
    private readonly items: Step[] = [];

    get size(): number {
        return this.items.length;
    }

    push(step: Step): void {
        const items = this.items;
        items.push(step);
        let at = items.length - 1;
        while (at > 0) {
            const parent = (at - 1) >> 1;
            if (items[parent]!.guess <= step.guess) {
                break;
            }
            items[at] = items[parent]!;
            at = parent;
        }
        items[at] = step;
    }

    pop(): Step {
        const items = this.items;
        const top = items[0]!;
        const last = items.pop()!;
        if (items.length > 0) {
            let at = 0;
            for (;;) {
                const left = at * 2 + 1;
                const right = left + 1;
                let least = at;
                const leastGuess = () => (least === at ? last.guess : items[least]!.guess);
                if (left < items.length && items[left]!.guess < leastGuess()) {
                    least = left;
                }
                if (right < items.length && items[right]!.guess < leastGuess()) {
                    least = right;
                }
                if (least === at) {
                    break;
                }
                items[at] = items[least]!;
                at = least;
            }
            items[at] = last;
        }
        return top;
    }
}

/** A coordinate as a lane's: to a thousandth, so the same place is the same lane however it was worked out. */
const lane = (value: number): number => Math.round(value * 1000) / 1000;

/** The lines a route may run along (through its ends, between them, and just clear of each box's sides), in order. */
const lanes = (values: number[]): number[] => [...new Set(values.map(lane))].sort((a, b) => a - b);

/**
 * The cheapest way from start (going the way it's heading, if it is) to end (arriving the way it should), or null if
 * there's none: its points.
 */
function search(
    start: Point,
    heading: Dir | null,
    end: Point,
    arrive: Dir | null,
    boxes: Box[],
    runs: Runs,
): Point[] | null {
    const area: Box = {
        x0: Math.min(start.x, end.x) - AROUND,
        y0: Math.min(start.y, end.y) - AROUND,
        x1: Math.max(start.x, end.x) + AROUND,
        y1: Math.max(start.y, end.y) + AROUND,
    };
    const near = boxes.filter((box) => box.x0 < area.x1 && box.x1 > area.x0 && box.y0 < area.y1 && box.y1 > area.y0);
    const xs = lanes([
        start.x,
        end.x,
        snapToGrid((start.x + end.x) / 2),
        area.x0,
        area.x1,
        ...near.flatMap((box) => [snapToGrid(box.x0 - CLEAR, GRID), snapToGrid(box.x1 + CLEAR, GRID)]),
    ]);
    const ys = lanes([
        start.y,
        end.y,
        snapToGrid((start.y + end.y) / 2),
        area.y0,
        area.y1,
        ...near.flatMap((box) => [snapToGrid(box.y0 - CLEAR, GRID), snapToGrid(box.y1 + CLEAR, GRID)]),
    ]);
    const width = xs.length;
    const point = (node: number): Point => ({ x: xs[node % width]!, y: ys[Math.floor(node / width)]! });
    const startNode = xs.indexOf(lane(start.x)) + ys.indexOf(lane(start.y)) * width;
    const endNode = xs.indexOf(lane(end.x)) + ys.indexOf(lane(end.y)) * width;
    const open = (node: number): boolean =>
        node === startNode || node === endNode || !near.some((box) => inside(point(node), box));
    // Whether the way from a node to the next one across (or down) is clear, worked out once each.
    const across = new Int8Array(xs.length * ys.length).fill(-1);
    const down = new Int8Array(xs.length * ys.length).fill(-1);
    const clear = (memo: Int8Array, a: number, b: number): boolean => {
        if (memo[a] === -1) {
            memo[a] = near.some((box) => crosses(point(a), point(b), box)) ? 0 : 1;
        }
        return memo[a] === 1;
    };
    const step = (node: number, dir: Dir): number | null => {
        const i = node % width;
        const j = Math.floor(node / width);
        switch (dir) {
            case "right":
                return i + 1 < width && clear(across, node, node + 1) ? node + 1 : null;
            case "left":
                return i > 0 && clear(across, node - 1, node) ? node - 1 : null;
            case "down":
                return j + 1 < ys.length && clear(down, node, node + width) ? node + width : null;
            case "up":
                return j > 0 && clear(down, node - width, node) ? node - width : null;
        }
    };

    const target = point(endNode);
    const best = new Map<number, number>(); // node * 5 + heading: the least cost it's been reached at
    const queue = new Queue();
    const first = heading ? HEADINGS.indexOf(heading) : 4;
    queue.push({ cost: 0, guess: 0, node: startNode, heading: first, from: null, done: false });
    best.set(startNode * 5 + first, 0);
    while (queue.size > 0) {
        const current = queue.pop();
        if (current.done) {
            return trace(current, point);
        }
        if (current.cost > (best.get(current.node * 5 + current.heading) ?? Infinity)) {
            continue; // reached more cheaply since
        }
        if (current.node === endNode) {
            // Arriving the wrong way costs the bend it takes to go in the right way: it's done once nothing in the
            // queue could arrive for less.
            const last = current.heading === 4 ? null : HEADINGS[current.heading]!;
            const late = arrive !== null && last !== null && last !== arrive ? BEND : 0;
            if (late === 0) {
                return trace(current, point);
            }
            queue.push({ ...current, cost: current.cost + late, guess: current.cost + late, done: true });
            continue;
        }
        for (let next = 0; next < 4; next++) {
            const dir = HEADINGS[next]!;
            if (current.heading !== 4 && dir === OPPOSITE[HEADINGS[current.heading]!]) {
                continue; // never straight back
            }
            const node = step(current.node, dir);
            if (node === null || !open(node)) {
                continue;
            }
            const from = point(current.node);
            const to = point(node);
            const turn = current.heading !== 4 && current.heading !== next ? BEND : 0;
            const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
            const cost = current.cost + length + turn + ALONG * overlap(from, to, runs);
            const key = node * 5 + next;
            if (cost < (best.get(key) ?? Infinity)) {
                best.set(key, cost);
                const left = Math.abs(target.x - to.x) + Math.abs(target.y - to.y);
                queue.push({ cost, guess: cost + left, node, heading: next, from: current, done: false });
            }
        }
    }
    return null;
}

function trace(last: Step, point: (node: number) => Point): Point[] {
    const points: Point[] = [];
    for (let step: Step | null = last; step; step = step.from) {
        const at = point(step.node);
        if (!points[0] || !samePoint(points[0], at)) {
            points.unshift(at);
        }
    }
    return points;
}
