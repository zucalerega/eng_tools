import { useMemo, useState, type MouseEvent } from "react";
import type { AbortStageCoverage, SensorTrace, SimulationEvent, SimulationResult } from "./types";

const WIDTH = 1000;
const LEFT = 150;
const RIGHT = 969;
const PIN_COLORS = ["#e0a500", "#75cbe3", "#c89cde", "#8fd1a5"];
const SENSOR_COLORS = ["#75cbe3", "#8fd1a5", "#c89cde", "#e0a500", "#ee9d85"];

function nice(value: number): string {
    return Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function sensorValueAt(sensor: SensorTrace, time: number): number | null {
    const samples = sensor.samples || [];
    let previous = samples[0];
    if (!previous) {
        return null;
    }
    for (const sample of samples.slice(1)) {
        if (sample.at > time) {
            if (sensor.interpolation === "linear" && time > previous.at) {
                const ratio = (time - previous.at) / (sample.at - previous.at);
                return previous.value + ratio * (sample.value - previous.value);
            }
            break;
        }
        previous = sample;
    }
    return previous.value;
}

export function valveStateAt(
    initial: Record<string, string>,
    events: SimulationEvent[],
    name: string,
    time: number,
): string {
    let state = initial[name] || "CLOSED";
    for (const event of events) {
        if (event.time > time) {
            break;
        }
        if (event.kind === "valve" && event.target === name) {
            state = event.detail;
        }
    }
    return state;
}

export function abortStatusAt(events: SimulationEvent[], time: number): { stage: string; aborted: boolean } {
    let stage = "DEFAULT";
    let aborted = false;
    for (const event of events) {
        if (event.time > time) {
            break;
        }
        if (event.kind === "abort_stage") {
            stage = event.target;
        }
        if (event.kind === "abort") {
            aborted = true;
        }
    }
    return { stage, aborted };
}

function sampleScale(sensor: SensorTrace): { min: number; max: number } {
    const values = (sensor.samples || []).map((s) => Number(s.value));
    if (!values.length) {
        return { min: 0, max: 1 };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const margin = Math.max((max - min) * 0.12, Math.abs(max) * 0.015, 1);
    return { min: min - margin, max: max + margin };
}

interface Pin {
    id: number;
    time: number;
    color: string;
}

export interface TimelineViewProps {
    result: SimulationResult;
    onJumpToSource: (line: number) => void;
}

export function TimelineView({ result, onJumpToSource }: TimelineViewProps) {
    const [pins, setPins] = useState<Pin[]>([]);
    const [hoveredTime, setHoveredTime] = useState<number | null>(null);
    const [nextPinId, setNextPinId] = useState(0);

    const events = result.events || [];
    const sim = result.simulation;
    const initialValves = sim?.initial_valves ?? {};
    const sensors: SensorTrace[] = useMemo(() => {
        const raw = sim?.sensors;
        if (!raw) {
            return [];
        }
        if (Array.isArray(raw)) {
            return raw;
        }
        return Object.entries(raw).map(([name, trace]) => ({ ...trace, name }));
    }, [sim?.sensors]);
    const abortStages: AbortStageCoverage[] = sim?.abort_stages ?? [];

    const valveNames = useMemo(() => {
        const names = new Set<string>([
            ...Object.keys(initialValves),
            ...Object.keys(result.valves || {}),
            ...events.filter((e) => e.kind === "valve").map((e) => e.target),
        ]);
        return Array.from(names);
    }, [initialValves, result.valves, events]);

    const duration = useMemo(() => {
        const maxEventTime = events.reduce((acc, e) => Math.max(acc, e.time), 0);
        return Math.max(0.001, result.virtual_time || 0, maxEventTime);
    }, [result.virtual_time, events]);

    const xAt = (time: number) => LEFT + (Math.min(duration, Math.max(0, time)) / duration) * (RIGHT - LEFT);

    function timeFromPointer(event: MouseEvent<SVGSVGElement>): number {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
        const clamped = Math.min(RIGHT, Math.max(LEFT, x));
        return ((clamped - LEFT) / (RIGHT - LEFT)) * duration;
    }

    function handleChartClick(event: MouseEvent<SVGSVGElement>) {
        const time = timeFromPointer(event);
        if (pins.length >= 4) {
            return;
        }
        let chosen = -1;
        for (let i = 0; i < 4; i += 1) {
            const candidate = (nextPinId + i) % 4;
            if (!pins.some((p) => p.id === candidate)) {
                chosen = candidate;
                setNextPinId((candidate + 1) % 4);
                break;
            }
        }
        if (chosen >= 0) {
            const color = PIN_COLORS[chosen] ?? "#e0a500";
            setPins((prev) => [...prev, { id: chosen, time, color }]);
        }
    }

    const lastPin = pins[pins.length - 1];
    const inspectTime = hoveredTime ?? (lastPin ? lastPin.time : null);
    const abortStatus = inspectTime !== null ? abortStatusAt(events, inspectTime) : null;

    // Valve timeline height
    const valveRowH = 28;
    const abortRowH =
        abortStages.length > 0 || events.some((e) => e.kind === "abort" || e.kind === "abort_stage") ? 28 : 0;
    const valveChartHeight = Math.max(60, 26 + valveNames.length * valveRowH + abortRowH + 28);

    // Abort stage segments
    const abortEvents = events.filter((e) => e.kind === "abort_stage" || e.kind === "abort");

    return (
        <div className="tempo-timeline">
            <div className="tempo-cursor-bar">
                <div className="tempo-pin-chips">
                    {pins.map((pin) => (
                        <span key={pin.id} className="tempo-pin-chip" style={{ borderColor: pin.color }}>
                            <span className="tempo-pin-dot" style={{ background: pin.color }} />
                            <span>T+ {nice(pin.time)}s</span>
                            <button
                                type="button"
                                aria-label={`Remove cursor at ${nice(pin.time)}s`}
                                onClick={() => setPins((prev) => prev.filter((p) => p.id !== pin.id))}
                            >
                                ×
                            </button>
                        </span>
                    ))}
                    {pins.length === 0 && (
                        <span className="muted">Click any chart to pin up to 4 timeline cursors.</span>
                    )}
                </div>
                {pins.length > 0 && (
                    <button type="button" className="button-small" onClick={() => setPins([])}>
                        Clear cursors
                    </button>
                )}
            </div>

            {inspectTime !== null && (
                <div className="tempo-cursor-readout">
                    <strong>T+ {nice(inspectTime)}s</strong>
                    {valveNames.map((name) => {
                        const state = valveStateAt(initialValves, events, name, inspectTime);
                        return (
                            <span key={name} className="tempo-readout-item">
                                <span className="muted">{name}:</span>{" "}
                                <strong className={state === "OPEN" ? "tempo-text-open" : ""}>{state}</strong>
                            </span>
                        );
                    })}
                    {sensors.map((sensor) => {
                        const val = sensorValueAt(sensor, inspectTime);
                        return (
                            <span key={sensor.name} className="tempo-readout-item">
                                <span className="muted">{sensor.name}:</span>{" "}
                                <strong>{val !== null ? `${nice(val)} ${sensor.unit}` : "—"}</strong>
                            </span>
                        );
                    })}
                    {abortStatus && (abortStages.length > 0 || abortStatus.aborted) && (
                        <span className="tempo-readout-item">
                            <span className="muted">Abort stage:</span>{" "}
                            <strong className={abortStatus.aborted ? "tempo-text-danger" : ""}>
                                {abortStatus.aborted ? "ABORTED" : abortStatus.stage}
                            </strong>
                        </span>
                    )}
                </div>
            )}

            {(valveNames.length > 0 || abortRowH > 0) && (
                <div className="tempo-chart-block">
                    <div className="tempo-chart-title">Valves & Abort State</div>
                    <svg
                        viewBox={`0 0 ${WIDTH} ${valveChartHeight}`}
                        className="tempo-timeline-svg"
                        onMouseMove={(e) => setHoveredTime(timeFromPointer(e))}
                        onMouseLeave={() => setHoveredTime(null)}
                        onClick={handleChartClick}
                    >
                        {[0, 1, 2, 3, 4, 5].map((i) => {
                            const t = (duration * i) / 5;
                            const x = xAt(t);
                            return (
                                <g key={i}>
                                    <line x1={x} x2={x} y1={18} y2={valveChartHeight - 24} className="tempo-tl-grid" />
                                    <text x={x} y={valveChartHeight - 6} className="tempo-tl-axis" textAnchor="middle">
                                        {nice(t)}s
                                    </text>
                                </g>
                            );
                        })}

                        {valveNames.map((name, rowIdx) => {
                            const y = 24 + rowIdx * valveRowH;
                            const valveEvents = events.filter((e) => e.kind === "valve" && e.target === name);
                            const spans: { start: number; end: number; state: string; line: number }[] = [];
                            let curState = initialValves[name] || "CLOSED";
                            let curStart = 0;
                            let curLine = 0;
                            for (const ev of valveEvents) {
                                if (ev.time > curStart) {
                                    spans.push({ start: curStart, end: ev.time, state: curState, line: curLine });
                                }
                                curState = ev.detail;
                                curStart = ev.time;
                                curLine = ev.line;
                            }
                            spans.push({ start: curStart, end: duration, state: curState, line: curLine });

                            return (
                                <g key={name}>
                                    <text x={LEFT - 10} y={y + 14} textAnchor="end" className="tempo-tl-label">
                                        {name}
                                    </text>
                                    {spans.map((span, sIdx) => {
                                        const x1 = xAt(span.start);
                                        const x2 = xAt(span.end);
                                        const w = Math.max(2, x2 - x1);
                                        return (
                                            <rect
                                                key={sIdx}
                                                x={x1}
                                                y={y + 2}
                                                width={w}
                                                height={18}
                                                rx={3}
                                                className={
                                                    span.state === "OPEN"
                                                        ? "tempo-tl-valve-open"
                                                        : "tempo-tl-valve-closed"
                                                }
                                                onClick={(ev) => {
                                                    if (span.line > 0) {
                                                        ev.stopPropagation();
                                                        onJumpToSource(span.line);
                                                    }
                                                }}
                                            />
                                        );
                                    })}
                                </g>
                            );
                        })}

                        {abortRowH > 0 && (
                            <g>
                                <text
                                    x={LEFT - 10}
                                    y={24 + valveNames.length * valveRowH + 14}
                                    textAnchor="end"
                                    className="tempo-tl-label"
                                >
                                    ABORT
                                </text>
                                {abortEvents.map((ev, idx) => {
                                    const x = xAt(ev.time);
                                    const y = 24 + valveNames.length * valveRowH + 11;
                                    return (
                                        <g
                                            key={idx}
                                            className="tempo-tl-marker"
                                            onClick={(e) => {
                                                if (ev.line > 0) {
                                                    e.stopPropagation();
                                                    onJumpToSource(ev.line);
                                                }
                                            }}
                                        >
                                            <circle
                                                cx={x}
                                                cy={y}
                                                r={5}
                                                fill={ev.kind === "abort" ? "var(--danger)" : "var(--gold)"}
                                            />
                                            <title>
                                                {ev.kind === "abort"
                                                    ? `ABORT at T+${nice(ev.time)}s: ${ev.detail}`
                                                    : `Stage ${ev.target} at T+${nice(ev.time)}s`}
                                            </title>
                                        </g>
                                    );
                                })}
                            </g>
                        )}

                        {pins.map((pin) => (
                            <line
                                key={pin.id}
                                x1={xAt(pin.time)}
                                x2={xAt(pin.time)}
                                y1={18}
                                y2={valveChartHeight - 24}
                                stroke={pin.color}
                                strokeWidth={2}
                            />
                        ))}
                        {hoveredTime !== null && (
                            <line
                                x1={xAt(hoveredTime)}
                                x2={xAt(hoveredTime)}
                                y1={18}
                                y2={valveChartHeight - 24}
                                className="tempo-tl-hover"
                            />
                        )}
                    </svg>
                </div>
            )}

            {sensors.map((sensor, sIdx) => {
                const { min, max } = sampleScale(sensor);
                const color = SENSOR_COLORS[sIdx % SENSOR_COLORS.length];
                const h = 148;
                const top = 16;
                const bottom = h - 26;
                const yAt = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);
                const samples = sensor.samples || [];
                const firstSample = samples[0];
                let path = "";
                if (firstSample) {
                    path = `M${xAt(firstSample.at)} ${yAt(firstSample.value)}`;
                    for (let i = 1; i < samples.length; i += 1) {
                        const pt = samples[i];
                        if (!pt) {
                            continue;
                        }
                        path +=
                            sensor.interpolation === "linear"
                                ? ` L${xAt(pt.at)} ${yAt(pt.value)}`
                                : ` H${xAt(pt.at)} V${yAt(pt.value)}`;
                    }
                    path += ` H${xAt(duration)}`;
                }

                return (
                    <div key={sensor.name} className="tempo-chart-block">
                        <div className="tempo-chart-title">
                            <span>{sensor.name}</span>
                            <span className="muted"> ({sensor.unit})</span>
                        </div>
                        <svg
                            viewBox={`0 0 ${WIDTH} ${h}`}
                            className="tempo-timeline-svg"
                            onMouseMove={(e) => setHoveredTime(timeFromPointer(e))}
                            onMouseLeave={() => setHoveredTime(null)}
                            onClick={handleChartClick}
                        >
                            {[0, 1, 2, 3].map((i) => {
                                const level = top + ((bottom - top) * i) / 3;
                                const val = max - ((max - min) * i) / 3;
                                return (
                                    <g key={i}>
                                        <line x1={LEFT} x2={RIGHT} y1={level} y2={level} className="tempo-tl-grid" />
                                        <text x={LEFT - 10} y={level + 4} textAnchor="end" className="tempo-tl-axis">
                                            {nice(val)}
                                        </text>
                                    </g>
                                );
                            })}
                            {[0, 1, 2, 3, 4, 5].map((i) => {
                                const t = (duration * i) / 5;
                                const x = xAt(t);
                                return (
                                    <g key={i}>
                                        <line x1={x} x2={x} y1={top} y2={bottom} className="tempo-tl-grid" />
                                        <text x={x} y={h - 6} className="tempo-tl-axis" textAnchor="middle">
                                            {nice(t)}s
                                        </text>
                                    </g>
                                );
                            })}
                            {path && <path d={path} fill="none" stroke={color} strokeWidth={2.2} />}
                            {pins.map((pin) => (
                                <line
                                    key={pin.id}
                                    x1={xAt(pin.time)}
                                    x2={xAt(pin.time)}
                                    y1={top}
                                    y2={bottom}
                                    stroke={pin.color}
                                    strokeWidth={2}
                                />
                            ))}
                            {hoveredTime !== null && (
                                <line
                                    x1={xAt(hoveredTime)}
                                    x2={xAt(hoveredTime)}
                                    y1={top}
                                    y2={bottom}
                                    className="tempo-tl-hover"
                                />
                            )}
                        </svg>
                    </div>
                );
            })}
        </div>
    );
}
