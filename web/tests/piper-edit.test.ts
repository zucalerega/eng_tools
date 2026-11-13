import { expect, test } from "vitest";
import {
    emptyDrawing,
    isPortEnd,
    newLine,
    readDrawing,
    type Drawing,
    type Line,
    type Part,
    type Point,
} from "../src/piper/drawing";
import {
    addPart,
    alignParts,
    carryFluid,
    connect,
    copyItems,
    deleteItems,
    insertIntoLine,
    moveItems,
    moveSegment,
    nextTag,
    pasteClip,
    reconnect,
    reorderParts,
    sharedTags,
    traced,
    turnParts,
    updateLine,
    updatePart,
} from "../src/piper/edit";
import { example } from "../src/piper/example";
import { presetOf } from "../src/piper/library/index";
import { runOf } from "../src/piper/edit";
import { dirOf } from "../src/piper/geometry";
import { route } from "../src/piper/route";
import { lineLabelPlaces } from "../src/piper/labels";
import { partsById, pathOf, placeEnd, portOf, portsOf } from "../src/piper/ports";
import { boxOf } from "../src/piper/library/index";

// The editor's changes to a drawing: placing and tagging parts, connecting them, tees, putting a part into a line,
// deleting (and joining a line up again), moving, and copying and pasting.

let drawing: Drawing;

function place(preset: string, x: number, y: number, change: Partial<Part> = {}): string {
    const added = addPart(drawing, presetOf(preset)!, { x, y });
    drawing = updatePart(added.drawing, added.id, (part) => ({
        ...part,
        ...change,
        props: { ...part.props, ...change.props },
    }));
    return added.id;
}

function join(from: [string, string], to: [string, string]): string {
    const made = connect(drawing, { part: from[0], port: from[1] }, { part: to[0], port: to[1] })!;
    drawing = made.drawing;
    return made.id;
}

const line = (id: string): Line => drawing.lines.find((entry) => entry.id === id)!;
const part = (id: string): Part => drawing.parts.find((entry) => entry.id === id)!;

/** Whether a line's drawn path is orthogonal: each segment across or down. */
function orthogonalPath(id: string): boolean {
    const path = pathOf(partsById(drawing), line(id));
    return path.every(
        (point, index) => index === 0 || point.x === path[index - 1]!.x || point.y === path[index - 1]!.y,
    );
}

function fresh() {
    drawing = emptyDrawing();
}

test("new parts are tagged with the next number free of their prefix", () => {
    fresh();
    const first = place("pressure-transducer", 0, 0);
    const second = place("pressure-transducer", 100, 0);
    expect([part(first).tag, part(second).tag]).toEqual(["PT-1", "PT-2"]);
    drawing = updatePart(drawing, first, (entry) => ({ ...entry, tag: "PT-7" }));
    expect(part(place("pressure-transducer", 200, 0)).tag).toBe("PT-8");
    expect(nextTag(drawing, "")).toBe(""); // a junction, a note: no tag
    drawing = updatePart(drawing, second, (entry) => ({ ...entry, tag: "pt-7" }));
    expect([...sharedTags(drawing)]).toEqual(["PT-7"]);
});

test("parts go on the grid, wherever they're dropped", () => {
    fresh();
    const valve = place("ball-valve", 103, 46);
    expect([part(valve).x, part(valve).y]).toEqual([100, 50]);
});

test("a line between ports is routed, and carries the fluid of what it's drawn from", () => {
    fresh();
    const bottle = place("bottle", 0, 0, { rotation: 90 }); // its neck faces right, at (50, 0)
    const valve = place("ball-valve", 110, 0);
    const regulator = place("regulator", 200, 60);
    const first = join([bottle, "top"], [valve, "a"]);
    const second = join([valve, "b"], [regulator, "a"]);
    expect(line(first).fluid).toBe("gn2"); // what the bottle holds
    expect(line(second).fluid).toBe("gn2"); // on through the valve
    expect(line(first).points).toEqual([]); // straight: the ports line up
    expect(line(second).points.length).toBeGreaterThan(0);
    expect(orthogonalPath(second)).toBe(true);
    expect(connect(drawing, { part: valve, port: "a" }, { part: valve, port: "a" })).toBeNull(); // to itself
});

test("a tank's top is its ullage: a line from it doesn't take the liquid it holds", () => {
    fresh();
    const tank = place("tank", 0, 0, { props: { fluid: "lox" } });
    const below = place("ball-valve", 0, 120, { rotation: 90 });
    const above = place("check-valve", 0, -120, { rotation: 90 });
    expect(line(join([tank, "bottom"], [below, "a"])).fluid).toBe("lox");
    expect(line(join([above, "b"], [tank, "top"])).fluid).toBe("");
});

