import { useEffect, useState } from "react";
import { Notice } from "../components";
import { formatDate } from "../format";
import { tests as fetchTests, type Test } from "./testdata";
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

/** Yorg's tests to read the diagram against, by name and when each was added. */
export function TestSelect({ testId, onTest }: { testId: number | null; onTest: (id: number | null) => void }) {
    const [tests, setTests] = useState<Test[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);

    useEffect(() => {
        fetchTests().then(
            (found) => setTests(found.filter((test) => test.status === "ready" && !test.deleted_at)),
            (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
        );
    }, []);

    const chosen = tests?.find((test) => test.id === testId);
    return (
        <>
            <select
                aria-label="Test"
                value={testId ?? ""}
                onChange={(event) => onTest(event.target.value ? Number(event.target.value) : null)}
            >
                <option value="">{tests === null ? "Loading Yorg's tests…" : "Choose a test from Yorg…"}</option>
                {testId !== null && tests !== null && !chosen && <option value={testId}>Test {testId}</option>}
                {tests?.map((test) => (
                    <option key={test.id} value={test.id}>
                        {test.name} ({formatDate(test.created_at)})
                    </option>
                ))}
            </select>
            {problem && <Notice tone="error">Yorg&apos;s tests couldn&apos;t be listed: {problem}</Notice>}
        </>
    );
}
