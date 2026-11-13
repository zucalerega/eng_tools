import { useState } from "react";
import type { SensorConfig, SensorUnit, TestEnvironment, ValveConfig } from "./types";

const UNITS: SensorUnit[] = ["psi", "V", "A", "lbf", "K", "unknown"];

function tableKeys(count: number): string[] {
    return Array.from({ length: 2 ** count }, (_, i) => i.toString(2).padStart(count, "0"));
}

function ProfileChart({ sensor }: { sensor: SensorConfig }) {
    const samples = (sensor.samples || [])
        .filter(
            (pt) =>
                pt.at !== "" &&
                pt.value !== "" &&
                Number.isFinite(Number(pt.at)) &&
                Number.isFinite(Number(pt.value)) &&
                Number(pt.at) >= 0,
        )
        .map((pt) => ({ at: Number(pt.at), value: Number(pt.value) }))
        .sort((a, b) => a.at - b.at);

    if (!samples.length) {
        return (
            <svg
                viewBox="0 0 320 128"
                className="tempo-env-chart"
                role="img"
                aria-label={`${sensor.name || "Sensor"} profile`}
            />
        );
    }

    const left = 36;
    const right = 307;
    const top = 16;
    const bottom = 100;
    const duration = Math.max(1, ...samples.map((pt) => pt.at));
    const values = samples.map((pt) => pt.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const spread = Math.max(1, high - low);
    const min = low - spread * 0.15;
    const max = high + spread * 0.15;
    const x = (t: number) => left + (t / duration) * (right - left);
    const y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);

    const first = samples[0];
    if (!first) {
        return null;
    }
    let path = `M${left} ${y(first.value)}`;
    for (let i = 1; i < samples.length; i += 1) {
        const pt = samples[i];
        if (!pt) {
            continue;
        }
        path += sensor.interpolation === "linear" ? ` L${x(pt.at)} ${y(pt.value)}` : ` H${x(pt.at)} V${y(pt.value)}`;
    }
    path += ` H${right}`;

    return (
        <svg
            viewBox="0 0 320 128"
            className="tempo-env-chart"
            role="img"
            aria-label={`${sensor.name || "Sensor"} profile`}
        >
            {[0, 1, 2, 3].map((i) => {
                const level = top + ((bottom - top) * i) / 3;
                return <line key={i} x1={left} x2={right} y1={level} y2={level} className="tempo-env-chart-grid" />;
            })}
            <path d={path} className="tempo-env-chart-line" />
            {samples.map((pt, idx) => (
                <circle key={idx} cx={x(pt.at)} cy={y(pt.value)} r={3.5} className="tempo-env-chart-point" />
            ))}
            <text x={left - 4} y={top + 4} className="tempo-env-chart-label" textAnchor="end">
                {Number(high.toFixed(1))}
            </text>
            <text x={left - 4} y={bottom} className="tempo-env-chart-label" textAnchor="end">
                {Number(low.toFixed(1))}
            </text>
            <text x={left} y={119} className="tempo-env-chart-label" textAnchor="start">
                0s
            </text>
            <text x={(left + right) / 2} y={119} className="tempo-env-chart-label" textAnchor="middle">
                {sensor.unit} · {sensor.interpolation}
            </text>
            <text x={right} y={119} className="tempo-env-chart-label" textAnchor="end">
                {Number(duration.toFixed(2))}s
            </text>
        </svg>
    );
}

export interface EnvironmentEditorProps {
    environment: TestEnvironment;
    onChange: (next: TestEnvironment) => void;
}

