import { useEffect, useState } from "react";
import { api, type Account } from "../api";
import { Notice, Time } from "../components";
import { useSession } from "../session";
import { piper, type Diagram, type Release, type Revision, type RevisionDetail } from "./api";

// A diagram's history: its revisions, the latest first, each a stretch of one person's work. Look at one on the drawing,
// name it to keep it as it is ("Rev B, for HF-3"), or restore it, which makes it the drawing again as a new revision.
// Release one, for a design review or before a test: once everyone named for it approves it, it's the diagram's next
// letter (Rev A, B...), and it never changes (server: piper/releases.py).

export function HistoryPanel({
    diagram,
    looking,
    onLook,
    onRestore,
    onReleased,
    onClose,
}: {
    diagram: Diagram;
    looking: number | null; // the revision shown on the drawing, if one is
    onLook: (revision: RevisionDetail | null) => void;
    onRestore: (number: number) => Promise<void>;
    onReleased: (release: Release) => void; // one just released: the diagram's latest release now
    onClose: () => void;
}) {
    const { me } = useSession();
    const [revisions, setRevisions] = useState<Revision[] | null>(null);
    const [releases, setReleases] = useState<Release[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    const [naming, setNaming] = useState<number | null>(null);
    const [releasing, setReleasing] = useState<number | null>(null);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);

    // Listed again as the diagram gets new revisions (a save of one's own amends the latest, which lists the same).
    useEffect(() => {
        piper.revisions(diagram.id).then(setRevisions, (error: unknown) => setProblem(message(error)));
        piper.releases(diagram.id).then(setReleases, (error: unknown) => setProblem(message(error)));
    }, [diagram.id, diagram.revision]);

    const pending = releases.find((release) => release.state === "pending") ?? null;
    const releasedAt = diagram.released_revision ?? 0;

    async function act(action: () => Promise<void>) {
        setBusy(true);
        setProblem(null);
        try {
            await action();
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }

    /** The releases and revisions again, after one's been asked for, decided, or withdrawn. */
    async function reload(changed: Release) {
        const [found, listed] = await Promise.all([piper.releases(diagram.id), piper.revisions(diagram.id)]);
        setReleases(found);
        setRevisions(listed);
        if (changed.state === "released") {
            onReleased(changed);
        }
    }

    async function look(number: number) {
        if (looking === number) {
            onLook(null);
            return;
        }
        setProblem(null);
        try {
            onLook(await piper.revision(diagram.id, number));
        } catch (error) {
            setProblem(message(error));
        }
    }

    return (
        <aside className="piper-history" aria-label="History">
            <div className="piper-panel-head">
                <h2>History</h2>
                <button type="button" className="piper-close" aria-label="Close history" onClick={onClose}>
                    ×
                </button>
            </div>
            <p className="muted piper-small">
                Each revision is one person's changes, up to half an hour of them. Name one to keep it as it is; the
                next change starts another. Release one for a design review or before a test: once everyone you name
                approves it, it's the next Rev (A, B...), and it never changes.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {pending && (
                <PendingRelease
                    release={pending}
                    me={me}
                    busy={busy}
                    onDecide={(approve, comment) =>
                        void act(async () => {
                            const decided = approve
                                ? await piper.approve(diagram.id, pending.id, comment)
                                : await piper.reject(diagram.id, pending.id, comment);
                            await reload(decided);
                        })
                    }
                    onWithdraw={() => void act(async () => reload(await piper.withdraw(diagram.id, pending.id)))}
                />
            )}
            <PastReleases releases={releases.filter((release) => release.state !== "pending")} />
            {revisions === null && !problem && <p className="muted">Loading…</p>}
            <ol className="piper-revisions">
                {revisions?.map((revision, index) => {
                    // Released, or waiting to be: kept as it is, its name too.
                    const kept = !!revision.released || !!revision.release_pending;
                    return (
                        <li key={revision.number} aria-current={looking === revision.number ? "true" : undefined}>
                            <div className="piper-revision-head">
                                <strong>Revision {revision.number}</strong>
                                {index === 0 && <span className="badge">Latest</span>}
                                {revision.released && (
                                    <span className="badge piper-badge-released">Rev {revision.released}</span>
                                )}
                                {revision.release_pending && <span className="badge">Waiting for approval</span>}
                            </div>
                            {revision.note && <p className="piper-revision-note">{revision.note}</p>}
                            <p className="muted piper-small">
                                {revision.author?.name ?? "Someone"}, <Time at={revision.saved_at} />
                                {revision.restored_from !== null &&
                                    `, restored from revision ${revision.restored_from}`}
                            </p>
                            {naming === revision.number ? (
                                <form
                                    className="piper-add-form"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void act(async () => {
                                            const named = await piper.nameRevision(
                                                diagram.id,
                                                revision.number,
                                                note.trim(),
                                            );
                                            setRevisions(
                                                (now) =>
                                                    now?.map((entry) =>
                                                        entry.number === revision.number ? named : entry,
                                                    ) ?? null,
                                            );
                                            setNaming(null);
                                        });
                                    }}
                                >
                                    <input
                                        autoFocus
                                        aria-label={`Name for revision ${revision.number}`}
                                        placeholder="Rev B, for HF-3"
                                        value={note}
                                        maxLength={200}
                                        onChange={(event) => setNote(event.target.value)}
                                    />
                                    <button type="submit" className="button-small" disabled={busy}>
                                        Save
                                    </button>
                                    <button type="button" className="button-small" onClick={() => setNaming(null)}>
                                        Cancel
                                    </button>
                                </form>
                            ) : releasing === revision.number ? (
                                <ReleaseForm
                                    number={revision.number}
                                    me={me}
                                    busy={busy}
                                    onAsk={(approvers, why) =>
                                        void act(async () => {
                                            await reload(
                                                await piper.requestRelease(diagram.id, revision.number, approvers, why),
                                            );
                                            setReleasing(null);
                                        })
                                    }
                                    onCancel={() => setReleasing(null)}
                                />
                            ) : (
                                <div className="piper-revision-actions">
                                    <button
                                        type="button"
                                        className="button-small"
                                        aria-pressed={looking === revision.number}
                                        onClick={() => void look(revision.number)}
                                    >
                                        {looking === revision.number ? "Back to the drawing" : "Look"}
                                    </button>
                                    {!kept && (
                                        <button
                                            type="button"
                                            className="button-small"
                                            onClick={() => {
                                                setNote(revision.note);
                                                setNaming(revision.number);
                                            }}
                                        >
                                            {revision.note ? "Rename" : "Name"}
                                        </button>
                                    )}
                                    {index > 0 && (
                                        <button
                                            type="button"
                                            className="button-small"
                                            disabled={busy}
                                            onClick={() => void act(() => onRestore(revision.number))}
                                        >
                                            Restore
                                        </button>
                                    )}
                                    {/* One release waits at a time, and each is of a revision after the last. */}
                                    {!pending && revision.number > releasedAt && (
                                        <button
                                            type="button"
                                            className="button-small"
                                            onClick={() => setReleasing(revision.number)}
                                        >
                                            Release…
                                        </button>
                                    )}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ol>
        </aside>
    );
}

/** Asking for a revision to be released: what it's for, and who approves it (at least one besides you). */
function ReleaseForm({
    number,
    me,
    busy,
    onAsk,
    onCancel,
}: {
    number: number;
    me: Account | null;
    busy: boolean;
    onAsk: (approvers: number[], note: string) => void;
    onCancel: () => void;
}) {
    const [members, setMembers] = useState<Account[] | null>(null);
    const [chosen, setChosen] = useState<Set<number>>(new Set());
    const [why, setWhy] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        api.users().then(
            (found) =>
                setMembers(
                    found
                        .filter((member) => member.status === "active")
                        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
                ),
            (error: unknown) => setProblem(message(error)),
        );
    }, []);
    const others = [...chosen].some((id) => id !== me?.id);
    return (
        <form
            className="piper-release-form"
            aria-label={`Release revision ${number}`}
            onSubmit={(event) => {
                event.preventDefault();
                onAsk([...chosen], why.trim());
            }}
        >
            <label className="field">
                What it's for
                <input
                    autoFocus
                    value={why}
                    maxLength={2000}
                    placeholder="For HF-3's test readiness review"
                    onChange={(event) => setWhy(event.target.value)}
                />
            </label>
            <fieldset>
                <legend>Approvers</legend>
                {problem && <Notice tone="error">{problem}</Notice>}
                {members === null && !problem && <p className="muted piper-small">Loading the team…</p>}
                <div className="piper-approvers">
                    {members?.map((member) => (
                        <label key={member.id} className="check">
                            <input
                                type="checkbox"
                                checked={chosen.has(member.id)}
                                onChange={(event) => {
                                    const next = new Set(chosen);
                                    if (event.target.checked) {
                                        next.add(member.id);
                                    } else {
                                        next.delete(member.id);
                                    }
                                    setChosen(next);
                                }}
                            />
                            {member.name}
                            {member.id === me?.id && <span className="muted"> (you)</span>}
                        </label>
                    ))}
                </div>
            </fieldset>
            {!others && <p className="muted piper-small">Pick at least one approver besides yourself.</p>}
            <div className="piper-revision-actions">
                <button type="submit" className="button-small button-primary" disabled={busy || !others}>
                    Ask for approval
                </button>
                <button type="button" className="button-small" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    );
}

/** The release waiting for its approvers: who's had their say, and yours if you're one of them. */
function PendingRelease({
    release,
    me,
    busy,
    onDecide,
    onWithdraw,
}: {
    release: Release;
    me: Account | null;
    busy: boolean;
    onDecide: (approve: boolean, comment: string) => void;
    onWithdraw: () => void;
}) {
    const [rejecting, setRejecting] = useState(false);
    const [why, setWhy] = useState("");
    const mine = release.approvals.find(
        (approval) => approval.approver.id === me?.id && approval.decision === "pending",
    );
    return (
        <section className="piper-release" aria-label="Release waiting for approval">
            <h3 className="piper-subhead">Revision {release.revision}, waiting for approval</h3>
            {release.note && <p className="piper-revision-note">{release.note}</p>}
            <p className="muted piper-small">
                Asked for by {release.requested_by?.name ?? "someone"}, <Time at={release.requested_at} />
            </p>
            <ul className="piper-approvals">
                {release.approvals.map((approval) => (
                    <li key={approval.approver.id}>
                        <span className={`piper-decision piper-decision-${approval.decision}`}>
                            {approval.decision === "approved" ? "Approved" : "Waiting"}
                        </span>{" "}
                        {approval.approver.name}
                        {approval.comment && <span className="muted">: {approval.comment}</span>}
                    </li>
                ))}
            </ul>
            {rejecting ? (
                <form
                    className="piper-add-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        onDecide(false, why.trim());
                    }}
                >
                    <input
                        autoFocus
                        aria-label="Why it's rejected"
                        placeholder="PT-101's range is wrong"
                        value={why}
                        maxLength={2000}
                        onChange={(event) => setWhy(event.target.value)}
                    />
                    <button type="submit" className="button-small button-danger" disabled={busy || !why.trim()}>
                        Reject
                    </button>
                    <button type="button" className="button-small" onClick={() => setRejecting(false)}>
                        Cancel
                    </button>
                </form>
            ) : (
                <div className="piper-revision-actions">
                    {mine && (
                        <>
                            <button
                                type="button"
                                className="button-small button-primary"
                                disabled={busy}
                                onClick={() => onDecide(true, "")}
                            >
                                Approve
                            </button>
                            <button type="button" className="button-small" onClick={() => setRejecting(true)}>
                                Reject…
                            </button>
                        </>
                    )}
                    {release.can_withdraw && (
                        <button type="button" className="button-small" disabled={busy} onClick={onWithdraw}>
                            Withdraw
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}

/** The diagram's releases that are over: each released one with its letter and approvers, and those that weren't. */
function PastReleases({ releases }: { releases: Release[] }) {
    if (releases.length === 0) {
        return null;
    }
    const names = (release: Release) => release.approvals.map((approval) => approval.approver.name).join(", ");
    return (
        <section aria-label="Releases">
            <h3 className="piper-subhead">Releases</h3>
            <ul className="piper-releases">
                {releases.map((release) => (
                    <li key={release.id}>
                        {release.state === "released" ? (
                            <>
                                <strong>Rev {release.letter}</strong>: revision {release.revision}, approved by{" "}
                                {names(release)}
                            </>
                        ) : release.state === "rejected" ? (
                            <>
                                Revision {release.revision}, rejected by{" "}
                                {release.approvals
                                    .filter((approval) => approval.decision === "rejected")
                                    .map(
                                        (approval) =>
                                            `${approval.approver.name}: ${approval.comment || "no reason given"}`,
                                    )
                                    .join("; ")}
                            </>
                        ) : (
                            <>Revision {release.revision}, withdrawn</>
                        )}
                        {release.decided_at && (
                            <span className="muted">
                                {" "}
                                · <Time at={release.decided_at} />
                            </span>
                        )}
                        {release.note && <span className="muted piper-small piper-release-note">{release.note}</span>}
                    </li>
                ))}
            </ul>
        </section>
    );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
