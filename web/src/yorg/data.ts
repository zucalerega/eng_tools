import { useSyncExternalStore } from "react";
import { yorg, type Channel, type DatasetDetail, type Formula } from "./api";
import { calculate, channelsOf, findChannel, FormulaError, readFormula, type Input, type Node } from "./formula";
import type { Layout } from "./layout";
import { intersect, runsOf, within, type Runs } from "./masks";
import { Samples } from "./samples";

// Datasets and channels' samples, each loaded once and shared by every plot on the page. Samples can be big (a
// minute at 10 kHz is 5 MB a channel), so those not looked at for a while go once there are too many; the browser
// keeps the arrays (they never change), so bringing them back is quick.

export type Loaded<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; error: string };

const BUDGET = 768 * 1024 * 1024;
const RECENT_MS = 30_000;

class Store<T> {
    private readonly entries = new Map<string, { loaded: Loaded<T>; used: number; bytes: number }>();
    private readonly listeners = new Set<() => void>();
    private version = 0;

    constructor(private readonly size: (value: T) => number = () => 0) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    snapshot = (): number => this.version;

    /** What's loaded for key, loading it (with load) the first time it's asked for. */
    get(key: string, load: () => Promise<T>): Loaded<T> {
        const found = this.entries.get(key);
        if (found) {
            found.used = Date.now();
            return found.loaded;
        }
        const entry = { loaded: { status: "loading" } as Loaded<T>, used: Date.now(), bytes: 0 };
        this.entries.set(key, entry);
        load().then(
            (value) => this.settle(key, entry, { status: "ready", value }, this.size(value)),
            (error: unknown) =>
                this.settle(key, entry, {
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                }),
        );
        return entry.loaded;
    }

    /** Forget key, so the next get loads it again. */
    forget(key: string): void {
        if (this.entries.delete(key)) {
            this.changed();
        }
    }

    /** What key is now, known already (the server just sent it back). */
    put(key: string, value: T): void {
        this.entries.set(key, { loaded: { status: "ready", value }, used: Date.now(), bytes: this.size(value) });
        this.changed();
    }

    /** Load key again, showing what's there until the new one comes. */
    refresh(key: string, load: () => Promise<T>): Promise<void> {
        if (this.entries.get(key)?.loaded.status !== "ready") {
            this.forget(key);
            return Promise.resolve();
        }
        return load().then(
            (value) => this.put(key, value),
            () => this.forget(key),
        );
    }

    private settle(key: string, entry: { loaded: Loaded<T>; bytes: number }, loaded: Loaded<T>, bytes = 0) {
        if (this.entries.get(key) !== entry) {
            return; // forgotten meanwhile
        }
        entry.loaded = loaded;
        entry.bytes = bytes;
        this.trim();
        this.changed();
    }

    private trim() {
        let total = 0;
        for (const entry of this.entries.values()) {
            total += entry.bytes;
        }
        const old = [...this.entries].filter(([, entry]) => entry.bytes > 0 && Date.now() - entry.used > RECENT_MS);
        old.sort(([, a], [, b]) => a.used - b.used);
        for (const [key, entry] of old) {
            if (total <= BUDGET) {
                break;
            }
            this.entries.delete(key);
            total -= entry.bytes;
        }
    }

    private changed() {
        this.version += 1;
        this.listeners.forEach((listener) => listener());
    }
}

export const datasetStore = new Store<DatasetDetail>();
const sampleStore = new Store<Samples>((samples) => samples.times.byteLength + samples.values.byteLength);

// A dataset's time array is shared by most of its channels: fetch it once while anything still holds it.
const arrays = new Map<string, Promise<Float64Array> | WeakRef<Float64Array>>();

