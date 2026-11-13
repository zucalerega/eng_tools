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

    const abortStatus = hoveredTime !== null ? abortStatusAt(events, hoveredTime) : null;

    const sensorReadLines = sim?.sensor_read_lines ?? {};
    const abortTriggers = useMemo(() => events.filter((e) => e.kind === "abort"), [events]);
    const abortActivations = useMemo(
        () => events.filter((e) => e.kind === "abort_stage").sort((a, b) => a.time - b.time),
        [events],
    );
    const hasAbortSection = abortStages.length > 0 || abortTriggers.length > 0 || abortActivations.length > 0;

    // Valve timeline height
    const valveRowH = 30;
    const valveChartHeight = Math.max(76, 26 + valveNames.length * valveRowH + 28);

    // Abort stages chart height
    const abortStageRowH = 42;
    const abortChartHeight = Math.max(88, 28 + Math.max(1, abortStages.length) * abortStageRowH + 26);

    // Unified compact sensor chart height
    const sensorRowH = 74;
    const sensorChartHeight = Math.max(96, 24 + sensors.length * sensorRowH + 26);

    function renderAbortMarkers(topY: number, bottomY: number) {
        return abortTriggers.map((ev, idx) => {
            const x = xAt(ev.time);
            return (
                <g key={`abort-${idx}`}>
                    {x < RIGHT && (
                        <rect
                            x={x}
                            y={topY}
                            width={Math.max(0, RIGHT - x)}
                            height={bottomY - topY}
                            className="tempo-tl-aborted-region"
                        />
                    )}
                    <line
                        x1={x}
                        x2={x}
                        y1={topY}
                        y2={bottomY}
                        className="tempo-tl-abort-marker"
                        onClick={(e) => {
                            if (ev.line > 0) {
                                e.stopPropagation();
                                onJumpToSource(ev.line);
                            }
                        }}
                    >
                        <title>{`Abort triggered at T+${nice(ev.time)}s${ev.line ? ` · line ${ev.line}` : ""}`}</title>
                    </line>
                </g>
            );
        });
    }

    const sortedPins = useMemo(() => [...pins].sort((a, b) => a.time - b.time), [pins]);
    const showAbortCol = hasAbortSection;

    return (
        <div className="tempo-timeline">
            {valveNames.length > 0 && (
                <div className="tempo-chart-block">
                    <div className="tempo-chart-title">
                        <span>Valves</span>
                        <span className="muted">Scripted commands vs abort safe-state transitions</span>
                    </div>
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
                                    {valveEvents.map((ev, eIdx) => {
                                        const cx = xAt(ev.time);
                                        const cy = y + 11;
                                        const isAbortSafe = ev.origin === "abort";
                                        return (
                                            <circle
                                                key={eIdx}
                                                cx={cx}
                                                cy={cy}
                                                r={isAbortSafe ? 4.5 : 3.5}
                                                className={`tempo-tl-valve-dot ${isAbortSafe ? "abort-safe" : "command"}`}
                                                onClick={(e) => {
                                                    if (ev.line > 0) {
                                                        e.stopPropagation();
                                                        onJumpToSource(ev.line);
                                                    }
                                                }}
                                            >
                                                <title>
                                                    {`${name}: ${ev.detail}${isAbortSafe ? " (abort safe state)" : ""} · T+${nice(ev.time)}s${ev.line ? ` · line ${ev.line}` : ""}`}
                                                </title>
                                            </circle>
                                        );
                                    })}
                                </g>
                            );
                        })}

                        {renderAbortMarkers(18, valveChartHeight - 24)}

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

            {hasAbortSection && (
                <div className="tempo-chart-block tempo-abort-section">
                    <div className="tempo-chart-title">
                        <span>Abort stages</span>
                        <span className="muted">Active stage segments, triggers &amp; safe states</span>
                    </div>
                    {abortStages.length > 0 && (
                        <svg
                            viewBox={`0 0 ${WIDTH} ${abortChartHeight}`}
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
                                        <line
                                            x1={x}
                                            x2={x}
                                            y1={18}
                                            y2={abortChartHeight - 24}
                                            className="tempo-tl-grid"
                                        />
                                        <text
                                            x={x}
                                            y={abortChartHeight - 6}
                                            className="tempo-tl-axis"
                                            textAnchor="middle"
                                        >
                                            {nice(t)}s
                                        </text>
                                    </g>
                                );
                            })}

                            {abortStages.map((stage, idx) => {
                                const y = 34 + idx * abortStageRowH;
                                const stageActivations = abortActivations.filter((a) => a.target === stage.name);
                                return (
                                    <g key={stage.name}>
                                        <text x={LEFT - 10} y={y + 4} textAnchor="end" className="tempo-tl-label">
                                            {stage.name}
                                        </text>
                                        <line x1={LEFT} x2={RIGHT} y1={y} y2={y} className="tempo-tl-rail" />
                                        {stageActivations.map((act, actIdx) => {
                                            const globalIdx = abortActivations.indexOf(act);
                                            const nextAct =
                                                globalIdx >= 0 ? abortActivations[globalIdx + 1] : undefined;
                                            const stop = nextAct ? nextAct.time : duration;
                                            return (
                                                <g key={`${stage.name}-${actIdx}`}>
                                                    <line
                                                        x1={xAt(act.time)}
                                                        x2={xAt(stop)}
                                                        y1={y}
                                                        y2={y}
                                                        className="tempo-tl-stage-active"
                                                    />
                                                    <circle
                                                        cx={xAt(act.time)}
                                                        cy={y}
                                                        r={5}
                                                        className="tempo-tl-stage-dot"
                                                        onClick={(e) => {
                                                            if (act.line > 0) {
                                                                e.stopPropagation();
                                                                onJumpToSource(act.line);
                                                            }
                                                        }}
                                                    >
                                                        <title>{`Activated ${stage.name} at T+${nice(act.time)}s · line ${act.line}`}</title>
                                                    </circle>
                                                </g>
                                            );
                                        })}
                                        {stage.triggered !== null && (
                                            <g>
                                                <circle
                                                    cx={xAt(stage.triggered)}
                                                    cy={y}
                                                    r={7}
                                                    className="tempo-tl-abort-dot"
                                                />
                                                <text
                                                    x={Math.min(RIGHT - 50, xAt(stage.triggered) + 12)}
                                                    y={y - 8}
                                                    className="tempo-tl-abort-label"
                                                >
                                                    ABORT
                                                </text>
                                            </g>
                                        )}
                                    </g>
                                );
                            })}

                            {renderAbortMarkers(18, abortChartHeight - 24)}

                            {pins.map((pin) => (
                                <line
                                    key={pin.id}
                                    x1={xAt(pin.time)}
                                    x2={xAt(pin.time)}
                                    y1={18}
                                    y2={abortChartHeight - 24}
                                    stroke={pin.color}
                                    strokeWidth={2}
                                />
                            ))}
                            {hoveredTime !== null && (
                                <line
                                    x1={xAt(hoveredTime)}
                                    x2={xAt(hoveredTime)}
                                    y1={18}
                                    y2={abortChartHeight - 24}
                                    className="tempo-tl-hover"
                                />
                            )}
                        </svg>
                    )}

                    {abortStages.length > 0 && (
                        <div className="tempo-abort-cards">
                            {abortStages.map((stage) => {
                                const wasActivated = Array.isArray(stage.activated)
                                    ? stage.activated.length > 0
                                    : Boolean(stage.activated);
                                const safeStates =
                                    stage.safe_states ??
                                    Object.entries(stage.safing ?? {}).map(([vName, info]) => ({
                                        name: vName,
                                        state: info.state,
                                        delay_ms: info.delay_ms,
                                    }));
                                const cardState =
                                    stage.triggered !== null ? "triggered" : wasActivated ? "untested" : "inactive";
                                return (
                                    <button
                                        key={stage.name}
                                        type="button"
                                        className={`tempo-abort-card ${cardState}`}
                                        disabled={!stage.defined_line}
                                        title={
                                            stage.defined_line
                                                ? `Show abort stage definition at line ${stage.defined_line}`
                                                : undefined
                                        }
                                        onClick={() => {
                                            if (stage.defined_line > 0) {
                                                onJumpToSource(stage.defined_line);
                                            }
                                        }}
                                    >
                                        <div className="tempo-abort-card-header">
                                            <strong>{stage.name}</strong>
                                            <span className="tempo-abort-card-status">
                                                {stage.triggered !== null
                                                    ? `TRIGGERED · T+${nice(stage.triggered)}s`
                                                    : wasActivated
                                                      ? "CONDITION NEVER TRIGGERED"
                                                      : "STAGE NEVER ACTIVATED"}
                                            </span>
                                        </div>
                                        <code className="tempo-abort-condition">{stage.condition}</code>
                                        {safeStates.length > 0 ? (
                                            <div className="tempo-abort-safe-states">
                                                {safeStates.map((ss, idx) => (
                                                    <span
                                                        key={`${ss.name}-${idx}`}
                                                        className={`tempo-abort-safe-state ${ss.state === "OPEN" ? "open" : "closed"}`}
                                                    >
                                                        {ss.name} → {ss.state} · {ss.delay_ms}ms
                                                    </span>
                                                ))}
                                            </div>
                                        ) : (
                                            <small className="muted">No valves explicitly safed in this stage</small>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {sensors.length > 0 && (
                <div className="tempo-chart-block">
                    <div className="tempo-chart-title">
                        <span>Sensors</span>
                        <span className="muted">Readings over virtual time · click L# to jump to read site</span>
                    </div>
                    <svg
                        viewBox={`0 0 ${WIDTH} ${sensorChartHeight}`}
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
                                    <line x1={x} x2={x} y1={16} y2={sensorChartHeight - 24} className="tempo-tl-grid" />
                                    <text x={x} y={sensorChartHeight - 6} className="tempo-tl-axis" textAnchor="middle">
                                        {nice(t)}s
                                    </text>
                                </g>
                            );
                        })}

                        {sensors.map((sensor, sIdx) => {
                            const top = 22 + sIdx * sensorRowH;
                            const bottom = top + 46;
                            const { min, max } = sampleScale(sensor);
                            const color = SENSOR_COLORS[sIdx % SENSOR_COLORS.length];
                            const yAt = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);
                            const samples = sensor.samples || [];
                            const firstSample = samples[0];
                            let path = "";
                            if (firstSample) {
                                path = `M${xAt(firstSample.at)} ${yAt(firstSample.value)}`;
                                for (let i = 1; i < samples.length; i += 1) {
                                    const pt = samples[i];
                                    if (!pt) continue;
                                    path +=
                                        sensor.interpolation === "linear"
                                            ? ` L${xAt(pt.at)} ${yAt(pt.value)}`
                                            : ` H${xAt(pt.at)} V${yAt(pt.value)}`;
                                }
                                path += ` H${xAt(duration)}`;
                            }
                            const readLine = sensorReadLines[sensor.name]?.[0];

                            return (
                                <g key={sensor.name}>
                                    <text x={14} y={top + 16} className="tempo-tl-label">
                                        {sensor.name}
                                    </text>
                                    <text x={14} y={top + 32} className="tempo-tl-unit">
                                        {sensor.unit}
                                    </text>
                                    {readLine ? (
                                        <text
                                            x={90}
                                            y={top + 32}
                                            className="tempo-tl-source-link"
                                            role="button"
                                            tabIndex={0}
                                            aria-label={`Show ${sensor.name} read at Python line ${readLine}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onJumpToSource(readLine);
                                            }}
                                        >
                                            L{readLine} ↗
                                        </text>
                                    ) : null}
                                    <line x1={LEFT} x2={RIGHT} y1={bottom} y2={bottom} className="tempo-tl-rail" />
                                    <text x={LEFT - 10} y={top + 6} textAnchor="end" className="tempo-tl-axis">
                                        {nice(max)}
                                    </text>
                                    <text x={LEFT - 10} y={bottom} textAnchor="end" className="tempo-tl-axis">
                                        {nice(min)}
                                    </text>
                                    {path && <path d={path} fill="none" stroke={color} strokeWidth={2.2} />}
                                </g>
                            );
                        })}

                        {renderAbortMarkers(16, sensorChartHeight - 24)}

                        {pins.map((pin) => (
                            <line
                                key={pin.id}
                                x1={xAt(pin.time)}
                                x2={xAt(pin.time)}
                                y1={16}
                                y2={sensorChartHeight - 24}
                                stroke={pin.color}
                                strokeWidth={2}
                            />
                        ))}
                        {hoveredTime !== null && (
                            <line
                                x1={xAt(hoveredTime)}
                                x2={xAt(hoveredTime)}
                                y1={16}
                                y2={sensorChartHeight - 24}
                                className="tempo-tl-hover"
                            />
                        )}
                    </svg>
                </div>
            )}

            <div className="tempo-cursor-bar">
                <div className="tempo-pin-chips">
                    {pins.map((pin, idx) => (
                        <span key={pin.id} className="tempo-pin-chip" style={{ borderColor: pin.color }}>
                            <span className="tempo-pin-dot" style={{ background: pin.color }} />
                            <strong>C{idx + 1}</strong>
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
                        <span className="muted">
                            Hover or click any chart to inspect and pin up to 4 timeline cursors.
                        </span>
                    )}
                </div>
                {pins.length > 0 && (
                    <button type="button" className="button-small" onClick={() => setPins([])}>
                        Clear cursors
                    </button>
                )}
            </div>

            {hoveredTime !== null && (
                <div className="tempo-cursor-readout">
                    <strong>Hover · T+ {nice(hoveredTime)}s</strong>
                    {valveNames.map((name) => {
                        const state = valveStateAt(initialValves, events, name, hoveredTime);
                        return (
                            <span key={name} className="tempo-readout-item">
                                <span className="muted">{name}:</span>{" "}
                                <strong className={state === "OPEN" ? "tempo-text-open" : ""}>{state}</strong>
                            </span>
                        );
                    })}
                    {sensors.map((sensor) => {
                        const val = sensorValueAt(sensor, hoveredTime);
                        return (
                            <span key={sensor.name} className="tempo-readout-item">
                                <span className="muted">{sensor.name}:</span>{" "}
                                <strong>{val !== null ? `${nice(val)} ${sensor.unit}` : "—"}</strong>
                            </span>
                        );
                    })}
                    {abortStatus && showAbortCol && (
                        <span className="tempo-readout-item">
                            <span className="muted">Abort stage:</span>{" "}
                            <strong className={abortStatus.aborted ? "tempo-text-danger" : ""}>
                                {abortStatus.aborted ? "ABORTED" : abortStatus.stage}
                            </strong>
                        </span>
                    )}
                </div>
            )}

            {sortedPins.length > 0 && (
                <div className="tempo-cursor-table-wrap">
                    <table className="tempo-cursor-table">
                        <thead>
                            <tr>
                                <th>Cursor</th>
                                <th>Time</th>
                                {sortedPins.length > 1 && <th>ΔT</th>}
                                {valveNames.map((name) => (
                                    <th key={name}>{name}</th>
                                ))}
                                {sensors.map((s) => (
                                    <th key={s.name}>
                                        {s.name} ({s.unit})
                                    </th>
                                ))}
                                {showAbortCol && <th>Abort</th>}
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {sortedPins.map((pin, idx) => {
                                const pinNum = pins.findIndex((p) => p.id === pin.id) + 1;
                                const prev = idx > 0 ? sortedPins[idx - 1] : null;
                                const delta = prev ? pin.time - prev.time : null;
                                const st = abortStatusAt(events, pin.time);
                                return (
                                    <tr key={pin.id}>
                                        <td>
                                            <span className="tempo-cursor-label">
                                                <span className="tempo-pin-dot" style={{ background: pin.color }} />
                                                <strong>C{pinNum}</strong>
                                            </span>
                                        </td>
                                        <td className="tempo-mono">T+ {nice(pin.time)}s</td>
                                        {sortedPins.length > 1 && (
                                            <td className="tempo-mono muted">
                                                {delta !== null ? `+${nice(delta)}s` : "—"}
                                            </td>
                                        )}
                                        {valveNames.map((name) => {
                                            const state = valveStateAt(initialValves, events, name, pin.time);
                                            return (
                                                <td key={name}>
                                                    <span
                                                        className={`tempo-state-pill ${state === "OPEN" ? "open" : "closed"}`}
                                                    >
                                                        {state}
                                                    </span>
                                                </td>
                                            );
                                        })}
                                        {sensors.map((sensor) => {
                                            const val = sensorValueAt(sensor, pin.time);
                                            return (
                                                <td key={sensor.name} className="tempo-mono">
                                                    {val !== null ? nice(val) : "—"}
                                                </td>
                                            );
                                        })}
                                        {showAbortCol && (
                                            <td>
                                                <strong className={st.aborted ? "tempo-text-danger" : ""}>
                                                    {st.aborted ? "ABORTED" : st.stage}
                                                </strong>
                                            </td>
                                        )}
                                        <td>
                                            <button
                                                type="button"
                                                className="tempo-icon-btn"
                                                aria-label={`Remove cursor C${pinNum}`}
                                                onClick={() =>
                                                    setPins((prevPins) => prevPins.filter((p) => p.id !== pin.id))
                                                }
                                            >
                                                ×
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
