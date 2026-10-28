import { useEffect, useState, type ReactNode } from "react";
import { formatValue } from "../../scale";
import { STANDARD_SIM_UNITS, type Document, type Line, type Part, type SimUnits } from "../drawing";
import { Row } from "../fields";
import type { EditorStore } from "../store";
import type { TestDetail } from "../testdata";
import type { Catalog, Link, ModelPart, Quantity, Role, Setting } from "./api";
import {
    kindOfType,
    linkRole,
    NOT_SIMULATED,
    readChoices,
    ROLE_NAMES,
    roleChoices,
    shownLinks,
    shownSettings,
    withDefaults,
    type Built,
    type LinkUse,
    type SimRole,
} from "./model";
import { partOf, withLineSim, withModelSetting, withPartSim } from "./settings";
import { fromDisplay, toDisplay, unitOf, ATMOSPHERE } from "./units";

// The inspector's Simulation section, in Simulation mode: what the part or line selected is in the model, its settings
// there (in the diagram's units; the knobs to tune are marked), and the test's channels it's linked to, which the P&ID
// names (a valve's own, a transducer's where it taps). Changes go into the drawing, undone and saved as any change is.

/** What Simulation mode's inspector needs: the model's parts, the model built from the P&ID, and the test. */
export interface SimContext {
    catalog: Catalog;
    built: Built;
    test: TestDetail | null;
}

const ROLES: Record<Role, string> = {
    boundary: "it follows",
    start: "starts it, compared",
    sensor: "compared",
    command: "drives it",
};

/** A number in the diagram's units, edited as text and kept (in SI) when you leave the box or press Enter; cleared,
 * back to what it'd be if it weren't set. */
function NumberField({
    label,
    si,
    quantity,
    units,
    tunable,
    help,
    note,
    onCommit,
}: {
    label: string;
    si: number;
    quantity: Quantity;
    units: SimUnits;
    tunable: boolean;
    help: string;
    note: string | null; // a linked channel sets it instead: how
    onCommit: (si: number | undefined) => void;
}) {
    const shown = formatValue(Number(toDisplay(quantity, si, units).toPrecision(6)));
    const [text, setText] = useState(shown);
    useEffect(() => setText(shown), [shown]);
    const commit = () => {
        const value = Number(text.trim());
        if (text.trim() === "") {
            onCommit(undefined);
        } else if (!Number.isFinite(value)) {
            setText(shown);
        } else if (value !== Number(shown)) {
            onCommit(fromDisplay(quantity, value, units));
        }
    };
    const unit = unitOf(quantity, units);
    return (
        <Row label={label}>
            {(id) =>
                note ? (
                    <span className="piper-sim-linked" title={help || undefined}>
                        {note}
                    </span>
                ) : (
                    <>
                        <input
                            id={id}
                            inputMode="decimal"
                            title={help || undefined}
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            onBlur={commit}
                            onKeyDown={(event) => event.key === "Enter" && commit()}
                        />
                        {unit && <span className="muted piper-sim-unit">{unit}</span>}
                        {tunable && (
                            <span className="piper-sim-tune" title="A knob to tune the model with">
                                tune
                            </span>
                        )}
                    </>
                )
            }
        </Row>
    );
}

function Box({ children }: { children: ReactNode }) {
    return (
        <section className="piper-sim-section" aria-label="Simulation settings">
            <h3 className="piper-subhead">Simulation</h3>
            {children}
        </section>
    );
}

/** A model's part's settings, and the channels it's linked to: as the P&ID keeps them (on the part, or a point's
 * lines). */