export function EnvironmentEditor({ environment, onChange }: EnvironmentEditorProps) {
    const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

    const configuredValves = environment.valves.map((v) => v.name).filter((n) => n.trim().length > 0);
    const openCount = environment.valves.filter((v) => v.initial === "OPEN").length;
    const allCollapsed = environment.sensors.length > 0 && environment.sensors.every((_, idx) => collapsed[idx]);

    function updateValve(index: number, patch: Partial<ValveConfig>) {
        const nextValves = environment.valves.map((v, i) => (i === index ? { ...v, ...patch } : v));
        onChange({ ...environment, valves: nextValves });
    }

    function addValve() {
        onChange({
            ...environment,
            valves: [...environment.valves, { name: "", initial: "CLOSED" }],
        });
    }

    function removeValve(index: number) {
        onChange({
            ...environment,
            valves: environment.valves.filter((_, i) => i !== index),
        });
    }

    function updateSensor(index: number, patch: Partial<SensorConfig>) {
        const nextSensors = environment.sensors.map((s, i) => (i === index ? { ...s, ...patch } : s));
        onChange({ ...environment, sensors: nextSensors });
    }

    function addSensor() {
        const nextIndex = environment.sensors.length;
        setCollapsed((prev) => ({ ...prev, [nextIndex]: false }));
        onChange({
            ...environment,
            sensors: [
                ...environment.sensors,
                {
                    name: "",
                    unit: "psi",
                    mode: "time",
                    initial: 0,
                    min: null,
                    max: null,
                    valves: [],
                    rates: {},
                    interpolation: "step",
                    samples: [{ at: 0, value: 0 }],
                },
            ],
        });
    }

    function removeSensor(index: number) {
        onChange({
            ...environment,
            sensors: environment.sensors.filter((_, i) => i !== index),
        });
    }

    return (
        <div className="tempo-env-pane">
            <div className="tempo-env-summary">
                <span>
                    <strong>{environment.valves.length}</strong> valves ({openCount} OPEN ·{" "}
                    {environment.valves.length - openCount} CLOSED)
                </span>
                <span>
                    <strong>{environment.sensors.length}</strong> sensors
                </span>
            </div>
            <section className="tempo-env-group" aria-label="Valves">
                <div className="tempo-env-heading">
                    <div className="tempo-env-title">
                        <h3>Valves</h3>
                        <span className="tempo-count-badge">{environment.valves.length}</span>
                    </div>
                    <button type="button" className="button-small" onClick={addValve}>
                        + Add valve
                    </button>
                </div>
                <div className="tempo-env-valves">
                    {environment.valves.map((valve, index) => (
                        <div key={index} className="tempo-env-valve-row">
                            <label className="tempo-env-field">
                                <span>Valve name</span>
                                <input
                                    type="text"
                                    value={valve.name}
                                    placeholder="e.g. press_valve"
                                    onChange={(e) => updateValve(index, { name: e.target.value })}
                                />
                            </label>
                            <label className="tempo-env-field">
                                <span>Initial</span>
                                <select
                                    value={valve.initial}
                                    onChange={(e) =>
                                        updateValve(index, {
                                            initial: e.target.value === "OPEN" ? "OPEN" : "CLOSED",
                                        })
                                    }
                                >
                                    <option value="CLOSED">CLOSED</option>
                                    <option value="OPEN">OPEN</option>
                                </select>
                            </label>
                            <button
                                type="button"
                                className="tempo-icon-btn"
                                aria-label={`Remove valve ${valve.name || index + 1}`}
                                onClick={() => removeValve(index)}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    {!environment.valves.length && <p className="muted">No valves configured.</p>}
                </div>
            </section>

            <section className="tempo-env-group" aria-label="Sensors">
                <div className="tempo-env-heading">
                    <div className="tempo-env-title">
                        <h3>Sensors</h3>
                        <span className="tempo-count-badge">{environment.sensors.length}</span>
                    </div>
                    <div className="tempo-sensor-actions">
                        {environment.sensors.length > 0 && (
                            <button
                                type="button"
                                className="button-small"
                                onClick={() => {
                                    const next: Record<number, boolean> = {};
                                    environment.sensors.forEach((_, idx) => {
                                        next[idx] = !allCollapsed;
                                    });
                                    setCollapsed(next);
                                }}
                            >
                                {allCollapsed ? "Expand all" : "Collapse all"}
                            </button>
                        )}
                        <button type="button" className="button-small" onClick={addSensor}>
                            + Add sensor
                        </button>
                    </div>
                </div>
                <div className="tempo-env-sensors">
                    {environment.sensors.map((sensor, index) => {
                        const isOpen = !collapsed[index];
                        const dynamic = sensor.mode === "valve";
                        const keys = dynamic ? tableKeys(sensor.valves.length) : [];
                        const completed = keys.filter(
                            (k) =>
                                sensor.rates[k] !== "" &&
                                sensor.rates[k] !== undefined &&
                                Number.isFinite(Number(sensor.rates[k])),
                        ).length;

                        return (
                            <div key={index} className="tempo-sensor-card">
                                <div className="tempo-sensor-head">
                                    <label className="tempo-env-field">
                                        <span>Sensor name</span>
                                        <input
                                            type="text"
                                            value={sensor.name}
                                            placeholder="e.g. tank_pt"
                                            onChange={(e) => updateSensor(index, { name: e.target.value })}
                                        />
                                    </label>
                                    <label className="tempo-env-field">
                                        <span>Unit</span>
                                        <select
                                            value={sensor.unit}
                                            onChange={(e) =>
                                                updateSensor(index, { unit: e.target.value as SensorUnit })
                                            }
                                        >
                                            {UNITS.map((u) => (
                                                <option key={u} value={u}>
                                                    {u}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="tempo-env-field">
                                        <span>Behavior</span>
                                        <select
                                            value={sensor.mode}
                                            onChange={(e) =>
                                                updateSensor(index, {
                                                    mode: e.target.value === "valve" ? "valve" : "time",
                                                })
                                            }
                                        >
                                            <option value="time">Time-based</option>
                                            <option value="valve">Valve-driven</option>
                                        </select>
                                    </label>
                                    <div className="tempo-sensor-actions">
                                        <button
                                            type="button"
                                            className="button-small"
                                            onClick={() => setCollapsed((prev) => ({ ...prev, [index]: isOpen }))}
                                        >
                                            {isOpen ? "Collapse" : "Expand"}
                                        </button>
                                        <button
                                            type="button"
                                            className="tempo-icon-btn"
                                            aria-label={`Remove sensor ${sensor.name || index + 1}`}
                                            onClick={() => removeSensor(index)}
                                        >
                                            ×
                                        </button>
                                    </div>
                                </div>

                                {!isOpen ? (
                                    <div className="tempo-sensor-preview">
                                        {dynamic ? (
                                            <span className="muted">
                                                {sensor.valves.join(" + ") || "No valves selected"} · {completed}/
                                                {keys.length} rates defined
                                            </span>
                                        ) : (
                                            <ProfileChart sensor={sensor} />
                                        )}
                                    </div>
                                ) : (
                                    <div className="tempo-sensor-details">
                                        {dynamic ? (
                                            <div className="tempo-valve-driven">
                                                <div className="tempo-env-grid-3">
                                                    <label className="tempo-env-field">
                                                        <span>Initial ({sensor.unit})</span>
                                                        <input
                                                            type="number"
                                                            step="any"
                                                            value={sensor.initial}
                                                            onChange={(e) =>
                                                                updateSensor(index, {
                                                                    initial:
                                                                        e.target.value === ""
                                                                            ? ""
                                                                            : Number(e.target.value),
                                                                })
                                                            }
                                                        />
                                                    </label>
                                                    <label className="tempo-env-field">
                                                        <span>Min ({sensor.unit})</span>
                                                        <input
                                                            type="number"
                                                            step="any"
                                                            value={sensor.min ?? ""}
                                                            onChange={(e) =>
                                                                updateSensor(index, {
                                                                    min:
                                                                        e.target.value === ""
                                                                            ? null
                                                                            : Number(e.target.value),
                                                                })
                                                            }
                                                        />
                                                    </label>
                                                    <label className="tempo-env-field">
                                                        <span>Max ({sensor.unit})</span>
                                                        <input
                                                            type="number"
                                                            step="any"
                                                            value={sensor.max ?? ""}
                                                            onChange={(e) =>
                                                                updateSensor(index, {
                                                                    max:
                                                                        e.target.value === ""
                                                                            ? null
                                                                            : Number(e.target.value),
                                                                })
                                                            }
                                                        />
                                                    </label>
                                                </div>

                                                <div className="tempo-influences">
                                                    <span className="tempo-field-caption">
                                                        Influencing valves (up to 4)
                                                    </span>
                                                    {sensor.valves.map((selectedValve, vIdx) => (
                                                        <div key={vIdx} className="tempo-influence-row">
                                                            <select
                                                                aria-label={`Valve ${vIdx + 1}`}
                                                                value={selectedValve}
                                                                onChange={(e) => {
                                                                    const nextValves = [...sensor.valves];
                                                                    nextValves[vIdx] = e.target.value;
                                                                    updateSensor(index, {
                                                                        valves: nextValves,
                                                                        rates: {},
                                                                    });
                                                                }}
                                                            >
                                                                <option value="">Select valve…</option>
                                                                {configuredValves
                                                                    .filter(
                                                                        (v) =>
                                                                            v === selectedValve ||
                                                                            !sensor.valves.includes(v),
                                                                    )
                                                                    .map((v) => (
                                                                        <option key={v} value={v}>
                                                                            {v}
                                                                        </option>
                                                                    ))}
                                                            </select>
                                                            <button
                                                                type="button"
                                                                className="tempo-icon-btn"
                                                                onClick={() => {
                                                                    const nextValves = sensor.valves.filter(
                                                                        (_, i) => i !== vIdx,
                                                                    );
                                                                    updateSensor(index, {
                                                                        valves: nextValves,
                                                                        rates: {},
                                                                    });
                                                                }}
                                                            >
                                                                ×
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button
                                                        type="button"
                                                        className="button-small"
                                                        disabled={
                                                            sensor.valves.length >= 4 ||
                                                            configuredValves.filter((v) => !sensor.valves.includes(v))
                                                                .length === 0
                                                        }
                                                        onClick={() => {
                                                            const next = configuredValves.find(
                                                                (v) => !sensor.valves.includes(v),
                                                            );
                                                            if (next) {
                                                                updateSensor(index, {
                                                                    valves: [...sensor.valves, next],
                                                                    rates: {},
                                                                });
                                                            }
                                                        }}
                                                    >
                                                        + Add influencing valve
                                                    </button>
                                                </div>

                                                {sensor.valves.length > 0 ? (
                                                    <div className="tempo-truth-table">
                                                        <div
                                                            className="tempo-truth-head"
                                                            style={{
                                                                gridTemplateColumns: `repeat(${sensor.valves.length}, minmax(60px, 1fr)) minmax(100px, 1.3fr)`,
                                                            }}
                                                        >
                                                            {sensor.valves.map((v, i) => (
                                                                <span key={i}>{v || "?"}</span>
                                                            ))}
                                                            <span>RATE ({sensor.unit}/s)</span>
                                                        </div>
                                                        {keys.map((key) => (
                                                            <div
                                                                key={key}
                                                                className="tempo-truth-row"
                                                                style={{
                                                                    gridTemplateColumns: `repeat(${sensor.valves.length}, minmax(60px, 1fr)) minmax(100px, 1.3fr)`,
                                                                }}
                                                            >
                                                                {key.split("").map((bit, bIdx) => (
                                                                    <span
                                                                        key={bIdx}
                                                                        className={`tempo-state-pill ${bit === "1" ? "open" : "closed"}`}
                                                                    >
                                                                        {bit === "1" ? "OPEN" : "CLOSED"}
                                                                    </span>
                                                                ))}
                                                                <input
                                                                    type="number"
                                                                    step="any"
                                                                    aria-label={`Rate for ${key}`}
                                                                    value={sensor.rates[key] ?? ""}
                                                                    onChange={(e) =>
                                                                        updateSensor(index, {
                                                                            rates: {
                                                                                ...sensor.rates,
                                                                                [key]:
                                                                                    e.target.value === ""
                                                                                        ? ""
                                                                                        : Number(e.target.value),
                                                                            },
                                                                        })
                                                                    }
                                                                />
                                                            </div>
                                                        ))}
                                                        <p
                                                            className={`tempo-table-status ${completed !== keys.length ? "incomplete" : ""}`}
                                                        >
                                                            {completed}/{keys.length} combinations defined
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <p className="tempo-table-status incomplete">
                                                        Select at least one valve to generate its truth table.
                                                    </p>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="tempo-time-based">
                                                <div className="tempo-time-head">
                                                    <label className="tempo-env-field">
                                                        <span>Interpolation</span>
                                                        <select
                                                            value={sensor.interpolation}
                                                            onChange={(e) =>
                                                                updateSensor(index, {
                                                                    interpolation:
                                                                        e.target.value === "linear" ? "linear" : "step",
                                                                })
                                                            }
                                                        >
                                                            <option value="step">Step</option>
                                                            <option value="linear">Linear</option>
                                                        </select>
                                                    </label>
                                                    <ProfileChart sensor={sensor} />
                                                </div>
                                                <div className="tempo-samples-list">
                                                    {sensor.samples.map((sample, sIdx) => (
                                                        <div key={sIdx} className="tempo-sample-row">
                                                            <label className="tempo-env-field">
                                                                <span>Time (s)</span>
                                                                <input
                                                                    type="number"
                                                                    step="any"
                                                                    value={sample.at}
                                                                    onChange={(e) => {
                                                                        const next = sensor.samples.map((pt, i) =>
                                                                            i === sIdx
                                                                                ? {
                                                                                      ...pt,
                                                                                      at:
                                                                                          e.target.value === ""
                                                                                              ? ""
                                                                                              : Number(e.target.value),
                                                                                  }
                                                                                : pt,
                                                                        );
                                                                        updateSensor(index, { samples: next });
                                                                    }}
                                                                />
                                                            </label>
                                                            <label className="tempo-env-field">
                                                                <span>Value ({sensor.unit})</span>
                                                                <input
                                                                    type="number"
                                                                    step="any"
                                                                    value={sample.value}
                                                                    onChange={(e) => {
                                                                        const next = sensor.samples.map((pt, i) =>
                                                                            i === sIdx
                                                                                ? {
                                                                                      ...pt,
                                                                                      value:
                                                                                          e.target.value === ""
                                                                                              ? ""
                                                                                              : Number(e.target.value),
                                                                                  }
                                                                                : pt,
                                                                        );
                                                                        updateSensor(index, { samples: next });
                                                                    }}
                                                                />
                                                            </label>
                                                            <button
                                                                type="button"
                                                                className="tempo-icon-btn"
                                                                disabled={sensor.samples.length <= 1}
                                                                onClick={() =>
                                                                    updateSensor(index, {
                                                                        samples: sensor.samples.filter(
                                                                            (_, i) => i !== sIdx,
                                                                        ),
                                                                    })
                                                                }
                                                            >
                                                                ×
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button
                                                        type="button"
                                                        className="button-small"
                                                        onClick={() => {
                                                            const last = sensor.samples[sensor.samples.length - 1];
                                                            const nextAt = last ? Number(last.at || 0) + 1 : 0;
                                                            const nextVal = last ? Number(last.value || 0) : 0;
                                                            updateSensor(index, {
                                                                samples: [
                                                                    ...sensor.samples,
                                                                    { at: nextAt, value: nextVal },
                                                                ],
                                                            });
                                                        }}
                                                    >
                                                        + Add sample
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {!environment.sensors.length && <p className="muted">No sensors configured.</p>}
                </div>
            </section>
        </div>
    );
}
