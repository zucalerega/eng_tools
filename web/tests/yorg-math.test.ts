import { describe, expect, test } from "vitest";
import { forDataset, newLayout, readLayout, reduce, type Layout, type Note } from "../src/yorg/layout";
import { arrowStart, placeNotes } from "../src/yorg/Plot";
import { lowerBound, MinMax, sampleAt, Samples, trace, upperBound, visibleRange } from "../src/yorg/samples";
import {
    clockTicks,
    decimalsFor,
    formatClock,
    formatDuration,
    formatRate,
    formatTick,
    formatValue,
    niceStep,
    ticks,
} from "../src/yorg/scale";

// What Yorg's plots draw is worked out by these; the canvas only strokes what they give it.

const plain = { shift: 0, scale: 1, offset: 0 };

function seeded(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

describe("samples", () => {
    test("finding a time among sorted times", () => {
        const times = new Float64Array([0, 1, 1, 2, 5]);
        expect([lowerBound(times, 1), upperBound(times, 1)]).toEqual([1, 3]);
        expect([lowerBound(times, -1), upperBound(times, 9)]).toEqual([0, 5]);
        expect(lowerBound(times, 3)).toBe(4);
    });

    test("the smallest and largest of any run, as if every value were looked at", () => {
        const random = seeded(7);
        const values = new Float64Array(20_000).map(() => (random() < 0.05 ? NaN : random() * 200 - 100));
        const index = new MinMax(values);
        for (let trial = 0; trial < 300; trial++) {
            const a = Math.floor(random() * values.length);
            const b = a + Math.floor(random() * (values.length - a + 1));
            let low = Infinity;
            let high = -Infinity;
            for (let i = a; i < b; i++) {
                if (values[i]! < low) low = values[i]!;
                if (values[i]! > high) high = values[i]!;
            }
            expect(index.range(a, b)).toEqual([low, high]);
        }
        expect(new MinMax(new Float64Array([NaN, NaN])).range(0, 2)).toEqual([Infinity, -Infinity]);
    });

    test("with few samples in view, each one is drawn; a pause in logging lifts the pen", () => {
        const samples = new Samples(new Float64Array([0, 1, 2, 3, 100, 101]), new Float64Array([5, 6, NaN, 8, 9, 10]));
        const drawn = trace(samples, 0.5, 2.5, 800, { shift: 10, scale: 2, offset: 1 });
        expect(drawn.raw).toBe(true);
        // In view 0.5 to 2.5 on the axis is -9.5 to -7.5 in the file: nothing. Shifted to 10.5 to 12.5, it's 0.5 to 2.5.
        const shifted = trace(samples, 10.5, 12.5, 800, { shift: 10, scale: 2, offset: 1 });
        expect([...shifted.x.slice(0, shifted.length)]).toEqual([10, 11, 12, 13]);
        expect([...shifted.y.slice(0, shifted.length)]).toEqual([11, 13, NaN, 17]);
        expect(drawn.length).toBe(1); // only the sample next to the window, for a line to run in from
        const everything = trace(samples, 0, 101, 800, plain);
        expect([...everything.y.slice(0, everything.length)]).toEqual([5, 6, NaN, 8, NaN, 9, 10]);
    });

    test("with many samples in view, each pixel column keeps its extremes", () => {
        const count = 100_000;
        const times = new Float64Array(count).map((_, i) => i / 1000);
        const values = new Float64Array(count).map((_, i) => Math.sin(i / 500));
        values[54_321] = 50; // a spike, one sample wide
        const drawn = trace(new Samples(times, values), 0, 99.999, 400, plain);
        expect(drawn.raw).toBe(false);
        expect(drawn.length).toBeLessThanOrEqual(4 * 400 + 4);
        const ys = [...drawn.y.slice(0, drawn.length)];
        expect(Math.max(...ys)).toBe(50);
        expect(Math.min(...ys)).toBeCloseTo(-1, 5);
    });

    test("the range in view, scaled and offset, for fitting an axis", () => {
        const samples = new Samples(new Float64Array([0, 1, 2, 3]), new Float64Array([4, -2, 7, 1]));
        expect(visibleRange(samples, 0.5, 2.5, plain)).toEqual([-2, 7]);
        expect(visibleRange(samples, 0.5, 2.5, { shift: 0, scale: -1, offset: 10 })).toEqual([3, 12]);
        // Between two samples, the line between them is what's in view.
        expect(visibleRange(samples, 1.2, 1.8, plain)).toEqual([-2, 7]);
    });

    test("the value under the cursor is the nearest sample's, if it's near", () => {
        const samples = new Samples(new Float64Array([0, 1, 2, 3, 4]), new Float64Array([10, 11, 12, 13, 14]));
        expect(sampleAt(samples, 1.4, plain)).toEqual({ x: 1, y: 11 });
        expect(sampleAt(samples, 1.6, { shift: 0, scale: 10, offset: 1 })).toEqual({ x: 2, y: 121 });
        expect(sampleAt(samples, 60, plain)).toBeNull(); // long after the last one
    });
});

describe("scales", () => {
    test("ticks fall on round numbers", () => {
        expect(niceStep(10, 5)).toBe(2);
        expect(niceStep(1, 4)).toBe(0.25);
        expect(niceStep(0.003, 3)).toBe(0.001);
        expect(ticks(-0.1, 1.05, 5).values).toEqual([0, 0.25, 0.5, 0.75, 1]);
        expect(decimalsFor(0.25)).toBe(2);
        expect(formatTick(0.30000000000000004, 0.1)).toBe("0.3");
        expect(formatTick(-0, 1)).toBe("0");
        expect(formatTick(25_000_000, 5_000_000)).toBe("2.5e+7");
    });

    test("values keep the file's decimals, or six significant digits", () => {
        expect(formatValue(14.7, 3)).toBe("14.700");
        expect(formatValue(512.37051)).toBe("512.371");
        expect(formatValue(0.000012345)).toBe("1.2345e-5");
        expect(formatValue(NaN)).toBe("—");
    });

    test("times of day, durations, and rates", () => {
        expect(formatClock(52325.25, 0.05)).toBe("14:32:05.25");
        expect(formatClock(86399.9996, 0.001)).toBe("00:00:00.000");
        expect(clockTicks(0, 120, 4).step).toBe(30);
        expect(formatDuration(0.25)).toBe("250 ms");
        expect(formatDuration(12.5)).toBe("12.5 s");
        expect(formatDuration(200)).toBe("3 min 20 s");
        expect(formatDuration(3900)).toBe("1 h 5 min");
        // Rounded as a whole: never "1 min 60 s".
        expect(formatDuration(119.97)).toBe("2 min");
        expect(formatDuration(299.9)).toBe("5 min");
        expect(formatDuration(59.999)).toBe("1 min");
        expect(formatDuration(3599.9)).toBe("1 h");
        expect(formatRate(1000)).toBe("1 kHz");
        expect(formatRate(12.5)).toBe("12.5 Hz");
        expect(formatRate(null)).toBe("—");
    });
});

describe("layouts", () => {
    const add = (layout: Layout, channel: string, panel: string | null = layout.panels[0]!.id) =>
        reduce(layout, { type: "addSeries", panel, dataset: 1, channel });

    test("channels get colors of their own, in the plot they're added to or a new one", () => {
        let layout = add(add(newLayout(1), "PT-1"), "PT-2");
        layout = add(layout, "TC-1", null);
        expect(layout.panels.map((panel) => panel.series.map((series) => series.channel))).toEqual([
            ["PT-1", "PT-2"],
            ["TC-1"],
        ]);
        const colors = layout.panels.flatMap((panel) => panel.series.map((series) => series.color));
        expect(new Set(colors).size).toBe(3);
    });

    test("moving a channel to another plot, and a plot up", () => {
        let layout = add(add(newLayout(1), "PT-1"), "TC-1", null);
        const [first, second] = layout.panels;
        layout = reduce(layout, { type: "moveSeries", panel: first!.id, series: first!.series[0]!.id, to: second!.id });
        expect(layout.panels.map((panel) => panel.series.map((series) => series.channel))).toEqual([
            [],
            ["TC-1", "PT-1"],
        ]);
        layout = reduce(layout, { type: "movePanel", panel: second!.id, by: -1 });
        expect(layout.panels[0]!.id).toBe(second!.id);
    });

    test("a saved layout reads back as it was, and anything unreadable in it gets a default", () => {
        const layout = reduce(add(newLayout(3), "LC-1"), { type: "t0", t0: 12.5 });
        expect(readLayout(JSON.parse(JSON.stringify(layout)), 3)).toEqual(layout);
        const odd = readLayout(
            {
                panels: [{ series: [{ channel: "PT-1", color: "red", scale: "x", axis: "up" }, { nope: 1 }] }],
                window: [5, 2],
            },
            9,
        );
        expect(odd.datasets).toEqual([{ id: 9, shift: 0 }]);
        expect(odd.window).toBeNull();
        expect(odd.panels[0]!.series).toHaveLength(1);
        expect(odd.panels[0]!.series[0]).toMatchObject({ channel: "PT-1", dataset: 9, scale: 1, axis: "left" });
        expect(readLayout("nonsense", 4)).toMatchObject({ datasets: [{ id: 4, shift: 0 }], window: null });
    });

    test("a layout for another test: the same channels, from the other dataset", () => {
        const layout = reduce(add(newLayout(1), "PT-1"), { type: "window", window: [1, 2] });
        const other = forDataset(layout, 7);
        expect(other.datasets).toEqual([{ id: 7, shift: 0 }]);
        expect(other.panels[0]!.series[0]).toMatchObject({ dataset: 7, channel: "PT-1" });
        expect(other.window).toBeNull();
    });
});

describe("labels on plots", () => {
    const note: Note = { id: "n1", t: 5, y: 50, axis: "left", text: "Ignition", dx: 40, dy: -30, arrow: true };

    test("are added to a plot, changed, moved, and taken away", () => {
        let layout = newLayout(1);
        const panel = layout.panels[0]!.id;
        layout = reduce(layout, { type: "addNote", panel, note });
        layout = reduce(layout, { type: "changeNote", panel, note: "n1", change: { text: "Hard start", dx: 60 } });
        expect(layout.panels[0]!.notes).toEqual([{ ...note, text: "Hard start", dx: 60 }]);
        expect(readLayout(JSON.parse(JSON.stringify(layout)), 1).panels[0]!.notes).toEqual(layout.panels[0]!.notes);
        layout = reduce(layout, { type: "removeNote", panel, note: "n1" });
        expect(layout.panels[0]!.notes).toEqual([]);
        // A saved label that doesn't say where it points is left out.
        const read = readLayout({ panels: [{ notes: [{ text: "where?" }, { ...note, arrow: "yes" }] }] }, 1);
        expect(read.panels[0]!.notes).toEqual([note]);
    });

    test("sit their offset from the point they're about, inside the plot, with the arrow leaving the box's edge", () => {
        const g = { width: 600, height: 300, left: 70, right: 586, top: 8, bottom: 276 };
        const ranges = { left: [0, 100] as [number, number], right: null };
        const measure = (text: string) => text.length * 7;
        const [hit] = placeNotes([note], measure, g, ranges, [0, 10]);
        // t 5 of 0..10 is halfway across; 50 of 0..100 halfway up.
        expect(hit!.tip).toEqual({ x: 328, y: 142 });
        expect(hit!.box).toEqual({ x: 328 + 40 - 35, y: 142 - 30 - 11.5, w: 70, h: 23 });
        const start = arrowStart(hit!.box, hit!.tip)!;
        expect(start.y).toBeCloseTo(hit!.box.y + hit!.box.h); // out of the bottom edge, towards the point below
        // A label that would hang off the plot is kept on it; one about a time out of view isn't drawn.
        const [edge] = placeNotes([{ ...note, t: 9.99, dx: 200 }], measure, g, ranges, [0, 10]);
        expect(edge!.box.x + edge!.box.w).toBeLessThanOrEqual(g.right - 1);
        expect(placeNotes([{ ...note, t: 20 }], measure, g, ranges, [0, 10])).toEqual([]);
        // An arrow to a point inside its box isn't drawn.
        expect(arrowStart({ x: 0, y: 0, w: 100, h: 20 }, { x: 50, y: 10 })).toBeNull();
    });
});
