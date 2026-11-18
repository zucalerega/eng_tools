import { useEffect, useState } from "react";
import { Dialog, Notice } from "../components";
import { Link } from "../router";
import { useDemo } from "../session";
import { buildflow, type Component, type ProgramDetail } from "./api";
import { ComponentPicker } from "./Picker";
import { byStart, dayNumber, dayString, leadInWords, LONG_LEAD_DAYS, planOf, type Planned } from "./planning";
import { formatDay, STATE_NAMES, today } from "./vehicle";

// A program's build plan (/buildflow/programs/{id}/plan): each component's lead time and the day it has to be ready by,
// on a calendar, with the day to order it (or start making it) by, what it needs first, and what's late, at risk, or a
// long lead. Anyone signed in keeps it, here or on a component's panel.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Order = "start" | "subsystem";

export function PlanPage({ id }: { id: number }) {
    const [program, setProgram] = useState<ProgramDetail | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [order, setOrder] = useState<Order>("start");
    const [hideReady, setHideReady] = useState(false);
    const [needing, setNeeding] = useState<Component | null>(null);
    const demo = useDemo();

    useEffect(() => {
        buildflow.program(id).then(setProgram, (error: unknown) => setProblem(message(error)));
    }, [id]);

    /** Change a component, then show it as the server says it is now (or why it didn't take). */
    async function change(action: () => Promise<Component>): Promise<boolean> {
        setProblem(null);
        try {
            const changed = await action();
            setProgram(
                (now) => now && { ...now, components: now.components.map((c) => (c.id === changed.id ? changed : c)) },
            );
            return true;
        } catch (error) {
            setProblem(message(error));
            return false;
        }
    }

    if (!program) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    const now = today();
    const planned = planOf(program, now);
    const shown = planned.filter((p) => !(hideReady && p.ready));
    const locked = demo || program.archived_at !== null;
    const open = planned.filter((p) => !p.ready);
    const counts = [
        {
            name: "Order or start now",
            count: open.filter((p) => p.lateToStart).length,
            tone: "danger",
            hint: "Past the day to order or start it by, and not started",
        },
        {
            name: "Late",
            count: open.filter((p) => p.late).length,
            tone: "danger",
            hint: "Past the day it has to be ready by",
        },
        {
            name: "At risk",
            count: open.filter((p) => p.atRisk && !p.late).length,
            tone: "warning",
            hint: "Won't be ready by its day, as things stand",
        },
        {
            name: "Long leads",
            count: open.filter((p) => p.long).length,
            tone: "",
            hint: `A lead time of ${LONG_LEAD_DAYS / 7} weeks or more`,
        },
        {
            name: "Waiting on others",
            count: open.filter((p) => p.waitingOn.length > 0).length,
            tone: "",
            hint: "What it needs first isn't ready yet",
        },
        {
            name: "Not planned",
            count: open.filter((p) => p.lead === null || p.needBy === null).length,
            tone: "muted",
            hint: "No lead time, or no day it has to be ready by",
        },
    ];
    const range = rangeOf(planned, now);
    return (
        <section className="bf-plan">
            <div className="page-head">
                <div className="page-title">
                    <nav className="breadcrumbs" aria-label="Programs">
                        <Link to="/buildflow">Programs</Link>
                        <span className="separator">/</span>
                        <Link to={`/buildflow/programs/${program.id}?phase=build`}>{program.name}</Link>
                    </nav>
                    <h1>Build plan</h1>
                </div>
            </div>
            <p className="muted bf-lead">
                Each component&apos;s lead time and the day it has to be ready by give the day to order it (or start
                making it) by. What it needs first has to be ready before it can start.
            </p>
            {program.archived_at && (
                <Notice tone="warning">{program.name} is archived: an admin can bring it back to change it.</Notice>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}

            <ul className="bf-plan-counts" aria-label="The plan, in numbers">
                {counts.map((each) => (
                    <li
                        key={each.name}
                        className={each.count > 0 && each.tone ? `bf-plan-count-${each.tone}` : undefined}
                        title={each.hint}
                    >
                        <span className="bf-plan-count">{each.count}</span> {each.name}
                    </li>
                ))}
            </ul>

            <div className="bf-plan-controls">
                <div className="segmented" role="group" aria-label="Order">
                    <button type="button" aria-pressed={order === "start"} onClick={() => setOrder("start")}>
                        By start date
                    </button>
                    <button type="button" aria-pressed={order === "subsystem"} onClick={() => setOrder("subsystem")}>
                        By subsystem
                    </button>
                </div>
                <label className="check">
                    <input
                        type="checkbox"
                        checked={hideReady}
                        onChange={(event) => setHideReady(event.target.checked)}
                    />
                    Hide what&apos;s ready
                </label>
            </div>

            <div className="table-scroll">
                <table className="table bf-plan-table" aria-label="Build plan">
                    <thead>
                        <tr>
                            <th>Component</th>
                            <th>Lead (weeks)</th>
                            <th>Ready by</th>
                            <th>Order or start by</th>
                            <th>Needs first</th>
                            <th className="bf-plan-time">
                                <Months range={range} />
                            </th>
                        </tr>
                    </thead>
                    {order === "start" ? (
                        <tbody>
                            {byStart(shown).map((p) => (
                                <Row
                                    key={p.component.id}
                                    planned={p}
                                    range={range}
                                    now={now}
                                    locked={locked}
                                    change={change}
                                    onNeeds={setNeeding}
                                />
                            ))}
                        </tbody>
                    ) : (
                        program.subsystems.map((subsystem) => {
                            const inside = shown.filter((p) => p.component.subsystem_id === subsystem.id);
                            return inside.length === 0 ? null : (
                                <tbody key={subsystem.id}>
                                    <tr className="bf-subsystem-row">
                                        <th colSpan={6} scope="rowgroup">
                                            {subsystem.name}
                                        </th>
                                    </tr>
                                    {inside.map((p) => (
                                        <Row
                                            key={p.component.id}
                                            planned={p}
                                            range={range}
                                            now={now}
                                            locked={locked}
                                            change={change}
                                            onNeeds={setNeeding}
                                        />
                                    ))}
                                </tbody>
                            );
                        })
                    )}
                </table>
            </div>
            {needing && (
                <NeedsDialog
                    program={program}
                    component={needing}
                    onSaved={(changed) => {
                        setProgram(
                            (now) =>
                                now && {
                                    ...now,
                                    components: now.components.map((c) => (c.id === changed.id ? changed : c)),
                                },
                        );
                        setNeeding(null);
                    }}
                    onCancel={() => setNeeding(null)}
                />
            )}
        </section>
    );
}

interface Range {
    from: number; // the first day on the calendar, as a day number
    to: number; // the last
    today: number;
}

/** The calendar's days: from two weeks before today (or the first day on the plan) to a week after the last. */
function rangeOf(planned: Planned[], now: string): Range {
    const today = dayNumber(now);
    const days = planned
        .flatMap((p) => [p.startBy, p.needBy, p.projected])
        .filter((d): d is string => d !== null)
        .map(dayNumber);
    return { from: Math.min(today - 14, ...days), to: Math.max(today + 56, ...days) + 7, today };
}

const at = (range: Range, day: number) => `${((day - range.from) / (range.to - range.from)) * 100}%`;

/** The months across the calendar's head, each at its first day. */
function Months({ range }: { range: Range }) {
    const first = new Date(dayString(range.from) + "T00:00:00Z");
    const months: { day: number; label: string }[] = [];
    for (let month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)); ;) {
        const day = month.getTime() / 86_400_000;
        if (day > range.to) {
            break;
        }
        const label = month.toLocaleDateString(undefined, {
            month: "short",
            timeZone: "UTC",
            ...(month.getUTCMonth() === 0 ? { year: "numeric" } : {}),
        });
        months.push({ day, label });
        month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    }
    return (
        <div className="bf-plan-months" aria-hidden="true">
            {months.map((month) => (
                <span key={month.day} style={{ left: at(range, month.day) }}>
                    {month.label}
                </span>
            ))}
            <span className="bf-plan-today-label" style={{ left: at(range, range.today) }}>
                Today
            </span>
        </div>
    );
}

