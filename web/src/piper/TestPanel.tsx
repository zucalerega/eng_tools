import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice } from "../components";
import { ItemPicker, type BrowseFolder, type BrowseItem } from "../FolderBrowser";
import { formatDate } from "../format";
import { tests as fetchTests, testFolders, type Test, type TestFolder } from "./testdata";
import { Timeline } from "./Timeline";
import type { TestReading } from "./useTest";

// The test a diagram's read against, from Yorg's datasets, and its timeline: drag it, or play the test, to see each
// instrument's value and each valve's state change on the drawing.

export function TestPanel({
    testId,
    time,
    reading,
    problem,
    onTest,
    onTime,
    onPlot,
    onClose,
}: {
    testId: number | null;
    time: number;
    reading: TestReading | null;
    problem: string | null;
    onTest: (id: number | null) => void;
    onTime: (time: number, settled: boolean) => void; // settled: not mid-drag or mid-play, so it can go in the address
    onPlot: () => void;
    onClose: () => void;
}) {
    const start = reading?.detail.t_min ?? 0;
    const end = reading?.detail.t_max ?? 0;
    const linked = reading ? reading.live.size - reading.missing.length : 0;
    return (
        <section className="piper-test" aria-label="Test data">
            <div className="piper-test-head">
                <h2>Test data</h2>
                <TestSelect testId={testId} onTest={onTest} />
                {reading && (
                    <span className="muted piper-test-count">
                        {linked === 1 ? "1 part reads it" : `${linked} parts read it`}
                    </span>
                )}
                {reading && linked > 0 && (
                    <button type="button" className="button-small" onClick={onPlot}>
                        Plot in Yorg
                    </button>
                )}
                <button type="button" className="piper-close" aria-label="Close test data" onClick={onClose}>
                    ×
                </button>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            {testId === null && (
                <p className="muted piper-small">
                    Pick a test, and each instrument shows what its channel read, and each valve whether it was open, at
                    the time on the timeline. A part reads the channel named as its tag, or the one in its Test channel.
                </p>
            )}
            {reading && end > start && (
                <Timeline
                    key={testId}
                    start={start}
                    end={end}
                    time={time}
                    events={reading.detail.events}
                    onTime={onTime}
                />
            )}
            {reading && reading.missing.length > 0 && (
                <p className="piper-small piper-missing">
                    {reading.detail.name} has no channel for{" "}
                    {reading.missing
                        .map((part) => part.tag || "an untagged part")
                        .slice(0, 12)
                        .join(", ")}
                    {reading.missing.length > 12 ? `, and ${reading.missing.length - 12} more` : ""}.
                </p>
            )}
        </section>
    );
}

const keyOf = (id: number | null | undefined): string | null => (id === null || id === undefined ? null : String(id));

/**
 * The test to read the diagram against, picked from Yorg's tests in Yorg's folders, as Yorg's datasets page shows them
 * (the site's FolderBrowser): it opens in the folder of the test chosen, and each test says when it was added. They're
 * listed again each time it opens, so a test added meanwhile is there.
 */
export function TestSelect({ testId, onTest }: { testId: number | null; onTest: (id: number) => void }) {
    const [lists, setLists] = useState<{ tests: Test[]; folders: TestFolder[] } | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const load = useCallback(() => {
        setProblem(null);
        Promise.all([fetchTests(), testFolders()]).then(
            ([found, folders]) =>
                setLists({ tests: found.filter((test) => test.status === "ready" && !test.deleted_at), folders }),
            (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
        );
    }, []);
    useEffect(load, [load]); // for the chosen test's name

    const folders = useMemo<BrowseFolder[] | null>(
        () =>
            lists?.folders.map((one) => ({ key: String(one.id), parent: keyOf(one.parent_id), name: one.name })) ??
            null,
        [lists],
    );
    const items = useMemo<BrowseItem[] | null>(
        () =>
            lists?.tests.map((test) => ({
                key: String(test.id),
                name: test.name,
                folder: keyOf(test.folder_id),
                note: formatDate(test.created_at),
            })) ?? null,
        [lists],
    );
    const chosen = lists?.tests.find((test) => test.id === testId);
    const button = chosen
        ? chosen.name
        : testId === null
          ? "Choose a test from Yorg"
          : lists === null && problem === null
            ? "Loading Yorg's tests…"
            : `Test ${testId}`;
    return (
        <div className="piper-test-pick">
            <ItemPicker
                label="Test"
                button={button}
                buttonLabel={`Test: ${button}`}
                buttonClass="button-small"
                folders={folders}
                items={items}
                start={keyOf(chosen?.folder_id)}
                chosen={keyOf(testId)}
                top="Yorg"
                findLabel="Find a test"
                empty="No tests in it"
                problem={problem && `Yorg's tests couldn't be listed: ${problem}`}
                onOpen={load}
                onPick={(key) => onTest(Number(key))}
            />
        </div>
    );
}
