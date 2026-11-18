import { useEffect, useMemo, useState } from "react";
import { api, type Deal, type UserRef } from "../api";
import { Notice, Time, usePopover } from "../components";
import { Link, navigate } from "../router";
import {
    buildflow,
    PHASE_NAMES,
    PHASES,
    type Activity,
    type Component,
    type Milestone,
    type Phase,
    type ProgramDetail,
    type Review,
    type Status,
} from "./api";
import { ComponentPanel } from "./Panel";
import { leadInWords, planOf } from "./planning";
import { ReviewsSection } from "./Review";
import { reviewPath, reviewsOf } from "./reviews";
import { Vehicle } from "./VehicleView";
import {
    formatDay,
    headline,
    inPhase,
    phaseState,
    schedule,
    STATE_NAMES,
    statusAt,
    statusName,
    STATUS_NAMES,
    today,
} from "./vehicle";
import { useDemo } from "../session";

// A program's bill of design (/buildflow/programs/{id}): its vehicle on the stage, each component a dot in the color of
// where it is in the phase picked above it (Design, Build, Test, Launch), and under it the bill, every component's
// progress at every milestone; what's due, and what's been done lately. A component, picked on either, opens beside
// them, to keep up. The phase and the component picked are in the address (?phase=build&component=12), to share.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ORDER: Status[] = ["not_started", "in_progress", "done", "blocked", "skipped"];

function fromAddress(): { phase: Phase; component: number | null } {
    const params = new URLSearchParams(window.location.search);
    const phase = params.get("phase") as Phase | null;
    const component = Number(params.get("component"));
    return {
        phase: phase && PHASES.includes(phase) ? phase : "design",
        component: Number.isInteger(component) && component > 0 ? component : null,
    };
}

