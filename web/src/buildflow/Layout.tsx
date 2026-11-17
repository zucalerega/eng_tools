import { useEffect, useState, type KeyboardEvent } from "react";
import { Dialog, Notice } from "../components";
import { Link } from "../router";
import {
    buildflow,
    PHASE_NAMES,
    PHASES,
    type Component,
    type Milestone,
    type Phase,
    type ProgramDetail,
    type Section,
} from "./api";
import { Vehicle } from "./VehicleView";
import { inPhase } from "./vehicle";

// A program's layout (/buildflow/programs/{id}/layout, admins'): its name, its vehicle's drawing (sections from the aft
// end to the nose, and the components dragged onto it), its subsystems and components, and its milestones. The name,
// the description, and the drawing's sections are changed, then saved together, with the bar that says what isn't saved
// yet; everything else is saved as it's changed.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const SECTION_KINDS: { value: Section["kind"]; name: string }[] = [
    { value: "engine", name: "Engine" },
    { value: "body", name: "Body tube" },
    { value: "tank", name: "Tank" },
    { value: "coupler", name: "Coupler" },
    { value: "transition", name: "Transition" },
    { value: "nose", name: "Nose cone" },
];

const NEW_SECTION: Section = { kind: "body", length: 20, diameter: 8, label: "", count: 1, fins: false, legs: false };

/** What's changed on the page, to save together: the name, the description, and the drawing. */
interface Draft {
    name: string;
    description: string;
    sections: Section[];
    stand: boolean;
}

type ProgramChange = Parameters<typeof buildflow.changeProgram>[1];

const draftOf = (program: ProgramDetail): Draft => ({
    name: program.name,
    description: program.description,
    sections: program.profile.sections,
    stand: program.profile.stand,
});

const drawing = (sections: Section[], stand: boolean) => JSON.stringify({ sections, stand });

/** What of the draft isn't saved yet, as the change that saves it: only what's changed. */
function changeOf(draft: Draft, program: ProgramDetail): ProgramChange {
    const change: ProgramChange = {};
    if (draft.name.trim() !== program.name) {
        change.name = draft.name.trim();
    }
    if (draft.description.trim() !== program.description) {
        change.description = draft.description.trim();
    }
    if (drawing(draft.sections, draft.stand) !== drawing(program.profile.sections, program.profile.stand)) {
        change.profile = { sections: draft.sections, stand: draft.stand };
    }
    return change;
}

const UNSAVED: Record<keyof ProgramChange, string> = {
    name: "the name",
    description: "the description",
    profile: "the drawing",
    position: "its place in the list",
};

/** Things in words: "the name", "the name and the drawing", "the name, the description, and the drawing". */
const listed = (items: string[]) =>
    items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

