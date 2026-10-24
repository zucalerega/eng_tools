import { useEffect, useRef, useState } from "react";
import { Notice } from "../components";
import { formatDate } from "../format";
import { tests as fetchTests, type Test } from "./testdata";
import type { TestReading } from "./useTest";

// The test a diagram's read against, from Yorg's datasets, and its timeline: drag it, or play the test, to see each
// instrument's value and each valve's state change on the drawing.

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10];

/** Seconds as the timeline reads them: to the millisecond under a minute, then minutes and seconds. */
export function formatSeconds(seconds: number): string {
    const sign = seconds < 0 ? "−" : "";
    const value = Math.abs(seconds);
    if (value < 60) {
        return `${sign}${value.toFixed(3)} s`;
    }
    const minutes = Math.floor(value / 60);
    return `${sign}${minutes} min ${(value - minutes * 60).toFixed(1)} s`;
}

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
    const [tests, setTests] = useState<Test[] | null>(null);
    const [listProblem, setListProblem] = useState<string | null>(null);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const clock = useRef({ time, onTime });
    clock.current = { time, onTime };

    useEffect(() => {
        fetchTests().then(
            (found) => setTests(found.filter((test) => test.status === "ready" && !test.deleted_at)),
            (error: unknown) => setListProblem(error instanceof Error ? error.message : String(error)),
        );
    }, []);

    const start = reading?.detail.t_min ?? 0;
    const end = reading?.detail.t_max ?? 0;

    // Playing: the test's time goes on at the speed chosen, to its end.
    useEffect(() => {
        if (!playing || end <= start) {
            return;
        }
        let last = performance.now();
        let frame = requestAnimationFrame(function step(now) {
            const next = Math.min(end, clock.current.time + ((now - last) / 1000) * speed);
            last = now;
            clock.current.onTime(next, next >= end);
            if (next >= end) {
                setPlaying(false);
                return;
            }
            frame = requestAnimationFrame(step);
        });
        return () => cancelAnimationFrame(frame);
    }, [playing, speed, start, end]);

    const chosen = tests?.find((test) => test.id === testId);
    const linked = reading ? reading.live.size - reading.missing.length : 0;
    return (
        <section className="piper-test" aria-label="Test data">
            <div className="piper-test-head">
                <h2>Test data</h2>
                <select
                    aria-label="Test"
                    value={testId ?? ""}
                    onChange={(event) => {
                        setPlaying(false);
                        onTest(event.target.value ? Number(event.target.value) : null);
                    }}
                >
                    <option value="">{tests === null ? "Loading Yorg's tests…" : "Choose a test from Yorg…"}</option>
                    {testId !== null && tests !== null && !chosen && <option value={testId}>Test {testId}</option>}
                    {tests?.map((test) => (
                        <option key={test.id} value={test.id}>
                            {test.name} ({formatDate(test.created_at)})
                        </option>
                    ))}
                </select>
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
            {listProblem && <Notice tone="error">Yorg's tests couldn't be listed: {listProblem}</Notice>}
            {problem && <Notice tone="error">{problem}</Notice>}
            {testId === null && (
                <p className="muted piper-small">
                    Pick a test, and each instrument shows what its channel read, and each valve whether it was open, at
                    the time on the timeline. A part reads the channel named as its tag, or the one in its Test channel.
                </p>
            )}
            {reading && end > start && (
                <div className="piper-timeline">
                    <button
                        type="button"
                        className="button-small piper-play"
                        aria-label={playing ? "Pause" : "Play"}
                        onClick={() => {
                            if (!playing && time >= end) {
                                onTime(start, false);
                            }
                            setPlaying(!playing);
                            if (playing) {
                                onTime(time, true);
                            }
                        }}
                    >
                        {playing ? "❚❚" : "▶"}
                    </button>
                    <div className="piper-track">
                        <input
                            type="range"
                            aria-label="Time"
                            min={start}
                            max={end}
                            step={(end - start) / 2000}
                            value={time}
                            onChange={(event) => onTime(Number(event.target.value), false)}
                            onPointerUp={() => onTime(clock.current.time, true)}
                            onKeyUp={() => onTime(clock.current.time, true)}
                        />
                        {reading.detail.events.map((event, index) => (
                            <button
                                key={index}
                                type="button"
                                className="piper-event"
                                style={{ left: `${((event.t - start) / (end - start)) * 100}%` }}
                                title={`${event.label} at ${formatSeconds(event.t)}`}
                                aria-label={`Go to ${event.label}`}
                                onClick={() => onTime(event.t, true)}
                            />
                        ))}
                    </div>
                    <output className="piper-time" aria-label="Time shown">
                        {formatSeconds(time)}
                    </output>
                    <select aria-label="Speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                        {SPEEDS.map((value) => (
                            <option key={value} value={value}>
                                {value}×
                            </option>
                        ))}
                    </select>
                </div>
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
