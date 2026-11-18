import { useEffect, useState, type FormEvent } from "react";
import { Dialog, Notice, Time } from "../components";
import { Markdown } from "../markdown";
import { Link, navigate } from "../router";
import { useDemo } from "../session";
import {
    buildflow,
    type Component,
    type Milestone,
    type Phase,
    type ProgramDetail,
    type Review,
    type Status,
} from "./api";
import { linkHref, siteTarget, tidyUrl } from "./links";
import { ComponentPicker } from "./Picker";
import { coveredBy, reviewPath, through } from "./reviews";
import { formatDay, statusAt, statusName, today } from "./vehicle";

// A design review (/buildflow/programs/{id}/reviews/{review}): one held for several of a program's components at once,
// at one of its review milestones (a subsystem's PDR, say). Its day is each one's due date there, and passing it passes
// each one there; each one's progress is still its own, set here or on the bill. Its files are links (to SharePoint,
// say), and its notes are taken in it, in Markdown. Anyone signed in keeps it. And the program page's list of its
// reviews, with the dialog that starts one.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ORDER: Status[] = ["not_started", "in_progress", "done", "blocked", "skipped"];

export function ReviewPage({ programId, id }: { programId: number; id: number }) {
    const [program, setProgram] = useState<ProgramDetail | null>(null);
    const [review, setReview] = useState<Review | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [asking, setAsking] = useState<"pass" | "remove" | "components" | null>(null);
    const demo = useDemo();

    const load = () =>
        Promise.all([buildflow.program(programId), buildflow.review(id)]).then(
            ([loaded, found]) => {
                setProgram(loaded);
                setReview(found);
            },
            (error: unknown) => setProblem(message(error)),
        );
    useEffect(() => {
        void load();
    }, [programId, id]);

    /** Make a change, then show the review and its components as they are after it (if it didn't work, says why). */
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

    if (!program || !review) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    const milestone = program.milestones.find((m) => m.id === review.milestone_id);
    if (review.program_id !== program.id || !milestone) {
        return (
            <Notice tone="error">
                That review isn&apos;t {program.name}&apos;s.{" "}
                <Link to={`/buildflow/programs/${program.id}`}>Back to {program.name}</Link>
            </Notice>
        );
    }
    const covered = coveredBy(review, program);
    const passed = covered.filter((c) => through(c, milestone)).length;
    const archived = program.archived_at !== null;
    const removed = review.removed_at !== null;
    const locked = demo || archived || removed;
    // Passed on its day, once that's come; today, if it's passed early.
    const passDay = review.held_on && review.held_on <= today() ? review.held_on : today();
    const subsystems = new Map(program.subsystems.map((s) => [s.id, s.name]));
    return (
        <section className="bf-review">
            <div className="page-head">
                <div className="page-title">
                    <nav className="breadcrumbs" aria-label="Programs">
                        <Link to="/buildflow">Programs</Link>
                        <span className="separator">/</span>
                        <Link to={`/buildflow/programs/${program.id}`}>{program.name}</Link>
                    </nav>
                    <h1>{review.name}</h1>
                </div>
                {!locked && (
                    <div className="page-actions">
                        <button type="button" onClick={() => setAsking("remove")}>
                            Remove…
                        </button>
                        <button
                            type="button"
                            className="button-primary"
                            disabled={passed === covered.length}
                            onClick={() => setAsking("pass")}
                        >
                            Pass…
                        </button>
                    </div>
                )}
            </div>
            <p className="bf-review-summary">
                <span className="tag">{milestone.name}</span>
                {milestone.title && <span className="muted">{milestone.title}</span>}
                <span>{review.held_on ? formatDay(review.held_on) : "No day yet"}</span>
                <span>
                    {passed} of {covered.length} {statusName("done", milestone).toLowerCase()}
                </span>
            </p>
            {archived && (
                <Notice tone="warning">{program.name} is archived: an admin can bring it back to change it.</Notice>
            )}
            {removed && (
                <Notice tone="warning">
                    This review was removed: it&apos;s kept, with its notes and files.{" "}
                    {!demo && !archived && (
                        <button
                            type="button"
                            className="button-small"
                            onClick={() => void run(() => buildflow.restoreReview(review.id))}
                        >
                            Bring it back
                        </button>
                    )}
                </Notice>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}

            <fieldset className="bf-review-body" disabled={locked}>
                <div className="bf-review-about">
                    <NameField
                        value={review.name}
                        onSave={(name) => run(() => buildflow.changeReview(review.id, { name }))}
                    />
                    <label className="field">
                        Day
                        <input
                            type="date"
                            value={review.held_on ?? ""}
                            onChange={(event) =>
                                void run(() =>
                                    buildflow.changeReview(review.id, { held_on: event.target.value || null }),
                                )
                            }
                        />
                    </label>
                    <p className="muted bf-small bf-grow">
                        Its day is each component&apos;s {milestone.name} date, but those through it already.
                    </p>
                </div>

                <section aria-label="Components">
                    <div className="bf-section-head">
                        <h2>
                            Components <span className="muted">{covered.length}</span>
                        </h2>
                        <button type="button" className="button-small" onClick={() => setAsking("components")}>
                            Change components…
                        </button>
                    </div>
                    {covered.length === 0 ? (
                        <p className="muted">
                            None yet: <em>Change components…</em> picks the ones it covers.
                        </p>
                    ) : (
                        <div className="table-scroll">
                            <table className="table bf-review-table" aria-label={`${review.name}'s components`}>
                                <thead>
                                    <tr>
                                        <th>Component</th>
                                        <th>Subsystem</th>
                                        <th>{milestone.name}</th>
                                        <th>Day</th>
                                        <th>Actions, outcome</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {covered.map((component) => (
                                        <CoveredRow
                                            key={component.id}
                                            component={component}
                                            milestone={milestone}
                                            subsystem={subsystems.get(component.subsystem_id) ?? ""}
                                            passDay={passDay}
                                            run={run}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                <section aria-label="Files">
                    <h2>Files</h2>
                    {review.files.length === 0 && (
                        <p className="muted bf-small">
                            None yet: its slides, its package, its minutes, wherever they&apos;re kept (SharePoint,
                            say).
                        </p>
                    )}
                    <ul className="plain bf-review-files">
                        {review.files.map((file) => (
                            <li key={file.id}>
                                {siteTarget(file.url) ? (
                                    <Link to={file.url}>{file.title || file.url}</Link>
                                ) : (
                                    <a href={linkHref(file.url)} target="_blank" rel="noopener noreferrer">
                                        {file.title || file.url}
                                    </a>
                                )}
                                <span className="muted bf-small">
                                    {file.added_by?.name ?? "Someone"}, <Time at={file.added_at} />
                                </span>
                                <button
                                    type="button"
                                    className="bf-remove"
                                    aria-label={`Remove ${file.title || file.url}`}
                                    onClick={() => void run(() => buildflow.removeReviewFile(review.id, file.id))}
                                >
                                    ✕
                                </button>
                            </li>
                        ))}
                    </ul>
                    <AddFile onAdd={(body) => run(() => buildflow.addReviewFile(review.id, body))} />
                </section>

                <Notes
                    notes={review.notes}
                    onSave={(notes) => run(() => buildflow.changeReview(review.id, { notes }))}
                />
            </fieldset>

            {asking === "pass" && (
                <Dialog
                    title={`Pass ${review.name}?`}
                    confirm="Pass"
                    onConfirm={() => {
                        setAsking(null);
                        void run(() => buildflow.passReview(review.id, passDay));
                    }}
                    onCancel={() => setAsking(null)}
                >
                    <p>
                        Each of its components not through {milestone.name} yet passes it, on {formatDay(passDay)}:{" "}
                        {covered.length - passed} of them. Each one&apos;s progress is still its own after, to set
                        apart: back in progress with actions to close, say.
                    </p>
                </Dialog>
            )}
            {asking === "remove" && (
                <Dialog
                    title={`Remove ${review.name}?`}
                    confirm="Remove"
                    onConfirm={() => {
                        setAsking(null);
                        void run(() => buildflow.removeReview(review.id));
                    }}
                    onCancel={() => setAsking(null)}
                >
                    <p>
                        It comes off {program.name}&apos;s reviews, kept with its notes and files, and its
                        components&apos; progress stays as it is. Anyone can bring it back.
                    </p>
                </Dialog>
            )}
            {asking === "components" && (
                <ComponentsDialog
                    program={program}
                    picked={covered.map((c) => c.id)}
                    title={`${review.name}'s components`}
                    onSave={(ids) => {
                        setAsking(null);
                        void run(() => buildflow.changeReview(review.id, { component_ids: ids }));
                    }}
                    onCancel={() => setAsking(null)}
                />
            )}
        </section>
    );
}

/** A component the review covers: where it is at the review's milestone, set here as on the bill, and its note there
 * (a review's actions, its outcome). */
function CoveredRow({
    component,
    milestone,
    subsystem,
    passDay,
    run,
}: {
    component: Component;
    milestone: Milestone;
    subsystem: string;
    passDay: string;
    run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
    const kept = component.progress.find((p) => p.milestone_id === milestone.id);
    const status = statusAt(component, milestone);
    const saved = kept?.note ?? "";
    const [note, setNote] = useState(saved);
    useEffect(() => setNote(saved), [saved]);
    const day = status === "done" ? kept?.done_on : kept?.due;
    return (
        <tr>
            <th scope="row">
                <Link
                    to={`/buildflow/programs/${component.program_id}?phase=${milestone.phase}&component=${component.id}`}
                >
                    {component.name}
                </Link>
            </th>
            <td className="muted">{subsystem}</td>
            <td>
                <select
                    aria-label={`${component.name}: ${milestone.name}`}
                    value={status}
                    onChange={(event) => {
                        const next = event.target.value as Status;
                        void run(() =>
                            buildflow.setProgress(
                                component.id,
                                milestone.id,
                                next === "done" ? { status: next, done_on: passDay } : { status: next },
                            ),
                        );
                    }}
                >
                    {ORDER.map((each) => (
                        <option key={each} value={each}>
                            {statusName(each, milestone)}
                        </option>
                    ))}
                </select>
            </td>
            <td className="bf-due-day">{day ? formatDay(day) : ""}</td>
            <td>
                <input
                    className="bf-note"
                    aria-label={`${component.name}: actions, outcome`}
                    value={note}
                    maxLength={10_000}
                    onChange={(event) => setNote(event.target.value)}
                    onBlur={() => {
                        if (note.trim() !== saved) {
                            void run(() => buildflow.setProgress(component.id, milestone.id, { note: note.trim() }));
                        }
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.currentTarget.blur();
                        }
                    }}
                />
            </td>
        </tr>
    );
}

/** The review's name, changed where it is, saved when it's left (or on Enter). */
function NameField({ value, onSave }: { value: string; onSave: (name: string) => Promise<boolean> }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <label className="field bf-review-name">
            Name
            <input
                value={text}
                maxLength={200}
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
        </label>
    );
}

/** A file for the review: its address (pasted from SharePoint, say), and a name for it. */
function AddFile({ onAdd }: { onAdd: (body: { url: string; title: string }) => Promise<boolean> }) {
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("");
    async function add(event: FormEvent) {
        event.preventDefault();
        if (await onAdd({ url: tidyUrl(url), title: title.trim() })) {
            setUrl("");
            setTitle("");
        }
    }
    return (
        <form className="bf-review-add-file" onSubmit={(event) => void add(event)}>
            <label className="field bf-grow">
                Address
                <input
                    value={url}
                    placeholder="https://… (its slides, package, minutes)"
                    onChange={(event) => setUrl(event.target.value)}
                />
            </label>
            <label className="field">
                Name
                <input
                    value={title}
                    maxLength={200}
                    placeholder="Slides"
                    onChange={(event) => setTitle(event.target.value)}
                />
            </label>
            <button type="submit" disabled={!url.trim()}>
                Add file
            </button>
        </form>
    );
}

/** The notes taken in the review, in Markdown: shown, and edited with Edit notes, then saved. */
function Notes({ notes, onSave }: { notes: string; onSave: (notes: string) => Promise<boolean> }) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(notes);
    const [saving, setSaving] = useState(false);
    const changed = editing && text.trim() !== notes;

    // Leaving with notes not saved yet: the browser asks first.
    useEffect(() => {
        if (!changed) {
            return;
        }
        const leaving = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", leaving);
        return () => window.removeEventListener("beforeunload", leaving);
    }, [changed]);

    async function save() {
        setSaving(true);
        if (await onSave(text.trim())) {
            setEditing(false);
        }
        setSaving(false);
    }
    return (
        <section aria-label="Notes">
            <div className="bf-section-head">
                <h2>Notes</h2>
                {!editing && (
                    <button
                        type="button"
                        className="button-small"
                        onClick={() => {
                            setText(notes);
                            setEditing(true);
                        }}
                    >
                        Edit notes
                    </button>
                )}
            </div>
            {editing ? (
                <div className="bf-review-notes-edit">
                    <textarea
                        aria-label="Notes"
                        value={text}
                        rows={14}
                        maxLength={50_000}
                        placeholder={"What was said, and its actions:\n\n- RFA 1: …"}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                void save();
                            }
                        }}
                    />
                    <div className="bf-review-notes-actions">
                        <span className="muted bf-small bf-grow">
                            Markdown: <code>-</code> for a list, <code>**bold**</code>, <code>[a link](https://…)</code>
                        </span>
                        <button type="button" disabled={saving} onClick={() => setEditing(false)}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="button-primary"
                            disabled={saving || !changed}
                            onClick={() => void save()}
                        >
                            Save notes
                        </button>
                    </div>
                </div>
            ) : notes ? (
                <div className="bf-review-notes">
                    <Markdown source={notes} />
                </div>
            ) : (
                <p className="muted">None yet. Take them here as the review goes: what was said, and its actions.</p>
            )}
        </section>
    );
}

/** In the program's order, as the review lists them. */
const inOrder = (program: ProgramDetail, ids: number[]) =>
    program.components.filter((c) => ids.includes(c.id)).map((c) => c.id);

function ComponentsDialog({
    program,
    picked,
    title,
    onSave,
    onCancel,
}: {
    program: ProgramDetail;
    picked: number[];
    title: string;
    onSave: (ids: number[]) => void;
    onCancel: () => void;
}) {
    const [ids, setIds] = useState(picked);
    return (
        <Dialog
            title={title}
            confirm="Save"
            onConfirm={() => onSave(inOrder(program, ids))}
            onCancel={onCancel}
            tall
            wide
        >
            <ComponentPicker program={program} picked={ids} onChange={setIds} />
        </Dialog>
    );
}

/** A new review: at which of the program's reviews, its name, its day, and the components it covers. */
function NewReview({ program, phase, onClose }: { program: ProgramDetail; phase: Phase; onClose: () => void }) {
    const stones = program.milestones.filter((m) => m.review);
    // The review that's next: the first some component isn't through yet, in the phase picked if there's one in it.
    const next = stones.filter((m) => program.components.some((c) => !through(c, m)));
    const first = next.find((m) => m.phase === phase) ?? next[0] ?? stones.find((m) => m.phase === phase) ?? stones[0];
    const [milestoneId, setMilestoneId] = useState(first?.id ?? 0);
    const [name, setName] = useState("");
    const [day, setDay] = useState("");
    const [picked, setPicked] = useState<number[]>([]);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const milestone = stones.find((m) => m.id === milestoneId);

    async function add() {
        setBusy(true);
        setProblem(null);
        try {
            const made = await buildflow.addReview(program.id, {
                milestone_id: milestoneId,
                name: name.trim(),
                held_on: day || null,
                component_ids: inOrder(program, picked),
            });
            navigate(reviewPath(made));
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }

    if (!milestone) {
        return (
            <Dialog title="New review" cancel="Close" onCancel={onClose}>
                <p>
                    {program.name} has no review milestones yet. An admin marks one a review on its layout (its PDR,
                    say).
                </p>
            </Dialog>
        );
    }
    return (
        <Dialog
            title="New review"
            confirm="Add it"
            busy={busy}
            disabled={!name.trim()}
            onConfirm={() => void add()}
            onCancel={onClose}
            tall
            wide
        >
            {problem && <Notice tone="error">{problem}</Notice>}
            <div className="bf-review-new">
                <label className="field">
                    At
                    <select value={milestoneId} onChange={(event) => setMilestoneId(Number(event.target.value))}>
                        {stones.map((each) => (
                            <option key={each.id} value={each.id}>
                                {each.name}
                                {each.title ? `: ${each.title}` : ""}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field bf-grow">
                    Name
                    <input
                        value={name}
                        maxLength={200}
                        placeholder={`Feed system ${milestone.name}`}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>
                <label className="field">
                    Day
                    <input type="date" value={day} onChange={(event) => setDay(event.target.value)} />
                </label>
            </div>
            <p className="muted bf-small">
                The components it covers. Its day is each one&apos;s {milestone.name} date, and passing it passes each
                one.
            </p>
            <ComponentPicker program={program} picked={picked} onChange={setPicked} />
        </Dialog>
    );
}

/** The program's reviews, on its page: each one's milestone, day, and how many of its components have passed; and New
 * review. */
export function ReviewsSection({ program, phase }: { program: ProgramDetail; phase: Phase }) {
    const demo = useDemo();
    const [adding, setAdding] = useState(false);
    const [removed, setRemoved] = useState<Review[] | null>(null);
    const open = program.archived_at === null && !demo;
    return (
        <section className="bf-reviews" aria-label="Reviews">
            <div className="bf-section-head">
                <h2>Reviews</h2>
                {open && (
                    <button type="button" className="button-small" onClick={() => setAdding(true)}>
                        New review
                    </button>
                )}
            </div>
            {program.reviews.length === 0 ? (
                <p className="muted">
                    None yet. A review covers several components at once, at one of the program&apos;s reviews (a
                    subsystem&apos;s PDR, say): its day, its files, and its notes, in one place.
                </p>
            ) : (
                <div className="table-scroll">
                    <table className="table bf-reviews-table" aria-label="The program's reviews">
                        <thead>
                            <tr>
                                <th>Review</th>
                                <th>At</th>
                                <th>Day</th>
                                <th>Passed</th>
                                <th>Files</th>
                            </tr>
                        </thead>
                        <tbody>
                            {program.reviews.map((review) => {
                                const milestone = program.milestones.find((m) => m.id === review.milestone_id);
                                const covered = coveredBy(review, program);
                                const passed = milestone ? covered.filter((c) => through(c, milestone)).length : 0;
                                const late = !!review.held_on && review.held_on < today() && passed < covered.length;
                                return (
                                    <tr key={review.id}>
                                        <th scope="row">
                                            <Link to={reviewPath(review)}>{review.name}</Link>
                                        </th>
                                        <td>{milestone?.name}</td>
                                        <td className={late ? "bf-late bf-due-day" : "bf-due-day"}>
                                            {review.held_on ? (
                                                formatDay(review.held_on)
                                            ) : (
                                                <span className="muted">No day yet</span>
                                            )}
                                        </td>
                                        <td>
                                            {passed} of {covered.length}
                                        </td>
                                        <td>{review.files.length || ""}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {removed === null ? (
                <button
                    type="button"
                    className="bf-link-button bf-small"
                    onClick={() => buildflow.reviews(program.id, true).then(setRemoved, () => setRemoved([]))}
                >
                    Removed reviews
                </button>
            ) : (
                <p className="bf-small">
                    <span className="muted">Removed: </span>
                    {removed.length === 0
                        ? "none."
                        : removed.map((review, index) => (
                              <span key={review.id}>
                                  {index > 0 && ", "}
                                  <Link to={reviewPath(review)}>{review.name}</Link>
                              </span>
                          ))}
                </p>
            )}
            {adding && <NewReview program={program} phase={phase} onClose={() => setAdding(false)} />}
        </section>
    );
}
