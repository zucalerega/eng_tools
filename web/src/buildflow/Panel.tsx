import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Deal, type UserRef } from "../api";
import { Notice } from "../components";
import { DealCard } from "../deals";
import { Link } from "../router";
import {
    buildflow,
    PHASE_NAMES,
    PHASES,
    SHOP_STATUS_NAMES,
    type Component,
    type Link as ComponentLink,
    type LinkKind,
    type Milestone,
    type Phase,
    type ProgramDetail,
    type ProgressChange,
    type ShopPart,
    type Status,
} from "./api";
import { appName, guessKind, KIND_NAMES, KINDS, siteTarget, tidyUrl, useSiteName } from "./links";
import { inPhase, phaseState, STATE_NAMES, statusAt, statusName, today } from "./vehicle";

// A component, beside the bill: what it is, its lead, and for each phase its milestones (status, due date, the day it
// was done, a note), who's on it (the build phase's people are who's making it), and its links (CAD and drawings in
// Vault, requirements, design documents, reviews' slides, P&IDs in Piper, test data in Yorg). Anyone keeps them up. In
// its build phase, its parts in the shop's queue (Shop.tsx), and a way to queue one.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ORDER: Status[] = ["not_started", "in_progress", "done", "blocked", "skipped"];

/** Who's on a component in each phase. */
const WHO: Record<Phase, string> = {
    design: "Designing it",
    build: "Making it",
    test: "Testing it",
    launch: "Flying it",
};

/** What each phase's links usually are, to offer first. */
const KIND_FOR: Record<Phase, LinkKind> = { design: "cad", build: "drawing", test: "data", launch: "procedure" };

interface Props {
    program: ProgramDetail;
    component: Component;
    phase: Phase; // its section opens first
    focus: number | null; // a milestone to scroll to
    members: UserRef[];
    deals: Deal[]; // found on eBay for it
    onDismiss: (deal: Deal) => void;
    onChange: (component: Component) => void;
    onClose: () => void;
}

export function ComponentPanel({
    program,
    component,
    phase,
    focus,
    members,
    deals,
    onDismiss,
    onChange,
    onClose,
}: Props) {
    const [problem, setProblem] = useState<string | null>(null);
    const panel = useRef<HTMLElement>(null);
    const subsystem = program.subsystems.find((s) => s.id === component.subsystem_id);

    useEffect(() => {
        const close = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !(event.target instanceof HTMLElement && event.target.closest(".menu"))) {
                onClose();
            }
        };
        window.addEventListener("keydown", close);
        return () => window.removeEventListener("keydown", close);
    }, [onClose]);

    useEffect(() => {
        if (focus !== null) {
            panel.current?.querySelector(`[data-milestone="${focus}"]`)?.scrollIntoView?.({ block: "center" });
        }
    }, [focus]);

    /** Do something to the component, and show it as it is then: whether it worked (if not, the page says why). */
    async function act(action: () => Promise<Component>): Promise<boolean> {
        setProblem(null);
        try {
            onChange(await action());
            return true;
        } catch (error) {
            setProblem(message(error));
            return false;
        }
    }

    return (
        <aside className="bf-panel" aria-label={component.name} ref={panel}>
            <header className="bf-panel-head">
                <div>
                    <p className="bf-panel-kicker">
                        {subsystem?.name}
                        {component.bought ? " · Off the shelf" : ""}
                    </p>
                    <h2>{component.name}</h2>
                </div>
                <button type="button" className="button-small" aria-label="Close" onClick={onClose}>
                    ✕
                </button>
            </header>
            {problem && <Notice tone="error">{problem}</Notice>}
            {deals.length > 0 && (
                <section className="bf-deals" aria-label="On eBay">
                    <h3>On eBay</h3>
                    {deals.map((deal) => (
                        <DealCard
                            key={deal.id}
                            deal={deal}
                            compact
                            onDismiss={() =>
                                void api.dismissDeal(deal.id).then(
                                    () => onDismiss(deal),
                                    (error: unknown) => setProblem(message(error)),
                                )
                            }
                        />
                    ))}
                </section>
            )}
            <Describe
                component={component}
                onSave={(description) => act(() => buildflow.changeComponent(component.id, { description }))}
            />
            <label className="field">
                Lead
                <select
                    aria-label="Lead"
                    value={component.lead?.id ?? ""}
                    onChange={(event) =>
                        void act(() =>
                            buildflow.changeComponent(component.id, {
                                lead_id: event.target.value ? Number(event.target.value) : null,
                            }),
                        )
                    }
                >
                    <option value="">No one yet</option>
                    {withThem(members, component.lead).map((person) => (
                        <option key={person.id} value={person.id}>
                            {person.name}
                        </option>
                    ))}
                </select>
            </label>
            {PHASES.map((each) => (
                <PhaseSection
                    key={each}
                    phase={each}
                    open={each === phase}
                    program={program}
                    component={component}
                    members={members}
                    focus={focus}
                    act={act}
                />
            ))}
        </aside>
    );
}