test("a line drawn to another line tees into it at a junction on the grid", () => {
    fresh();
    const left = place("ball-valve", 0, 0);
    const right = place("ball-valve", 200, 0);
    const pipe = join([left, "b"], [right, "a"]);
    drawing = carryFluid(drawing, pipe, "rp1");
    const gauge = place("pressure-gauge", 104, -80);
    const made = connect(drawing, { part: gauge, port: "bottom" }, { line: pipe, at: { x: 103, y: 2 } })!;
    drawing = made.drawing;
    const junction = drawing.parts.find((entry) => entry.kind === "junction")!;
    expect([junction.x, junction.y]).toEqual([100, 0]);
    expect(drawing.lines).toHaveLength(3);
    const tee = line(made.id);
    expect(tee.fluid).toBe("rp1"); // what the line it tees into carries
    // The line it split: each half ends at the junction, and the first keeps its id.
    expect(line(pipe).to).toEqual({ part: junction.id, port: "c" });
    expect(drawing.lines.filter((entry) => isPortEnd(entry.from) && entry.from.part === junction.id)).toHaveLength(1);
});

test("a part dropped on a line goes into it, turned the line's way, and deleting it joins the line up again", () => {
    fresh();
    const top = place("tank", 0, 0);
    const bottom = place("engine", 0, 300);
    const feed = join([top, "bottom"], [bottom, "fuel"]);
    drawing = carryFluid(drawing, feed, "rp1");
    const before = runOf(partsById(drawing), line(feed))!;
    const valve = place("pneumatic-valve", 300, 300); // dropped off to the side first, as from the library
    const into = insertIntoLine(drawing, valve, feed, { x: before[0]!.x + 3, y: 150 });
    expect(into).not.toBeNull();
    drawing = into!;
    // On the line, turned to its way (down: a quarter turn), its first port toward where the line comes from.
    expect(part(valve).rotation).toBe(90);
    const entering = portOf(part(valve), "a")!.at;
    const leaving = portOf(part(valve), "b")!.at;
    expect(entering.x).toBe(before[0]!.x);
    expect(entering.y).toBeLessThan(leaving.y);
    const lines = drawing.lines.filter((entry) =>
        [entry.from, entry.to].some((end) => isPortEnd(end) && end.part === valve),
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((entry) => entry.fluid === "rp1")).toBe(true);

    drawing = deleteItems(drawing, new Set([valve]));
    expect(drawing.lines).toHaveLength(1);
    expect(line(feed).from).toEqual({ part: top, port: "bottom" });
    expect(line(feed).to).toEqual({ part: bottom, port: "fuel" });
    expect(runOf(partsById(drawing), line(feed))).toEqual(before);
});

test("deleting a part keeps its other lines, ending where it was; a junction left with too few lines goes", () => {
    fresh();
    const tank = place("tank", 0, 0);
    const sensor = place("pressure-transducer", 120, -30);
    const tap = join([tank, "right-upper"], [sensor, "left"]);
    const end = portOf(part(sensor), "left")!.at;
    drawing = deleteItems(drawing, new Set([sensor]));
    expect(line(tap).to).toEqual(end);

    fresh();
    const left = place("ball-valve", 0, 0);
    const right = place("ball-valve", 200, 0);
    const pipe = join([left, "b"], [right, "a"]);
    const gauge = place("pressure-gauge", 100, -80);
    const made = connect(drawing, { part: gauge, port: "bottom" }, { line: pipe, at: { x: 100, y: 0 } })!;
    drawing = deleteItems(made.drawing, new Set([made.id]));
    // The tee's line went: the junction joins the two halves back into one, and goes.
    expect(drawing.parts.some((entry) => entry.kind === "junction")).toBe(false);
    expect(drawing.lines).toHaveLength(1);
    expect(line(pipe).to).toEqual({ part: right, port: "a" });
});

test("moving a part routes its lines again; lines routed by hand keep their bends and follow their ends", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 200, 100);
    const pipe = join([a, "b"], [b, "a"]);
    expect(line(pipe).points).toEqual([
        { x: 160, y: 0 },
        { x: 160, y: 100 },
    ]);
    drawing = moveSegment(drawing, pipe, 1, { x: -60, y: 0 });
    expect(line(pipe).auto).toBe(false);
    expect(line(pipe).points).toEqual([
        { x: 100, y: 0 },
        { x: 100, y: 100 },
    ]);
    drawing = moveItems(drawing, new Set([b]), { x: 0, y: 40 });
    expect(line(pipe).points).toEqual([
        { x: 100, y: 0 },
        { x: 100, y: 140 },
    ]); // its upright segment stays where it was put
    // Moved past the line's bend, the valve's port faces away from it: routed round to it, the line would loop back
    // past the valve to keep a bend that's no use now, so it's routed afresh.
    drawing = moveItems(drawing, new Set([b]), { x: -140, y: 0 });
    expect(orthogonalPath(pipe)).toBe(true);
    const path = pathOf(partsById(drawing), line(pipe));
    const [last, previous] = [path[path.length - 1]!, path[path.length - 2]!];
    expect(previous.x).toBeLessThan(last.x); // in from the left, as the port faces
    expect([flaws(pipe), line(pipe).auto]).toEqual([[], true]);
    // Both ends moving together: the line moves with them, as it was.
    const before = line(pipe).points;
    drawing = moveItems(drawing, new Set([a, b]), { x: 50, y: 50 });
    expect(line(pipe).points).toEqual(before.map((point) => ({ x: point.x + 50, y: point.y + 50 })));
});

