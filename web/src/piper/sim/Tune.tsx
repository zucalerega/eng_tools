import { useState } from "react";
import { Dialog } from "../../components";
import { AnchorChoices, type AnchorPlan, useAnchorPlan } from "./Anchor";
import type { Catalog, Knob, Solver, SystemModel } from "./api";
import { FitChoices, useFitChoice } from "./Fit";

// Tuning the model's knobs (settings marked tune) to a test, one of two ways, side by side so it's plain which is which:
// a fit (Fit.tsx) runs the model again and again for one best value of each knob; an anchored run (Anchor.tsx) moves
// each knob within one run, at every time step, until its sensor reads what was measured. Each keeps what was picked
// for it while the other is shown.

export type Method = "fit" | "anchor";

const METHODS: { method: Method; name: string; what: string }[] = [
    {
        method: "fit",
        name: "Fit",
        what: "Runs the model again and again, turning the knobs you pick until every sensor matches as well as it can: one value for each knob. Any knob, in minutes.",
    },
    {
        method: "anchor",
        name: "Anchor",
        what: "One run: FullFlow moves each knob, at every time step, until its sensor reads what was measured, so you see how the knob changes through the run. For a knob that sets a reading directly: a CdA, a line's losses, a wall's hA.",
    },
];

export function TuneDialog({
    model,
    catalog,
    solver,
    method: first,
    knobs,
    plan,
    window,
    onFit,
    onAnchor,
    onCancel,
}: {
    model: SystemModel;
    catalog: Catalog;
    solver: Solver;
    method: Method; // the one used last
    knobs: Knob[]; // last fit's, to start from
    plan: AnchorPlan; // last anchored run's
    window: { from: string; to: string }; // the run's, as the page shows it
    onFit: (knobs: Knob[]) => void;
    onAnchor: (plan: AnchorPlan) => void;
    onCancel: () => void;
}) {
    const [method, setMethod] = useState<Method>(first);
    const fit = useFitChoice(model, catalog, solver, knobs);
    const anchor = useAnchorPlan(model, catalog, solver, plan);
    return (
        <Dialog
            title="Tune the model to the test"
            confirm={method === "fit" ? "Fit" : "Anchor"}
            tall
            wide
            disabled={method === "fit" ? !fit.ready : !anchor.ready}
            onConfirm={() => (method === "fit" ? onFit(fit.chosen) : onAnchor(anchor.plan))}
            onCancel={onCancel}
        >
            <fieldset className="piper-sim-methods">
                <legend>How</legend>
                {METHODS.map((one) => (
                    <label
                        key={one.method}
                        className={`piper-sim-method${method === one.method ? " piper-sim-method-on" : ""}`}
                    >
                        <input
                            type="radio"
                            name="tune-method"
                            aria-label={one.name}
                            checked={method === one.method}
                            onChange={() => setMethod(one.method)}
                        />
                        <span>
                            <strong>{one.name}</strong>
                            <span className="muted">{one.what}</span>
                        </span>
                    </label>
                ))}
            </fieldset>
            {method === "fit" ? (
                <FitChoices model={model} choice={fit} />
            ) : (
                <AnchorChoices choice={anchor} window={window} />
            )}
        </Dialog>
    );
}