/** Everyone to choose from, and whoever's chosen already even if they're not on the list (no longer active). */
const withThem = (members: UserRef[], chosen: UserRef | null) =>
    chosen && !members.some((m) => m.id === chosen.id) ? [...members, chosen] : members;

function Describe({ component, onSave }: { component: Component; onSave: (description: string) => Promise<boolean> }) {
    const [text, setText] = useState(component.description);
    const [busy, setBusy] = useState(false);
    useEffect(() => setText(component.description), [component.description]);
    const changed = text.trim() !== component.description;
    return (
        <form
            className="bf-describe"
            onSubmit={(event) => {
                event.preventDefault();
                setBusy(true);
                void onSave(text.trim()).finally(() => setBusy(false));
            }}
        >
            <label className="field">
                What it is
                <textarea
                    rows={2}
                    value={text}
                    maxLength={10_000}
                    placeholder="What it is, what it's made of, what it has to do"
                    onChange={(event) => setText(event.target.value)}
                />
            </label>
            {changed && (
                <div className="bf-row-actions">
                    <button type="button" className="button-small" onClick={() => setText(component.description)}>
                        Cancel
                    </button>
                    <button type="submit" className="button-small button-primary" disabled={busy}>
                        Save
                    </button>
                </div>
            )}
        </form>
    );
}

interface SectionProps {
    phase: Phase;
    open: boolean;
    program: ProgramDetail;
    component: Component;
    members: UserRef[];
    focus: number | null;
    act: (action: () => Promise<Component>) => Promise<boolean>;
}

function PhaseSection({ phase, open, program, component, members, focus, act }: SectionProps) {
    const stones = inPhase(program.milestones, phase);
    const state = phaseState(component, stones);
    const people = component.people.filter((a) => a.phase === phase).map((a) => a.user);
    const links = component.links.filter((link) => link.phase === phase);
    const setPeople = (ids: number[]) => act(() => buildflow.setPeople(component.id, phase, ids));
    return (
        <details className="bf-phase-section" open={open || stones.some((m) => m.id === focus)}>
            <summary>
                <span className="bf-phase-section-name">{PHASE_NAMES[phase]}</span>
                <span className={`bf-state bf-state-${state}`}>{STATE_NAMES[state]}</span>
            </summary>
            {stones.length === 0 && <p className="muted">This program has no milestones in {PHASE_NAMES[phase]}.</p>}
            {stones.map((milestone) => (
                <MilestoneRow
                    key={milestone.id}
                    component={component}
                    milestone={milestone}
                    links={links.filter((link) => link.milestone_id === milestone.id)}
                    onChange={(change) => act(() => buildflow.setProgress(component.id, milestone.id, change))}
                    onRemoveLink={(link) => act(() => buildflow.removeLink(link.id))}
                />
            ))}
            {stones.length > 1 && (
                <button
                    type="button"
                    className="button-small bf-skip-phase"
                    onClick={() =>
                        void act(async () => {
                            let latest = component;
                            for (const milestone of stones) {
                                if (statusAt(latest, milestone) === "not_started") {
                                    latest = await buildflow.setProgress(component.id, milestone.id, {
                                        status: "skipped",
                                    });
                                }
                            }
                            return latest;
                        })
                    }
                    hidden={!stones.some((m) => statusAt(component, m) === "not_started")}
                >
                    Not needed: skip what&apos;s not started
                </button>
            )}
            {phase === "build" && <InTheShop component={component} />}
            <div className="bf-people">
                <h3>{WHO[phase]}</h3>
                <ul className="plain bf-people-list">
                    {people.map((person) => (
                        <li key={person.id} className="bf-person">
                            {person.name}
                            <button
                                type="button"
                                className="bf-remove"
                                aria-label={`Take ${person.name} off ${WHO[phase].toLowerCase()}`}
                                onClick={() =>
                                    void setPeople(people.filter((p) => p.id !== person.id).map((p) => p.id))
                                }
                            >
                                ✕
                            </button>
                        </li>
                    ))}
                </ul>
                <select
                    aria-label={`Add someone to ${WHO[phase].toLowerCase()}`}
                    value=""
                    onChange={(event) => void setPeople([...people.map((p) => p.id), Number(event.target.value)])}
                >
                    <option value="">Add someone…</option>
                    {members
                        .filter((m) => !people.some((p) => p.id === m.id))
                        .map((person) => (
                            <option key={person.id} value={person.id}>
                                {person.name}
                            </option>
                        ))}
                </select>
            </div>
            <div className="bf-links">
                <h3>Links</h3>
                {links.filter((link) => link.milestone_id === null).length === 0 && (
                    <p className="muted bf-small">None yet.</p>
                )}
                <ul className="plain">
                    {links
                        .filter((link) => link.milestone_id === null)
                        .map((link) => (
                            <LinkRow
                                key={link.id}
                                link={link}
                                onRemove={() => void act(() => buildflow.removeLink(link.id))}
                            />
                        ))}
                </ul>
                <AddLink
                    phase={phase}
                    milestones={stones}
                    onAdd={(body) => act(() => buildflow.addLink(component.id, { phase, ...body }))}
                />
            </div>
        </details>
    );
}