test("a selection dragged with its lines moves each line once, as it was", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 200, 100);
    const pipe = join([a, "b"], [b, "a"]);
    const before = line(pipe).points;
    // Selected with its parts (a box drawn around them, or select all): the line goes with them, once.
    drawing = moveItems(drawing, new Set([a, b, pipe]), { x: 50, y: 50 });
    expect(line(pipe).points).toEqual(before.map((point) => ({ x: point.x + 50, y: point.y + 50 })));
    expect(orthogonalPath(pipe)).toBe(true);
});

test("a tee moves with its lines when everything they join moves, and stays a straight run", () => {
    fresh();
    const left = place("ball-valve", 0, 0);
    const right = place("ball-valve", 200, 0);
    const pipe = join([left, "b"], [right, "a"]);
    const gauge = place("pressure-gauge", 100, -80);
    const tee = connect(drawing, { part: gauge, port: "bottom" }, { line: pipe, at: { x: 100, y: 0 } })!;
    drawing = tee.drawing;
    const junction = drawing.parts.find((entry) => entry.kind === "junction")!;
    const lines = drawing.lines.map((entry) => entry.id);
    const runs = new Map(lines.map((id) => [id, pathOf(partsById(drawing), line(id))]));
    // The valves and the gauge picked, the junction under the lines not: it comes along all the same.
    for (const ids of [new Set([left, right, gauge]), new Set([left, right, gauge, ...lines])]) {
        drawing = moveItems(drawing, ids, { x: 30, y: 40 });
        expect([part(junction.id).x, part(junction.id).y]).toEqual([junction.x + 30, junction.y + 40]);
        for (const id of lines) {
            const moved = pathOf(partsById(drawing), line(id));
            expect(moved).toEqual(runs.get(id)!.map((point) => ({ x: point.x + 30, y: point.y + 40 })));
        }
        drawing = moveItems(drawing, ids, { x: -30, y: -40 });
    }
});

test("a run of tees comes along with what's on it, and tees on nothing but each other stay", () => {
    fresh();
    const left = place("ball-valve", 0, 0);
    const right = place("ball-valve", 300, 0);
    const pipe = join([left, "b"], [right, "a"]);
    const first = place("pressure-gauge", 100, -80);
    drawing = connect(drawing, { part: first, port: "bottom" }, { line: pipe, at: { x: 100, y: 0 } })!.drawing;
    const second = place("pressure-gauge", 200, -80);
    const run = drawing.lines.find((entry) => isPortEnd(entry.to) && entry.to.part === right)!;
    drawing = connect(drawing, { part: second, port: "bottom" }, { line: run.id, at: { x: 200, y: 0 } })!.drawing;
    const tees = drawing.parts.filter((entry) => entry.kind === "junction").map((entry) => entry.id);
    expect(tees).toHaveLength(2);
    drawing = moveItems(drawing, new Set([left, right, first, second]), { x: 0, y: 30 });
    expect(tees.map((id) => part(id).y)).toEqual([30, 30]);
    for (const entry of drawing.lines) {
        expect(orthogonalPath(entry.id), entry.id).toBe(true);
    }
    // Moving one valve alone leaves the tees where they are.
    drawing = moveItems(drawing, new Set([left]), { x: -20, y: 0 });
    expect(tees.map((id) => [part(id).x, part(id).y])).toEqual([
        [100, 30],
        [200, 30],
    ]);
});

test("a free end moves only with its line: a line from a moved part to a point stays on that point", () => {
    fresh();
    const valve = place("ball-valve", 0, 0);
    const made = connect(drawing, { part: valve, port: "b" }, { x: 200, y: 100 })!;
    drawing = made.drawing;
    drawing = moveItems(drawing, new Set([valve]), { x: 0, y: -40 });
    expect(line(made.id).to).toEqual({ x: 200, y: 100 });
    expect(orthogonalPath(made.id)).toBe(true);
    const path = pathOf(partsById(drawing), line(made.id));
    expect(path[path.length - 1]).toEqual({ x: 200, y: 100 });
    // Selected with it, the line takes its free end along.
    drawing = moveItems(drawing, new Set([valve, made.id]), { x: 20, y: 0 });
    expect(line(made.id).to).toEqual({ x: 220, y: 100 });
    expect(orthogonalPath(made.id)).toBe(true);
});

test("a selected line to a part that stayed keeps its hand routing, following the end that moved", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 200, 100);
    const pipe = join([a, "b"], [b, "a"]);
    drawing = moveSegment(drawing, pipe, 1, { x: -60, y: 0 });
    drawing = moveItems(drawing, new Set([b, pipe]), { x: 0, y: 40 });
    expect(line(pipe).auto).toBe(false);
    expect(line(pipe).points).toEqual([
        { x: 100, y: 0 },
        { x: 100, y: 140 },
    ]);
});