function array(dataset: DatasetDetail, file: string): Promise<Float64Array> {
    const key = `${dataset.id}/${dataset.data_version}/${file}`;
    const found = arrays.get(key);
    if (found instanceof Promise) {
        return found;
    }
    const alive = found?.deref();
    if (alive) {
        return Promise.resolve(alive);
    }
    const loading = yorg.array(dataset, file).then(
        (values) => {
            arrays.set(key, new WeakRef(values));
            return values;
        },
        (error: unknown) => {
            arrays.delete(key);
            throw error;
        },
    );
    arrays.set(key, loading);
    return loading;
}

export function dataset(id: number): Loaded<DatasetDetail> {
    return datasetStore.get(String(id), () => yorg.dataset(id));
}

/** A channel's samples, from its dataset's latest read. */
export function samples(detail: DatasetDetail, channel: Channel): Loaded<Samples> {
    return sampleStore.get(`${detail.id}/${detail.data_version}/${channel.values}`, async () => {
        const [times, values] = await Promise.all([array(detail, channel.time), array(detail, channel.values)]);
        return new Samples(times, values);
    });
}

/** What a store has once it's in (asking for it with get, which loads it the first time), for code that waits. */
function whenReady<T>(store: Store<T>, get: () => Loaded<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const settled = (): boolean => {
            const loaded = get();
            if (loaded.status === "loading") {
                return false;
            }
            unsubscribe();
            if (loaded.status === "ready") {
                resolve(loaded.value);
            } else {
                reject(new Error(loaded.error));
            }
            return true;
        };
        if (!settled()) {
            unsubscribe = store.subscribe(() => void settled());
        }
    });
}

/** A dataset once it's in (the same one its page shows). */
export function datasetWhenReady(id: number): Promise<DatasetDetail> {
    return whenReady(datasetStore, () => dataset(id));
}

/** A channel's samples once they're in (the same ones the plots use), for code that waits rather than redraws. */
export function samplesWhenReady(detail: DatasetDetail, channel: Channel): Promise<Samples> {
    return whenReady(sampleStore, () => samples(detail, channel));
}

/** Load a dataset again (it was renamed, deleted, or restored), showing it as it was until then. */
export function reloadDataset(id: number): Promise<void> {
    return datasetStore.refresh(String(id), () => yorg.dataset(id));
}

/** A dataset as the server just sent it back (after reading it again). */
export function showDataset(detail: DatasetDetail): void {
    datasetStore.put(String(detail.id), detail);
}

// --- calculated channels ------------------------------------------------------------------------------------------

const formulaStore = new Store<Formula[]>();

/** The team's calculated channels. */
export function formulas(): Loaded<Formula[]> {
    return formulaStore.get("all", () => yorg.formulas());
}

/** Load the calculated channels again, after one was added, changed, or deleted. */
export function reloadFormulas(): Promise<void> {
    return formulaStore.refresh("all", () => yorg.formulas());
}

/**
 * A dataset an expression reads channels from, and how far its times move to line up with the first one's (whose
 * times the result is on): a dataset's own calculated channels have one, with no shift; one across the datasets
 * compared on a page has each of them, shifted as they are there.
 */
export interface Place {
    detail: DatasetDetail;
    shift: number;
}

/** The datasets on a page, lined up as they are there: each shifted from the first. Null until they're all in. */
export function placesOf(layout: Layout): Place[] | null {
    const places: Place[] = [];
    for (const ref of layout.datasets) {
        const loaded = dataset(ref.id);
        if (loaded.status !== "ready") {
            return null;
        }
        places.push({ detail: loaded.value, shift: ref.shift - layout.datasets[0]!.shift });
    }
    return places;
}

/** Where a name in an expression comes from: a dataset's channel, or another calculated channel, worked out first. */
type Source =
    { kind: "channel"; place: Place; channel: Channel } | { kind: "formula"; formula: FormulaRef; plan: Plan };

/** An expression ready to work out: where each name in it comes from, and a key that changes when any of that does. */
export interface Plan {
    tree: Node;
    sources: ReadonlyMap<string, Source>;
    key: string;
    datasets: DatasetDetail[]; // those it reads channels from (through the calculated channels it uses, too)
}