function ModelSettings({
    store,
    sim,
    model,
    hidden,
}: {
    store: EditorStore;
    sim: SimContext;
    model: ModelPart;
    hidden: ReadonlySet<string>; // settings the P&ID decides (a gas vessel's wall)
}) {
    const { catalog, built } = sim;
    const kind = kindOfType(catalog, model.type);
    if (!kind) {
        return null;
    }
    const units = built.model.display;
    const settings = withDefaults(kind, model.settings);
    const links = shownLinks(kind, model.settings);
    const set = (key: string, value: number | string | undefined) =>
        store.commitDocument(withModelSetting(store.getState().document, built, model.id, key, value));
    const linkOf = (key: string) => built.links.find((one) => one.model === model.id && one.key === key);
    const nameOfPart = (id: string) => {
        const part = store
            .getState()
            .document.pages.flatMap((page) => page.parts)
            .find((one) => one.id === id);
        return part?.tag || "a part";
    };

    /** How a linked channel sets a setting of the same name, if one does. */
    function linkedNote(key: string): string | null {
        const link = links.find((one) => one.key === key);
        const channel = link && model.links[link.key];
        if (!link || !channel) {
            return null;
        }
        const role = linkRole(link, settings);
        return role === "boundary" ? `Follows ${channel}` : role === "start" ? `${channel} at the run's start` : null;
    }

    const field = (setting: Setting) => {
        const value = settings[setting.key] ?? setting.default;
        if (setting.quantity === "choice") {
            const fixed = model.type === "tank" && setting.key === "mode" && gasReaches(sim, model.id);
            return (
                <Row key={setting.key} label={setting.label}>
                    {(id) =>
                        fixed ? (
                            <span className="piper-sim-linked">A gas ullage: gas lines reach it</span>
                        ) : (
                            <select
                                id={id}
                                title={setting.help || undefined}
                                value={String(value)}
                                onChange={(event) => set(setting.key, event.target.value)}
                            >
                                {setting.choices.map((choice, index) => (
                                    <option key={choice} value={choice}>
                                        {setting.choice_labels[index] ?? choice}
                                    </option>
                                ))}
                            </select>
                        )
                    }
                </Row>
            );
        }
        return (
            <NumberField
                key={setting.key}
                label={setting.label}
                si={Number(value)}
                quantity={setting.quantity}
                units={units}
                tunable={setting.tunable}
                help={setting.help}
                note={linkedNote(setting.key)}
                onCommit={(si) => set(setting.key, si)}
            />
        );
    };

    return (
        <>
            {shownSettings(kind, model.settings)
                .filter((setting) => !hidden.has(setting.key))
                .map(field)}
            {links.length > 0 && <p className="piper-sim-label">Linked to the test</p>}
            {links.map((link: Link) => {
                const used = linkOf(link.key);
                const channel = used ?? built.left.find((one) => one.model === model.id && one.key === link.key);
                // Whose channel it is, where that isn't said already: another part's, named other than it.
                const whose =
                    channel &&
                    channel.from !== built.origins.get(model.id)?.part &&
                    nameOfPart(channel.from) !== channel.channel
                        ? `, ${nameOfPart(channel.from)}'s`
                        : "";
                return (
                    <div key={link.key} className="piper-sim-link">
                        <span className="piper-sim-link-label">{link.label}</span>
                        {channel ? (
                            <UseChannel
                                store={store}
                                use={channel}
                                on={used !== undefined}
                                what={
                                    used
                                        ? `${ROLES[linkRole(link, settings)]}${whose}`
                                        : `left out${whose}: its value's set here instead`
                                }
                            />
                        ) : (
                            <span className="muted">none</span>
                        )}
                    </div>
                );
            })}
        </>
    );
}

/** A part's channel in the model, checked; unchecked, left out, and what it would set is the settings' instead: your
 * own conditions. It's kept on the part whose channel it is (a valve, an instrument), as `sim.unlinked`. */
function UseChannel({ store, use, on, what }: { store: EditorStore; use: LinkUse; on: boolean; what: string }) {
    const set = (yes: boolean) =>
        store.commitDocument(
            withPartSim(store.getState().document, use.from, (now) =>
                yes ? { as: now.as, settings: now.settings } : { ...now, unlinked: true },
            ),
        );
    return (
        <label
            className="check piper-sim-use"
            title={on ? "Uncheck to leave it out of the model, and set its value yourself" : "Check to use the test's"}
        >
            <input type="checkbox" checked={on} onChange={(event) => set(event.target.checked)} />
            <span>
                <strong>{use.channel}</strong> <span className="muted">({what})</span>
            </span>
        </label>
    );
}

/** Whether gas lines reach a model's node: then a tank's under a gas ullage. */
function gasReaches(sim: SimContext, node: string): boolean {
    return sim.built.model.edges.some(
        (edge) =>
            (edge.source === node || edge.target === node) &&
            (edge.type === "gas_valve" || edge.type === "gas_orifice" || edge.type === "regulator"),
    );
}

/** What a part's role is, in a sentence for the inspector: where it is in the model. */
function whereText(sim: SimContext, role: SimRole, ids: string[]): string {
    const model = sim.built.model;
    const edge = model.edges.find((one) => one.id === ids[0]);
    if (edge) {
        const from = partOf(model, edge.source)?.name ?? edge.source;
        const to = partOf(model, edge.target)?.name ?? edge.target;
        const label = kindOfType(sim.catalog, edge.type)?.label.toLowerCase() ?? edge.type;
        return `In the model: a ${label}, from ${from} to ${to}.`;
    }
    if (role === "outlet" && ids.length > 1) {
        const names = ids.map((id) => partOf(model, id)?.name ?? id);
        return `In the model: an outlet for each of its inlets, ${names.join(" and ")}, at one pressure.`;
    }
    if (ids.length === 0) {
        return role === "through"
            ? "In the model: a plain connection. Its ports are one point, with no loss."
            : role === "none"
              ? "Not in the model: the lines at it end there."
              : "Not in the model yet: see the Simulation panel for why.";
    }
    const node = partOf(model, ids[0]!);
    const label = node ? (kindOfType(sim.catalog, node.type)?.label.toLowerCase() ?? node.type) : "";
    return `In the model: a ${label}.`;
}

