import { useEffect, useMemo, useState } from "react";
import { Dialog, Notice, Time } from "../components";
import { Link, navigate } from "../router";
import { useSession } from "../session";
import { buildflow, PHASE_NAMES, PHASES, type Phase, type Program, type Profile, type Template } from "./api";
import { drawVehicle } from "./vehicle";

// Buildflow's front page (/buildflow): the team's programs, each a card with its vehicle and how far its components
// have come in each phase, to open its bill of design. Admins make programs here, from a starting layout, and see the
// archived ones.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const TEMPLATES: { value: Template; name: string; what: string }[] = [
    {
        value: "rocket",
        name: "Rocket",
        what: "A liquid rocket: engine, fins, LOX and fuel tanks, pressurant, avionics, recovery, and the nose, with 19 components in 5 subsystems.",
    },
    {
        value: "hopper",
        name: "Hopper",
        what: "An engine on landing legs under its tanks and avionics, with 11 components in 4 subsystems.",
    },
    {
        value: "stand",
        name: "Test stand",
        what: "An engine on its thrust mount, fed from its tanks, on a stand's frame, with its DAQ and controls: 14 components.",
    },
    { value: "blank", name: "Blank", what: "Only the milestones: draw the vehicle and add its components yourself." },
];

export function ProgramsPage() {
    const { me } = useSession();
    const [programs, setPrograms] = useState<Program[] | null>(null);
    const [archived, setArchived] = useState<Program[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [making, setMaking] = useState(false);
    const admin = me?.is_admin ?? false;

    useEffect(() => {
        buildflow.programs().then(setPrograms, (error: unknown) => setProblem(message(error)));
    }, []);

    return (
        <section className="bf-programs">
            <div className="page-head">
                <h1 className="page-title">Programs</h1>
                {admin && (
                    <div className="page-actions">
                        <button type="button" className="button-primary" onClick={() => setMaking(true)}>
                            New program
                        </button>
                    </div>
                )}
            </div>
            <p className="muted bf-lead">
                Each program&apos;s bill of design: its components, on the vehicle, through design (DCR, CoDR, PDR,
                CDR), build, test, and launch. Open one to see where everything is, and keep it up.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {programs === null && !problem && <p className="muted">Loading…</p>}
            {programs?.length === 0 && (
                <p className="empty">
                    No programs yet.{" "}
                    {admin ? "Make one with New program." : "An admin makes them: one for each vehicle."}
                </p>
            )}
            <div className="bf-cards">
                {programs?.map((program) => (
                    <ProgramCard key={program.id} program={program} />
                ))}
            </div>
            {admin && (
                <section className="bf-archived">
                    {archived === null ? (
                        <button
                            type="button"
                            className="button-small"
                            onClick={() =>
                                buildflow
                                    .programs(true)
                                    .then(setArchived, (error: unknown) => setProblem(message(error)))
                            }
                        >
                            Show archived programs
                        </button>
                    ) : (
                        <>
                            <h2>Archived</h2>
                            {archived.length === 0 ? (
                                <p className="muted">None.</p>
                            ) : (
                                <ul className="plain">
                                    {archived.map((program) => (
                                        <li key={program.id}>
                                            <Link to={`/buildflow/programs/${program.id}`}>{program.name}</Link>
                                            <span className="muted">
                                                archived <Time at={program.archived_at!} />
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    )}
                </section>
            )}
            {making && <NewProgram onClose={() => setMaking(false)} />}
        </section>
    );
}

function ProgramCard({ program }: { program: Program }) {
    const total = program.component_count;
    return (
        <Link to={`/buildflow/programs/${program.id}`} className="bf-card" aria-label={program.name}>
            <div className="bf-card-stage">
                <Outline profile={program.profile} />
            </div>
            <div className="bf-card-body">
                <h2 className="bf-card-name">{program.name}</h2>
                <p className="muted bf-small">
                    {total} component{total === 1 ? "" : "s"}
                    {program.last_milestone.design &&
                        `, ${program.through.design} through ${program.last_milestone.design}`}
                </p>
                <ul className="plain bf-card-phases">
                    {PHASES.map((phase) => (
                        <PhaseBar key={phase} program={program} phase={phase} />
                    ))}
                </ul>
                <p className="muted bf-small">
                    Changed <Time at={program.updated_at} />
                </p>
            </div>
        </Link>
    );
}

/** How a program's components stand in a phase, in one bar: done, in progress, blocked, and the rest. */
function PhaseBar({ program, phase }: { program: Program; phase: Phase }) {
    const counts = program.phases[phase];
    const needed = program.component_count - counts.skipped;
    const share = (n: number) => `${needed > 0 ? (n / needed) * 100 : 0}%`;
    return (
        <li className="bf-card-phase">
            <span className="bf-card-phase-name">{PHASE_NAMES[phase]}</span>
            <span
                className="bf-bar"
                role="img"
                aria-label={`${PHASE_NAMES[phase]}: ${counts.done} done, ${counts.in_progress} in progress, ${counts.blocked} blocked, of ${needed}`}
            >
                <span className="bf-bar-done" style={{ width: share(counts.done) }} />
                <span className="bf-bar-in_progress" style={{ width: share(counts.in_progress) }} />
                <span className="bf-bar-blocked" style={{ width: share(counts.blocked) }} />
            </span>
            <span className="bf-card-phase-count">
                {counts.done}/{needed}
            </span>
        </li>
    );
}

/** A vehicle's outline alone, small: a program's card. */
export function Outline({ profile }: { profile: Profile }) {
    const drawn = useMemo(() => drawVehicle(profile), [profile]);
    if (profile.sections.length === 0) {
        return <span className="bf-card-undrawn">Not drawn yet</span>;
    }
    const { box } = drawn;
    return (
        <svg className="bf-outline-small" viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} aria-hidden="true">
            <path className="bf-detail" d={drawn.detail} />
            <path className="bf-outline" d={drawn.outline} />
        </svg>
    );
}

function NewProgram({ onClose }: { onClose: () => void }) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [template, setTemplate] = useState<Template>("rocket");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function make() {
        setBusy(true);
        setProblem(null);
        try {
            const made = await buildflow.addProgram(name.trim(), description.trim(), template);
            navigate(`/buildflow/programs/${made.id}`);
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title="New program"
            confirm="Make it"
            busy={busy}
            disabled={!name.trim()}
            onConfirm={() => void make()}
            onCancel={onClose}
            wide
        >
            <label className="field">
                Name
                <input
                    autoFocus
                    value={name}
                    maxLength={100}
                    placeholder="Elytra"
                    onChange={(event) => setName(event.target.value)}
                />
            </label>
            <label className="field">
                Description <span className="muted">(optional)</span>
                <input value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <fieldset className="bf-templates">
                <legend>Start from</legend>
                {TEMPLATES.map((each) => (
                    <label key={each.value} className="bf-template">
                        <input
                            type="radio"
                            name="template"
                            value={each.value}
                            checked={template === each.value}
                            onChange={() => setTemplate(each.value)}
                        />
                        <span>
                            <strong>{each.name}</strong>
                            <span className="muted"> {each.what}</span>
                        </span>
                    </label>
                ))}
            </fieldset>
            <p className="muted bf-small">
                Every program starts with the same milestones: DCR, CoDR, PDR, and CDR in design; drawings, procurement,
                manufacturing, and inspection in build; TRR, testing, and QRR in test; integration, FRR, and flight in
                launch. Change any of it on its Layout page.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}