export function ProgramPage({ id }: { id: number }) {
    const [program, setProgram] = useState<ProgramDetail | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>(() => fromAddress().phase);
    const [selected, setSelected] = useState<number | null>(() => fromAddress().component);
    const [focus, setFocus] = useState<number | null>(null); // a milestone to show in the panel
    const [members, setMembers] = useState<UserRef[]>([]);
    const [activity, setActivity] = useState<Activity[]>([]);
    const [deals, setDeals] = useState<Deal[]>([]); // on eBay, for what's on this bill

    const loadActivity = () => buildflow.activity(id, 15).then(setActivity, () => setActivity([]));
    useEffect(() => {
        buildflow.program(id).then(setProgram, (error: unknown) => setProblem(message(error)));
        void loadActivity();
        api.users().then(
            (people) => setMembers(people.filter((person) => person.status === "active")),
            () => setMembers([]),
        );
        // All of Buildflow's, as many as the server gives, to find this program's among them.
        api.deals("buildflow", 200).then(setDeals, () => setDeals([]));
    }, [id]);

    // Deals found for each component of this program, by its id: the server's say on what they're for.
    const dealsFor = useMemo(() => {
        const found = new Map<number, Deal[]>();
        const here = new Set(program?.components.map((c) => c.id));
        for (const deal of deals) {
            const component = Number(/^buildflow:component:(\d+)$/.exec(deal.want_key)?.[1]);
            if (here.has(component)) {
                found.set(component, [...(found.get(component) ?? []), deal]);
            }
        }
        return found;
    }, [deals, program]);

    // The phase and the component picked go in the address, without a page of history for each.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        params.set("phase", phase);
        if (selected === null) {
            params.delete("component");
        } else {
            params.set("component", String(selected));
        }
        window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}`);
    }, [phase, selected]);

    function changed(component: Component) {
        setProgram(
            (now) => now && { ...now, components: now.components.map((c) => (c.id === component.id ? component : c)) },
        );
        void loadActivity();
    }

    async function setStatus(component: Component, milestone: Milestone, status: Status) {
        setProblem(null);
        try {
            const change = status === "done" ? { status, done_on: today() } : { status };
            changed(await buildflow.setProgress(component.id, milestone.id, change));
        } catch (error) {
            setProblem(message(error));
        }
    }

    function pick(component: Component | null, milestone: Milestone | null = null) {
        setSelected(component?.id ?? null);
        setFocus(milestone?.id ?? null);
        if (milestone) {
            setPhase(milestone.phase);
        }
    }

    if (!program) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    const component = program.components.find((c) => c.id === selected) ?? null;
    return (
        <section className={`bf-program ${component ? "bf-program-picked" : ""}`}>
            <div className="page-head">
                <div className="page-title">
                    <nav className="breadcrumbs" aria-label="Programs">
                        <Link to="/buildflow">Programs</Link>
                    </nav>
                    <h1>
                        {program.name} <span className="bf-subtitle">Bill of design</span>
                    </h1>
                </div>
                <div className="page-actions">
                    {program.archived_at && <span className="tag tag-warning">Archived</span>}
                    <Link to={`/buildflow/programs/${program.id}/plan`} className="button">
                        Build plan
                    </Link>
                    {program.can_edit && (
                        <Link to={`/buildflow/programs/${program.id}/layout`} className="button">
                            Layout
                        </Link>
                    )}
                </div>
            </div>
            {program.description && <p className="muted bf-lead">{program.description}</p>}
            {problem && <Notice tone="error">{problem}</Notice>}
            <Stage
                program={program}
                phase={phase}
                onPhase={setPhase}
                selected={selected}
                onPick={pick}
                marks={new Map([...dealsFor].map(([component, found]) => [component, found.length]))}
            />
            <Bill
                program={program}
                phase={phase}
                selected={selected}
                onPick={pick}
                onStatus={setStatus}
                dealsFor={dealsFor}
                longLeads={
                    new Set(
                        planOf(program, today())
                            .filter((p) => p.long)
                            .map((p) => p.component.id),
                    )
                }
            />
            <ReviewsSection program={program} phase={phase} />
            <div className="bf-lower">
                <Coming program={program} onPick={pick} />
                <section className="bf-activity" aria-label="Recent activity">
                    <h2>Recent activity</h2>
                    {activity.length === 0 ? (
                        <p className="muted">Nothing yet.</p>
                    ) : (
                        <ul className="plain bf-feed">
                            {activity.map((event) => (
                                <li key={event.id}>
                                    <span>
                                        <strong>{event.user?.name ?? "Someone"}</strong>
                                        {event.component ? `, ${event.component}: ` : ": "}
                                        {event.what}
                                    </span>
                                    <span className="muted">
                                        <Time at={event.at} />
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
            {component && (
                <ComponentPanel
                    key={component.id}
                    program={program}
                    component={component}
                    phase={phase}
                    focus={focus}
                    members={members}
                    deals={dealsFor.get(component.id) ?? []}
                    onDismiss={(deal) => setDeals((now) => now.filter((each) => each.id !== deal.id))}
                    onChange={changed}
                    onClose={() => pick(null)}
                />
            )}
        </section>
    );
}

/** The vehicle on its stage, as in a launch company's progress page: the phases across the top, the components on
 * the vehicle in the colors of where each is in the phase picked, and how many are through it, in big letters. */
function Stage({
    program,
    phase,
    onPhase,
    selected,
    onPick,
    marks,
}: {
    program: ProgramDetail;
    phase: Phase;
    onPhase: (phase: Phase) => void;
    selected: number | null;
    onPick: (component: Component) => void;
    marks: Map<number, number>;
}) {
    const stones = inPhase(program.milestones, phase);
    const placed = program.components.filter((c) => c.x !== null && c.y !== null);
    const drawn = program.profile.sections.length > 0 || placed.length > 0;
    const counts = useMemo(() => {
        const found = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<string, number>;
        for (const c of program.components) {
            found[phaseState(c, stones)]! += 1;
        }
        return found;
    }, [program.components, stones]);
    return (
        <section className="bf-stage" aria-label="The vehicle">
            <div className="bf-phases" role="tablist" aria-label="Phases">
                {PHASES.map((each) => {
                    const done = program.components.filter(
                        (c) => phaseState(c, inPhase(program.milestones, each)) === "done",
                    ).length;
                    return (
                        <button
                            key={each}
                            type="button"
                            role="tab"
                            aria-selected={each === phase}
                            className="bf-phase"
                            onClick={() => onPhase(each)}
                        >
                            <span className="bf-phase-name">{PHASE_NAMES[each]}</span>
                            <span className="bf-phase-count">
                                {done} of {program.components.length} done
                            </span>
                        </button>
                    );
                })}
            </div>
            <div className="bf-stage-drawing" role="tabpanel" aria-label={PHASE_NAMES[phase]}>
                {drawn ? (
                    <Vehicle
                        profile={program.profile}
                        components={program.components}
                        milestones={stones}
                        selected={selected}
                        onSelect={onPick}
                        label={program.name}
                        marks={marks}
                    />
                ) : (
                    <p className="bf-stage-empty">
                        The vehicle isn&apos;t drawn yet.{" "}
                        {program.can_edit
                            ? "Draw it, and place its components on it, on the Layout page."
                            : "An admin draws it on the program's layout page."}
                    </p>
                )}
            </div>
            <Headline text={headline(program.components, program.milestones, phase)} />
            <ul className="bf-legend" aria-label="What the colors mean">
                {STATES.map((state) => (
                    <li key={state}>
                        <span className={`bf-swatch bf-dot-${state}`} aria-hidden="true" />
                        {STATE_NAMES[state]} <span className="bf-legend-count">{counts[state]}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

const STATES = ["done", "in_progress", "blocked", "not_started", "skipped"] as const;

/** The stage's caption, in capitals but for a review's plural: "18 COMPONENT-LEVEL CDRs ACROSS THE VEHICLE". */
function Headline({ text }: { text: string }) {
    const plural = /^(.*\d component-level \S+)(s)( across the vehicle)$/.exec(text);
    return (
        <p className="bf-headline">
            {plural ? (
                <>
                    {plural[1]}
                    <span className="bf-keep-case">{plural[2]}</span>
                    {plural[3]}
                </>
            ) : (
                text
            )}
        </p>
    );
}

/** Every component's progress at every milestone, by subsystem: a chip for each, which sets its status. */
function Bill({
    program,
    phase,
    selected,
    onPick,
    onStatus,
    dealsFor,
    longLeads,
}: {
    program: ProgramDetail;
    phase: Phase;
    selected: number | null;
    onPick: (component: Component, milestone?: Milestone | null) => void;
    onStatus: (component: Component, milestone: Milestone, status: Status) => void;
    dealsFor: Map<number, Deal[]>;
    longLeads: Set<number>; // not ready yet, with a lead time of six weeks or more
}) {
    const { milestones, subsystems, components } = program;
    if (components.length === 0) {
        return (
            <p className="empty">
                No components yet.{" "}
                {program.can_edit ? (
                    <Link to={`/buildflow/programs/${program.id}/layout`}>Add them on the Layout page.</Link>
                ) : (
                    "An admin adds them on the program's layout page."
                )}
            </p>
        );
    }
    const columns = 3 + milestones.length;
    return (
        <div className="table-scroll bf-bill-scroll">
            <table className="table bf-bill" aria-label="Bill of design">
                <thead>
                    <tr>
                        <th rowSpan={2} className="bf-bill-name">
                            Component
                        </th>
                        <th rowSpan={2}>Lead</th>
                        {PHASES.map((each) => {
                            const count = inPhase(milestones, each).length;
                            return count === 0 ? null : (
                                <th
                                    key={each}
                                    colSpan={count}
                                    className={`bf-phase-head ${each === phase ? "bf-phase-current" : ""}`}
                                >
                                    {PHASE_NAMES[each]}
                                </th>
                            );
                        })}
                        <th rowSpan={2}>Next due</th>
                    </tr>
                    <tr>
                        {milestones.map((milestone) => (
                            <th
                                key={milestone.id}
                                className={`bf-bill-stone ${milestone.phase === phase ? "bf-phase-current" : ""}`}
                                title={milestone.title || undefined}
                            >
                                <span>{milestone.name}</span>
                            </th>
                        ))}
                    </tr>
                </thead>
                {subsystems.map((subsystem) => {
                    const inside = components.filter((c) => c.subsystem_id === subsystem.id);
                    if (inside.length === 0) {
                        return null;
                    }
                    return (
                        <tbody key={subsystem.id}>
                            <tr className="bf-subsystem-row">
                                <th colSpan={columns} scope="rowgroup">
                                    {subsystem.name} <span className="muted">{inside.length}</span>
                                </th>
                            </tr>
                            {inside.map((component) => (
                                <tr
                                    key={component.id}
                                    className={component.id === selected ? "bf-row-picked" : undefined}
                                >
                                    <th scope="row" className="bf-bill-name">
                                        <button
                                            type="button"
                                            className="bf-component-name"
                                            onClick={() => onPick(component)}
                                        >
                                            {component.name}
                                        </button>
                                        {component.bought && (
                                            <span className="tag" title="Off the shelf: bought, not made">
                                                COTS
                                            </span>
                                        )}
                                        {longLeads.has(component.id) && (
                                            <span
                                                className="tag bf-long-lead"
                                                title={`A lead time of ${leadInWords(component.lead_days!)}: on the build plan`}
                                            >
                                                Long lead
                                            </span>
                                        )}
                                        <DealMark
                                            component={component}
                                            deals={dealsFor.get(component.id) ?? []}
                                            onOpen={() => onPick(component)}
                                        />
                                    </th>
                                    <td className="muted bf-bill-lead">{component.lead?.name ?? ""}</td>
                                    {milestones.map((milestone) => (
                                        <td key={milestone.id} className="bf-cell">
                                            <Chip
                                                component={component}
                                                milestone={milestone}
                                                reviews={reviewsOf(program, component, milestone)}
                                                onStatus={(status) => onStatus(component, milestone, status)}
                                                onMore={() => onPick(component, milestone)}
                                            />
                                        </td>
                                    ))}
                                    <td className="bf-bill-due">
                                        <NextDue component={component} milestones={milestones} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    );
                })}
            </table>
        </div>
    );
}

/** A quiet mark beside a component the deals finder found something on eBay for: a tag, and how many; it opens the
 * component, whose panel lists them. */
function DealMark({ component, deals, onOpen }: { component: Component; deals: Deal[]; onOpen: () => void }) {
    if (deals.length === 0) {
        return null;
    }
    const best = deals[0]!;
    const said = `${deals.length} ${deals.length === 1 ? "deal" : "deals"} on eBay for ${component.name}`;
    return (
        <button
            type="button"
            className="bf-deal-mark"
            aria-label={said}
            title={`${said}: ${best.title}`}
            onClick={onOpen}
        >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path
                    d="M1.5 8.6V2.5a1 1 0 0 1 1-1h6.1l6 6-7.1 7.1z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                />
                <circle cx="5" cy="5" r="1.3" fill="currentColor" />
            </svg>
            {deals.length}
        </button>
    );
}

/** A component's status at a milestone, as a chip; clicked, a menu of the statuses to set, the reviews it's in there,
 * and more in its panel. */
function Chip({
    component,
    milestone,
    reviews,
    onStatus,
    onMore,
}: {
    component: Component;
    milestone: Milestone;
    reviews: Review[];
    onStatus: (status: Status) => void;
    onMore: () => void;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const demo = useDemo(); // the demo: a chip shows its component, as nothing can be changed
    const status = statusAt(component, milestone);
    const kept = component.progress.find((p) => p.milestone_id === milestone.id);
    const said = [`${milestone.name}: ${statusName(status, milestone)}`];
    if (kept?.done_on && status === "done") {
        said.push(formatDay(kept.done_on));
    } else if (kept?.due) {
        said.push(`due ${formatDay(kept.due)}`);
    }
    if (reviews.length > 0) {
        said.push(`in ${reviews.map((r) => r.name).join(" and ")}`);
    }
    const late = kept?.due && status !== "done" && status !== "skipped" && kept.due < today();
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className={`bf-chip bf-chip-${status} ${late ? "bf-chip-late" : ""}`}
                aria-label={`${component.name}, ${said.join(", ")}`}
                title={said.join(", ")}
                aria-haspopup={demo ? undefined : "menu"}
                aria-expanded={demo ? undefined : open}
                onClick={() => (demo ? onMore() : setOpen(!open))}
            />
            {open && (
                <div className="menu menu-left" role="menu" aria-label={`${component.name}, ${milestone.name}`}>
                    <p className="menu-label">
                        {component.name}, {milestone.name}
                    </p>
                    {ORDER.map((each) => (
                        <button
                            key={each}
                            type="button"
                            role="menuitemradio"
                            aria-checked={each === status}
                            className="menu-item"
                            onClick={() => {
                                setOpen(false);
                                if (each !== status) {
                                    onStatus(each);
                                }
                            }}
                        >
                            <span className={`bf-chip bf-chip-${each}`} aria-hidden="true" />
                            {statusName(each, milestone)}
                        </button>
                    ))}
                    <hr />
                    {reviews.map((review) => (
                        <button
                            key={review.id}
                            type="button"
                            role="menuitem"
                            className="menu-item"
                            onClick={() => {
                                setOpen(false);
                                navigate(reviewPath(review));
                            }}
                        >
                            {review.name}…
                        </button>
                    ))}
                    <button
                        type="button"
                        role="menuitem"
                        className="menu-item"
                        onClick={() => {
                            setOpen(false);
                            onMore();
                        }}
                    >
                        Dates, notes, links…
                    </button>
                </div>
            )}
        </div>
    );
}

function NextDue({ component, milestones }: { component: Component; milestones: Milestone[] }) {
    const next = schedule([component], milestones, null)[0];
    if (!next) {
        return null;
    }
    return (
        <span
            className={next.late ? "bf-late" : undefined}
            title={`${next.milestone.name}, ${STATUS_NAMES[next.status]}`}
        >
            {next.milestone.name} {formatDay(next.due)}
        </span>
    );
}

/** What's due and not yet done, in every phase: what's late first, then the next. */
function Coming({ program, onPick }: { program: ProgramDetail; onPick: (c: Component, m: Milestone) => void }) {
    const due = schedule(program.components, program.milestones, null);
    const late = due.filter((d) => d.late);
    const next = due.filter((d) => !d.late).slice(0, 8);
    return (
        <section className="bf-coming" aria-label="Coming up">
            <h2>Coming up</h2>
            {late.length === 0 && next.length === 0 ? (
                <p className="muted">Nothing has a due date. Set them on a component&apos;s milestones.</p>
            ) : (
                <ul className="plain bf-due-list">
                    {[...late, ...next].map((d) => (
                        <li key={`${d.component.id}-${d.milestone.id}`} className={d.late ? "bf-late" : undefined}>
                            <span className="bf-due-day">{formatDay(d.due)}</span>
                            <button
                                type="button"
                                className="bf-link-button"
                                onClick={() => onPick(d.component, d.milestone)}
                            >
                                {d.component.name}
                            </button>
                            <span>
                                {d.milestone.name}
                                {d.late ? ", late" : d.status === "blocked" ? ", blocked" : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
