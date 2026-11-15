import { useEffect, useState } from "react";
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
    type Profile,
    type Section,
} from "./api";
import { Vehicle } from "./VehicleView";
import { inPhase } from "./vehicle";

// A program's layout (/buildflow/programs/{id}/layout, admins'): its name, its vehicle's drawing (sections from the aft
// end to the nose, and the components dragged onto it), its subsystems and components, and its milestones. Each change
// is saved as it's made, but the drawing's sections, which are saved together.

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

export function LayoutPage({ id }: { id: number }) {
    const [program, setProgram] = useState<ProgramDetail | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [placing, setPlacing] = useState<Component | null>(null);
    const [archiving, setArchiving] = useState(false);

    const load = () => buildflow.program(id).then(setProgram, (error: unknown) => setProblem(message(error)));
    useEffect(() => {
        void load();
    }, [id]);

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

    if (!program) {
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

            <About program={program} run={run} />

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
                key={JSON.stringify(program.profile)}
                profile={program.profile}
                disabled={archived}
                run={run}
                id={id}
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

function About({ program, run }: { program: ProgramDetail; run: Run }) {
    const [name, setName] = useState(program.name);
    const [description, setDescription] = useState(program.description);
    const changed = name.trim() !== program.name || description.trim() !== program.description;
    return (
        <form
            className="bf-about"
            onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                    buildflow.changeProgram(program.id, { name: name.trim(), description: description.trim() }),
                );
            }}
        >
            <label className="field">
                Name
                <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field bf-grow">
                Description
                <input value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <button type="submit" className="button-primary" disabled={!changed || !name.trim()}>
                Save
            </button>
        </form>
    );
}

/** The drawing's sections, aft to nose, changed together and saved with Save the drawing. */
function Sections({ profile, disabled, run, id }: { profile: Profile; disabled: boolean; run: Run; id: number }) {
    const [sections, setSections] = useState(profile.sections);
    const [stand, setStand] = useState(profile.stand);
    const changed = JSON.stringify({ sections, stand }) !== JSON.stringify(profile);
    const change = (index: number, patch: Partial<Section>) =>
        setSections(sections.map((s, i) => (i === index ? { ...s, ...patch } : s)));
    const move = (index: number, by: number) => {
        const next = [...sections];
        const [taken] = next.splice(index, 1);
        next.splice(index + by, 0, taken!);
        setSections(next);
    };
    const number = (value: string) => Math.max(0.01, Number(value) || 0.01);
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
                                <input
                                    type="number"
                                    className="bf-number"
                                    aria-label={`Section ${index + 1}: length`}
                                    value={section.length}
                                    min={0.01}
                                    step="any"
                                    disabled={disabled}
                                    onChange={(event) => change(index, { length: number(event.target.value) })}
                                />
                            </td>
                            <td>
                                <input
                                    type="number"
                                    className="bf-number"
                                    aria-label={`Section ${index + 1}: diameter`}
                                    value={section.diameter}
                                    min={0.01}
                                    step="any"
                                    disabled={disabled}
                                    onChange={(event) => change(index, { diameter: number(event.target.value) })}
                                />
                            </td>
                            <td>
                                {section.kind === "engine" && (
                                    <input
                                        type="number"
                                        className="bf-number"
                                        aria-label={`Section ${index + 1}: nozzles`}
                                        value={section.count}
                                        min={1}
                                        max={9}
                                        disabled={disabled}
                                        onChange={(event) =>
                                            change(index, {
                                                count: Math.min(9, Math.max(1, Math.round(Number(event.target.value)))),
                                            })
                                        }
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
                                    onClick={() => setSections(sections.filter((_, i) => i !== index))}
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
                        setSections([...sections, { ...NEW_SECTION, diameter: sections.at(-1)?.diameter ?? 8 }])
                    }
                >
                    + Add a section
                </button>
                <label className="check">
                    <input
                        type="checkbox"
                        checked={stand}
                        disabled={disabled}
                        onChange={(event) => setStand(event.target.checked)}
                    />
                    On a test stand
                </label>
                <span className="bf-grow" />
                {changed && (
                    <>
                        <button
                            type="button"
                            onClick={() => {
                                setSections(profile.sections);
                                setStand(profile.stand);
                            }}
                        >
                            Undo changes
                        </button>
                        <button
                            type="button"
                            className="button-primary"
                            onClick={() =>
                                void run(() => buildflow.changeProgram(id, { profile: { sections, stand } }))
                            }
                        >
                            Save the drawing
                        </button>
                    </>
                )}
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
