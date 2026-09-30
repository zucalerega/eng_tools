import { request } from "../../api";
import type { Channel, Dataset, DatasetDetail } from "../api";
import { datasetWhenReady, samples, samplesWhenReady } from "../data";
import { storedT0 } from "../pages";
import { bytesOf, type Bytes } from "./sandbox";
import { channelsToLoad } from "./tree";

// What a run needs from the page: the tests attached to it (their channels' names and units), and the samples of the
// channels its code names, from the same store the plots use (so what a page has plotted is here already). Python
// keeps the channels it's been given (yorg.py) under a key for each read of each channel, so a run hands over only
// those it hasn't had, and a test's channels share their times, which go once.

/** What a run starts with: the tests attached to the script, the first first, and their channels. */
export interface RunContext {
    datasets: {
        id: number;
        name: string;
        t0: number | null;
        channels: { name: string; unit: string; kind: string; labels: string[] }[];
    }[];
}

/** A channel as Python takes it: what it is (JSON), its times (null: Python has them), and its values. */
export interface Handover {
    meta: string;
    t: Bytes | null;
    v: Bytes;
}

/** What a run has gathered: its context, and the channels it names, by key (all of them in this tab). */
export interface Inputs {
    context: RunContext;
    keys: string[];
    fetched: boolean; // whether any channel had to come from the server
    channels: Map<string, { detail: DatasetDetail; channel: Channel }>;
}

/** The key of one read of a channel's values, as Python keeps it (and the page's store does). */
export const channelKey = (detail: DatasetDetail, channel: Channel): string =>
    `${detail.id}/${detail.data_version}/${channel.values}`;

/** The key of a channel's times: its test's channels mostly share one array. */
const timeKey = (detail: DatasetDetail, channel: Channel): string =>
    `${detail.id}/${detail.data_version}/${channel.time}`;

/** A channel by name: exactly, else ignoring case. */
const findChannel = (detail: DatasetDetail, name: string): Channel | undefined =>
    detail.channels.find((one) => one.name === name) ??
    detail.channels.find((one) => one.name.toLowerCase() === name.toLowerCase());

/**
 * Gather what a run needs: its tests, and the channels its code names, loaded (from the server, unless the tab has
 * them: onServer says which are coming first).
 */
export async function gatherInputs(
    code: string,
    datasets: number[],
    onServer: (names: string[]) => void = () => {},
): Promise<Inputs> {
    const tests = await Promise.all(datasets.map((id) => datasetWhenReady(id)));
    const context: RunContext = {
        datasets: tests.map((detail) => ({
            id: detail.id,
            name: detail.name,
            t0: storedT0(detail.id),
            channels: detail.channels.map(({ name, unit, kind, labels }) => ({ name, unit, kind, labels })),
        })),
    };
    const wanted = channelsToLoad(
        code,
        tests.map((detail) => ({ id: detail.id, name: detail.name, channels: detail.channels.map((one) => one.name) })),
    );
    const channels = new Map<string, { detail: DatasetDetail; channel: Channel }>();
    for (const one of wanted) {
        const detail = tests.find((test) => test.id === one.dataset)!;
        const channel = findChannel(detail, one.channel)!;
        channels.set(channelKey(detail, channel), { detail, channel });
    }
    const coming = [...channels.values()].filter(({ detail, channel }) => samples(detail, channel).status !== "ready");
    if (coming.length) {
        onServer(coming.map(({ channel }) => channel.name));
    }
    await Promise.all([...channels.values()].map(({ detail, channel }) => samplesWhenReady(detail, channel)));
    return { context, keys: [...channels.keys()], fetched: coming.length > 0, channels };
}

/** A channel's handover: its times too, unless Python has them (or one handed over just before in this batch). */
function handoverOf(
    detail: DatasetDetail,
    channel: Channel,
    times: Float64Array | null,
    values: Float64Array,
): Handover {
    const meta = {
        key: channelKey(detail, channel),
        time_key: timeKey(detail, channel),
        name: channel.name,
        unit: channel.unit,
        labels: channel.labels,
        dataset: detail.name,
        dataset_id: detail.id,
    };
    return { meta: JSON.stringify(meta), t: times ? bytesOf(times) : null, v: bytesOf(values) };
}

/**
 * The channels Python asked for (by key), in order, each with its times unless Python has them (known: the time keys it
 * has) or an earlier one in the list brings them.
 */
export async function handover(inputs: Inputs, keys: string[], known: string[]): Promise<Handover[]> {
    const found = await Promise.all(
        keys.map(async (key) => {
            const one = inputs.channels.get(key);
            if (!one) {
                throw new Error(`The run has no channel ${key}`);
            }
            return { ...one, samples: await samplesWhenReady(one.detail, one.channel) };
        }),
    );
    const brought = new Set(known);
    return found.map(({ detail, channel, samples: loaded }) => {
        const time = timeKey(detail, channel);
        const withTimes = !brought.has(time);
        brought.add(time);
        return handoverOf(detail, channel, withTimes ? loaded.times : null, loaded.values);
    });
}

/** Every test there is, ready to read, as yorg.datasets() gives them. */
export async function datasetList(): Promise<string> {
    const all = await request<Dataset[]>("GET", "/api/yorg/datasets");
    return JSON.stringify(
        all
            .filter((one) => one.status === "ready")
            .map(({ id, name, rows, t_min, t_max, time_kind }) => ({ id, name, rows, t_min, t_max, time_kind })),
    );
}

/** A test by its id, or its name (refused if two have it: only an id says which), or the first attached (null). */
async function testOf(which: unknown, attached: number[]): Promise<DatasetDetail> {
    if (typeof which === "number") {
        return datasetWhenReady(which);
    }
    if (typeof which === "string" && which.trim()) {
        const all = await request<Dataset[]>("GET", "/api/yorg/datasets");
        const wanted = which.trim().toLowerCase();
        const named = all.filter((one) => one.name === which);
        const found = named.length ? named : all.filter((one) => one.name.toLowerCase() === wanted);
        if (found.length > 1) {
            // Tests in two folders can have one name: only an id says which.
            const ids = found.map((one) => one.id).join(" or ");
            throw new Error(`${found.length} tests are called ${which}: say which by its id (dataset=${ids})`);
        }
        const id = found[0]?.id;
        if (id === undefined) {
            throw new Error(`There's no test called ${which}`);
        }
        return datasetWhenReady(id);
    }
    const first = attached[0];
    if (first === undefined) {
        throw new Error("Attach a test to the script (Data), or name one: dataset=...");
    }
    return datasetWhenReady(first);
}

/** Any channel of any test, as yorg.load asks for it (with its times: it goes on its own). */
export async function channelNamed(name: string, which: unknown, attached: number[]): Promise<Handover> {
    const detail = await testOf(which, attached);
    const channel = findChannel(detail, name);
    if (!channel) {
        throw new Error(`${detail.name} has no channel ${name}`);
    }
    const loaded = await samplesWhenReady(detail, channel);
    return handoverOf(detail, channel, loaded.times, loaded.values);
}
