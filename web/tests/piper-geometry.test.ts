import { expect, test } from "vitest";
import { newPart, type Point, type Rotation } from "../src/piper/drawing";
import {
    dirOf,
    GRID,
    nearestOnPolyline,
    OPPOSITE,
    orthogonal,
    simplify,
    toLocal,
    toWorld,
    turnDir,
    worldBox,
    type Box,
} from "../src/piper/geometry";
import { pathsWithHops } from "../src/piper/hops";
import { route, STUB } from "../src/piper/route";

// A drawing's geometry: parts' frames, the polylines lines are, routing them, and their hops.

const part = (x: number, y: number, rotation: Rotation = 0, flip = false) =>
    newPart("valve", { x, y }, { rotation, flip });

/** Whether a path runs through a box's inside (along its edge is fine). */
function through(path: Point[], box: Box): boolean {
    return path.slice(1).some((b, index) => {
        const a = path[index]!;
        return a.y === b.y
            ? a.y > box.y0 && a.y < box.y1 && Math.min(a.x, b.x) < box.x1 && Math.max(a.x, b.x) > box.x0
            : a.x > box.x0 && a.x < box.x1 && Math.min(a.y, b.y) < box.y1 && Math.max(a.y, b.y) > box.y0;
    });
}

/** Whether a path turns back on itself: straight back, or round a step of less than half a grid, which reads the same. */
function turnsBack(path: Point[]): boolean {
    const runs = path.slice(1).map((b, index) => {
        const a = path[index]!;
        return { dir: dirOf(a, b)!, length: Math.abs(b.x - a.x) + Math.abs(b.y - a.y) };
    });
    return runs.some(({ dir }, index) => {
        const [next, after] = [runs[index + 1], runs[index + 2]];
        return next?.dir === OPPOSITE[dir] || (!!next && next.length < GRID / 2 && after?.dir === OPPOSITE[dir]);
    });
}

test("a part's frame turns clockwise, as SVG turns, and flips before it turns", () => {
    expect(toWorld(part(100, 50), { x: 20, y: 0 })).toEqual({ x: 120, y: 50 });
    expect(toWorld(part(100, 50, 90), { x: 20, y: 0 })).toEqual({ x: 100, y: 70 }); // right turns down
    expect(toWorld(part(100, 50, 180), { x: 20, y: 0 })).toEqual({ x: 80, y: 50 });
    expect(toWorld(part(100, 50, 270), { x: 20, y: 0 })).toEqual({ x: 100, y: 30 });
    expect(toWorld(part(100, 50, 0, true), { x: 20, y: 5 })).toEqual({ x: 80, y: 55 });
    expect(toWorld(part(100, 50, 90, true), { x: 20, y: 0 })).toEqual({ x: 100, y: 30 });
    expect(turnDir(part(0, 0, 90), "right")).toBe("down");
    expect(turnDir(part(0, 0, 90, true), "right")).toBe("up");
    expect(turnDir(part(0, 0, 270), "up")).toBe("left");
});

test("toLocal undoes toWorld, however a part's turned or flipped", () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
        for (const flip of [false, true]) {
            const placed = part(30, -40, rotation, flip);
            const local = { x: 17, y: -6 };
            expect(toLocal(placed, toWorld(placed, local))).toEqual(local);
        }
    }
});

test("a turned part's box is the box around its turned corners", () => {
    expect(worldBox(part(0, 0, 90), [-20, -30, 20, 10])).toEqual({ x0: -10, y0: -20, x1: 30, y1: 20 });
});

test("polylines are kept to their corners, and made orthogonal the way they head", () => {
    const points: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 20 },
    ];
    expect(simplify(points)).toEqual([
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 20 },
    ]);
    // A diagonal gets a bend: across first for a line heading across, down first for one heading down.
    expect(
        orthogonal(
            [
                { x: 0, y: 0 },
                { x: 40, y: 30 },
            ],
            "right",
        ),
    ).toEqual([
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 30 },
    ]);
    expect(
        orthogonal(
            [
                { x: 0, y: 0 },
                { x: 40, y: 30 },
            ],
            "down",
        ),
    ).toEqual([
        { x: 0, y: 0 },
        { x: 0, y: 30 },
        { x: 40, y: 30 },
    ]);
});

test("a polyline's nearest point", () => {
    const run = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 40 },
    ];
    expect(nearestOnPolyline({ x: 30, y: 6 }, run)).toEqual({ at: { x: 30, y: 0 }, distance: 6, segment: 0 });
    expect(nearestOnPolyline({ x: 108, y: 30 }, run)?.segment).toBe(1);
});

test("a route between ports facing each other on a line is that line", () => {
    expect(route({ at: { x: 0, y: 0 }, dir: "right" }, { at: { x: 100, y: 0 }, dir: "left" }, [])).toEqual([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
    ]);
});