function Row({
    planned,
    range,
    now,
    locked,
    change,
    onNeeds,
}: {
    planned: Planned;
    range: Range;
    now: string;
    locked: boolean;
    change: (action: () => Promise<Component>) => Promise<boolean>;
    onNeeds: (component: Component) => void;
}) {
    const p = planned;
    const c = p.component;
    const flags = [
        p.ready && "Ready",
        p.long && "Long lead",
        p.late && "Late",
        p.atRisk && !p.late && "At risk",
    ].filter((each): each is string => typeof each === "string");
    return (
        <tr className={p.ready ? "bf-plan-ready" : undefined}>
            <th scope="row">
                <Link to={`/buildflow/programs/${c.program_id}?phase=build&component=${c.id}`}>{c.name}</Link>
                {flags.map((flag) => (
                    <span
                        key={flag}
                        className={`tag bf-plan-flag bf-plan-flag-${flag.toLowerCase().replace(" ", "-")}`}
                    >
                        {flag}
                    </span>
                ))}
            </th>
            <td>
                <LeadField component={c} disabled={locked} change={change} />
            </td>
            <td>
                <input
                    type="date"
                    aria-label={`${c.name}: ready by`}
                    value={c.need_by ?? ""}
                    disabled={locked}
                    onChange={(event) =>
                        void change(() => buildflow.changeComponent(c.id, { need_by: event.target.value || null }))
                    }
                />
            </td>
            <td className={p.lateToStart ? "bf-late bf-due-day" : "bf-due-day"}>
                {p.ready ? (
                    <span className="muted">{c.bought ? "In hand" : "Made"}</span>
                ) : p.startBy ? (
                    `${c.bought ? "Order" : "Start"} by ${formatDay(p.startBy)}${p.lateToStart ? ", late" : ""}`
                ) : (
                    <span className="muted">—</span>
                )}
            </td>
            <td className="bf-plan-needs">
                <button
                    type="button"
                    className={`bf-link-button ${c.needs.length === 0 ? "bf-plan-nothing" : ""}`}
                    aria-label={`What ${c.name} needs first`}
                    disabled={locked}
                    onClick={() => onNeeds(c)}
                >
                    {c.needs.length === 0
                        ? "Nothing"
                        : `${c.needs.length} ${c.needs.length === 1 ? "component" : "components"}`}
                </button>
                {p.waitingOn.length > 0 && (
                    <span className="muted bf-small"> waiting on {p.waitingOn.map((w) => w.name).join(", ")}</span>
                )}
            </td>
            <td className="bf-plan-time">
                <Bar planned={p} range={range} now={now} />
            </td>
        </tr>
    );
}