export function LayoutPage({ id }: { id: number }) {
    const [program, setProgram] = useState<ProgramDetail | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [placing, setPlacing] = useState<Component | null>(null);
    const [archiving, setArchiving] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveProblem, setSaveProblem] = useState<string | null>(null);

    // What's being changed stays as it is while the rest of the page is saved and shown again.
    const load = () =>
        buildflow.program(id).then(
            (loaded) => {
                setProgram(loaded);
                setDraft((now) => now ?? draftOf(loaded));
            },
            (error: unknown) => setProblem(message(error)),
        );
    useEffect(() => {
        setDraft(null);
        void load();
    }, [id]);

    const change = program && draft ? changeOf(draft, program) : {};
    const unsaved = (Object.keys(change) as (keyof ProgramChange)[]).map((key) => UNSAVED[key]);
    const dirty = unsaved.length > 0;

    // Leaving with changes not saved yet: the browser asks first.
    useEffect(() => {
        if (!dirty) {
            return;
        }
        const leaving = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", leaving);
        return () => window.removeEventListener("beforeunload", leaving);
    }, [dirty]);

    /** Make a change, then show the program as it is after it: whether it worked (if not, the page says why). */
    async function run(action: () => Promise<unknown>): Promise<boolean> {
        setProblem(null);
        try {
            await action();
            await load();
            return true;
        } catch (error) {
            setProblem(message(error));
            await load();
            return false;
        }
    }

    /** Save what's changed in the draft, all at once, and start again from what's saved. */
    async function save() {
        if (!dirty || saving || !draft?.name.trim()) {
            return;
        }
        setSaving(true);
        setSaveProblem(null);
        try {
            await buildflow.changeProgram(id, change);
            const saved = await buildflow.program(id);
            setProgram(saved);
            setDraft(draftOf(saved));
        } catch (error) {
            setSaveProblem(message(error));
        } finally {
            setSaving(false);
        }
    }

    if (!program || !draft) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    if (!program.can_edit) {
        return (
            <Notice tone="error">
                Only admins lay programs out. <Link to={`/buildflow/programs/${id}`}>Back to {program.name}</Link>
            </Notice>
        );
    }
    const archived = program.archived_at !== null;
    const unplaced = program.components.filter((c) => c.x === null || c.y === null);
    const edit = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
    return (
        <section className="bf-layout">
            <div className="page-head">
                <div className="page-title">
                    <nav className="breadcrumbs" aria-label="Programs">
                        <Link to="/buildflow">Programs</Link>
                        <span className="separator">/</span>
                        <Link to={`/buildflow/programs/${id}`}>{program.name}</Link>
                    </nav>
                    <h1>Layout</h1>
                </div>
                <div className="page-actions">
                    {archived ? (
                        <button type="button" onClick={() => void run(() => buildflow.restore(id))}>
                            Bring it back
                        </button>
                    ) : (
                        <button type="button" onClick={() => setArchiving(true)}>
                            Archive…
                        </button>
                    )}
                </div>
            </div>
            {archived && (
                <Notice tone="warning">{program.name} is archived: bring it back to change it, or its progress.</Notice>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}

            <About draft={draft} disabled={archived} onChange={edit} onSave={() => void save()} />

            <h2>The vehicle</h2>
            <p className="muted bf-small">
                Drag a component&apos;s dot to move it. One that isn&apos;t on the drawing goes on it with{" "}
                <em>Place</em>, then a click where it goes.
            </p>
            <div className="bf-stage bf-stage-layout">
                <div className="bf-stage-drawing">
                    <Vehicle
                        profile={program.profile}
                        components={program.components}
                        milestones={inPhase(program.milestones, "design")}
                        selected={placing?.id ?? null}
                        onSelect={() => undefined}
                        label={program.name}
                        arranging={!archived}
                        sections
                        onMove={(component, x, y) => void run(() => buildflow.changeComponent(component.id, { x, y }))}
                        placing={placing}
                        onPlace={(x, y) => {
                            const component = placing;
                            setPlacing(null);
                            if (component) {
                                void run(() => buildflow.changeComponent(component.id, { x, y }));
                            }
                        }}
                    />
                </div>
            </div>
            {placing && (
                <Notice>
                    Click on the drawing where {placing.name} goes.{" "}
                    <button type="button" className="button-small" onClick={() => setPlacing(null)}>
                        Cancel
                    </button>
                </Notice>
            )}
            {unplaced.length > 0 && (
                <div className="bf-unplaced">
                    <span className="muted">Not on the drawing:</span>
                    {unplaced.map((component) => (
                        <button
                            key={component.id}
                            type="button"
                            className="button-small"
                            disabled={archived}
                            onClick={() => setPlacing(component)}
                        >
                            Place {component.name}
                        </button>
                    ))}
                </div>
            )}
            <Sections
                sections={draft.sections}
                stand={draft.stand}
                changed={change.profile !== undefined}
                disabled={archived}
                onChange={edit}
            />

            <h2>Subsystems and components</h2>
            <Structure program={program} disabled={archived} run={run} />

            <h2>Milestones</h2>
            <p className="muted bf-small">
                The steps every component goes through, in each phase. One with progress or links kept on it can be
                renamed or moved, not deleted.
            </p>
            <div className="bf-milestone-columns">
                {PHASES.map((phase) => (
                    <Milestones key={phase} program={program} phase={phase} disabled={archived} run={run} />
                ))}
            </div>
            {dirty && (
                <section className="bf-save-bar" aria-label="Changes not saved yet">
                    <span>Not saved yet: {listed(unsaved)}.</span>
                    {(saveProblem || !draft.name.trim()) && (
                        <span className="bf-save-problem" role="alert">
                            {saveProblem ?? "A program needs a name."}
                        </span>
                    )}
                    <span className="bf-grow" />
                    <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                            setDraft(draftOf(program));
                            setSaveProblem(null);
                        }}
                    >
                        Undo changes
                    </button>
                    <button
                        type="button"
                        className="button-primary"
                        disabled={saving || !draft.name.trim()}
                        onClick={() => void save()}
                    >
                        {saving ? "Saving…" : "Save"}
                    </button>
                </section>
            )}
            {archiving && (
                <Dialog
                    title={`Archive ${program.name}?`}
                    confirm="Archive"
                    onConfirm={() => {
                        setArchiving(false);
                        void run(() => buildflow.archive(id));
                    }}
                    onCancel={() => setArchiving(false)}
                >
                    <p>
                        It goes off the list of programs, kept as it is, with all its progress: for a vehicle
                        that&apos;s flown, or that the team has set aside. You can bring it back from the archived
                        programs.
                    </p>
                </Dialog>
            )}
        </section>
    );
}

