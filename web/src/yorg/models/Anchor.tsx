import { useState } from "react";
import { Dialog } from "../../components";
import type { Catalog, Solver, SystemModel } from "./api";
import { MAX_KNOBS } from "./Fit";
import { comparisons, knobsOf } from "./model";

// Anchoring a model to a test: each sensor picked moves a knob (FullFlow's Sensors), in every time step of the run, until
// the model reads what that sensor measured. One run, and each knob's history through it: what it settled at is then
// yours to apply (or not).

/** A sensor anchoring a knob, over a span in seconds from the run's zero (T0, or the dataset's start; blank: the run's
 * window). */
export interface AnchorChoice {
    part: string;
    key: string;
    sensor: string;
    link: string;
    from: string;
    to: string;
}

const knobId = (part: string, key: string) => `${part}.${key}`;

export function AnchorDialog({
    model,
    catalog,
    solver,
    picked,
    window,
    onStart,
    onCancel,
}: {
    model: SystemModel;
    catalog: Catalog;
    solver: Solver;
    picked: AnchorChoice[]; // last time's, to start from
    window: { from: string; to: string }; // the run's, as the page shows it
    onStart: (anchors: AnchorChoice[]) => void;
    onCancel: () => void;
}) {
    // Steady, tanks hold what was measured: their knobs don't matter, and their sensors are what they follow.
    const steady = solver === "steady";
    const tanks = new Set(model.nodes.filter((node) => node.type === "tank").map((node) => node.id));
    const sensors = comparisons(model, catalog).filter((one) => !(steady && tanks.has(one.part)));
    const knobs = knobsOf(model, catalog).filter(({ part }) => !(steady && tanks.has(part.id)));
    const [rows, setRows] = useState<AnchorChoice[]>(() =>
        sensors.map((sensor) => {
            const before = picked.find((one) => one.sensor === sensor.part && one.link === sensor.link);
            const known =
                before && knobs.some(({ part, setting }) => part.id === before.part && setting.key === before.key);
            return known ? before : { part: "", key: "", sensor: sensor.part, link: sensor.link, from: "", to: "" };
        }),
    );
    const chosen = rows.filter((row) => row.part !== "");
    const ids = chosen.map((row) => knobId(row.part, row.key));
    const twice = ids.find((id, index) => ids.indexOf(id) !== index);
    const twiceName = twice && knobs.find(({ part, setting }) => knobId(part.id, setting.key) === twice);
    const badSpan = chosen.some((row) =>
        [row.from, row.to].some((text) => text.trim() !== "" && !Number.isFinite(Number(text))),
    );
    const change = (index: number, next: Partial<AnchorChoice>) =>
        setRows(rows.map((row, at) => (at === index ? { ...row, ...next } : row)));
    return (
        <Dialog
            title="Anchor knobs to the test"
            confirm="Anchor"
            disabled={chosen.length === 0 || chosen.length > MAX_KNOBS || twice !== undefined || badSpan}
            onConfirm={() => onStart(chosen)}
            onCancel={onCancel}
        >
            <p className="muted dev-help">
                In one run, FullFlow moves each knob you pick, in every time step, until the model reads what its sensor
                measured. Where it can&apos;t (a valve&apos;s CdA while it&apos;s shut), it holds the knob: give such an
                anchor a span. {steady ? "Steady, tanks hold the pressure measured, so they aren't here. " : ""}
                In a transient run, an anchor starting partway through has the model jump to the test at once, which a
                line&apos;s inertia doesn&apos;t allow: start it with the run, or anchor in a steady run.
            </p>
            {sensors.length === 0 ? (
                <p className="notice notice-warning">
                    Nothing to anchor to: link a sensor first (a junction&apos;s pressure transducer, a flow meter
                    {steady ? "" : ", an ullage tank's pressure"}).
                </p>
            ) : (
                <fieldset className="dev-anchors">
                    <legend>Sensors, and the knob each moves</legend>
                    {sensors.map((sensor, index) => {
                        const row = rows[index]!;
                        return (
                            <div key={`${sensor.part}.${sensor.link}`} className="dev-anchor">
                                <label className="field">
                                    {sensor.name} <span className="muted">({sensor.channel})</span>
                                    <select
                                        value={row.part ? knobId(row.part, row.key) : ""}
                                        onChange={(event) => {
                                            const found = knobs.find(
                                                ({ part, setting }) =>
                                                    knobId(part.id, setting.key) === event.target.value,
                                            );
                                            change(index, {
                                                part: found?.part.id ?? "",
                                                key: found?.setting.key ?? "",
                                            });
                                        }}
                                    >
                                        <option value="">Nothing</option>
                                        {knobs.map(({ part, setting }) => (
                                            <option
                                                key={knobId(part.id, setting.key)}
                                                value={knobId(part.id, setting.key)}
                                            >
                                                {part.name}: {setting.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="field">
                                    From (s)
                                    <input
                                        inputMode="decimal"
                                        placeholder={window.from}
                                        disabled={!row.part}
                                        value={row.from}
                                        onChange={(event) => change(index, { from: event.target.value })}
                                    />
                                </label>
                                <label className="field">
                                    To (s)
                                    <input
                                        inputMode="decimal"
                                        placeholder={window.to}
                                        disabled={!row.part}
                                        value={row.to}
                                        onChange={(event) => change(index, { to: event.target.value })}
                                    />
                                </label>
                            </div>
                        );
                    })}
                </fieldset>
            )}
            {twiceName && (
                <p className="notice notice-warning">
                    {twiceName.part.name}: {twiceName.setting.label} is picked twice: give each knob one sensor.
                </p>
            )}
            {chosen.length > MAX_KNOBS && <p className="notice notice-warning">Anchor {MAX_KNOBS} knobs at most.</p>}
            {badSpan && <p className="notice notice-warning">A span&apos;s From and To are seconds, or blank.</p>}
        </Dialog>
    );
}
