import { describe, expect, test } from "vitest";
import type { DatasetDetail } from "../src/yorg/api";
import {
    forDataset,
    newAxisSide,
    newLayout,
    readLayout,
    reduce,
    type AxisTarget,
    type Layout,
    type Note,
} from "../src/yorg/layout";
import { cutAt, edgeOf, intersect, measure, readTimes, runsOf, testsOf, within } from "../src/yorg/masks";
import { arrowStart, placeNotes } from "../src/yorg/Plot";
import { timeLabels } from "../src/yorg/Workspace";
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
        expect(odd.panels[0]!.series[0]).toMatchObject({ channel: "PT-1", dataset: 9, scale: 1, axis: "up" });
        // A series on an axis the plot doesn't list gets one.
        expect(odd.panels[0]!.axes).toEqual([{ id: "up", side: "left", label: "", min: null, max: null }]);
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
        const ranges = new Map([["left", [0, 100] as [number, number]]]);
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

describe("masks", () => {
    const samples = (times: number[], values: number[]) =>
        new Samples(new Float64Array(times), new Float64Array(values));
    const pairs = (runs: Float64Array) =>
        Array.from({ length: runs.length / 2 }, (_, r) => [runs[2 * r], runs[2 * r + 1]]);

    test("hold where a test isn't 0 and isn't missing, from the first sample that holds to the last", () => {
        const valve = samples([0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 1, 0, 1, NaN, 1, 1]);
        expect(pairs(runsOf(valve))).toEqual([
            [1, 2],
            [4, 4],
            [6, 7],
        ]);
        // A pause in logging ends a run: samples every 0.1 s, then nothing for 5 s.
        const times = [...Array.from({ length: 30 }, (_, i) => i / 10), 8, 8.1, 8.2];
        const paused = runsOf(
            samples(
                times,
                times.map(() => 1),
            ),
        );
        expect(pairs(paused).map(([start, end]) => [start, Number(end!.toFixed(6))])).toEqual([
            [0, 2.9],
            [8, 8.2],
        ]);
        expect(measure(runsOf(valve))).toEqual({ count: 3, total: 2 });
    });

    test("go together, and hide what's outside them", () => {
        const a = Float64Array.from([0, 4, 6, 10]);
        const b = Float64Array.from([2, 7, 9, 12]);
        expect(pairs(intersect(a, b))).toEqual([
            [2, 4],
            [6, 7],
            [9, 10],
        ]);
        const kept = within(samples([0, 1, 2, 3, 4, 5, 6, 7], [10, 11, 12, 13, 14, 15, 16, 17]), b);
        expect([...kept.values].map((value) => (Number.isNaN(value) ? null : value))).toEqual([
            null,
            null,
            12,
            13,
            14,
            15,
            16,
            17,
        ]);
        // The axes fit what's left.
        expect(kept.index.range(0, 8)).toEqual([12, 17]);
    });

    test("find a file's tests: joined when close, blips left out, padded, and inside the file", () => {
        const runs = Float64Array.from([1, 2, 2.3, 3, 10, 10.05, 20, 25]);
        const finding = { before: 1, after: 2, join: 0.5, shortest: 0.1 };
        expect(testsOf(runs, [0, 26], finding)).toEqual([
            { start: 0, end: 5, run: [1, 3] }, // two runs 0.3 s apart are one test
            { start: 19, end: 26, run: [20, 25] }, // padded only to the file's end
        ]);
        expect(testsOf(runs, [0, 26], { ...finding, join: 0, shortest: 0 })).toHaveLength(4);
    });

    test("cut at times, counting each piece's time from where its mask starts holding in it", () => {
        const [test] = testsOf(Float64Array.from([10, 20]), [0, 100], { before: 2, after: 2, join: 0, shortest: 0 });
        const pieces = cutAt([test!], [15, 5, 15, 30]); // outside, repeated, and out of order
        expect(pieces.map((piece) => [piece.start, piece.end, edgeOf(piece)])).toEqual([
            [8, 15, 10],
            [15, 22, 15], // it holds from its start
        ]);
        // Before the run starts, it never holds in the piece.
        expect(edgeOf({ start: 8, end: 9, run: [10, 20] })).toBeNull();
        expect(edgeOf({ start: 0, end: 50, run: null })).toBeNull();
        // The whole file, cut at times typed.
        expect(cutAt([{ start: 0, end: 10, run: null }], readTimes("2.5, 6") as number[])).toEqual([
            { start: 0, end: 2.5, run: null },
            { start: 2.5, end: 6, run: null },
            { start: 6, end: 10, run: null },
        ]);
        expect(readTimes("1; 2 3,4")).toEqual([1, 2, 3, 4]);
        expect(readTimes("1, two")).toBe("two isn't a time: write seconds, like 12.5, 30");
    });

    test("are kept in the layout, and read back from it", () => {
        let layout = newLayout(1);
        const mask = {
            id: "m1",
            name: "Valve open",
            expression: "[MOV-OX] == 1",
            color: "#2ca25f",
            shade: true,
            hide: false,
        };
        layout = reduce(layout, { type: "addMask", mask });
        layout = reduce(layout, { type: "changeMask", mask: "m1", change: { hide: true, name: "Main valve open" } });
        expect(layout.masks).toEqual([{ ...mask, hide: true, name: "Main valve open" }]);
        expect(readLayout(JSON.parse(JSON.stringify(layout)), 1).masks).toEqual(layout.masks);
        // One without a test is left out; the rest get what they're missing.
        const read = readLayout({ masks: [{ name: "Nothing" }, { expression: "[PT] > 5", color: "red" }] }, 1).masks;
        expect(read.map(({ id: _, ...rest }) => rest)).toEqual([
            { name: "Mask 2", expression: "[PT] > 5", color: "#2ca25f", shade: true, hide: false },
        ]);
        expect(reduce(layout, { type: "removeMask", mask: "m1" }).masks).toEqual([]);
    });
});