test("a route leaves each port the way it faces, and arrives straight into the other", () => {
    const path = route({ at: { x: 0, y: 0 }, dir: "right" }, { at: { x: 100, y: 100 }, dir: "up" }, []);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[1]!.y).toBe(0); // out to the right first
    expect(path[path.length - 1]).toEqual({ x: 100, y: 100 });
    expect(path[path.length - 2]!.x).toBe(100); // in from above
    expect(path).toHaveLength(3); // one bend: the fewest there can be
});

test("a route goes around a part in its way, never through it", () => {
    const box = { x0: 40, y0: -30, x1: 60, y1: 30 };
    const path = route({ at: { x: 0, y: 0 }, dir: "right" }, { at: { x: 100, y: 0 }, dir: "left" }, [box]);
    expect(through(path, box), JSON.stringify(path)).toBe(false);
    expect(path[path.length - 1]).toEqual({ x: 100, y: 0 });
});

test("a route out of a port with a part close in front of it turns between them, not in the part", () => {
    const box = { x0: 12, y0: -30, x1: 52, y1: 30 }; // closer than a stub's length
    const path = route({ at: { x: 0, y: 0 }, dir: "right" }, { at: { x: 100, y: -100 }, dir: null }, [box]);
    expect(path[1]).toEqual({ x: 6, y: 0 }); // halfway to it
    expect(through(path, box), JSON.stringify(path)).toBe(false);
});

test("a route to an end with a part over it goes into the part, not back over itself", () => {
    // A line's free end, above its port, that a part's been dropped on.
    const box = { x0: -20, y0: -60, x1: 20, y1: -20 };
    const path = route({ at: { x: 0, y: 0 }, dir: "down" }, { at: { x: 0, y: -40 }, dir: null }, [box]);
    expect(path[1]).toEqual({ x: 0, y: STUB }); // out the way it faces
    expect(path[path.length - 1]).toEqual({ x: 0, y: -40 });
    expect(turnsBack(path), JSON.stringify(path)).toBe(false);
});

test("a route between ends a hair out of line turns round beside its stub, not through the hair", () => {
    // A port facing up, and a free end just below it, a hair aside (as Visio places them), nothing near.
    const path = route({ at: { x: 0, y: 0 }, dir: "up" }, { at: { x: 0.04, y: 30 }, dir: null }, []);
    expect(path[1]).toEqual({ x: 0, y: -STUB });
    expect(turnsBack(path), JSON.stringify(path)).toBe(false);
    // Round close by, not off round the far side of all it looks at.
    expect(Math.max(...path.map((point) => Math.abs(point.x)))).toBeLessThanOrEqual(STUB);
});

test("a route with no way clear to its end still never goes back down its stub", () => {
    // Its end walled in, behind the port: no way to it is clear, so it's the plainest way there, through a wall.
    const walls = [
        { x0: -140, y0: 20, x1: -60, y1: 30 },
        { x0: -140, y0: 90, x1: -60, y1: 100 },
        { x0: -140, y0: 20, x1: -130, y1: 100 },
        { x0: -70, y0: 20, x1: -60, y1: 100 },
    ];
    const path = route({ at: { x: 0, y: 0 }, dir: "right" }, { at: { x: -100, y: 60 }, dir: null }, walls);
    expect(path[1]).toEqual({ x: STUB, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: -100, y: 60 });
    expect(turnsBack(path), JSON.stringify(path)).toBe(false);
});

test("a route keeps off other lines where it can, rather than running along them", () => {
    // From a tee on a line across, to a port below and to the left: down first, not back along the line.
    const busy = [
        [
            { x: -200, y: 0 },
            { x: 0, y: 0 },
        ],
    ];
    const path = route({ at: { x: 0, y: 0 }, dir: null }, { at: { x: -120, y: 100 }, dir: "up" }, [], busy);
    expect(path[1]).toEqual({ x: 0, y: path[1]!.y });
    expect(path[1]!.y).toBeGreaterThan(0);
});

test("lines hop over lines they cross going down, but not over those they meet", () => {
    const paths = pathsWithHops(
        new Map([
            [
                "across",
                [
                    { x: 0, y: 50 },
                    { x: 100, y: 50 },
                ],
            ],
            [
                "down",
                [
                    { x: 50, y: 0 },
                    { x: 50, y: 100 },
                ],
            ],
            [
                "tee",
                [
                    { x: 80, y: 50 },
                    { x: 80, y: 90 },
                ],
            ],
        ]),
    );
    expect(paths.get("across")).toBe("M0 50 L46 50 A4 4 0 0 1 54 50 L100 50");
    expect(paths.get("down")).toBe("M50 0 L50 100");
    expect(paths.get("tee")).toBe("M80 50 L80 90");
});
