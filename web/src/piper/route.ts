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
export function crosses(a: Point, b: Point, box: Box): boolean {
    if (Math.abs(a.y - b.y) < 1e-6) {
        const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
        return a.y > box.y0 + 1e-6 && a.y < box.y1 - 1e-6 && x0 < box.x1 - 1e-6 && x1 > box.x0 + 1e-6;
    }
    const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
    return a.x > box.x0 + 1e-6 && a.x < box.x1 - 1e-6 && y0 < box.y1 - 1e-6 && y1 > box.y0 + 1e-6;
}

const inside = (point: Point, box: Box): boolean =>
    point.x > box.x0 + 1e-6 && point.x < box.x1 - 1e-6 && point.y > box.y0 + 1e-6 && point.y < box.y1 - 1e-6;

/**
 * Where a line out of an end may first turn: a stub out of a port, or a part in its way (one placed close in front of
 * it) halfway to that part, so the line turns between them rather than in it. A part over the port itself is no help
 * to stop short of: the line is in it either way.
 */
function stubOf(end: RouteEnd, boxes: Box[]): Point {
    if (!end.dir) {
        return end.at;
    }
    const { x: dx, y: dy } = VECTORS[end.dir];
    const out = (length: number): Point => ({ x: end.at.x + dx * length, y: end.at.y + dy * length });
    const length = boxes
        .filter((box) => !inside(end.at, box) && crosses(end.at, out(STUB), box))
        .reduce((least, box) => {
            const gap =
                dx > 0
                    ? box.x0 - end.at.x
                    : dx < 0
                      ? end.at.x - box.x1
                      : dy > 0
                        ? box.y0 - end.at.y
                        : end.at.y - box.y1;
            return Math.min(least, Math.max(0, gap) / 2);
        }, STUB);
    return out(length);
}

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
    const across = facing(from, to, boxes);
    if (across) {
        return across;
    }
    const start = stubOf(from, boxes);
    const end = stubOf(to, boxes);
    const found = search(start, from.dir, end, to.dir ? OPPOSITE[to.dir] : null, boxes, runsAlong(busy));
    // Its lanes are to a thousandth: on an end's own lane, it's on that end's exact coordinate, not a hair aside.
    const xs = [from.at.x, to.at.x];
    const ys = [from.at.y, to.at.y];
    const exact = (value: number, ends: number[]) => ends.find((end) => Math.abs(value - end) < 0.01) ?? value;
    const points = (found ?? elbow(start, end, from.dir)).map((point) => ({
        x: exact(point.x, xs),
        y: exact(point.y, ys),
    }));
    return simplify([from.at, ...points, to.at]);
}

/**
 * Two ports that face each other, off line, closer than a stub out of each (a valve beside a tank drawn bigger): a stub
 * from each would run past the other's, and the route come back. A Z instead, turning halfway across (on the grid, if
 * that's between them), if nothing's in its way; else null, for the search.
 */