type Run = (action: () => Promise<unknown>) => Promise<boolean>;

/** The name and the description, saved with the page's other changes (Enter saves them all). */
function About({
    draft,
    disabled,
    onChange,
    onSave,
}: {
    draft: Draft;
    disabled: boolean;
    onChange: (patch: Partial<Draft>) => void;
    onSave: () => void;
}) {
    const enter = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            onSave();
        }
    };
    return (
        <div className="bf-about">
            <label className="field">
                Name
                <input
                    value={draft.name}
                    maxLength={100}
                    disabled={disabled}
                    onChange={(event) => onChange({ name: event.target.value })}
                    onKeyDown={enter}
                />
            </label>
            <label className="field bf-grow">
                Description
                <input
                    value={draft.description}
                    disabled={disabled}
                    onChange={(event) => onChange({ description: event.target.value })}
                    onKeyDown={enter}
                />
            </label>
        </div>
    );
}

/** A number typed in: what's typed stays as typed (cleared, say, to type another), taken each time it's a number in
 * range, and shown as what was taken once it's left. */
function NumberField({
    value,
    label,
    min,
    max,
    whole = false,
    disabled,
    onChange,
}: {
    value: number;
    label: string;
    min: number;
    max?: number;
    whole?: boolean;
    disabled: boolean;
    onChange: (value: number) => void;
}) {
    const [text, setText] = useState(String(value));
    useEffect(() => {
        if (Number(text) !== value) {
            setText(String(value)); // changed from outside it: undone, or saved
        }
    }, [value]);
    return (
        <input
            type="number"
            className="bf-number"
            aria-label={label}
            value={text}
            min={min}
            max={max}
            step={whole ? 1 : "any"}
            disabled={disabled}
            onChange={(event) => {
                setText(event.target.value);
                const typed = Number(event.target.value);
                const fits = event.target.value.trim() !== "" && Number.isFinite(typed) && typed >= min;
                if (fits && (max === undefined || typed <= max) && (!whole || Number.isInteger(typed))) {
                    onChange(typed);
                }
            }}
            onBlur={() => setText(String(value))}
        />
    );
}