/** What a part is in the model, where it could be more than one thing. */
function RoleChoice({ choices, role, onRole }: { choices: SimRole[]; role: SimRole; onRole: (role: SimRole) => void }) {
    if (choices.length < 2) {
        return null;
    }
    return (
        <Row label="In the model">
            {(id) => (
                <select id={id} value={role} onChange={(event) => onRole(event.target.value as SimRole)}>
                    {choices.map((choice) => (
                        <option key={choice} value={choice}>
                            {ROLE_NAMES[choice]}
                        </option>
                    ))}
                </select>
            )}
        </Row>
    );
}

/** A part's simulation: what it is in the model, its settings there, and what it's linked to. */
export function PartSimSection({ store, sim, part }: { store: EditorStore; sim: SimContext; part: Part }) {
    const document = store.getState().document;
    const fluids = { ...store.getState().drawing, fluids: document.fluids };
    const placed = sim.built.placed.get(part.id);
    const choices = roleChoices(part, fluids);
    const role = placed?.role ?? choices[0]!;
    const setRole = (as: string) =>
        store.commitDocument(withPartSim(store.getState().document, part.id, (now) => ({ ...now, as })));
    if (role === "sensor") {
        return <SensorSection store={store} sim={sim} part={part} />;
    }
    if (role === "meter") {
        const edge = partOf(sim.built.model, placed?.ids[0] ?? "");
        const used = sim.built.links.find((one) => one.from === part.id);
        const channel = used ?? sim.built.left.find((one) => one.from === part.id);
        return (
            <Box>
                <RoleChoice choices={choices} role={role} onRole={setRole} />
                <p className="piper-small">
                    {edge ? (
                        `Reads the flow through ${edge.name}, with no loss of its own.`
                    ) : (
                        <span className="muted">Not compared: the Simulation panel says why.</span>
                    )}
                </p>
                {edge && channel && (
                    <UseChannel
                        store={store}
                        use={channel}
                        on={used !== undefined}
                        what={used ? "compared" : "left out of the model"}
                    />
                )}
                {edge && !channel && <p className="muted piper-small">Compared once the test has its channel.</p>}
            </Box>
        );
    }
    const model = partOf(sim.built.model, placed?.ids[0] ?? "");
    const hidden = new Set(
        model?.type === "gas_junction" ? ["wall"] : model?.type === "gas_valve" && role === "check" ? ["check"] : [],
    );
    if (choices.length === 1 && choices[0] === "none" && !NOT_SIMULATED.has(part.kind)) {
        return null; // a note, a picture: nothing of it's in a model
    }
    return (
        <Box>
            <RoleChoice choices={choices} role={role} onRole={setRole} />
            <p className="muted piper-small">{whereText(sim, role, placed?.ids ?? [])}</p>
            {model && <ModelSettings store={store} sim={sim} model={model} hidden={hidden} />}
        </Box>
    );
}

