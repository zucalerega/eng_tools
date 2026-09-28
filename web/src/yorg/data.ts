import { useSyncExternalStore } from "react";
import { yorg, type Channel, type DatasetDetail } from "./api";
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

/** Load a dataset again (it was renamed, deleted, or restored), showing it as it was until then. */
export function reloadDataset(id: number): Promise<void> {
    return datasetStore.refresh(String(id), () => yorg.dataset(id));
}

/** A dataset as the server just sent it back (after reading it again). */
export function showDataset(detail: DatasetDetail): void {
    datasetStore.put(String(detail.id), detail);
}

/** Re-render when anything loads. The number goes up each time, for memos that depend on what's loaded. */
export function useLoaded(): number {
    const datasets = useSyncExternalStore(datasetStore.subscribe, datasetStore.snapshot);
    const loadedSamples = useSyncExternalStore(sampleStore.subscribe, sampleStore.snapshot);
    return datasets + loadedSamples;
}