/** The lead time in weeks (halves too), saved when it's left, or on Enter. Empty is none. */
export function LeadField({
    component,
    disabled,
    change,
}: {
    component: Component;
    disabled: boolean;
    change: (action: () => Promise<Component>) => Promise<boolean>;
}) {
    const saved = component.lead_days === null ? "" : String(Math.round((component.lead_days / 7) * 10) / 10);
    const [text, setText] = useState(saved);
    useEffect(() => setText(saved), [saved]);
    function save() {
        const weeks = text.trim() === "" ? null : Number(text);
        if (weeks !== null && (!Number.isFinite(weeks) || weeks < 0 || weeks > 520)) {
            setText(saved);
            return;
        }
        const days = weeks === null ? null : Math.round(weeks * 7);
        if (days !== component.lead_days) {
            void change(() => buildflow.changeComponent(component.id, { lead_days: days })).then(
                (ok) => !ok && setText(saved),
            );
        }
    }
    return (
        <input
            type="number"
            className="bf-number"
            aria-label={`${component.name}: lead time, in weeks`}
            value={text}
            min={0}
            max={520}
            step="any"
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.currentTarget.blur();
                }
            }}
        />
    );
}

/** A component on the calendar: its lead time, as a bar from the day to order or start it by to the day it has to be
 * ready by, in the color of where it is; and, when it's at risk, the day it'd be ready as things stand. */
function Bar({ planned, range, now }: { planned: Planned; range: Range; now: string }) {
    const p = planned;
    const label = [
        p.lead !== null && `${leadInWords(p.lead)} lead`,
        p.startBy && `${p.component.bought ? "order" : "start"} by ${formatDay(p.startBy)}`,
        p.needBy && `ready by ${formatDay(p.needBy)}`,
        p.atRisk && p.projected && `ready ${formatDay(p.projected)} as things stand`,
        STATE_NAMES[p.state].toLowerCase(),
    ]
        .filter((each): each is string => typeof each === "string")
        .join(", ");
    const state = p.ready ? "done" : p.state;
    return (
        <div className="bf-plan-lane" role="img" aria-label={`${p.component.name}: ${label}`} title={label}>
            <span className="bf-plan-today" style={{ left: at(range, dayNumber(now)) }} />
            {p.startBy && p.needBy && (
                <span
                    className={`bf-plan-bar bf-plan-bar-${state} ${p.long ? "bf-plan-bar-long" : ""} ${p.atRisk ? "bf-plan-bar-risk" : ""}`}
                    style={{
                        left: at(range, dayNumber(p.startBy)),
                        width: `max(3px, calc(${at(range, dayNumber(p.needBy))} - ${at(range, dayNumber(p.startBy))}))`,
                    }}
                />
            )}
            {!p.startBy && p.needBy && (
                <span className={`bf-plan-day bf-plan-bar-${state}`} style={{ left: at(range, dayNumber(p.needBy)) }} />
            )}
            {p.atRisk && p.projected && p.projected !== p.needBy && (
                <span className="bf-plan-projected" style={{ left: at(range, dayNumber(p.projected)) }} />
            )}
        </div>
    );
}

/** What a component needs first, picked from the program's others. One that needs it can't be (the server says why). */
export function NeedsDialog({
    program,
    component,
    onSaved,
    onCancel,
}: {
    program: ProgramDetail;
    component: Component;
    onSaved: (component: Component) => void;
    onCancel: () => void;
}) {
    const [ids, setIds] = useState(component.needs);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        setProblem(null);
        try {
            const inOrder = program.components.filter((c) => ids.includes(c.id)).map((c) => c.id);
            onSaved(await buildflow.setNeeds(component.id, inOrder));
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title={`What ${component.name} needs first`}
            confirm="Save"
            busy={busy}
            onConfirm={() => void save()}
            onCancel={onCancel}
            tall
            wide
        >
            {problem && <Notice tone="error">{problem}</Notice>}
            <p className="muted bf-small">
                What has to be ready (made, or bought and in hand) before {component.name} can be started.
            </p>
            <ComponentPicker program={program} picked={ids} onChange={setIds} except={component.id} />
        </Dialog>
    );
}
