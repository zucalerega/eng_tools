import { request, requestBytes } from "../api";
import { packJson } from "../packed";
import type { Part } from "./drawing";

// A test from Yorg, read as any client of Yorg's API reads one: its list of tests, a test's channels, and their
// samples. Piper imports none of Yorg's code; what it knows of Yorg is its API (docs/yorg.md), and the address of its
// plots, which links carry their layout in (?plots=, as packed.ts packs it).

/** A test as Yorg lists it (one of its datasets). */
export interface Test {
    id: number;
    name: string;
    status: "reading" | "ready" | "failed";
    created_at: string;
    t_min: number | null;
    t_max: number | null;
    deleted_at: string | null;
}

export interface TestChannel {
    name: string;
    unit: string;
    kind: "number" | "state"; // a state: text, numbered in the order of its labels (a valve's off 0, on 1)
    labels: string[];
    decimals: number | null; // the most digits after the point the file had
    time: string; // its arrays, in the test's data
    values: string;
}

export interface TestEvent {
    t: number;
    label: string;
}

export interface TestDetail extends Test {
    data_version: string | null;
    channels: TestChannel[];
    events: TestEvent[];
}

export const tests = (): Promise<Test[]> => request<Test[]>("GET", "/api/yorg/datasets");

export const test = (id: number): Promise<TestDetail> => request<TestDetail>("GET", `/api/yorg/datasets/${id}`);

/** A channel's samples: their times, and values (NaN where there's none), little-endian float64 as Yorg keeps them. */
export interface Samples {
    t: Float64Array;
    v: Float64Array;
}

export async function samplesOf(detail: TestDetail, channel: TestChannel): Promise<Samples> {
    const base = `/api/yorg/datasets/${detail.id}/data/${detail.data_version}/`;
    const [t, v] = await Promise.all([requestBytes(base + channel.time), requestBytes(base + channel.values)]);
    return { t: new Float64Array(t), v: new Float64Array(v) };
}

const loose = (name: string) => name.toLowerCase().replace(/[\s_.-]+/g, "");

/** A test's channel by name: as written, whatever its case, then ignoring spaces, dashes, and underscores. */
export function findChannel(detail: TestDetail, name: string): TestChannel | null {
    const wanted = name.trim();
    if (!wanted) {
        return null;
    }
    const lower = wanted.toLowerCase();
    return (
        detail.channels.find((channel) => channel.name.toLowerCase() === lower) ??
        detail.channels.find((channel) => loose(channel.name) === loose(wanted)) ??
        null
    );
}

/** The channel a part reads: the one named in its Test channel property, or else its tag. */
export const channelName = (part: Part): string => (part.props.channel ?? "").trim() || part.tag.trim();

/** A channel's value at a time: its last sample then, or null before its first (or where it's missing). */
export function valueAt(samples: Samples, t: number): number | null {
    const times = samples.t;
    if (times.length === 0 || t < times[0]!) {
        return null;
    }
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid]! <= t) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    const value = samples.v[lo]!;
    return Number.isNaN(value) ? null : value;
}

export type ValveState = "open" | "closed" | "other";

/**
 * What a valve's channel says it is: a state channel's off (0) is closed and on (1) open, as Yorg numbers a switch's
 * states; a number channel (a command, a position) is open where it isn't 0.
 */
export function stateOf(channel: TestChannel, value: number): ValveState {
    if (channel.kind === "state") {
        return value === 0 ? "closed" : value === 1 ? "open" : "other";
    }
    return Math.abs(value) < 1e-9 ? "closed" : "open";
}

/** A channel's value as it reads beside its part: a state's label, a number to the digits its file had (at most 3). */
export function formatValue(channel: TestChannel, value: number): string {
    if (channel.kind === "state") {
        return channel.labels[Math.round(value)] ?? String(value);
    }
    const digits = channel.decimals === null ? (Math.abs(value) >= 100 ? 1 : 2) : Math.min(3, channel.decimals);
    return `${value.toFixed(digits)}${channel.unit ? ` ${channel.unit}` : ""}`;
}

/** A channel's samples over a span, as a polyline of at most width points' lows and highs: a sparkline's. */
export function outline(
    samples: Samples,
    from: number,
    to: number,
    width: number,
): { t: number; lo: number; hi: number }[] {
    const columns: { t: number; lo: number; hi: number }[] = [];
    if (to <= from || width < 1) {
        return columns;
    }
    const step = (to - from) / width;
    for (let index = 0; index < samples.t.length; index++) {
        const t = samples.t[index]!;
        const v = samples.v[index]!;
        if (t < from || t > to || Number.isNaN(v)) {
            continue;
        }
        const column = Math.min(width - 1, Math.floor((t - from) / step));
        const last = columns[columns.length - 1];
        if (last && Math.floor((last.t - from) / step) === column) {
            last.lo = Math.min(last.lo, v);
            last.hi = Math.max(last.hi, v);
        } else {
            columns.push({ t, lo: v, hi: v });
        }
    }
    return columns;
}

/** A link to a test in Yorg with channels plotted together, as Yorg's own Copy link makes them. */
export async function plotLink(testId: number, channels: string[]): Promise<string> {
    const layout = {
        version: 1,
        datasets: [{ id: testId, shift: 0 }],
        panels: [{ series: channels.map((channel) => ({ dataset: testId, channel })) }],
    };
    return `/yorg/datasets/${testId}?plots=${await packJson(layout)}`;
}