describe("axes", () => {
    const axisOf = (layout: Layout, series: number) => {
        const [panel] = layout.panels;
        return panel!.axes.findIndex((axis) => axis.id === panel!.series[series]!.axis);
    };

    test("a plot's first channel makes its first axis, and new ones go on the side with fewer", () => {
        let layout = newLayout(1);
        const panel = () => layout.panels[0]!;
        const add = (channel: string, axis?: AxisTarget) =>
            (layout = reduce(layout, { type: "addSeries", panel: panel().id, dataset: 1, channel, axis }));
        add("PT-1");
        add("LC-1", { new: newAxisSide(panel()) });
        add("PT-2", panel().series[0]!.axis);
        add("MOV", { new: newAxisSide(panel()) });
        expect(panel().axes.map((axis) => axis.side)).toEqual(["left", "right", "left"]);
        expect([0, 1, 2, 3].map((index) => axisOf(layout, index))).toEqual([0, 1, 0, 2]);
    });

    test("series move onto new axes and back, and an axis with nothing on it goes", () => {
        let layout = newLayout(1);
        const panel = () => layout.panels[0]!;
        layout = reduce(layout, { type: "addSeries", panel: panel().id, dataset: 1, channel: "PT-1" });
        layout = reduce(layout, { type: "addSeries", panel: panel().id, dataset: 1, channel: "PT-2" });
        const [first, second] = panel().series;
        const move = (axis: AxisTarget) =>
            (layout = reduce(layout, {
                type: "moveSeries",
                panel: panel().id,
                series: second!.id,
                to: panel().id,
                axis,
            }));
        move({ new: "right" });
        expect(panel().axes.map((axis) => axis.side)).toEqual(["left", "right"]);
        move(first!.axis);
        expect(panel().axes).toHaveLength(1);
        // An axis's range and side: one moved to the other side goes outside the axes there.
        move({ new: "left" });
        const outer = panel().axes[1]!.id;
        layout = reduce(layout, {
            type: "changeAxis",
            panel: panel().id,
            axis: first!.axis,
            change: { side: "right", min: 0, max: 600 },
        });
        expect(panel().axes.map((axis) => [axis.id === outer, axis.side, axis.max])).toEqual([
            [true, "left", null],
            [false, "right", 600],
        ]);
        layout = reduce(layout, { type: "removeSeries", panel: panel().id, series: first!.id });
        expect(panel().axes.map((axis) => axis.id)).toEqual([outer]);
    });

    test("an older layout's left and right axes, heights, and time of day read as they meant", () => {
        const read = readLayout(
            {
                clock: true,
                panels: [
                    {
                        height: 260,
                        left: { label: "Pressure", min: 0, max: 600 },
                        right: { label: "", min: null, max: null },
                        series: [
                            { channel: "PT", axis: "left" },
                            { channel: "LC", axis: "right" },
                        ],
                    },
                    { height: 400, series: [{ channel: "TC" }] },
                ],
            },
            7,
        );
        expect(read.time).toBe("utc");
        const [first, second] = read.panels;
        expect(first!.height).toBeNull(); // the old default: it shares the window now
        expect(first!.axes).toEqual([
            { id: "left", side: "left", label: "Pressure", min: 0, max: 600 },
            { id: "right", side: "right", label: "", min: null, max: null },
        ]);
        expect(second!.height).toBe(400);
        expect(second!.axes.map((axis) => axis.id)).toEqual(["left"]); // its right axis had nothing on it
        expect(readLayout({ clock: false }, 1).time).toBe("t0");
        expect(readLayout({}, 1).time).toBe("auto");
        // A layout as it's saved now reads back the same.
        expect(readLayout(JSON.parse(JSON.stringify(read)), 7)).toEqual(read);
    });
});