/** What a calculated channel is to an expression: one the team has, or the one being written (id null, if new). */
export type FormulaRef = Pick<Formula, "name" | "expression"> & { id: number | null };

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A calculated channel that comes back to itself: said as it is, wherever in the chain it's found. */
class Loop extends FormulaError {}

const placesText = (places: readonly Place[]): string => {
    const names = places.map((place) => place.detail.name);
    return names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
};

function sourceOf(
    name: string,
    places: readonly Place[],
    list: readonly FormulaRef[],
    using: readonly string[],
): Source | FormulaError {
    // A dataset's own channel first (the first dataset's, across several), then a calculated channel.
    for (const place of places) {
        const channel = findChannel(place.detail.channels, name);
        if (channel) {
            return { kind: "channel", place, channel };
        }
    }
    const formula = findChannel(list, name);
    if (!formula) {
        return new FormulaError(`${name} isn't a channel of ${placesText(places)}, or a calculated channel`, 0);
    }
    const loop = using.findIndex((one) => sameName(one, formula.name));
    if (loop >= 0) {
        const chain = [...using.slice(loop), formula.name];
        return new Loop(
            `A calculated channel can't use itself: ${chain[0]} uses ${chain.slice(1).join(", which uses ")}`,
            0,
        );
    }
    const inner = plan(formula.expression, places, list, [...using, formula.name]);
    if (inner instanceof Loop) {
        return inner;
    }
    if (inner instanceof FormulaError) {
        return new FormulaError(`${formula.name}, which this uses: ${inner.message}`, 0);
    }
    return { kind: "formula", formula, plan: inner };
}

/**
 * How an expression is worked out in places, or why it can't be: each name a channel of the first of them that has
 * it, else a calculated channel, worked out there the same way (never one that comes back to itself: using names
 * those it's inside).
 */
export function plan(
    expression: string,
    places: readonly Place[],
    list: readonly FormulaRef[],
    using: readonly string[] = [],
): Plan | FormulaError {
    const tree = readFormula(expression);
    if (tree instanceof FormulaError) {
        return tree;
    }
    const sources = new Map<string, Source>();
    const datasets = new Map<number, DatasetDetail>();
    for (const name of channelsOf(tree)) {
        const source = sourceOf(name, places, list, using);
        if (source instanceof FormulaError) {
            return source;
        }
        sources.set(name, source);
        if (source.kind === "channel") {
            datasets.set(source.place.detail.id, source.place.detail);
        } else {
            source.plan.datasets.forEach((one) => datasets.set(one.id, one));
        }
    }
    const parts = [...sources].map(([name, source]) =>
        source.kind === "channel"
            ? `${name}=${source.place.detail.id}/${source.place.detail.data_version}/${source.channel.values}@${source.place.shift}`
            : `${name}=(${source.plan.key})`,
    );
    return { tree, sources, key: [expression, ...parts].join("\n"), datasets: [...datasets.values()] };
}

/** How a calculated channel is worked out for a dataset on a page: in it alone, or across the page's datasets. */
export interface Planned {
    plan: Plan;
    across: boolean;
}

/**
 * A calculated channel for a dataset: in it alone if it has what it uses (as a calculated channel always was), else
 * across the datasets on the page (page: as placesOf gives them), for the first of them, whose times are the result's.
 */
export function planFor(
    formula: FormulaRef,
    own: DatasetDetail,
    page: readonly Place[] | null,
    list: readonly FormulaRef[],
): Planned | FormulaError {
    const alone = plan(formula.expression, [{ detail: own, shift: 0 }], list, [formula.name]);
    if (!(alone instanceof FormulaError) || !page || page.length < 2 || page[0]!.detail.id !== own.id) {
        return alone instanceof FormulaError ? alone : { plan: alone, across: false };
    }
    const across = plan(formula.expression, page, list, [formula.name]);
    return across instanceof FormulaError ? across : { plan: across, across: true };
}