/**
 * What's wrong with how a line's drawn: a run on a slant, one back over the last, one through a part not its own, or an
 * end that leaves or comes in to its port another way than it faces.
 */
function flaws(id: string): string[] {
    const ends = [line(id).from, line(id).to].map((end) => (isPortEnd(end) ? end.part : ""));
    const boxes = drawing.parts.filter((each) => !ends.includes(each.id)).map((each) => boxOf(each, drawing));
    const own = drawing.parts.filter((each) => ends.includes(each.id)).map((each) => boxOf(each, drawing));
    const parts = partsById(drawing);
    const path = pathOf(parts, line(id));
    const found: string[] = [];
    // Out of its ports, and in to them, the way they face.
    const [from, to] = [placeEnd(parts, line(id).from)!, placeEnd(parts, line(id).to)!];
    if (from.dir && path.length > 1 && dirOf(path[0]!, path[1]!) !== from.dir) {
        found.push(`out of its first port the wrong way`);
    }
    if (to.dir && path.length > 1 && dirOf(path.at(-1)!, path.at(-2)!) !== to.dir) {
        found.push(`in to its last port the wrong way`);
    }
    for (let index = 0; index + 1 < path.length; index++) {
        const [a, b] = [path[index]!, path[index + 1]!];
        if (a.x !== b.x && a.y !== b.y) {
            found.push(`slanted from ${a.x},${a.y}`);
        }
        const c = path[index + 2];
        if (c && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) {
            found.push(`back over itself at ${b.x},${b.y}`);
        }
        const [x0, x1, y0, y1] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
        // Its own parts too, but where it goes into them.
        const inner = index > 0 && index + 2 < path.length;
        for (const box of inner ? [...boxes, ...own] : boxes) {
            if (x0 < box.x1 - 1 && x1 > box.x0 + 1 && y0 < box.y1 - 1 && y1 > box.y0 + 1) {
                found.push(`through a part from ${a.x},${a.y}`);
            }
        }
    }
    return found;
}

/** A line made as if routed by hand, as Visio's come in: its bends, kept until its ends move. */
function byHand(id: string, points: Point[]) {
    drawing = updateLine(drawing, id, (each) => ({ ...each, auto: false, points }));
}

test("a straight line routed by hand, its end moved off its line, is routed again: square, not slanted", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 200, 0);
    const pipe = join([a, "b"], [b, "a"]);
    byHand(pipe, []);
    // Along its line, it stays as it is: straight, and the drawer's.
    drawing = moveItems(drawing, new Set([b]), { x: 40, y: 0 });
    expect([flaws(pipe), line(pipe).points, line(pipe).auto]).toEqual([[], [], false]);
    // Off it, a slant would join its ends: it's Piper's to route instead.
    drawing = moveItems(drawing, new Set([b]), { x: 0, y: 40 });
    expect(flaws(pipe)).toEqual([]);
    expect([line(pipe).auto, line(pipe).points.length]).toEqual([true, 2]);
});

test("a line routed by hand that following a moved end would draw back over itself is routed again", () => {
    fresh();
    const a = place("ball-valve", 0, -100);
    const b = place("ball-valve", 100, 0); // its b, at 120, faces right: the line comes in from the right
    const pipe = join([a, "b"], [b, "b"]);
    byHand(pipe, [
        { x: 140, y: -100 },
        { x: 140, y: 0 },
    ]);
    expect(flaws(pipe)).toEqual([]);
    // Moved right, its port's past the line's last bend: the line can't come in from the right as it was.
    drawing = moveItems(drawing, new Set([b]), { x: 40, y: 0 });
    expect(flaws(pipe)).toEqual([]);
    expect(line(pipe).auto).toBe(true);
});

test("a line routed by hand from Visio, with points on points and steps of a tenth, follows a move square", () => {
    fresh();
    const a = place("ball-valve", 0, -100);
    const b = place("ball-valve", 200, 40);
    const pipe = join([a, "b"], [b, "a"]);
    // As a Visio connector comes in: a point twice, and a step too small to see.
    byHand(pipe, [
        { x: 100, y: -100 },
        { x: 100, y: -100 },
        { x: 100, y: 40.1 },
        { x: 100, y: 40 },
    ]);
    drawing = moveItems(drawing, new Set([b]), { x: 0, y: 60 });
    expect(flaws(pipe)).toEqual([]);
});

test("a line routed by hand over a part it isn't joined to (as Visio sets a quick disconnect on one) still follows", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 300, 0);
    const pipe = join([a, "b"], [b, "a"]);
    byHand(pipe, []);
    place("quick-disconnect", 150, 0); // on the line, not in it
    // Moved along its line, it stays as drawn: straight on over it, not routed off round it.
    drawing = moveItems(drawing, new Set([b]), { x: 40, y: 0 });
    expect(line(pipe)).toMatchObject({ auto: false, points: [] });
});

