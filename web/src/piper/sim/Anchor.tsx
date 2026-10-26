import { useState } from "react";
import type { Catalog, Knob, Solver, SystemModel } from "./api";
import { MAX_KNOBS } from "./Fit";
import { comparisons, heldInSteady, knobsOf } from "./settings";

// Anchoring the model to a test (one of Tune's two ways, Tune.tsx): each sensor picked moves a knob (FullFlow's
// Sensors), in every time step of the run, until the model reads what that sensor measured. One run, and each knob's
// history through it: what it settled at is then yours to apply to the P&ID (or not). What anchoring can't settle is
// fitted (Fit's least squares, the anchors held in each run): knobs picked to fit, and, falling back, any whose anchor
// didn't work.

/** A sensor anchoring a knob, over a span in seconds on the test's clock (blank: the run's window). */
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

/** What an anchored run is asked to do, as the Tune dialog sets it up, and what's wrong with it, if anything. */
export function useAnchorPlan(model: SystemModel, catalog: Catalog, solver: Solver, picked: AnchorPlan) {
    // Steady, a part holding what was measured has neither a knob that matters nor a sensor to anchor to.
    const held = solver === "steady" ? heldInSteady(model) : new Set<string>();
    const sensors = comparisons(model, catalog).filter((one) => !held.has(one.part));
    const knobs = knobsOf(model, catalog).filter(({ part }) => !held.has(part.id));
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
    const twice = ids.find((id, index) => ids.indexOf(id) !== index);
    const twiceName = twice && knobs.find(({ part, setting }) => knobId(part.id, setting.key) === twice);
    const problems = [
        fitting.length > 0 &&
            rows.every((row) => row.part !== "") &&
            "Every sensor anchors a knob, so none is left to fit the others to: anchor fewer.",
        fitting.length > MAX_KNOBS && `Fit ${MAX_KNOBS} knobs at most.`,
        twiceName && `${twiceName.part.name}: ${twiceName.setting.label} is picked twice: give each knob one sensor.`,
        chosen.length > MAX_KNOBS && `Anchor ${MAX_KNOBS} knobs at most.`,
        chosen.some((row) => [row.from, row.to].some((text) => text.trim() !== "" && !Number.isFinite(Number(text)))) &&
            "A span's From and To are seconds, or blank.",
    ].filter((one): one is string => typeof one === "string");
    return {
        steady: solver === "steady",
        sensors,
        knobs,
        rows,
        change: (index: number, next: Partial<AnchorChoice>) =>
            setRows(rows.map((row, at) => (at === index ? { ...row, ...next } : row))),
        fittable,
        fitting,
        toggleFit: (knob: Knob, on: boolean) =>
            setFitted(
                on ? [...fitting, knob] : fitting.filter((one) => !(one.part === knob.part && one.key === knob.key)),
            ),
        fallback,
        setFallback,
        problems,
        ready: chosen.length > 0 && problems.length === 0,
        plan: { anchors: chosen, knobs: fitting, fallback } as AnchorPlan,
    };
}

export type AnchorPlanChoice = ReturnType<typeof useAnchorPlan>;

/** Which sensor moves which knob, over what span; what to fit alongside; and what to do with a knob FullFlow can't
 * anchor. */
export function AnchorChoices({ choice, window }: { choice: AnchorPlanChoice; window: { from: string; to: string } }) {
    const { steady, sensors, knobs, rows, change, fittable, fitting, toggleFit, fallback, setFallback, problems } =
        choice;
    if (sensors.length === 0) {
        return (
            <p className="notice notice-warning">
                Nothing to anchor to: the model isn&apos;t compared with any of the test&apos;s channels
                {steady ? " that a steady run doesn't hold" : ""}. Tap a pressure transducer to a line, or put a flow
                meter in one, named as the test&apos;s channel.
            </p>
        );
    }
    return (
        <>
            <p className="muted piper-sim-help">
                Give an anchor a span where its knob counts: a valve&apos;s CdA while it&apos;s open, since nothing
                flows to tell it while it&apos;s shut. In a transient run, an anchor starting partway through jumps the
                model to the test at once, which a line&apos;s inertia doesn&apos;t allow: start it with the run, or
                anchor in a steady run.
                {steady
                    ? " Steady, tanks (and gas vessels and tubing a transducer reads) hold the pressure measured, so they aren't here."
                    : ""}
            </p>
            <table className="piper-sim-table piper-sim-anchors">
                <thead>
                    <tr>
                        <th>Sensor</th>
                        <th>Knob it moves</th>
                        <th>From (s)</th>
                        <th>To (s)</th>
                    </tr>
                </thead>
                <tbody>
                    {sensors.map((sensor, index) => {
                        const row = rows[index]!;
                        const named = `${sensor.name} (${sensor.channel})`;
                        return (
                            <tr key={`${sensor.part}.${sensor.link}`}>
                                <td>
                                    {sensor.name}
                                    <span className="muted piper-sim-channel">{sensor.channel}</span>
                                </td>
                                <td>
                                    <select
                                        aria-label={named}
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
                                        <option value="">None</option>
                                        {knobs.map(({ part, setting }) => (
                                            <option
                                                key={knobId(part.id, setting.key)}
                                                value={knobId(part.id, setting.key)}
                                            >
                                                {part.name}: {setting.label}
                                            </option>
                                        ))}
                                    </select>
                                </td>
                                <td>
                                    <input
                                        aria-label="From (s)"
                                        inputMode="decimal"
                                        placeholder={window.from}
                                        disabled={!row.part}
                                        value={row.from}
                                        onChange={(event) => change(index, { from: event.target.value })}
                                    />
                                </td>
                                <td>
                                    <input
                                        aria-label="To (s)"
                                        inputMode="decimal"
                                        placeholder={window.to}
                                        disabled={!row.part}
                                        value={row.to}
                                        onChange={(event) => change(index, { to: event.target.value })}
                                    />
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {fittable.length > 0 && (
                <fieldset className="piper-sim-knobs">
                    <legend>Fit alongside, to the sensors not anchoring</legend>
                    {fittable.map(({ part, setting }) => {
                        const knob = { part: part.id, key: setting.key };
                        return (
                            <label key={knobId(part.id, setting.key)} className="check">
                                <input
                                    type="checkbox"
                                    checked={fitting.some((one) => one.part === knob.part && one.key === knob.key)}
                                    onChange={(event) => toggleFit(knob, event.target.checked)}
                                />
                                {part.name}: {setting.label}
                            </label>
                        );
                    })}
                </fieldset>
            )}
            <label className="check">
                <input type="checkbox" checked={fallback} onChange={(event) => setFallback(event.target.checked)} />
                If FullFlow can&apos;t anchor a knob, fit it instead (slower: a fit takes minutes)
            </label>
            {problems.map((problem) => (
                <p key={problem} className="notice notice-warning">
                    {problem}
                </p>
            ))}
        </>
    );
}