function facing(from: RouteEnd, to: RouteEnd, boxes: Box[]): Point[] | null {
    if (!from.dir || !to.dir || OPPOSITE[from.dir] !== to.dir) {
        return null;
    }
    const level = isLevel(from.dir);
    const [a, b] = level ? [from.at.x, to.at.x] : [from.at.y, to.at.y];
    const gap = (b - a) * (level ? VECTORS[from.dir].x : VECTORS[from.dir].y);
    const off = level ? Math.abs(from.at.y - to.at.y) : Math.abs(from.at.x - to.at.x);
    // In line, they'd be joined straight, unless something's between them: that's the search's to go around.
    if (gap <= 0 || gap >= 2 * STUB || off < 1e-6) {
        return null;
    }
    const half = snapToGrid(a + (b - a) / 2);
    const middle = (half - a) * (b - half) > 0 ? half : a + (b - a) / 2;
    const points = level
        ? [from.at, { x: middle, y: from.at.y }, { x: middle, y: to.at.y }, to.at]
        : [from.at, { x: from.at.x, y: middle }, { x: to.at.x, y: middle }, to.at];
    // Its runs out of the ports are as stubs are, not looked at (a port of a part drawn bigger can sit just inside its
    // outline); the run between them has to be clear.
    const clear = !boxes.some((box) => crosses(points[1]!, points[2]!, box));
    return clear ? simplify(points) : null;
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

/**
 * The plainest way between two points, where the search found none clear: one bend, its first leg on the way it's
 * heading if that goes toward the end, else across it (not back down the stub it came out on).
 */
function elbow(start: Point, end: Point, heading: Dir | null): Point[] {
    if (Math.abs(start.x - end.x) < 1e-6 || Math.abs(start.y - end.y) < 1e-6) {
        return [start, end];
    }
    const level = { x: end.x, y: start.y };
    const upright = { x: start.x, y: end.y };
    const [first, other] = heading === null || isLevel(heading) ? [level, upright] : [upright, level];
    return [start, heading && dirOf(start, first) === OPPOSITE[heading] ? other : first, end];
}

interface Step {
    cost: number; // so far
    guess: number; // cost + what's left at the least
    node: number; // i + j * xs.length
    heading: number; // an index into HEADINGS, or 4 for none yet
    prior: number; // the heading before this one, the same way (4 for none)
    leg: number; // the node this heading began at
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

/**
 * The lines a route may run along (through its ends, between them, and just clear of each box's sides), in order. One
 * within half a grid of an end's is that end's: a part off the grid (as Visio places them) would otherwise have its
 * route step a hair aside to the grid and back, or turn around beside itself, through a lane a fraction of a unit away.
 */
function lanes(ends: number[], values: number[]): number[] {
    const kept = values.map((value) => ends.find((end) => Math.abs(value - end) <= GRID / 2) ?? value);
    return [...new Set([...ends, ...kept].map(lane))].sort((a, b) => a - b);
}

/**
 * Lanes a stub's length either side of an end, across the way the line goes out of it (if it goes across: a free end
 * goes both ways), where there's none within two: somewhere near to turn back by, where nothing beside it has sides to
 * go round (a figure drawn behind the lines, or nothing).
 */
function beside(values: number[], ...ends: [at: number, across: boolean][]): number[] {
    let found = values;
    for (const [at] of ends.filter(([, across]) => across)) {
        const here = lane(at);
        const room = (sign: number) =>
            !found.some((value) => sign * (value - here) > 0 && sign * (value - here) <= 2 * STUB);
        found = [...found, ...[1, -1].filter(room).map((sign) => lane(snapToGrid(at + sign * STUB)))];
    }
    return [...new Set(found)].sort((a, b) => a - b);
}

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
    // A part over an end (dropped on a port, or on a line's free end) can't be kept out of: the route goes into it, as
    // the line does, rather than finding no way. Its sides are still lanes, to go round it by.
    const blocking = near.filter((box) => !inside(start, box) && !inside(end, box));
    // Beside an end its line goes out of up or down, lanes to its left and right; out across, above and below it.
    const goes = (dir: Dir | null, level: boolean) => dir === null || isLevel(dir) === level;
    const xs = beside(
        lanes(
            [start.x, end.x],
            [
                snapToGrid((start.x + end.x) / 2),
                area.x0,
                area.x1,
                ...near.flatMap((box) => [snapToGrid(box.x0 - CLEAR, GRID), snapToGrid(box.x1 + CLEAR, GRID)]),
            ],
        ),
        [start.x, goes(heading, false)],
        [end.x, goes(arrive, false)],
    );
    const ys = beside(
        lanes(
            [start.y, end.y],
            [
                snapToGrid((start.y + end.y) / 2),
                area.y0,
                area.y1,
                ...near.flatMap((box) => [snapToGrid(box.y0 - CLEAR, GRID), snapToGrid(box.y1 + CLEAR, GRID)]),
            ],
        ),
        [start.y, goes(heading, true)],
        [end.y, goes(arrive, true)],
    );
    const width = xs.length;
    const point = (node: number): Point => ({ x: xs[node % width]!, y: ys[Math.floor(node / width)]! });
    const startNode = xs.indexOf(lane(start.x)) + ys.indexOf(lane(start.y)) * width;
    const endNode = xs.indexOf(lane(end.x)) + ys.indexOf(lane(end.y)) * width;
    const open = (node: number): boolean =>
        node === startNode || node === endNode || !blocking.some((box) => inside(point(node), box));
    // Whether the way from a node to the next one across (or down) is clear, worked out once each.
    const across = new Int8Array(xs.length * ys.length).fill(-1);
    const down = new Int8Array(xs.length * ys.length).fill(-1);
    const clear = (memo: Int8Array, a: number, b: number): boolean => {
        if (memo[a] === -1) {
            memo[a] = blocking.some((box) => crosses(point(a), point(b), box)) ? 0 : 1;
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
    queue.push({
        cost: 0,
        guess: 0,
        node: startNode,
        heading: first,
        prior: 4,
        leg: startNode,
        from: null,
        done: false,
    });
    // Whether turning a step's way would take it back the way it came before its last bend, beside itself: two ends a
    // hair out of line (as Visio places them) would otherwise turn round through the hair between them, which reads as
    // running back over itself. Half a grid across is the least that reads as turning round.
    const hairpin = (current: Step, dir: Dir): boolean => {
        if (current.prior === 4 || dir !== OPPOSITE[HEADINGS[current.prior]!]) {
            return false;
        }
        const [a, b] = [point(current.leg), point(current.node)];
        return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < GRID / 2;
    };
    best.set(startNode * 5 + first, 0);
    while (queue.size > 0) {
        const current = queue.pop();
        if (current.done) {
            return trace(current, point);
        }
        if (current.cost > (best.get(current.node * 5 + current.heading) ?? Infinity)) {
            continue; // reached more cheaply since
        }
        const last = current.heading === 4 ? null : HEADINGS[current.heading]!;
        // Come to it head on from the wrong side (past the port, as a line from below a port that faces up does), or a
        // hair aside of that, it can't go in from here: it would run back over itself, or beside itself. It goes on,
        // around.
        const backwards = arrive !== null && last !== null && (last === OPPOSITE[arrive] || hairpin(current, arrive));
        if (current.node === endNode && !backwards) {
            // Arriving the wrong way costs the bend it takes to go in the right way: it's done once nothing in the
            // queue could arrive for less.
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
            const turned = current.heading !== next;
            if (turned && hairpin(current, dir)) {
                continue;
            }
            const node = step(current.node, dir);
            if (node === null || !open(node)) {
                continue;
            }
            const from = point(current.node);
            const to = point(node);
            const turn = current.heading !== 4 && turned ? BEND : 0;
            const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
            const cost = current.cost + length + turn + ALONG * overlap(from, to, runs);
            const key = node * 5 + next;
            if (cost < (best.get(key) ?? Infinity)) {
                best.set(key, cost);
                const left = Math.abs(target.x - to.x) + Math.abs(target.y - to.y);
                queue.push({
                    cost,
                    guess: cost + left,
                    node,
                    heading: next,
                    prior: turned ? current.heading : current.prior,
                    leg: turned ? current.node : current.leg,
                    from: current,
                    done: false,
                });
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