test("a line routed by hand whose ends both moved round past its bend is routed afresh, not wound round each", () => {
    fresh();
    const a = place("ball-valve", 0, 0, { rotation: 270 }); // its b faces up
    const b = place("ball-valve", -100, -60); // its b faces right
    const pipe = join([a, "b"], [b, "b"]);
    const corner = { x: portOf(part(a), "b")!.at.x, y: portOf(part(b), "b")!.at.y };
    byHand(pipe, [corner]); // an L: up, then left in to b
    expect(flaws(pipe)).toEqual([]);
    // Moved up and away to the left, past b: the L's corner is behind both ports now.
    drawing = moveItems(drawing, new Set([a]), { x: -200, y: -100 });
    expect(flaws(pipe)).toEqual([]);
    expect(line(pipe).auto).toBe(true);
    expect(line(pipe).points.length).toBeLessThanOrEqual(3);
});

test("a line routed by hand stays as it is when its part changes but not where its end is", () => {
    fresh();
    const box = place("box", 0, 0); // its top at (0, -20)
    const valve = place("ball-valve", 100, -100); // its b at (120, -100) faces right
    const pipe = join([box, "top"], [valve, "b"]);
    byHand(pipe, [{ x: 0, y: -100 }]); // as Visio might have it: in to b the wrong way, over the valve
    // Wider: the ports on its sides move, not its top.
    drawing = updatePart(drawing, box, (part) => ({ ...part, w: 120 }));
    expect(line(pipe)).toMatchObject({ auto: false, points: [{ x: 0, y: -100 }] });
});

test("a line from Visio is kept as Visio drew it on Piper's ports, unless following it would loop round to one", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 200, 100);
    const drawn = [
        { x: 20, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 180, y: 100 },
    ];
    expect(traced(drawing, { part: a, port: "b" }, { part: b, port: "a" }, drawn)).toEqual({
        points: drawn.slice(1, -1),
        auto: false,
    });
    // Two ports facing each other a little apart, a hair out of line, and Visio's line in to the second from the side
    // (Visio knows no way a port faces): followed, it would loop round to come in as the port faces.
    const up = place("ball-valve", 0, 300, { rotation: 270 }); // its b, at (0, 280), faces up
    const down = place("ball-valve", 0, 250, { rotation: 90 });
    drawing = updatePart(drawing, down, (part) => ({ ...part, x: 1.5 })); // its b, at (1.5, 270), faces down
    const across = traced(drawing, { part: up, port: "b" }, { part: down, port: "b" }, [
        { x: 0, y: 280 },
        { x: 0, y: 270 },
        { x: 1.5, y: 270 },
    ]);
    expect(across.auto).toBe(true);
    expect(across.points.length).toBeLessThanOrEqual(2); // a step across between them, no more
});

test("a line from Visio in to a port from the side keeps its way, turning in to the port as it faces", () => {
    fresh();
    const a = place("ball-valve", 0, 0); // its b, at (20, 0), faces right
    const c = place("ball-valve", 100, 60, { rotation: 270 }); // its b, at (100, 40), faces up
    // In to it from the left, as Visio draws (knowing no way a port faces): it comes round to turn in from above, no
    // longer than Piper's own way there, and keeps the rest as drawn.
    const drawn = [
        { x: 20, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 40 },
        { x: 100, y: 40 },
    ];
    expect(traced(drawing, { part: a, port: "b" }, { part: c, port: "b" }, drawn)).toEqual({
        points: [
            { x: 60, y: 0 },
            { x: 60, y: 20 },
            { x: 100, y: 20 },
        ],
        auto: false,
    });
});

test("a sensor made duplicated moves its side tap out, and its line follows", () => {
    fresh();
    const sensor = place("pressure-transducer", 0, 0);
    const valve = place("ball-valve", 200, 0);
    const tap = join([sensor, "right"], [valve, "a"]);
    drawing = updatePart(drawing, sensor, (entry) => ({ ...entry, props: { ...entry.props, count: "2" } }));
    const path = pathOf(partsById(drawing), line(tap));
    expect(path[0]).toEqual({ x: 30, y: 0 }); // the side of the second bubble
    expect(orthogonalPath(tap)).toBe(true);
});

test("a part drawn bigger or smaller keeps its ports on the grid, and its lines straight to its outline", () => {
    fresh();
    const valve = place("ball-valve", 0, 0, { scale: 2 });
    const tank = place("tank", 300, 0, { scale: 0.75 });
    expect(portOf(part(valve), "b")?.at).toEqual({ x: 40, y: 0 }); // twice its 20
    for (const port of [...portsOf(part(tank)), ...portsOf(part(valve))]) {
        expect(port.at.x % 10 === 0 && port.at.y % 10 === 0, port.id).toBe(true);
        // Drawn to its outline, in line with the port: a level line stays level.
        if (port.dir === "left" || port.dir === "right") {
            expect(port.edge.y).toBe(port.at.y);
        }
    }
    const pipe = join([valve, "b"], [tank, "left-lower"]);
    expect(orthogonalPath(pipe)).toBe(true);
    // Its box, and what's drawn, scale with it.
    const box = boxOf(part(valve), drawing);
    expect([box.x0, box.x1]).toEqual([-40, 40]);
});