describe("time", () => {
    const relative = { start_epoch: null, time_kind: "relative", read_info: {}, t_min: 0, t_max: 60 };
    const unix = {
        start_epoch: 1790000000,
        time_kind: "absolute",
        read_info: { utc_offset: null },
        t_min: 0,
        t_max: 4.9,
    };
    const labels = (layout: Partial<Layout>, detail: object) =>
        timeLabels({ ...newLayout(1), ...layout }, detail as unknown as DatasetDetail);
    const minus = "−";

    test("from T0: T-10, T0, T+15 on the axis, at the cursor, and in the window's inputs", () => {
        const time = labels({ t0: 30 }, relative);
        expect(time.title).toBe("Time from T0 (s)");
        expect([20, 30, 45].map((x) => time.axis.label(x, 5))).toEqual([`T${minus}10`, "T0", "T+15"]);
        expect([time.at(31.5), time.at(30)]).toEqual(["T+1.5 s", "T0"]);
        expect(time.text(22.51634, 46)).toBe("T-7.48");
        expect(time.parse("T-7.48")).toBeCloseTo(22.52);
        expect(time.parse(`T${minus}10`)).toBe(20); // a minus sign, as the axis writes it
        expect(time.parse("T0")).toBe(30);
        expect(time.parse("5")).toBe(35); // from T0, in the window's inputs
        expect(time.parse("5", "file")).toBe(5); // or in the file, for T0 itself
        expect(time.parse("12:00")).toBeNull(); // this data has no times of day
        expect(time.clockAt).toBeNull();
        // Without T0: seconds from the start.
        const plain = labels({}, relative);
        expect([plain.title, plain.axis.label(10, 5), plain.at(2.5), plain.text(2.5, 10)]).toEqual([
            "Time (s)",
            "10",
            "2.5 s",
            "2.5",
        ]);
    });

    test("dated data reads as time of day, in UTC, until there's a T0; times of day are typed as they read", () => {
        const time = labels({}, unix); // 1790000000 is 14:13:20 UTC
        expect(time.title).toBe("Time of day (UTC)");
        expect(time.at(1.5)).toBe("14:13:21.500 UTC");
        expect(time.text(1.5, 4.9)).toBe("14:13:21.5");
        expect(time.parse("14:13:21.5")).toBeCloseTo(1.5);
        expect(time.parse("1790000002")).toBeCloseTo(2); // Unix seconds
        expect(time.parse("1790000002500")).toBeCloseTo(2.5); // or milliseconds
        expect(time.parse("2026-09-21T14:13:23Z")).toBeCloseTo(3);
        // With a T0, time's from it, and the cursor says the time of day too.
        const fromT0 = labels({ t0: 1 }, unix);
        expect([fromT0.title, fromT0.at(2)]).toEqual(["Time from T0 (s)", "T+1 s"]);
        expect(fromT0.clockAt!(2)).toBe("14:13:22.000 UTC");
        expect(fromT0.absolute(1)).toBe("14:13:21.000 UTC");
        // Or time of day anyway, if that's what's chosen.
        expect(labels({ t0: 1, time: "utc" }, unix).title).toBe("Time of day (UTC)");
    });
});