/** A component's parts in the shop's queue, where each is, and a way to queue another for it. */
function InTheShop({ component }: { component: Component }) {
    const [parts, setParts] = useState<ShopPart[] | null>(null);
    useEffect(() => {
        buildflow.shopPartsFor(component.id).then(setParts, () => setParts([]));
    }, [component.id]);
    return (
        <section className="bf-in-shop" aria-label="In the shop">
            <h3>In the shop</h3>
            {parts !== null && parts.length === 0 && <p className="muted bf-small">Nothing queued for it.</p>}
            <ul className="plain">
                {parts?.map((part) => (
                    <li key={part.id} className="bf-in-shop-part">
                        <span>
                            {part.name}
                            <span className="muted">
                                {" "}
                                · {part.machine}
                                {part.quantity > 1 && ` · ${part.quantity} of them`}
                            </span>
                        </span>
                        <span className={`bf-shop-chip bf-shop-status-${part.status}`}>
                            {SHOP_STATUS_NAMES[part.status]}
                        </span>
                    </li>
                ))}
            </ul>
            <p className="bf-small">
                <Link to={`/buildflow/shop?add=${component.id}`}>Queue a part for it</Link>
                {" · "}
                <Link to="/buildflow/shop">The shop</Link>
            </p>
        </section>
    );
}

function MilestoneRow({
    component,
    milestone,
    links,
    onChange,
    onRemoveLink,
}: {
    component: Component;
    milestone: Milestone;
    links: ComponentLink[];
    onChange: (change: ProgressChange) => Promise<boolean>;
    onRemoveLink: (link: ComponentLink) => Promise<boolean>;
}) {
    const kept = component.progress.find((p) => p.milestone_id === milestone.id);
    const status = statusAt(component, milestone);
    // The note as saved: what's typed starts over from it only when it changes, not when the milestone's first change
    // (its due date, say) makes its progress, with no note yet, while someone's typing one.
    const saved = kept?.note ?? "";
    const [note, setNote] = useState(saved);
    useEffect(() => setNote(saved), [saved]);
    const label = `${milestone.name}${milestone.title ? `, ${milestone.title}` : ""}`;
    return (
        <div className={`bf-milestone bf-milestone-${status}`} data-milestone={milestone.id}>
            <div className="bf-milestone-head">
                <span className="bf-milestone-name" title={milestone.title || undefined}>
                    {milestone.name}
                    {milestone.title && <span className="muted"> {milestone.title}</span>}
                </span>
                <select
                    aria-label={`${label}: status`}
                    value={status}
                    onChange={(event) => {
                        const next = event.target.value as Status;
                        void onChange(next === "done" ? { status: next, done_on: today() } : { status: next });
                    }}
                >
                    {ORDER.map((each) => (
                        <option key={each} value={each}>
                            {statusName(each, milestone)}
                        </option>
                    ))}
                </select>
            </div>
            <div className="bf-milestone-dates">
                <label>
                    {milestone.review ? "On" : "Due"}
                    <input
                        type="date"
                        aria-label={`${label}: due`}
                        value={kept?.due ?? ""}
                        onChange={(event) => void onChange({ due: event.target.value || null })}
                    />
                </label>
                {status === "done" && (
                    <label>
                        Done
                        <input
                            type="date"
                            aria-label={`${label}: done on`}
                            value={kept?.done_on ?? ""}
                            onChange={(event) => void onChange({ done_on: event.target.value || null })}
                        />
                    </label>
                )}
            </div>
            <input
                className="bf-note"
                aria-label={`${label}: note`}
                placeholder={
                    status === "blocked" ? "What's holding it up" : milestone.review ? "Actions, outcome" : "A note"
                }
                value={note}
                maxLength={10_000}
                onChange={(event) => setNote(event.target.value)}
                onBlur={() => {
                    if (note.trim() !== (kept?.note ?? "")) {
                        void onChange({ note: note.trim() });
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.currentTarget.blur();
                    }
                }}
            />
            {links.length > 0 && (
                <ul className="plain bf-milestone-links">
                    {links.map((link) => (
                        <LinkRow key={link.id} link={link} onRemove={() => void onRemoveLink(link)} />
                    ))}
                </ul>
            )}
        </div>
    );
}