test("ports that face each other close by are joined straight across, never past each other and back", () => {
    // 20 apart and 10 off level: a stub of 20 out of each would run past the other's, and the route come back.
    expect(route({ at: { x: 80, y: -100 }, dir: "left" }, { at: { x: 60, y: -90 }, dir: "right" }, [])).toEqual([
        { x: 80, y: -100 },
        { x: 70, y: -100 },
        { x: 70, y: -90 },
        { x: 60, y: -90 },
    ]);
    // As a tank drawn bigger brings its side port up to the valve beside it (the example's TK-2 and SV-1).
    drawing = example();
    const tank = drawing.parts.find((entry) => entry.tag === "TK-2")!;
    const valve = drawing.parts.find((entry) => entry.tag === "SV-1")!;
    const ends = (entry: Line) => [entry.from, entry.to].map((end) => (isPortEnd(end) ? end.part : ""));
    const vent = drawing.lines.find((entry) => ends(entry).includes(tank.id) && ends(entry).includes(valve.id))!;
    drawing = updatePart(drawing, tank.id, (entry) => ({ ...entry, scale: 1.5 }));
    const path = pathOf(partsById(drawing), line(vent.id));
    const headings = path
        .slice(1)
        .map((point, index) => Math.sign(point.x - path[index]!.x))
        .filter(Boolean);
    expect(new Set(headings).size, JSON.stringify(path)).toBe(1); // across one way only
    expect(orthogonalPath(vent.id)).toBe(true);
});

test("turning a part turns its ports, and its lines follow", () => {
    fresh();
    const tank = place("tank", 0, 0);
    const valve = place("ball-valve", 0, 120, { rotation: 90 });
    const feed = join([tank, "bottom"], [valve, "a"]);
    drawing = turnParts(drawing, new Set([valve]), true);
    expect(part(valve).rotation).toBe(180);
    expect(orthogonalPath(feed)).toBe(true);
    const path = pathOf(partsById(drawing), line(feed));
    expect(path[path.length - 1]).toEqual(portOf(part(valve), "a")!.edge);
});

test("dragging a line's segment past a port routes its end around to it, never through its part", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 200, 100);
    const pipe = join([a, "b"], [b, "a"]);
    drawing = moveSegment(drawing, pipe, 1, { x: 80, y: 0 }); // the segment down, past the valve's port at x 180
    const path = pathOf(partsById(drawing), line(pipe));
    expect(orthogonalPath(pipe)).toBe(true);
    expect(path[path.length - 2]!.x).toBeLessThan(path[path.length - 1]!.x);
});

test("a line's end moves to another port", () => {
    fresh();
    const a = place("ball-valve", 0, 0);
    const b = place("ball-valve", 200, 0);
    const c = place("ball-valve", 200, 150);
    const pipe = join([a, "b"], [b, "a"]);
    drawing = reconnect(drawing, pipe, "to", { part: c, port: "a" });
    expect(line(pipe).to).toEqual({ part: c, port: "a" });
    expect(orthogonalPath(pipe)).toBe(true);
});

test("a fluid carried along a run goes through valves and fittings, but not past tanks", () => {
    fresh();
    const tank = place("tank", 0, 0);
    const valve = place("ball-valve", 100, -30);
    const tee = place("junction", 200, -30);
    const engine = place("engine", 300, 100);
    const other = place("tank", -200, 0);
    const first = join([tank, "right-upper"], [valve, "a"]);
    const second = join([valve, "b"], [tee, "c"]);
    const third = join([tee, "c"], [engine, "fuel"]);
    const beyond = join([other, "right-lower"], [tank, "left-lower"]);
    drawing = carryFluid(drawing, second, "ipa");
    expect([first, second, third, beyond].map((id) => line(id).fluid)).toEqual(["ipa", "ipa", "ipa", ""]);
});