/** An instrument's simulation: what it reads in the model, where it taps, and what it does there. */
function SensorSection({ store, sim, part }: { store: EditorStore; sim: SimContext; part: Part }) {
    const placed = sim.built.placed.get(part.id);
    const model = sim.built.model;
    const node = partOf(model, placed?.ids[0] ?? "");
    const kind = node ? kindOfType(sim.catalog, node.type) : undefined;
    const link = kind?.links.find((one) => one.key === placed?.reads);
    const used = sim.built.links.find((one) => one.from === part.id);
    const channel = used ?? sim.built.left.find((one) => one.from === part.id);
    const choices = readChoices(sim.built, sim.catalog, part.id);
    const where = (placed?.ids ?? []).map((id) => partOf(model, id)?.name ?? id).join(" and ");
    return (
        <Box>
            {!node || !link || !kind ? (
                <p className="muted piper-small">
                    Not compared: the model has nothing it measures where it taps. The Simulation panel says why.
                </p>
            ) : (
                <>
                    <p className="piper-small">
                        Reads {where}&apos;s {link.label.toLowerCase()}.
                    </p>
                    {channel ? (
                        <UseChannel
                            store={store}
                            use={channel}
                            on={used !== undefined}
                            what={
                                used
                                    ? ROLES[linkRole(link, withDefaults(kind, node.settings))]
                                    : `left out: ${where}'s value is set there instead`
                            }
                        />
                    ) : (
                        <p className="muted piper-small">In the model once the test has its channel.</p>
                    )}
                    {choices.length > 1 && (
                        <Row label="Reads">
                            {(id) => (
                                <select
                                    id={id}
                                    value={placed?.reads ?? ""}
                                    onChange={(event) =>
                                        store.commitDocument(
                                            withPartSim(store.getState().document, part.id, (now) => ({
                                                ...now,
                                                as: event.target.value,
                                            })),
                                        )
                                    }
                                >
                                    {choices.map((one) => (
                                        <option key={one.key} value={one.key}>
                                            {one.label}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </Row>
                    )}
                </>
            )}
        </Box>
    );
}

/** A line's simulation: a liquid line modeled as a line, or not; and the point it's in, with a gas point's settings. */
export function LineSimSection({ store, sim, line }: { store: EditorStore; sim: SimContext; line: Line }) {
    const placed = sim.built.placed.get(line.id);
    const model = partOf(sim.built.model, placed?.ids[0] ?? "");
    const modeled = placed?.role === "line";
    const gas = placed?.phase === "gas";
    const document = store.getState().document;
    const setModeled = (on: boolean) =>
        store.commitDocument(withLineSim(document, [line.id], (now) => ({ ...now, line: on ? {} : null })));
    const point = !modeled && model && (model.type === "junction" || model.type === "gas_junction");
    const owner = !modeled && model && !point ? model.name : null;
    return (
        <Box>
            {!gas && (
                <label className="check piper-small">
                    <input type="checkbox" checked={modeled} onChange={(event) => setModeled(event.target.checked)} />
                    Model it as a line: its friction, and its liquid&apos;s inertia
                </label>
            )}
            {modeled ? (
                model ? (
                    <ModelSettings store={store} sim={sim} model={model} hidden={new Set()} />
                ) : (
                    <p className="muted piper-small">Not in the model yet: see the Simulation panel for why.</p>
                )
            ) : point ? (
                <>
                    <p className="muted piper-small">
                        Part of the point <strong>{model.name}</strong>
                        {gas
                            ? ": gas tubing, whose settings each of its lines keeps."
                            : ", one pressure where the lines and tees join."}
                    </p>
                    {gas && <ModelSettings store={store} sim={sim} model={model} hidden={new Set(["wall"])} />}
                </>
            ) : owner ? (
                <p className="muted piper-small">Part of {owner}, in the model.</p>
            ) : (
                <p className="muted piper-small">Not in the model: nothing flows from it to another part.</p>
            )}
        </Box>
    );
}

/** The diagram's simulation: the units it's shown in, and how a test's channels without them are read. */
export function DiagramSimSection({ store, document }: { store: EditorStore; document: Document }) {
    const units = document.sim ?? STANDARD_SIM_UNITS;
    const set = (change: Partial<SimUnits>) =>
        store.commitDocument({ ...store.getState().document, sim: { ...units, ...change } });
    return (
        <Box>
            <Row label="Units">
                {(id) => (
                    <select
                        id={id}
                        value={units.units}
                        onChange={(event) => set({ units: event.target.value as SimUnits["units"] })}
                    >
                        <option value="us">US: psi, °F, in, lbm/s</option>
                        <option value="si">SI: bar, K, mm, kg/s</option>
                    </select>
                )}
            </Row>
            <Row label="Pressures">
                {(id) => (
                    <select
                        id={id}
                        value={units.gauge ? "gauge" : "absolute"}
                        title="And how a channel in psi or bar, without g or a, is read"
                        onChange={(event) => set({ gauge: event.target.value === "gauge" })}
                    >
                        <option value="gauge">Gauge: above the atmosphere</option>
                        <option value="absolute">Absolute</option>
                    </select>
                )}
            </Row>
            {units.gauge && (
                <NumberField
                    label="The atmosphere"
                    si={units.ambient}
                    quantity="pressure_abs"
                    units={units}
                    tunable={false}
                    help="What gauge pressures are above: at sea level, 14.696 psia"
                    note={null}
                    onCommit={(si) => set({ ambient: si ?? ATMOSPHERE })}
                />
            )}
            <p className="muted piper-small">
                Channels without units are read in these. Each part&apos;s settings show when it&apos;s selected.
            </p>
        </Box>
    );
}
