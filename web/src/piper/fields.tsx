import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Palette } from "./colors";
import type { Drawing } from "./drawing";
import { fluidOf, fluidsOf } from "./fluids";
import type { TestChannel } from "./testdata";

// The inspector's fields: text with its units, choices, a valve's normal state, a fluid, a test's channel, and whether
// a property shows on the drawing.

/**
 * A test channel's name: typed, or picked from the test's channels, which narrow to what's typed. Its list is the
 * page's own, in its colors, as the find box's is: a datalist's is the browser's, white and plain on Windows, with each
 * name in it twice. Without a test, it's a box to type in.
 */
export function ChannelInput({
    id,
    value,
    channels,
    placeholder,
    onChange,
}: {
    id: string;
    value: string;
    channels: TestChannel[] | null; // the test the drawing's read against's, if there is one
    placeholder: string;
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const list = useId();
    const typed = value.trim().toLowerCase();
    const matches = useMemo(() => {
        if (!channels) {
            return [];
        }
        // A channel's whole name shows them all, to pick another; part of one, those it's in.
        const whole = channels.some((channel) => channel.name.toLowerCase() === typed);
        return typed && !whole ? channels.filter((channel) => channel.name.toLowerCase().includes(typed)) : channels;
    }, [channels, typed]);
    const showing = open && matches.length > 0;

    function pick(channel: TestChannel | undefined) {
        if (channel) {
            onChange(channel.name);
            setOpen(false);
        }
    }

    function onKey(event: KeyboardEvent<HTMLInputElement>) {
        if (!channels) {
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!showing) {
                setOpen(true);
                setActive(0);
                return;
            }
            const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
            setActive((now) => (now + step) % matches.length);
        } else if (event.key === "Enter" && showing) {
            event.preventDefault();
            pick(matches[active]);
        } else if (event.key === "Escape" && showing) {
            event.stopPropagation(); // closes the list, not the inspector or the selection
            setOpen(false);
        }
    }

    return (
        <div className="piper-combo">
            <input
                id={id}
                role={channels ? "combobox" : undefined}
                aria-autocomplete={channels ? "list" : undefined}
                aria-expanded={channels ? showing : undefined}
                aria-controls={channels ? list : undefined}
                aria-activedescendant={showing ? `${list}-${active}` : undefined}
                autoComplete="off"
                value={value}
                placeholder={placeholder}
                onChange={(event) => {
                    onChange(event.target.value);
                    setActive(0);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onKey}
            />
            {showing && (
                <ul
                    id={list}
                    role="listbox"
                    aria-label="The test's channels"
                    className="piper-find-pop piper-combo-pop"
                >
                    {matches.map((channel, index) => (
                        <li
                            key={channel.name}
                            id={`${list}-${index}`}
                            role="option"
                            aria-selected={index === active}
                            onMouseDown={(event) => {
                                event.preventDefault(); // the box keeps its focus as it's picked
                                pick(channel);
                            }}
                            onMouseEnter={() => setActive(index)}
                        >
                            <strong>{channel.name}</strong>
                            <span className="muted">{channel.kind === "state" ? "state" : channel.unit}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

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
