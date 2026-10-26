import { useId, useRef, useState } from "react";
import { formatTick, formatValue, ticks } from "../../scale";

// A plot of a simulation's run beside what the test measured: a channel's samples (each pixel's column drawn from its
// lowest to its highest, so a long test draws as drawing every sample would) and the model's values, over the run's
// window. The cursor reads each at a time; a click goes there on the test's timeline, which the drawing shows.

/** A series to plot: its points' times and values, in the plot's units (NaN: none there, the line breaks). */
export interface ChartSeries {
    id: string;
    name: string;
    color: string;
    width: number;
    times: ArrayLike<number>;
    values: ArrayLike<number>;
}

const WIDTH = 640;
const HEIGHT = 190;
const LEFT = 56; // room for the values' labels
const RIGHT = 10;
const TOP = 8;
const BOTTOM = 24; // and for the times'

/** The value a series has at a time: its last point then (NaN before its first). */
export function valueAt(series: { times: ArrayLike<number>; values: ArrayLike<number> }, t: number): number {
    const { times, values } = series;
    if (times.length === 0 || t < times[0]!) {
        return Number.NaN;
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
    return values[lo]!;
}

/** A series' path over the window: its points, or with more of them than columns, each column's lowest and highest. */
function pathOf(series: ChartSeries, from: number, to: number, x: (t: number) => number, y: (v: number) => number) {
    const columns = WIDTH - LEFT - RIGHT;
    const parts: string[] = [];
    let drawing = false;
    const point = (t: number, v: number) => {
        parts.push(`${drawing ? "L" : "M"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`);
        drawing = true;
    };
    const { times, values } = series;
    let first = 0;
    while (first < times.length - 1 && times[first + 1]! < from) {
        first += 1;
    }
    let column = -1;
    let lo = 0;
    let hi = 0;
    let at = 0;
    const flush = () => {
        if (column >= 0) {
            point(at, lo);
            if (hi !== lo) {
                point(at, hi);
            }
        }
    };
    for (let index = first; index < times.length; index += 1) {
        const t = times[index]!;
        const v = values[index]!;
        if (Number.isNaN(v)) {
            flush();
            column = -1;
            drawing = false;
            continue;
        }
        const here = Math.floor(((t - from) / (to - from)) * columns);
        if (here !== column) {
            flush();
            column = here;
            lo = v;
            hi = v;
            at = t;
        } else {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
        }
        if (t > to) {
            break;
        }
    }
    flush();
    return parts.join("");
}

/** Where the plot's values go: from the lowest to the highest any series has in the window, with a little room. */
function rangeOf(series: ChartSeries[], from: number, to: number): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const one of series) {
        for (let index = 0; index < one.times.length; index += 1) {
            const t = one.times[index]!;
            const v = one.values[index]!;
            if (t >= from && t <= to && Number.isFinite(v)) {
                lo = Math.min(lo, v);
                hi = Math.max(hi, v);
            }
        }
    }
    if (!Number.isFinite(lo)) {
        return [0, 1];
    }
    const pad = hi > lo ? (hi - lo) * 0.06 : Math.max(1, Math.abs(hi) * 0.05);
    return [lo - pad, hi + pad];
}

export function Chart({
    title,
    unit,
    series,
    window,
    time,
    note,
    onTime,
}: {
    title: string;
    unit: string;
    series: ChartSeries[];
    window: [number, number]; // the run's, on the test's clock
    time: number | null; // the timeline's
    note?: string | null; // how far apart they are (RMS, bias)
    onTime: (t: number) => void;
}) {
    const [hover, setHover] = useState<number | null>(null);
    const svg = useRef<SVGSVGElement>(null);
    const clip = useId();
    const [from, to] = window[1] > window[0] ? window : [window[0], window[0] + 1];
    const [low, high] = rangeOf(series, from, to);
    const x = (t: number) => LEFT + ((t - from) / (to - from)) * (WIDTH - LEFT - RIGHT);
    const y = (v: number) => TOP + (1 - (v - low) / (high - low)) * (HEIGHT - TOP - BOTTOM);
    const across = ticks(from, to, 6);
    const up = ticks(low, high, 4);
    const cursor = hover ?? (time !== null && time >= from && time <= to ? time : null);
    const timeAt = (event: { clientX: number }): number | null => {
        const box = svg.current?.getBoundingClientRect();
        if (!box || box.width === 0) {
            return null;
        }
        const at = ((event.clientX - box.left) / box.width) * WIDTH;
        const t = from + ((at - LEFT) / (WIDTH - LEFT - RIGHT)) * (to - from);
        return Math.min(to, Math.max(from, t));
    };
    return (
        <figure className="piper-sim-chart">
            <figcaption className="piper-sim-legend">
                <strong>{title}</strong>
                {series.map((one) => {
                    const value = cursor === null ? Number.NaN : valueAt(one, cursor);
                    return (
                        <span key={one.id} className="piper-sim-swatch">
                            <i style={{ background: one.color }} />
                            {one.name}
                            {Number.isFinite(value) && ` ${formatValue(Number(value.toPrecision(5)))} ${unit}`}
                        </span>
                    );
                })}
                {note && <span className="piper-sim-fit">{note}</span>}
            </figcaption>
            <svg
                ref={svg}
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                role="img"
                aria-label={title}
                onPointerMove={(event) => setHover(timeAt(event))}
                onPointerLeave={() => setHover(null)}
                onClick={(event) => {
                    const t = timeAt(event);
                    if (t !== null) {
                        onTime(t);
                    }
                }}
            >
                <g className="piper-sim-grid">
                    {up.values.map((value) => (
                        <g key={value}>
                            <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(value)} y2={y(value)} />
                            <text x={LEFT - 6} y={y(value)} textAnchor="end" dominantBaseline="central">
                                {formatTick(value, up.step)}
                            </text>
                        </g>
                    ))}
                    {across.values.map((value) => (
                        <text key={value} x={x(value)} y={HEIGHT - 6} textAnchor="middle">
                            {formatTick(value, across.step)}
                        </text>
                    ))}
                    <text x={WIDTH - RIGHT} y={HEIGHT - 6} textAnchor="end">
                        s
                    </text>
                    <text x={4} y={TOP + 2} dominantBaseline="hanging">
                        {unit}
                    </text>
                </g>
                <clipPath id={clip}>
                    <rect x={LEFT} y={TOP} width={WIDTH - LEFT - RIGHT} height={HEIGHT - TOP - BOTTOM} />
                </clipPath>
                <g clipPath={`url(#${clip})`}>
                    {series.map((one) => (
                        <path
                            key={one.id}
                            d={pathOf(one, from, to, x, y)}
                            fill="none"
                            stroke={one.color}
                            strokeWidth={one.width}
                            strokeLinejoin="round"
                        />
                    ))}
                </g>
                {cursor !== null && (
                    <line className="piper-sim-cursor" x1={x(cursor)} x2={x(cursor)} y1={TOP} y2={HEIGHT - BOTTOM} />
                )}
            </svg>
        </figure>
    );
}