/** A link: what kind it is, the app it's in if it's on the site, and its name (or, on the site, what it goes to). */
function LinkRow({ link, onRemove }: { link: ComponentLink; onRemove: () => void }) {
    const target = siteTarget(link.url);
    const named = useSiteName(link.url);
    const name = link.title || named || link.url;
    const external = !target;
    return (
        <li className="bf-link">
            <span className="tag">{KIND_NAMES[link.kind]}</span>
            {target && <span className={`bf-app bf-app-${target.app}`}>{appName(target)}</span>}
            <a
                href={link.url}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                title={link.added_by ? `${link.url}, added by ${link.added_by.name}` : link.url}
            >
                {name}
            </a>
            <button type="button" className="bf-remove" aria-label={`Remove the link ${name}`} onClick={onRemove}>
                ✕
            </button>
        </li>
    );
}

function AddLink({
    phase,
    milestones,
    onAdd,
}: {
    phase: Phase;
    milestones: Milestone[];
    onAdd: (body: { kind: LinkKind; url: string; title: string; milestone_id: number | null }) => Promise<boolean>;
}) {
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<LinkKind>(KIND_FOR[phase]);
    const [chosen, setChosen] = useState(false); // the kind was picked, not guessed from the address
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("");
    const [on, setOn] = useState("");
    const [busy, setBusy] = useState(false);
    if (!open) {
        return (
            <button type="button" className="button-small" onClick={() => setOpen(true)}>
                + Add a link
            </button>
        );
    }
    async function add(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        const added = await onAdd({
            kind,
            url: tidyUrl(url),
            title: title.trim(),
            milestone_id: on ? Number(on) : null,
        });
        setBusy(false);
        if (added) {
            setOpen(false);
            setUrl("");
            setTitle("");
            setOn("");
            setChosen(false);
        }
    }
    return (
        <form className="bf-add-link" onSubmit={(event) => void add(event)}>
            <label className="field">
                Address
                <input
                    autoFocus
                    value={url}
                    maxLength={2000}
                    placeholder="https://… or a page of the site, like /vault/file/12"
                    onChange={(event) => {
                        setUrl(event.target.value);
                        const guessed = guessKind(event.target.value);
                        if (!chosen && guessed) {
                            setKind(guessed);
                        }
                    }}
                />
            </label>
            <div className="bf-add-link-row">
                <label className="field">
                    Kind
                    <select
                        value={kind}
                        onChange={(event) => {
                            setKind(event.target.value as LinkKind);
                            setChosen(true);
                        }}
                    >
                        {KINDS.map((each) => (
                            <option key={each} value={each}>
                                {KIND_NAMES[each]}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    On
                    <select value={on} onChange={(event) => setOn(event.target.value)}>
                        <option value="">{PHASE_NAMES[phase]}</option>
                        {milestones.map((milestone) => (
                            <option key={milestone.id} value={milestone.id}>
                                {milestone.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <label className="field">
                Name <span className="muted">(optional)</span>
                <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <div className="bf-row-actions">
                <button type="button" className="button-small" onClick={() => setOpen(false)}>
                    Cancel
                </button>
                <button type="submit" className="button-small button-primary" disabled={busy || !url.trim()}>
                    Add
                </button>
            </div>
        </form>
    );
}
