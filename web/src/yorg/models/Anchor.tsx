import { useState } from "react";
import { Dialog } from "../../components";
import type { Catalog, Solver, SystemModel } from "./api";
import { MAX_KNOBS, type Knob } from "./Fit";
import { comparisons, knobsOf } from "./model";

// Anchoring a model to a test: each sensor picked moves a knob (FullFlow's Sensors), in every time step of the run, until
// the model reads what that sensor measured. One run, and each knob's history through it: what it settled at is then
// yours to apply (or not). What anchoring can't settle is fitted (Fit's least squares, the anchors held in each run):
// knobs picked to fit, and, falling back, any whose anchor didn't work.

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

/** What to anchor, what to fit alongside, and whether to fit a knob whose anchor doesn't work. */
export interface AnchorPlan {
    anchors: AnchorChoice[];
    knobs: Knob[];
    fallback: boolean;
}

export const NO_PLAN: AnchorPlan = { anchors: [], knobs: [], fallback: true };

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
    picked: AnchorPlan; // last time's, to start from
    window: { from: string; to: string }; // the run's, as the page shows it
    onStart: (plan: AnchorPlan) => void;
    onCancel: () => void;
}) {
    // Steady, tanks hold what was measured: their knobs don't matter, and their sensors are what they follow. So does a
    // gas junction a transducer reads (a bottle draining has no steady state), a vessel's wall too.
    const steady = solver === "steady";
    const held = new Set(
        model.nodes
            .filter((node) => node.type === "tank" || (node.type === "gas_junction" && node.links.pressure))
            .map((node) => node.id),
    );
    const sensors = comparisons(model, catalog).filter((one) => !(steady && held.has(one.part)));
    const knobs = knobsOf(model, catalog).filter(({ part }) => !(steady && held.has(part.id)));
    const [rows, setRows] = useState<AnchorChoice[]>(() =>
        sensors.map((sensor) => {
            const before = picked.anchors.find((one) => one.sensor === sensor.part && one.link === sensor.link);
            const known =
                before && knobs.some(({ part, setting }) => part.id === before.part && setting.key === before.key);
            return known ? before : { part: "", key: "", sensor: sensor.part, link: sensor.link, from: "", to: "" };
        }),
    );
    const [fitted, setFitted] = useState<Knob[]>(() =>
        picked.knobs.filter((one) =>
            knobs.some(({ part, setting }) => part.id === one.part && setting.key === one.key),
        ),
    );
    const [fallback, setFallback] = useState(picked.fallback);
    const chosen = rows.filter((row) => row.part !== "");
    const ids = chosen.map((row) => knobId(row.part, row.key));
    // Knobs to fit: any not anchored, fitted to the sensors that aren't anchoring.
    const fittable = knobs.filter(({ part, setting }) => !ids.includes(knobId(part.id, setting.key)));
    const fitting = fitted.filter((one) =>
        fittable.some(({ part, setting }) => part.id === one.part && setting.key === one.key),
    );
    const nothingLeft = fitting.length > 0 && rows.every((row) => row.part !== "");
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
            tall
            disabled={
                chosen.length === 0 ||
                chosen.length > MAX_KNOBS ||
                twice !== undefined ||
                badSpan ||
                fitting.length > MAX_KNOBS ||
                nothingLeft
            }
            onConfirm={() => onStart({ anchors: chosen, knobs: fitting, fallback })}
            onCancel={onCancel}
        >
            <p className="muted dev-help">
                In one run, FullFlow moves each knob you pick, in every time step, until the model reads what its sensor
                measured. Where it can&apos;t (a valve&apos;s CdA while it&apos;s shut), it holds the knob: give such an
                anchor a span.{" "}
                {steady
                    ? "Steady, tanks (and gas junctions a transducer reads) hold the pressure measured, so they aren't here. "
                    : ""}
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
            {sensors.length > 0 && fittable.length > 0 && (
                <fieldset className="dev-knobs">
                    <legend>Also fit, to the sensors not anchoring</legend>
                    {fittable.map(({ part, setting }) => {
                        const knob = { part: part.id, key: setting.key };
                        const on = fitting.some((one) => one.part === knob.part && one.key === knob.key);
                        return (
                            <label key={knobId(part.id, setting.key)} className="check">
                                <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={(event) =>
                                        setFitted(
                                            event.target.checked
                                                ? [...fitting, knob]
                                                : fitting.filter(
                                                      (one) => !(one.part === knob.part && one.key === knob.key),
                                                  ),
                                        )
                                    }
                                />
                                {part.name}: {setting.label}
                            </label>
                        );
                    })}
                </fieldset>
            )}
            {sensors.length > 0 && (
                <label className="check">
                    <input type="checkbox" checked={fallback} onChange={(event) => setFallback(event.target.checked)} />
                    Fit any knob FullFlow can&apos;t anchor (slower: a fit takes minutes)
                </label>
            )}
            {nothingLeft && (
                <p className="notice notice-warning">
                    Every sensor anchors a knob, so none is left to fit the others to: anchor fewer.
                </p>
            )}
            {fitting.length > MAX_KNOBS && <p className="notice notice-warning">Fit {MAX_KNOBS} knobs at most.</p>}
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