/** Whether a dataset can have a calculated channel on its own: it has what that uses. */
export function fitsAlone(formula: FormulaRef, detail: DatasetDetail, list: readonly FormulaRef[]): boolean {
    return !(plan(formula.expression, [{ detail, shift: 0 }], list, [formula.name]) instanceof FormulaError);
}

const shifted = (times: Float64Array, shift: number): Float64Array =>
    shift === 0 ? times : times.map((t) => t + shift);

async function work(planned: Plan): Promise<Samples> {
    const inputs = new Map<string, Input>();
    await Promise.all(
        [...planned.sources].map(async ([name, source]) => {
            if (source.kind === "formula") {
                inputs.set(name, { samples: await workedOut(source.plan), step: false });
                return;
            }
            const { detail, shift } = source.place;
            const [times, values] = await Promise.all([
                array(detail, source.channel.time),
                array(detail, source.channel.values),
            ]);
            inputs.set(name, {
                samples: new Samples(shifted(times, shift), values),
                step: source.channel.kind === "state",
            });
        }),
    );
    return calculate(planned.tree, inputs);
}

/** A plan's samples, worked out once and shared: a calculated channel plotted, used by another, or tried out. */
export function worked(planned: Plan): Loaded<Samples> {
    return sampleStore.get(`calculated/${planned.key}`, () => work(planned));
}

/** A plan's samples once they're worked out, for code that waits (trying an expression out as it's written). */
export function workedOut(planned: Plan): Promise<Samples> {
    return whenReady(sampleStore, () => worked(planned));
}

// --- masks --------------------------------------------------------------------------------------------------------

const runStore = new Store<Runs>((runs) => runs.byteLength);

/**
 * Where every one of the tests holds in a dataset (its latest read): runs of its own time, worked out once. A test can
 * use calculated channels, so this waits for them to be listed.
 */
export function maskRuns(detail: DatasetDetail, expressions: readonly string[]): Loaded<Runs> {
    const list = formulas();
    if (list.status === "loading") {
        return { status: "loading" };
    }
    const known = list.status === "ready" ? list.value : [];
    const plans = expressions.map((expression) => plan(expression, [{ detail, shift: 0 }], known));
    const key = plans.map((one) => (one instanceof FormulaError ? `!${one.message}` : one.key)).join("\n\n");
    return runStore.get(`${detail.id}/${detail.data_version}/mask/${key}`, async () => {
        const each = await Promise.all(
            plans.map(async (one) => {
                if (one instanceof FormulaError) {
                    throw one;
                }
                return runsOf(await workedOut(one));
            }),
        );
        return each.reduce((all, runs) => intersect(all, runs));
    });
}

const maskedStore = new WeakMap<Samples, WeakMap<Runs, Samples>>();

/** Samples with those outside the runs missing: each channel masked once for each mask. */
export function masked(samples: Samples, runs: Runs): Samples {
    let byRuns = maskedStore.get(samples);
    if (!byRuns) {
        byRuns = new WeakMap();
        maskedStore.set(samples, byRuns);
    }
    let found = byRuns.get(runs);
    if (!found) {
        found = within(samples, runs);
        byRuns.set(runs, found);
    }
    return found;
}

/** Re-render when anything loads. The number goes up each time, for memos that depend on what's loaded. */
export function useLoaded(): number {
    const datasets = useSyncExternalStore(datasetStore.subscribe, datasetStore.snapshot);
    const loadedSamples = useSyncExternalStore(sampleStore.subscribe, sampleStore.snapshot);
    const loadedFormulas = useSyncExternalStore(formulaStore.subscribe, formulaStore.snapshot);
    const loadedRuns = useSyncExternalStore(runStore.subscribe, runStore.snapshot);
    return datasets + loadedSamples + loadedFormulas + loadedRuns;
}
