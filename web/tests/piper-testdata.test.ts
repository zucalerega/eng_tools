import { expect, test } from "vitest";
import { newPart } from "../src/piper/drawing";
import { unpackJson } from "../src/packed";
import {
    channelName,
    channelNames,
    findChannel,
    formatValue,
    outline,
    plotLink,
    stateOf,
    valueAt,
    type TestChannel,
    type TestDetail,
} from "../src/piper/testdata";

// Reading a test from Yorg on a drawing: which channel a part reads, its value at a time, a valve's state, and the link
// that plots it in Yorg.

const channel = (name: string, more: Partial<TestChannel> = {}): TestChannel => ({
    name,
    unit: "",
    kind: "number",
    labels: [],
    decimals: null,
    time: "time.f64",
    values: "c1.f64",
    ...more,
});

const detail = (...channels: TestChannel[]): TestDetail => ({
    id: 5,
    name: "HF-3",
    status: "ready",
    created_at: "2026-10-01T00:00:00Z",
    t_min: 0,
    t_max: 10,
    deleted_at: null,
    data_version: "0123456789abcdef",
    channels,
    events: [],
});

test("a part reads the channel named in Test channel, or else its tag", () => {
    expect(channelName(newPart("instrument", { x: 0, y: 0 }, { tag: "PT-101" }))).toBe("PT-101");
    expect(channelName(newPart("instrument", { x: 0, y: 0 }, { tag: "PT-101", props: { channel: " PT-OX " } }))).toBe(
        "PT-OX",
    );
});

test("a duplicated or triplicated transducer reads a channel each: those named, or its tag's with A, B, C", () => {
    const sensor = (props: Record<string, string>) => newPart("instrument", { x: 0, y: 0 }, { tag: "PT-101", props });
    expect(channelNames(sensor({ count: "2" }))).toEqual(["PT-101A", "PT-101B"]);
    expect(channelNames(sensor({ count: "3", channel: "PT-OX" }))).toEqual(["PT-OXA", "PT-OXB", "PT-OXC"]);
    expect(channelNames(sensor({ count: "2", channel: "PT-OX-1, PT-OX-2" }))).toEqual(["PT-OX-1", "PT-OX-2"]);
    expect(channelNames(sensor({ channel: "PT-OX-1, PT-OX-2" }))).toEqual(["PT-OX-1"]); // one transducer, one
    expect(channelName(sensor({ count: "2" }))).toBe("PT-101A");
});

test("channels are found by name whatever their case, then ignoring spaces, dashes, and underscores", () => {
    const test = detail(channel("PT-OX-01"), channel("TC Nozzle"), channel("pt_fu_01"));
    expect(findChannel(test, "pt-ox-01")?.name).toBe("PT-OX-01");
    expect(findChannel(test, "TC-NOZZLE")?.name).toBe("TC Nozzle");
    expect(findChannel(test, "PT-FU-01")?.name).toBe("pt_fu_01");
    expect(findChannel(test, "PT-02")).toBeNull();
    expect(findChannel(test, "  ")).toBeNull();
});

test("a channel's value at a time is its last sample then", () => {
    const samples = { t: new Float64Array([0, 1, 2, 3]), v: new Float64Array([10, 20, Number.NaN, 40]) };
    expect(valueAt(samples, -0.5)).toBeNull(); // before its first
    expect(valueAt(samples, 0)).toBe(10);
    expect(valueAt(samples, 1.99)).toBe(20);
    expect(valueAt(samples, 2.5)).toBeNull(); // missing there
    expect(valueAt(samples, 99)).toBe(40);
});

test("a valve's state: a switch's off is closed and on is open; a number is open where it isn't 0", () => {
    const valve = channel("MOV-OX", { kind: "state", labels: ["CLOSED", "OPEN", "FAULT"] });
    expect([0, 1, 2].map((value) => stateOf(valve, value))).toEqual(["closed", "open", "other"]);
    const command = channel("CMD-OX");
    expect([0, 1, 37.5].map((value) => stateOf(command, value))).toEqual(["closed", "open", "open"]);
    expect(formatValue(valve, 1)).toBe("OPEN");
    expect(formatValue(channel("PT-1", { unit: "psi", decimals: 1 }), 452.123)).toBe("452.1 psi");
    expect(formatValue(channel("PT-1", { unit: "psi" }), 452.123)).toBe("452.1 psi");
    expect(formatValue(channel("TC-1", { unit: "K" }), 3.14159)).toBe("3.14 K");
});

test("a sparkline keeps each column's lowest and highest", () => {
    const samples = { t: new Float64Array([0, 0.1, 0.2, 5, 9.9]), v: new Float64Array([1, 5, 3, 7, 2]) };
    expect(outline(samples, 0, 10, 2)).toEqual([
        { t: 0, lo: 1, hi: 5 },
        { t: 5, lo: 2, hi: 7 },
    ]);
});

test("Plot in Yorg links to the test with its channels plotted, as Yorg's own links are made", async () => {
    const link = await plotLink(5, ["PT-OX-01", "MOV-OX"]);
    expect(link.startsWith("/yorg/datasets/5?plots=")).toBe(true);
    const layout = await unpackJson(new URL(link, "http://site").searchParams.get("plots")!, 64 * 1024);
    expect(layout).toEqual({
        version: 1,
        datasets: [{ id: 5, shift: 0 }],
        panels: [
            {
                series: [
                    { dataset: 5, channel: "PT-OX-01" },
                    { dataset: 5, channel: "MOV-OX" },
                ],
            },
        ],
    });
});
