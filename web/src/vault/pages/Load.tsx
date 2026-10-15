import { useEffect, useState, type MouseEvent } from "react";
import { api, type Load, type LoadPoint } from "../../api";
import { Notice } from "../../components";
import { formatSize } from "../../format";

// Admin > People's server load: how busy the server's CPUs have been and how full its memory, against all of each
// (100%), from the samples the server takes each minute (load.py). Near 100% for long, the site slows down.

const RANGES = [
    { hours: 24, label: "24 hours" },
    { hours: 168, label: "7 days" },
];
const REFRESH_MS = 60_000; // the server samples each minute
const BUSY = 85; // % of the CPUs, on average over the last quarter hour: say the server is busy
const FULL = 90; // % of memory: say it's nearly full
const HELD_BACK = 10; // % of the CPUs' time the hypervisor took, on average over the last hour: say so

type Point = LoadPoint & { time: number };

export function ServerLoad() {
    const [hours, setHours] = useState(RANGES[0]!.hours);
    const [load, setLoad] = useState<Load | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        let current = true;
        const fetchLoad = () =>
            api.load(hours).then(
                (loaded) => {
                    if (current) {
                        setLoad(loaded);
                        setProblem(null);
                    }
                },
                (error: Error) => {
                    if (current) {
                        setProblem(error.message);
                    }
                },
            );
        void fetchLoad();
        // A new sample each minute: look again while the page is in view.
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                void fetchLoad();
            }
        }, REFRESH_MS);
        return () => {
            current = false;
            window.clearInterval(timer);
        };
    }, [hours]);
    if (problem && !load) {
        return <p className="muted">Couldn't load the server's load: {problem}</p>;
    }
    if (!load) {
        return null;
    }
    const points: Point[] = load.points.map((point) => ({ ...point, time: Date.parse(point.at) }));
    const latest = points.at(-1);
    const busiest = most(points, (point) => point.cpu);
    const fullest = most(points, (point) => point.memory);
    const recently = (minutes: number) => points.filter((point) => point.time >= Date.now() - minutes * 60_000);
    const busy = average(recently(15).map((point) => point.cpu));
    const stolen = average(recently(60).map((point) => point.steal));
    const range = RANGES.find((each) => each.hours === hours)!;
    return (
        <section className="tracker" aria-labelledby="load-title">
            <div className="tracker-head">
                <h2 id="load-title">Server load</h2>
                <div className="segmented" role="group" aria-label="Over">
                    {RANGES.map((each) => (
                        <button
                            key={each.hours}
                            type="button"
                            aria-pressed={hours === each.hours}
                            onClick={() => setHours(each.hours)}
                        >
                            {each.label}
                        </button>
                    ))}
                </div>
            </div>
            <dl className="stat-tiles">
                <div>
                    <dt>CPU now</dt>
                    <dd>{percent(latest?.cpu)}</dd>
                </div>
                <div>
                    <dt>Busiest, last {range.label}</dt>
                    <dd>{percent(busiest?.cpu)}</dd>
                </div>
                <div>
                    <dt>Memory now</dt>
                    <dd>{percent(latest?.memory)}</dd>
                </div>
                <div>
                    <dt>Fullest, last {range.label}</dt>
                    <dd>{percent(fullest?.memory)}</dd>
                </div>
            </dl>
            {busy !== null && busy >= BUSY && (
                <Notice tone="warning">
                    Busy: the CPU has averaged {Math.round(busy)}% for the last 15 minutes, so pages and check-ins may
                    be slow.
                </Notice>
            )}
            {latest?.memory != null && latest.memory >= FULL && (
                <Notice tone="warning">
                    Memory is nearly full ({Math.round(latest.memory)}%): the server may stop a Yorg run, or restart.
                </Notice>
            )}
            {stolen !== null && stolen >= HELD_BACK && (
                <Notice tone="warning">
                    The cloud is holding the server back: {Math.round(stolen)}% of its CPU time in the last hour went to
                    other machines.
                </Notice>
            )}
            {points.length === 0 ? (
                <p className="muted">No samples yet: the server takes one each minute.</p>
            ) : (
                <LoadChart points={points} hours={hours} minutes={load.minutes} />
            )}
            <p className="muted tracker-note">
                {load.cpus === 1 ? "1 CPU core" : `${load.cpus} CPU cores`}
                {load.memory_total !== null && ` and ${formatSize(load.memory_total)} of memory`}, each at its busiest{" "}
                {load.minutes === 1 ? "minute" : `in ${load.minutes} minutes`}. Near 100% for long, the site slows down.
            </p>
        </section>
    );
}

