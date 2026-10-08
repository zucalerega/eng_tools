import { useState } from "react";
import { Dialog } from "../../components";
import { formatValue } from "../scale";
import type { Catalog, FitKnob, Setting, SystemModel } from "./api";
import { comparisons, kindOf, knobsOf, partOf, setSetting } from "./model";
import { toDisplay, unitOf } from "./units";

// Fitting a model to a test: pick the knobs (settings marked tune), and the server turns them until the model matches
// the channels it's compared with, run after run. What it found is then yours to apply (or not).

export const MAX_KNOBS = 8; // the server's: each costs a run per try

/** A value to four figures: a knob's, without the last digits of its unit conversion. */
const rounded = (value: number) => formatValue(Number(value.toPrecision(4)));

export interface Knob {
    part: string;
    key: string;
}

const same = (a: Knob, b: Knob) => a.part === b.part && a.key === b.key;

/** A knob's setting, if the model still has it. */
function settingOf(model: SystemModel, catalog: Catalog, knob: { part: string; key: string }): Setting | undefined {
    const part = partOf(model, knob.part);
    return part ? kindOf(catalog, part.type).settings.find((one) => one.key === knob.key) : undefined;
}

/** Whether a value is within its setting's limits: an anchor can take a knob past them, which no part can have. */
function withinLimits(setting: Setting | undefined, value: number): boolean {
    return (setting?.minimum ?? -Infinity) <= value && value <= (setting?.maximum ?? Infinity);
}

/** A model with the values a fit (or an anchored run) found, where they're within their settings' limits. */
export function applyKnobs(model: SystemModel, catalog: Catalog, found: FitKnob[]): SystemModel {
    return found
        .filter((knob) => withinLimits(settingOf(model, catalog, knob), knob.value))
        .reduce((next, knob) => setSetting(next, knob.part, knob.key, knob.value), model);
}

export function FitDialog({
    model,
    catalog,
    picked,
    onStart,
    onCancel,
}: {
    model: SystemModel;
    catalog: Catalog;
    picked: Knob[]; // last time's, to start from
    onStart: (knobs: Knob[]) => void;
    onCancel: () => void;
}) {
    const knobs = knobsOf(model, catalog);
    const [chosen, setChosen] = useState<Knob[]>(
        picked.filter((one) => knobs.some((knob) => same({ part: knob.part.id, key: knob.setting.key }, one))),
    );
    const compared = comparisons(model, catalog);
    const display = model.display;
    const toggle = (knob: Knob, on: boolean) =>
        setChosen(on ? [...chosen.filter((one) => !same(one, knob)), knob] : chosen.filter((one) => !same(one, knob)));
    return (
        <Dialog
            title="Fit the model to the test"
            confirm="Fit"
            disabled={chosen.length === 0 || chosen.length > MAX_KNOBS || compared.length === 0}
            onConfirm={() => onStart(chosen)}
            onCancel={onCancel}
        >
            <p className="muted dev-help">
                The model runs again and again over the run&apos;s window, the knobs you pick turned until it matches
                what was measured best. Each try is a run for every knob picked, so fewer knobs (and a longer time step)
                fit faster; it stops after 30 minutes with the best it found.
            </p>
            {compared.length === 0 ? (
                <p className="notice notice-warning">
                    Nothing to fit to: link a sensor first (a junction&apos;s pressure transducer, a flow meter, an
                    ullage tank&apos;s pressure).
                </p>
            ) : (
                <p className="dev-help">
                    Fits to <strong>{compared.map((one) => one.channel).join(", ")}</strong>.
                </p>
            )}
            <fieldset className="dev-knobs">
                <legend>Knobs</legend>
                {knobs.length === 0 && <p className="muted">This model has no knobs to tune.</p>}
                {knobs.map(({ part, setting }) => {
                    const knob = { part: part.id, key: setting.key };
                    const value = Number(part.settings[setting.key] ?? setting.default);
                    const unit = unitOf(setting.quantity, display);
                    return (
                        <label key={`${part.id}.${setting.key}`} className="check">
                            <input
                                type="checkbox"
                                checked={chosen.some((one) => same(one, knob))}
                                onChange={(event) => toggle(knob, event.target.checked)}
                            />
                            {part.name}: {setting.label}{" "}
                            <span className="muted">
                                (now {rounded(toDisplay(setting.quantity, value, display))}
                                {unit && ` ${unit}`})
                            </span>
                        </label>
                    );
                })}
            </fieldset>
            {chosen.length > MAX_KNOBS && <p className="notice notice-warning">Pick {MAX_KNOBS} knobs at most.</p>}
        </Dialog>
    );
}

/**
 * What a fit found (or, stopped, the best it had found), or what an anchored run's knobs settled at: each knob from
 * where it started to where it ended up, and, anchored, how much it moved (its 10th to 90th percentiles).
 */
export function FitSummary({
    model,
    catalog,
    found,
    note,
    title = "Fit",
    spread,
    how,
    onApply,
    onDiscard,
}: {
    model: SystemModel;
    catalog: Catalog;
    found: FitKnob[];
    note: string; // how it went
    title?: string;
    spread?: Record<string, [number, number]>; // by part.key
    how?: Record<string, string>; // how each knob was found (anchored, fitted), by part.key
    onApply: () => void;
    onDiscard: () => void;
}) {
    const display = model.display;
    return (
        <section className="dev-fit-found" aria-label={title}>
            <p>
                <strong>{title}</strong> <span className="muted">{note}</span>
            </p>
            <table className="dev-fit-table">
                <thead>
                    <tr>
                        <th>Knob</th>
                        <th>From</th>
                        <th>To</th>
                        <th>Change</th>
                        {spread && <th>10–90%</th>}
                        {how && <th>How</th>}
                    </tr>
                </thead>
                <tbody>
                    {found.map((knob) => {
                        const part = partOf(model, knob.part);
                        const setting = settingOf(model, catalog, knob);
                        const quantity = setting?.quantity ?? "number";
                        const unit = unitOf(quantity, display);
                        const number = (si: number) => rounded(toDisplay(quantity, si, display));
                        const show = (si: number) => `${number(si)}${unit ? ` ${unit}` : ""}`;
                        const ratio = knob.start !== 0 ? knob.value / knob.start : null;
                        const range = spread?.[`${knob.part}.${knob.key}`];
                        return (
                            <tr key={`${knob.part}.${knob.key}`}>
                                <td>
                                    {part?.name ?? knob.part}: {setting?.label ?? knob.key}
                                </td>
                                <td>{show(knob.start)}</td>
                                <td>
                                    <strong>{show(knob.value)}</strong>
                                    {!withinLimits(setting, knob.value) && (
                                        <span className="muted"> past its limits: not applied</span>
                                    )}
                                </td>
                                <td className="muted">{ratio === null ? "" : `×${rounded(ratio)}`}</td>
                                {spread && (
                                    <td className="muted">{range ? `${number(range[0])} to ${show(range[1])}` : ""}</td>
                                )}
                                {how && <td className="muted">{how[`${knob.part}.${knob.key}`] ?? ""}</td>}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <p className="dev-fit-actions">
                <button type="button" className="button-primary" onClick={onApply}>
                    Apply to the model
                </button>
                <button type="button" onClick={onDiscard}>
                    Discard
                </button>
            </p>
        </section>
    );
}
