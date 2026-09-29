import { useEffect, useState } from "react";
import type { Channel } from "../api";
import { formatValue } from "../scale";
import type { Catalog, Display, Link, Quantity, Role, SystemModel } from "./api";
import {
    changePart,
    isEdge,
    kindOf,
    partOf,
    reverse,
    roleOf,
    setLink,
    setSetting,
    shownLinks,
    shownSettings,
} from "./model";
import { fromDisplay, toDisplay, unitOf } from "./units";

// The picked part's name, settings (in the model's units; the knobs to tune are marked), and the channels it's linked
// to in the test's data. A setting a linked channel takes over says so: the tank's pressure follows PT-TANK, or starts
// at PT-TANK's value at the run's start.

interface Props {
    model: SystemModel;
    catalog: Catalog;
    id: string;
    channels: Channel[]; // the test's
    /** A channel's value at the run's start, in SI (null: no test, not loaded yet, or no sample there). */
    startValue: (channel: string, quantity: Quantity) => number | null;
    onChange: (model: SystemModel) => void;
    onDelete: (id: string) => void;
}

const ROLES: Record<Role, string> = {
    boundary: "(it follows)",
    start: "(starts it, compared)",
    sensor: "(compared)",
    command: "(drives it)",
};

/** A number in the model's units, edited as text and kept (in SI) when you leave the box or press Enter. */
function NumberField({
    label,
    si,
    quantity,
    display,
    tunable,
    help,
    note,
    onCommit,
}: {
    label: string;
    si: number;
    quantity: Quantity;
    display: Display;
    tunable: boolean;
    help: string;
    note: string | null; // a linked channel sets it instead: how
    onCommit: (si: number) => void;
}) {
    const shown = formatValue(toDisplay(quantity, si, display));
    const [text, setText] = useState(shown);
    useEffect(() => setText(shown), [shown]);
    const commit = () => {
        const value = Number(text.trim());
        if (text.trim() === "" || !Number.isFinite(value)) {
            setText(shown);
        } else if (value !== Number(shown)) {
            onCommit(fromDisplay(quantity, value, display));
        }
    };
    const unit = unitOf(quantity, display);
    return (
        <label className="field dev-field" title={help || undefined}>
            <span>
                {label}
                {tunable && (
                    <span className="dev-tune" title="A knob to tune the model with">
                        tune
                    </span>
                )}
            </span>
            {note ? (
                <span className="dev-linked">{note}</span>
            ) : (
                <span className="dev-input">
                    <input
                        inputMode="decimal"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => event.key === "Enter" && commit()}
                    />
                    {unit && <span className="muted">{unit}</span>}
                </span>
            )}
        </label>
    );
}

export function Inspector({ model, catalog, id, channels, startValue, onChange, onDelete }: Props) {
    const part = partOf(model, id);
    if (!part) {
        return null;
    }
    const kind = kindOf(catalog, part.type);
    const links = shownLinks(kind, part.settings);
    const sorted = [...channels].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const nameOf = (nodeId: string) => model.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
    const display = model.display;

    /** How a linked channel sets a setting of the same name, if one does. */
    function linkedNote(key: string): string | null {
        const link: Link | undefined = links.find((one) => one.key === key && part!.links[one.key]);
        if (!link) {
            return null;
        }
        const channel = part!.links[link.key]!;
        const role = roleOf(link, part!.settings);
        if (role === "boundary") {
            return `Follows ${channel}`;
        }
        if (role !== "start") {
            return null;
        }
        const value = startValue(channel, link.quantity);
        return value === null
            ? `${channel} at the run's start`
            : `${channel} at the start: ${formatValue(toDisplay(link.quantity, value, display))} ${unitOf(link.quantity, display)}`;
    }

    function link(key: string, channel: string, quantity: Quantity) {
        let next = setLink(model, id, key, channel);
        // A numeric command (a voltage, a percentage): open and closed at its highest and lowest.
        const found = channels.find((one) => one.name === channel);
        if (
            quantity === "command" &&
            found &&
            found.kind === "number" &&
            found.min !== null &&
            found.max !== null &&
            found.max > found.min
        ) {
            next = setSetting(setSetting(next, id, "closed_value", found.min), id, "open_value", found.max);
        } else if (quantity === "command" && found) {
            next = setSetting(setSetting(next, id, "closed_value", 0), id, "open_value", 1);
        }
        onChange(next);
    }

    return (
        <section className="dev-inspector" aria-label={`${part.name} settings`}>
            <label className="field">
                Name
                <input
                    value={part.name}
                    maxLength={80}
                    onChange={(event) => onChange(changePart(model, id, { name: event.target.value }))}
                />
            </label>
            <p className="muted dev-help">
                {kind.label}
                {isEdge(part) && (
                    <>
                        {" "}
                        from {nameOf(part.source)} to {nameOf(part.target)}{" "}
                        <button type="button" className="button-small" onClick={() => onChange(reverse(model, id))}>
                            Reverse
                        </button>
                    </>
                )}
                <br />
                {kind.help}
            </p>
            {shownSettings(kind, part.settings).map((setting) => {
                const value = part.settings[setting.key] ?? setting.default;
                if (setting.quantity === "choice") {
                    return (
                        <label key={setting.key} className="field dev-field" title={setting.help || undefined}>
                            <span>{setting.label}</span>
                            <select
                                value={String(value)}
                                onChange={(event) => onChange(setSetting(model, id, setting.key, event.target.value))}
                            >
                                {setting.choices.map((choice, index) => (
                                    <option key={choice} value={choice}>
                                        {setting.choice_labels[index] ?? choice}
                                    </option>
                                ))}
                            </select>
                        </label>
                    );
                }
                return (
                    <NumberField
                        key={setting.key}
                        label={setting.label}
                        si={Number(value)}
                        quantity={setting.quantity}
                        display={display}
                        tunable={setting.tunable}
                        help={setting.help}
                        note={linkedNote(setting.key)}
                        onCommit={(si) => onChange(setSetting(model, id, setting.key, si))}
                    />
                );
            })}
            {links.length > 0 && <h3>Channels</h3>}
            {links.map((one) => (
                <label key={one.key} className="field dev-field" title={one.help || undefined}>
                    <span>
                        {one.label}
                        <span className="muted"> {ROLES[roleOf(one, part.settings)]}</span>
                    </span>
                    <select
                        value={part.links[one.key] ?? ""}
                        onChange={(event) => link(one.key, event.target.value, one.quantity)}
                    >
                        <option value="">None</option>
                        {part.links[one.key] && !channels.some((channel) => channel.name === part.links[one.key]) && (
                            <option value={part.links[one.key]}>{part.links[one.key]} (not in this test)</option>
                        )}
                        {sorted.map((channel) => (
                            <option key={channel.name} value={channel.name}>
                                {channel.unit ? `${channel.name} (${channel.unit})` : channel.name}
                            </option>
                        ))}
                    </select>
                </label>
            ))}
            <p>
                <button type="button" className="button-danger" onClick={() => onDelete(id)}>
                    Delete {part.name}
                </button>
            </p>
        </section>
    );
}
