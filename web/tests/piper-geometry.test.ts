import { expect, test } from "vitest";
import { newPart, type Point, type Rotation } from "../src/piper/drawing";
import { nearestOnPolyline, orthogonal, simplify, toLocal, toWorld, turnDir, worldBox } from "../src/piper/geometry";
import { pathsWithHops } from "../src/piper/hops";
import { route } from "../src/piper/route";

// A drawing's geometry: parts' frames, the polylines lines are, routing them, and their hops.

const part = (x: number, y: number, rotation: Rotation = 0, flip = false) =>
    newPart("valve", { x, y }, { rotation, flip });

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
    for (let index = 0; index + 1 < path.length; index++) {
        const a = path[index]!;
        const b = path[index + 1]!;
        const level = a.y === b.y;
        const crosses = level
            ? a.y > box.y0 && a.y < box.y1 && Math.min(a.x, b.x) < box.x1 && Math.max(a.x, b.x) > box.x0
            : a.x > box.x0 && a.x < box.x1 && Math.min(a.y, b.y) < box.y1 && Math.max(a.y, b.y) > box.y0;
        expect(crosses, `segment ${JSON.stringify([a, b])}`).toBe(false);
    }
    expect(path[path.length - 1]).toEqual({ x: 100, y: 0 });
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
