import { useId, type ReactNode } from "react";
import type { Palette } from "./colors";
import type { Drawing } from "./drawing";
import { fluidOf, fluidsOf } from "./fluids";

// The inspector's fields: text with its units, choices, a valve's normal state, a fluid, and whether a property shows
// on the drawing.

/** Whether a property shows under its part's tag on the drawing. */
export function ShowToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            className="piper-show"
            aria-pressed={on}
            aria-label={`Show ${label} on the drawing`}
            title={on ? "Shown on the drawing: click to hide" : "Click to show it on the drawing"}
            onClick={onToggle}
        >
            <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
                <path
                    d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.4}
                    strokeLinejoin="round"
                />
                <circle cx={8} cy={8} r={on ? 2.4 : 1.2} fill="currentColor" />
                {!on && <path d="M2 14 14 2" stroke="currentColor" strokeWidth={1.4} />}
            </svg>
        </button>
    );
}

/** A labeled row: its label over its input, with what goes beside the input (a show toggle, a remove button). */
export function Row({
    label,
    children,
    after,
}: {
    label: string;
    children: (id: string) => ReactNode;
    after?: ReactNode;
}) {
    const id = useId();
    return (
        <div className="piper-row">
            <label htmlFor={id}>{label}</label>
            <div className="piper-row-input">
                {children(id)}
                {after}
            </div>
        </div>
    );
}

/** A valve's normal state: open (NO), closed (NC), or not said, each in the color it's drawn in. */
export function StatePicker({
    value,
    palette,
    onChange,
}: {
    value: string;
    palette: Palette;
    onChange: (value: string) => void;
}) {
    const choices: [string, string, string][] = [
        ["NO", "Normally open", palette.no],
        ["NC", "Normally closed", palette.nc],
        ["FIP", "Fails in place (double-acting)", palette.fip],
        ["", "Not set", palette.muted],
    ];
    return (
        <div className="piper-states" role="group" aria-label="Normal state">
            {choices.map(([choice, label, color]) => (
                <button
                    key={choice || "none"}
                    type="button"
                    aria-pressed={value === choice}
                    title={label}
                    onClick={() => onChange(choice)}
                    style={value === choice ? { borderColor: color, color } : undefined}
                >
                    <span
                        className="piper-swatch"
                        style={{ background: choice ? color : "transparent", borderColor: color }}
                    />
                    {choice || "—"}
                </button>
            ))}
        </div>
    );
}

/** A fluid, chosen from the diagram's: its color beside it. */
export function FluidSelect({
    id,
    drawing,
    value,
    onChange,
    none = "None",
}: {
    id?: string;
    drawing: Drawing;
    value: string;
    onChange: (value: string) => void;
    none?: string;
}) {
    const color = fluidOf(drawing, value)?.color;
    return (
        <span className="piper-fluid-select">
            <span className="piper-swatch" style={{ background: color ?? "transparent" }} aria-hidden="true" />
            <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
                <option value="">{none}</option>
                {fluidsOf(drawing).map((fluid) => (
                    <option key={fluid.id} value={fluid.id}>
                        {fluid.label && fluid.label !== fluid.name ? `${fluid.label} (${fluid.name})` : fluid.name}
                    </option>
                ))}
            </select>
        </span>
    );
}