/** CPU and memory as lines across the hours, 100% at the top, with the hovered minute's numbers. */
function LoadChart({ points, hours, minutes }: { points: Point[]; hours: number; minutes: number }) {
    const [hovered, setHovered] = useState<Point | null>(null);
    const end = Date.now();
    const start = end - hours * 3_600_000;
    const x = (time: number) => ((time - start) / (end - start)) * 100; // % of the width
    const gap = 2 * minutes * 60_000; // longer between points: the server wasn't running, so the line breaks
    const path = (value: (point: Point) => number | null) => {
        let line = "";
        let previous: Point | null = null;
        for (const point of points) {
            const amount = value(point);
            if (amount === null) {
                previous = null;
                continue;
            }
            const move = previous === null || point.time - previous.time > gap;
            line += `${move ? "M" : "L"}${x(point.time).toFixed(3)} ${(100 - amount).toFixed(3)}`;
            previous = point;
        }
        return line;
    };
    function hover(event: MouseEvent<HTMLDivElement>) {
        const box = event.currentTarget.getBoundingClientRect();
        const time = start + ((event.clientX - box.left) / box.width) * (end - start);
        let nearest: Point | null = null;
        for (const point of points) {
            if (nearest === null || Math.abs(point.time - time) < Math.abs(nearest.time - time)) {
                nearest = point;
            }
        }
        setHovered(nearest !== null && Math.abs(nearest.time - time) <= gap ? nearest : null);
    }
    const at = hovered === null ? 0 : x(hovered.time);
    return (
        <div className="bars">
            <ul className="lines-legend">
                <li>
                    <span className="lines-swatch lines-cpu" aria-hidden="true" />
                    CPU
                </li>
                <li>
                    <span className="lines-swatch lines-memory" aria-hidden="true" />
                    Memory
                </li>
            </ul>
            <div className="bars-plot" onMouseMove={hover} onMouseLeave={() => setHovered(null)}>
                {[100, 50, 0].map((amount) => (
                    <div key={amount} className="bars-grid" style={{ bottom: `${amount}%` }}>
                        <span>{amount}%</span>
                    </div>
                ))}
                <svg className="lines-plot" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    <path className="lines-memory" d={path((point) => point.memory)} />
                    <path className="lines-cpu" d={path((point) => point.cpu)} />
                </svg>
                {hovered && (
                    <>
                        <div className="lines-cursor" style={{ left: `${at}%` }} />
                        {hovered.memory !== null && (
                            <span
                                className="lines-dot lines-memory"
                                style={{ left: `${at}%`, bottom: `${hovered.memory}%` }}
                            />
                        )}
                        {hovered.cpu !== null && (
                            <span
                                className="lines-dot lines-cpu"
                                style={{ left: `${at}%`, bottom: `${hovered.cpu}%` }}
                            />
                        )}
                        <div
                            className="bars-tip"
                            role="status"
                            style={{
                                left: `${at}%`,
                                bottom: "calc(100% + 0.25rem)",
                                translate: at < 25 ? "-15% 0" : at > 75 ? "-85% 0" : "-50% 0",
                            }}
                        >
                            <strong>{when(hovered.time, hours > 24)}</strong>
                            <span>CPU {percent(hovered.cpu)}</span>
                            <span>Memory {percent(hovered.memory)}</span>
                            {hovered.steal !== null && hovered.steal >= 1 && (
                                <span>Held back {percent(hovered.steal)}</span>
                            )}
                        </div>
                    </>
                )}
            </div>
            <div className="bars-axis" aria-hidden="true">
                {ticks(start, end, hours).map((tick) => (
                    <span key={tick.time} style={{ left: `${x(tick.time)}%` }}>
                        {tick.label}
                    </span>
                ))}
            </div>
        </div>
    );
}

/** The time marks under the chart: each 6 hours over a day, each midnight over a week, and now. */
function ticks(start: number, end: number, hours: number): { time: number; label: string }[] {
    const every = hours <= 24 ? 6 : 24;
    const mark = new Date(start);
    mark.setMinutes(0, 0, 0);
    while (mark.getTime() <= start || mark.getHours() % every !== 0) {
        mark.setHours(mark.getHours() + 1);
    }
    const found = [];
    for (; mark.getTime() < end - (every * 3_600_000) / 4; mark.setHours(mark.getHours() + every)) {
        found.push({
            time: mark.getTime(),
            label:
                every === 24
                    ? mark.toLocaleDateString("en", { weekday: "short" })
                    : mark.toLocaleTimeString("en", { hour: "numeric" }),
        });
    }
    return [...found, { time: end, label: "Now" }];
}

/** "3:12 PM", or "Tue 3:10 PM" over a week. */
function when(time: number, withDay: boolean): string {
    return new Date(time).toLocaleString("en", {
        weekday: withDay ? "short" : undefined,
        hour: "numeric",
        minute: "2-digit",
    });
}

function percent(amount: number | null | undefined): string {
    return amount === null || amount === undefined ? "–" : `${Math.round(amount)}%`;
}

function most(points: Point[], value: (point: Point) => number | null): Point | undefined {
    let found: Point | undefined;
    for (const point of points) {
        const amount = value(point);
        if (amount !== null && (found === undefined || amount > value(found)!)) {
            found = point;
        }
    }
    return found;
}

function average(amounts: (number | null)[]): number | null {
    const known = amounts.filter((amount): amount is number => amount !== null);
    return known.length === 0 ? null : known.reduce((sum, amount) => sum + amount, 0) / known.length;
}