test("a label the same along a run is written once, however the parts on it move", () => {
    fresh();
    const tank = place("tank", 0, 0);
    const valve = place("ball-valve", 300, -30);
    const other = place("tank", 600, 0);
    const first = join([tank, "right-upper"], [valve, "a"]);
    const second = join([valve, "b"], [other, "left-upper"]);
    drawing = carryFluid(drawing, first, "gox");
    const show = (ids: string[], shown: string[], tag = "") => {
        drawing = {
            ...drawing,
            lines: drawing.lines.map((each) => (ids.includes(each.id) ? { ...each, shown, tag } : each)),
        };
    };
    const written = () => {
        const parts = partsById(drawing);
        const paths = new Map(drawing.lines.map((each) => [each.id, pathOf(parts, each)]));
        return lineLabelPlaces(drawing, paths).map((place) => place.text);
    };
    show([first, second], ["fluid"]);
    expect(written()).toEqual(["GOX"]);
    // Moving the valve along makes room on both sides of it: still once.
    for (const by of [-150, 300, -100]) {
        drawing = moveItems(drawing, new Set([valve]), { x: by, y: 0 });
        expect(written()).toEqual(["GOX"]);
    }

    // A pipe's tag, on each of the pieces a valve cuts it into: once too. Two lines' own tags are each written.
    show([first, second], ["tag"], "L-101");
    expect(written()).toEqual(["L-101"]);
    drawing = {
        ...drawing,
        lines: drawing.lines.map((each) => (each.id === second ? { ...each, tag: "L-102" } : each)),
    };
    expect(written().sort()).toEqual(["L-101", "L-102"]);

    // Past a tank, it's another run: its own.
    const beyond = join([other, "right-upper"], [place("ball-valve", 900, -30), "a"]);
    drawing = carryFluid(drawing, beyond, "gox");
    show([first, second, beyond], ["fluid"]);
    expect(written()).toEqual(["GOX", "GOX"]);
});

test("parts brought to the front go last, over everything; sent to the back, first, under the lines too", () => {
    fresh();
    const [a, b, c, d] = [0, 100, 200, 300].map((x) => place("ball-valve", x, 0));
    const pipe = join([a!, "b"], [b!, "a"]);
    const order = () => drawing.parts.map((each) => `${each.tag}${each.back ? " (back)" : ""}`);
    drawing = reorderParts(drawing, new Set([a!, c!]), "front");
    expect(order()).toEqual(["BV-2", "BV-4", "BV-1", "BV-3"]); // keeping their order among themselves
    drawing = reorderParts(drawing, new Set([d!, c!]), "back");
    expect(order()).toEqual(["BV-4 (back)", "BV-3 (back)", "BV-2", "BV-1"]);
    drawing = reorderParts(drawing, new Set([d!]), "front");
    expect(order()).toEqual(["BV-3 (back)", "BV-2", "BV-1", "BV-4"]);
    expect(drawing.lines.map((each) => each.id)).toEqual([pipe]); // lines stay as they are
    expect(reorderParts(drawing, new Set([pipe]), "back")).toBe(drawing); // no parts: no change
    // Kept as saved; a part from before is where its kind draws it.
    expect(readDrawing(drawing).parts.map((each) => each.back === true)).toEqual([true, false, false, false]);
});

test("a line's label goes where no part covers it: its longest stretch that's clear, else its longest", () => {
    fresh();
    const pipe = { ...newLine({ x: 35, y: -100 }, { x: 135, y: 100 }), fluid: "gox", shown: ["fluid"] };
    drawing = { ...drawing, lines: [pipe] };
    // Down 200 beside where a valve will be, then across 100.
    const paths = new Map([
        [
            pipe.id,
            [
                { x: 35, y: -100 },
                { x: 35, y: 100 },
                { x: 135, y: 100 },
            ],
        ],
    ]);
    const where = () => lineLabelPlaces(drawing, paths).map((place) => [place.at, place.level]);
    expect(where()).toEqual([[{ x: 35, y: 0 }, false]]); // the longest, down beside it
    place("ball-valve", 60, 0); // over where that's written
    expect(where()).toEqual([[{ x: 85, y: 100 }, true]]); // across, where nothing covers it
    place("ball-valve", 85, 90); // and over that too: its longest again, as nothing's clear
    expect(where()).toEqual([[{ x: 35, y: 0 }, false]]);
});

test("copied parts paste with their lines between them, and taken tags renumbered", () => {
    fresh();
    const a = place("pressure-transducer", 0, 0);
    const b = place("ball-valve", 100, 0);
    const between = join([a, "right"], [b, "a"]);
    const clip = copyItems(drawing, new Set([a, b]))!;
    expect(clip.lines.map((entry) => entry.id)).toEqual([between]); // the line between them comes along
    const pasted = pasteClip(drawing, clip, { x: 23, y: 37 });
    drawing = pasted.drawing;
    const tags = drawing.parts.map((entry) => entry.tag).sort();
    expect(tags).toEqual(["BV-1", "BV-2", "PT-1", "PT-2"]);
    const copies = drawing.parts.filter((entry) => pasted.ids.includes(entry.id));
    expect(copies.map((entry) => [entry.x, entry.y])).toEqual([
        [20, 40],
        [120, 40],
    ]); // moved on the grid
    expect(drawing.lines).toHaveLength(2);
});

test("parts line up by their boxes, and space evenly by their centers", () => {
    fresh();
    const a = place("pressure-transducer", 0, 0);
    const b = place("pressure-transducer", 70, 40);
    const c = place("pressure-transducer", 300, -20);
    drawing = alignParts(drawing, new Set([a, b, c]), "top");
    expect([a, b, c].map((id) => part(id).y)).toEqual([-20, -20, -20]);
    drawing = alignParts(drawing, new Set([a, b, c]), "across");
    expect([a, b, c].map((id) => part(id).x)).toEqual([0, 150, 300]);
});

