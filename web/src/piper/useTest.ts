import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import type { LiveValue } from "./DiagramView";
import type { Drawing, Part } from "./drawing";
import { kindOf } from "./library/index";
import {
    channelNames,
    findChannel,
    formatValue,
    samplesOf,
    stateOf,
    test as fetchTest,
    valueAt,
    type Samples,
    type TestDetail,
} from "./testdata";

// A drawing read against a test from Yorg: the test's channels, the samples of those the drawing's parts read (each
// fetched once), and what each part's channel says at the time shown.

export interface TestReading {
    detail: TestDetail;
    time: number;
    samples: ReadonlyMap<string, Samples>; // by channel name: those loaded so far
    live: Map<string, LiveValue>; // by part id
    missing: Part[]; // parts that read a channel the test doesn't have
}

/** The parts that read a test's channels: instruments and flow meters their values, valves their states. */
export const readers = (drawing: Drawing): Part[] => drawing.parts.filter((part) => kindOf(part.kind).reads);

export function useTest(
    drawing: Drawing,
    testId: number | null,
    time: number,
): { reading: TestReading | null; problem: string | null } {
    const [detail, setDetail] = useState<TestDetail | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [samples, setSamples] = useState<Map<string, Samples>>(new Map());

    useEffect(() => {
        setDetail(null);
        setSamples(new Map());
        setProblem(null);
        if (testId === null) {
            return;
        }
        let current = true;
        fetchTest(testId).then(
            (found) => {
                if (!current) {
                    return;
                }
                if (found.status !== "ready" || found.deleted_at) {
                    setProblem(
                        found.deleted_at
                            ? `${found.name} is deleted in Yorg.`
                            : found.status === "failed"
                              ? `Yorg couldn't read ${found.name}'s file.`
                              : `Yorg is still reading ${found.name}.`,
                    );
                    return;
                }
                setDetail(found);
            },
            (error: unknown) => {
                if (current) {
                    setProblem(
                        error instanceof ApiError && error.status === 404
                            ? "That test isn't in Yorg any more."
                            : error instanceof Error
                              ? error.message
                              : String(error),
                    );
                }
            },
        );
        return () => {
            current = false;
        };
    }, [testId]);

    // The channels the drawing's parts read, by name: fetched as they're first wanted.
    const wanted = useMemo(() => {
        if (!detail) {
            return [];
        }
        const names = readers(drawing)
            .flatMap((part) => channelNames(part).map((name) => findChannel(detail, name)?.name))
            .filter((name) => name !== undefined);
        return [...new Set(names)];
    }, [detail, drawing]);

    useEffect(() => {
        if (!detail) {
            return;
        }
        let current = true;
        for (const name of wanted) {
            if (samples.has(name)) {
                continue;
            }
            const channel = detail.channels.find((entry) => entry.name === name);
            if (!channel) {
                continue;
            }
            samplesOf(detail, channel).then(
                (loaded) => {
                    if (current) {
                        setSamples((now) => new Map(now).set(name, loaded));
                    }
                },
                (error: unknown) => {
                    if (current) {
                        setProblem(`Couldn't load ${name}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                },
            );
        }
        return () => {
            current = false;
        };
        // Not on samples: each channel's fetched once, when it's first wanted, not again as others arrive.
    }, [detail, wanted]);

    const reading = useMemo((): TestReading | null => {
        if (!detail) {
            return null;
        }
        const live = new Map<string, LiveValue>();
        const missing: Part[] = [];
        for (const part of readers(drawing)) {
            const names = channelNames(part);
            if (names.length === 0) {
                continue; // nothing to read it by yet
            }
            const channels = names.map((name) => findChannel(detail, name));
            if (channels.some((channel) => !channel)) {
                missing.push(part);
            }
            const found = channels.filter((channel) => channel !== null);
            if (found.length === 0) {
                live.set(part.id, { text: "", state: null, missing: true });
                continue;
            }
            // Each of its channels' values at the time: a duplicated transducer's two, side by side.
            const values = found.map((channel) => {
                const loaded = samples.get(channel.name);
                return { channel, value: loaded ? valueAt(loaded, time) : null };
            });
            const reads = kindOf(part.kind).reads;
            const first = values[0]!;
            live.set(part.id, {
                text: values
                    .filter((entry) => entry.value !== null)
                    .map((entry) => formatValue(entry.channel, entry.value!))
                    .join(" / "),
                state: first.value === null || reads !== "state" ? null : stateOf(first.channel, first.value),
                missing: found.length < names.length,
            });
        }
        return { detail, time, samples, live, missing };
    }, [detail, drawing, samples, time]);

    return { reading, problem };
}