/** The drawing's sections, aft to nose, changed together and saved with the page's other changes. */
function Sections({
    sections,
    stand,
    changed,
    disabled,
    onChange,
}: {
    sections: Section[];
    stand: boolean;
    changed: boolean;
    disabled: boolean;
    onChange: (patch: Partial<Draft>) => void;
}) {
    const change = (index: number, patch: Partial<Section>) =>
        onChange({ sections: sections.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
    const move = (index: number, by: number) => {
        const next = [...sections];
        const [taken] = next.splice(index, 1);
        next.splice(index + by, 0, taken!);
        onChange({ sections: next });
    };
    return (
        <div className="bf-sections">
            <table className="table bf-sections-table" aria-label="Sections, aft to nose">
                <thead>
                    <tr>
                        <th>Section</th>
                        <th>Name</th>
                        <th>Length</th>
                        <th>Diameter</th>
                        <th>Nozzles</th>
                        <th>Fins</th>
                        <th>Legs</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {sections.map((section, index) => (
                        <tr key={index}>
                            <td>
                                <select
                                    aria-label={`Section ${index + 1}: kind`}
                                    value={section.kind}
                                    disabled={disabled}
                                    onChange={(event) => change(index, { kind: event.target.value as Section["kind"] })}
                                >
                                    {SECTION_KINDS.map((kind) => (
                                        <option key={kind.value} value={kind.value}>
                                            {kind.name}
                                        </option>
                                    ))}
                                </select>
                            </td>
                            <td>
                                <input
                                    aria-label={`Section ${index + 1}: name`}
                                    value={section.label}
                                    maxLength={200}
                                    disabled={disabled}
                                    onChange={(event) => change(index, { label: event.target.value })}
                                />
                            </td>
                            <td>
                                <NumberField
                                    label={`Section ${index + 1}: length`}
                                    value={section.length}
                                    min={0.01}
                                    disabled={disabled}
                                    onChange={(length) => change(index, { length })}
                                />
                            </td>
                            <td>
                                <NumberField
                                    label={`Section ${index + 1}: diameter`}
                                    value={section.diameter}
                                    min={0.01}
                                    disabled={disabled}
                                    onChange={(diameter) => change(index, { diameter })}
                                />
                            </td>
                            <td>
                                {section.kind === "engine" && (
                                    <NumberField
                                        label={`Section ${index + 1}: nozzles`}
                                        value={section.count}
                                        min={1}
                                        max={9}
                                        whole
                                        disabled={disabled}
                                        onChange={(count) => change(index, { count })}
                                    />
                                )}
                            </td>
                            <td>
                                <input
                                    type="checkbox"
                                    aria-label={`Section ${index + 1}: fins`}
                                    checked={section.fins}
                                    disabled={disabled}
                                    onChange={(event) => change(index, { fins: event.target.checked })}
                                />
                            </td>
                            <td>
                                <input
                                    type="checkbox"
                                    aria-label={`Section ${index + 1}: legs`}
                                    checked={section.legs}
                                    disabled={disabled}
                                    onChange={(event) => change(index, { legs: event.target.checked })}
                                />
                            </td>
                            <td className="bf-row-actions">
                                <button
                                    type="button"
                                    className="button-small"
                                    aria-label={`Move section ${index + 1} aft`}
                                    disabled={disabled || index === 0}
                                    onClick={() => move(index, -1)}
                                >
                                    ←
                                </button>
                                <button
                                    type="button"
                                    className="button-small"
                                    aria-label={`Move section ${index + 1} forward`}
                                    disabled={disabled || index === sections.length - 1}
                                    onClick={() => move(index, 1)}
                                >
                                    →
                                </button>
                                <button
                                    type="button"
                                    className="button-small"
                                    aria-label={`Delete section ${index + 1}`}
                                    disabled={disabled}
                                    onClick={() => onChange({ sections: sections.filter((_, i) => i !== index) })}
                                >
                                    ✕
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="bf-sections-actions">
                <button
                    type="button"
                    className="button-small"
                    disabled={disabled}
                    onClick={() =>
                        onChange({
                            sections: [...sections, { ...NEW_SECTION, diameter: sections.at(-1)?.diameter ?? 8 }],
                        })
                    }
                >
                    + Add a section
                </button>
                <label className="check">
                    <input
                        type="checkbox"
                        checked={stand}
                        disabled={disabled}
                        onChange={(event) => onChange({ stand: event.target.checked })}
                    />
                    On a test stand
                </label>
            </div>
            {changed && (
                <div className="bf-stage bf-preview" aria-label="The drawing, as it'll be saved">
                    <div className="bf-stage-drawing">
                        <Vehicle
                            profile={{ sections, stand }}
                            components={[]}
                            milestones={[]}
                            selected={null}
                            onSelect={() => undefined}
                            label="The drawing as it'll be saved"
                            sections
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

/** A name that's changed where it is, saved when it's left (or on Enter). */
function Inline({
    value,
    label,
    disabled,
    onSave,
}: {
    value: string;
    label: string;
    disabled: boolean;
    onSave: (value: string) => Promise<boolean>;
}) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <input
            className="bf-inline"
            aria-label={label}
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => {
                if (text.trim() && text.trim() !== value) {
                    void onSave(text.trim()).then((saved) => !saved && setText(value));
                } else {
                    setText(value);
                }
            }}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.currentTarget.blur();
                }
            }}
        />
    );
}

function Structure({ program, disabled, run }: { program: ProgramDetail; disabled: boolean; run: Run }) {
    const [subsystemName, setSubsystemName] = useState("");
    const [componentName, setComponentName] = useState("");
    const [into, setInto] = useState<number | "">("");
    const [bought, setBought] = useState(false);
    const subsystems = program.subsystems;
    const target = into === "" ? subsystems[0]?.id : into;
    return (
        <div className="bf-structure">
            {subsystems.map((subsystem, index) => {
                const inside = program.components.filter((c) => c.subsystem_id === subsystem.id);
                return (
                    <section key={subsystem.id} className="bf-structure-group" aria-label={subsystem.name}>
                        <div className="bf-structure-head">
                            <Inline
                                value={subsystem.name}
                                label={`Subsystem ${subsystem.name}: name`}
                                disabled={disabled}
                                onSave={(name) => run(() => buildflow.changeSubsystem(subsystem.id, { name }))}
                            />
                            <span className="bf-row-actions">
                                <button
                                    type="button"
                                    className="button-small"
                                    aria-label={`Move ${subsystem.name} up`}
                                    disabled={disabled || index === 0}
                                    onClick={() =>
                                        void run(() => buildflow.changeSubsystem(subsystem.id, { position: index - 1 }))
                                    }
                                >
                                    ↑
                                </button>
                                <button
                                    type="button"
                                    className="button-small"
                                    aria-label={`Move ${subsystem.name} down`}
                                    disabled={disabled || index === subsystems.length - 1}
                                    onClick={() =>
                                        void run(() => buildflow.changeSubsystem(subsystem.id, { position: index + 1 }))
                                    }
                                >
                                    ↓
                                </button>
                                <button
                                    type="button"
                                    className="button-small"
                                    disabled={disabled}
                                    onClick={() => void run(() => buildflow.removeSubsystem(subsystem.id))}
                                >
                                    Delete
                                </button>
                            </span>
                        </div>
                        {inside.length === 0 && <p className="muted bf-small">No components in it.</p>}
                        <ul className="plain bf-structure-list">
                            {inside.map((component, place) => (
                                <ComponentRow
                                    key={component.id}
                                    component={component}
                                    place={place}
                                    count={inside.length}
                                    program={program}
                                    disabled={disabled}
                                    run={run}
                                />
                            ))}
                        </ul>
                    </section>
                );
            })}
            <form
                className="inline-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (target !== undefined && componentName.trim()) {
                        void run(() =>
                            buildflow.addComponent(program.id, {
                                subsystem_id: target,
                                name: componentName.trim(),
                                bought,
                            }),
                        ).then((added) => added && setComponentName(""));
                    }
                }}
            >
                <label className="field">
                    New component
                    <input
                        value={componentName}
                        maxLength={200}
                        disabled={disabled || subsystems.length === 0}
                        placeholder={subsystems.length === 0 ? "Add a subsystem first" : "Main fuel valve"}
                        onChange={(event) => setComponentName(event.target.value)}
                    />
                </label>
                <label className="field">
                    In
                    <select
                        value={target ?? ""}
                        disabled={disabled || subsystems.length === 0}
                        onChange={(event) => setInto(Number(event.target.value))}
                    >
                        {subsystems.map((subsystem) => (
                            <option key={subsystem.id} value={subsystem.id}>
                                {subsystem.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="check">
                    <input type="checkbox" checked={bought} onChange={(event) => setBought(event.target.checked)} />
                    Off the shelf
                </label>
                <button type="submit" disabled={disabled || !componentName.trim() || target === undefined}>
                    Add
                </button>
            </form>
            <form
                className="inline-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (subsystemName.trim()) {
                        void run(() => buildflow.addSubsystem(program.id, subsystemName.trim())).then(
                            (added) => added && setSubsystemName(""),
                        );
                    }
                }}
            >
                <label className="field">
                    New subsystem
                    <input
                        value={subsystemName}
                        maxLength={100}
                        disabled={disabled}
                        placeholder="Recovery"
                        onChange={(event) => setSubsystemName(event.target.value)}
                    />
                </label>
                <button type="submit" disabled={disabled || !subsystemName.trim()}>
                    Add
                </button>
            </form>
            {program.removed.length > 0 && (
                <div className="bf-removed">
                    <h3>Removed</h3>
                    <ul className="plain">
                        {program.removed.map((component) => (
                            <li key={component.id}>
                                {component.name}
                                <button
                                    type="button"
                                    className="button-small"
                                    disabled={disabled}
                                    onClick={() => void run(() => buildflow.restoreComponent(component.id))}
                                >
                                    Bring back
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function ComponentRow({
    component,
    place,
    count,
    program,
    disabled,
    run,
}: {
    component: Component;
    place: number;
    count: number;
    program: ProgramDetail;
    disabled: boolean;
    run: Run;
}) {
    const change = (patch: Parameters<typeof buildflow.changeComponent>[1]) =>
        run(() => buildflow.changeComponent(component.id, patch));
    return (
        <li className="bf-structure-row">
            <Inline
                value={component.name}
                label={`${component.name}: name`}
                disabled={disabled}
                onSave={(name) => change({ name })}
            />
            <label className="check bf-small">
                <input
                    type="checkbox"
                    checked={component.bought}
                    disabled={disabled}
                    onChange={(event) => void change({ bought: event.target.checked })}
                />
                Off the shelf
            </label>
            <select
                aria-label={`${component.name}: subsystem`}
                value={component.subsystem_id}
                disabled={disabled}
                onChange={(event) => void change({ subsystem_id: Number(event.target.value) })}
            >
                {program.subsystems.map((subsystem) => (
                    <option key={subsystem.id} value={subsystem.id}>
                        {subsystem.name}
                    </option>
                ))}
            </select>
            <span className="bf-row-actions">
                <button
                    type="button"
                    className="button-small"
                    aria-label={`Move ${component.name} up`}
                    disabled={disabled || place === 0}
                    onClick={() => void change({ position: place - 1 })}
                >
                    ↑
                </button>
                <button
                    type="button"
                    className="button-small"
                    aria-label={`Move ${component.name} down`}
                    disabled={disabled || place === count - 1}
                    onClick={() => void change({ position: place + 1 })}
                >
                    ↓
                </button>
                {component.x !== null && (
                    <button
                        type="button"
                        className="button-small"
                        disabled={disabled}
                        onClick={() => void change({ x: null, y: null })}
                    >
                        Off the drawing
                    </button>
                )}
                <button
                    type="button"
                    className="button-small"
                    disabled={disabled}
                    onClick={() => void run(() => buildflow.removeComponent(component.id))}
                >
                    Remove
                </button>
            </span>
        </li>
    );
}

function Milestones({
    program,
    phase,
    disabled,
    run,
}: {
    program: ProgramDetail;
    phase: Phase;
    disabled: boolean;
    run: Run;
}) {
    const stones = inPhase(program.milestones, phase);
    const [name, setName] = useState("");
    const change = (milestone: Milestone, patch: Parameters<typeof buildflow.changeMilestone>[1]) =>
        run(() => buildflow.changeMilestone(milestone.id, patch));
    return (
        <section className="bf-milestone-column" aria-label={`${PHASE_NAMES[phase]} milestones`}>
            <h3>{PHASE_NAMES[phase]}</h3>
            <ul className="plain">
                {stones.map((milestone, index) => (
                    <li key={milestone.id} className="bf-milestone-edit">
                        <div className="bf-milestone-edit-names">
                            <Inline
                                value={milestone.name}
                                label={`${milestone.name}: name`}
                                disabled={disabled}
                                onSave={(value) => change(milestone, { name: value })}
                            />
                            <Inline
                                value={milestone.title}
                                label={`${milestone.name}: what it stands for`}
                                disabled={disabled}
                                onSave={(value) => change(milestone, { title: value })}
                            />
                        </div>
                        <span className="bf-row-actions">
                            <label className="check bf-small" title="A review, held on a day">
                                <input
                                    type="checkbox"
                                    checked={milestone.review}
                                    disabled={disabled}
                                    onChange={(event) => void change(milestone, { review: event.target.checked })}
                                />
                                Review
                            </label>
                            <button
                                type="button"
                                className="button-small"
                                aria-label={`Move ${milestone.name} earlier`}
                                disabled={disabled || index === 0}
                                onClick={() => void change(milestone, { position: index - 1 })}
                            >
                                ↑
                            </button>
                            <button
                                type="button"
                                className="button-small"
                                aria-label={`Move ${milestone.name} later`}
                                disabled={disabled || index === stones.length - 1}
                                onClick={() => void change(milestone, { position: index + 1 })}
                            >
                                ↓
                            </button>
                            <button
                                type="button"
                                className="button-small"
                                aria-label={`Delete ${milestone.name}`}
                                disabled={disabled}
                                onClick={() => void run(() => buildflow.removeMilestone(milestone.id))}
                            >
                                ✕
                            </button>
                        </span>
                    </li>
                ))}
            </ul>
            <form
                className="bf-add-milestone"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim()) {
                        void run(() => buildflow.addMilestone(program.id, { phase, name: name.trim() })).then(
                            (added) => added && setName(""),
                        );
                    }
                }}
            >
                <input
                    aria-label={`New ${PHASE_NAMES[phase].toLowerCase()} milestone`}
                    placeholder="New milestone"
                    value={name}
                    maxLength={40}
                    disabled={disabled}
                    onChange={(event) => setName(event.target.value)}
                />
                <button type="submit" className="button-small" disabled={disabled || !name.trim()}>
                    Add
                </button>
            </form>
        </section>
    );
}