test("a drawing reads back whatever its age: what's missing filled in, what can't be read left out", () => {
    const read = readDrawing({
        format: 1,
        parts: [
            { id: "p1", kind: "valve", x: 10, y: 20, props: { size: "1/2 in", cv: 1.2 } },
            { id: "p2", kind: "something-newer", x: 0, y: 0, rotation: 45 },
            { kind: "valve" },
        ],
        lines: [
            { id: "l1", from: { part: "p1", port: "b" }, to: { x: 100, y: 20 } },
            { id: "l2", from: { part: "gone", port: "a" }, to: { x: 0, y: 0 } },
        ],
        fluids: [{ id: "kero", name: "Kerosene", label: "KERO", color: "red" }],
        future: true,
    });
    expect(read.parts.map((entry) => entry.id)).toEqual(["p1", "p2"]);
    expect(read.parts[0]!.props).toEqual({ size: "1/2 in", cv: "1.2" });
    expect(read.parts[1]!.rotation).toBe(0);
    expect(read.lines.map((entry) => entry.id)).toEqual(["l1"]);
    expect(read.lines[0]!.auto).toBe(true);
    expect(read.fluids[0]!.color).toBe("#7f8c9a"); // not a color it can draw
    expect(readDrawing(null)).toEqual(emptyDrawing());
    // From before labels were sized and FIP had a color: the standard ones.
    expect(read.style).toEqual({ no: "", nc: "", fip: "", labels: 1, scheme: "", schemeAt: "" });
    // Sizes are numbers, of the standard one; from before they were, small and large are what they were.
    expect(readDrawing({ style: { fip: "#123456", labels: "small" } }).style).toMatchObject({
        fip: "#123456",
        labels: 0.8,
    });
    expect([1.25, "large", 9, -1, "huge"].map((labels) => readDrawing({ style: { labels } }).style.labels)).toEqual([
        1.25, 1.3, 3, 1, 1,
    ]);
    // A part from before sizes is its kind's own size, with the diagram's label size; any other size within what a
    // part can be is its own, and one past it is as far as a part goes.
    expect([read.parts[0]!.scale, read.parts[0]!.labelSize]).toEqual([1, null]);
    const sized = readDrawing({
        parts: [
            { id: "a", kind: "valve", scale: 1.5, labelSize: "small" },
            { id: "b", kind: "valve", scale: 7 },
            { id: "c", kind: "valve", scale: 0.3, labelSize: 1.65 },
            { id: "d", kind: "valve", scale: 0.1, labelSize: 0 },
            { id: "e", kind: "valve", scale: 0 },
        ],
    });
    expect(sized.parts.map((entry) => [entry.scale, entry.labelSize])).toEqual([
        [1.5, 0.8],
        [4, null],
        [0.3, 1.65],
        [0.25, null],
        [1, null],
    ]);
    // A line saved without saying what it shows shows nothing: a fluid's color says what it carries.
    expect(read.lines[0]!.shown).toEqual([]);
});

test("a pressure rating from before MAWP is read as the MAWP it is; a filter's micron rating stays", () => {
    const read = readDrawing({
        parts: [
            { id: "v", kind: "valve", props: { rating: "3000 psi" }, shown: ["rating"] },
            { id: "f", kind: "filter", props: { rating: "10 µm" }, shown: ["rating"] },
            { id: "w", kind: "valve", props: { rating: "old", mawp: "6000 psi" } },
        ],
        lines: [{ id: "l", from: { x: 0, y: 0 }, to: { x: 50, y: 0 }, props: { rating: "1500 psi" } }],
    });
    const [valve, filter, both] = read.parts;
    expect([valve!.props, valve!.shown]).toEqual([{ mawp: "3000 psi" }, ["mawp"]]);
    expect([filter!.props, filter!.shown]).toEqual([{ rating: "10 µm" }, ["rating"]]);
    expect(both!.props).toEqual({ rating: "old", mawp: "6000 psi" }); // a MAWP of its own wins
    expect(read.lines[0]!.props).toEqual({ mawp: "1500 psi" });
});

test("new lines don't write their fluid on themselves, and a split line doesn't repeat what it shows", () => {
    fresh();
    const left = place("ball-valve", 0, 0);
    const right = place("ball-valve", 200, 0);
    const pipe = join([left, "b"], [right, "a"]);
    expect(line(pipe).shown).toEqual([]);
    drawing = carryFluid(drawing, pipe, "rp1");
    drawing = { ...drawing, lines: drawing.lines.map((entry) => ({ ...entry, shown: ["fluid", "size"] })) };
    const gauge = place("pressure-gauge", 100, -80);
    drawing = connect(drawing, { part: gauge, port: "bottom" }, { line: pipe, at: { x: 100, y: 0 } })!.drawing;
    const halves = drawing.lines.filter((entry) => entry.fluid === "rp1" && entry.id !== drawing.lines.at(-1)!.id);
    expect(halves.map((entry) => entry.shown)).toEqual([["fluid", "size"], ["size"]]);
});
