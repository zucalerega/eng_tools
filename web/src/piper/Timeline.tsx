import { useEffect, useRef, useState } from "react";
import type { TestEvent } from "./testdata";

// A test's timeline: drag it, or play the test (at a tenth of its speed to ten times it), to see the drawing at each
// moment; its events (a sequence's steps) are marked, to go to. A simulation's run window is shaded on it.

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

export function Timeline({
    start,
    end,
    time,
    events,
    band = null,
    onTime,
}: {
    start: number;
    end: number;
    time: number;
    events: TestEvent[];
    band?: [number, number] | null; // a span to shade: a run's window
    onTime: (time: number, settled: boolean) => void; // settled: not mid-drag or mid-play, so it can go in the address
}) {
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const clock = useRef({ time, onTime });
    clock.current = { time, onTime };

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

    const at = (t: number) => `${((Math.min(end, Math.max(start, t)) - start) / (end - start)) * 100}%`;
    return (
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
                {band && band[1] > band[0] && (
                    <span
                        className="piper-band"
                        style={{ left: at(band[0]), width: `calc(${at(band[1])} - ${at(band[0])})` }}
                        title={`The run: ${formatSeconds(band[0])} to ${formatSeconds(band[1])}`}
                    />
                )}
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
                {events.map((event, index) => (
                    <button
                        key={index}
                        type="button"
                        className="piper-event"
                        style={{ left: at(event.t) }}
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
    );
}
