import { useEffect, useState } from "react";
import { Notice, Time } from "../components";
import { piper, type Diagram, type Revision, type RevisionDetail } from "./api";

// A diagram's history: its revisions, the latest first, each a stretch of one person's work. Look at one on the drawing,
// name it to keep it as it is ("Rev B, for HF-3"), or restore it, which makes it the drawing again as a new revision.

export function HistoryPanel({
    diagram,
    looking,
    onLook,
    onRestore,
    onClose,
}: {
    diagram: Diagram;
    looking: number | null; // the revision shown on the drawing, if one is
    onLook: (revision: RevisionDetail | null) => void;
    onRestore: (number: number) => Promise<void>;
    onClose: () => void;
}) {
    const [revisions, setRevisions] = useState<Revision[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [naming, setNaming] = useState<number | null>(null);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);

    // Listed again as the diagram gets new revisions (a save of one's own amends the latest, which lists the same).
    useEffect(() => {
        piper.revisions(diagram.id).then(setRevisions, (error: unknown) => setProblem(message(error)));
    }, [diagram.id, diagram.revision]);

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

    async function name(number: number) {
        setBusy(true);
        try {
            const named = await piper.nameRevision(diagram.id, number, note.trim());
            setRevisions((now) => now?.map((revision) => (revision.number === number ? named : revision)) ?? null);
            setNaming(null);
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }

    async function restore(number: number) {
        setBusy(true);
        setProblem(null);
        try {
            await onRestore(number);
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
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
                next change starts another.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {revisions === null && !problem && <p className="muted">Loading…</p>}
            <ol className="piper-revisions">
                {revisions?.map((revision, index) => (
                    <li key={revision.number} aria-current={looking === revision.number ? "true" : undefined}>
                        <div className="piper-revision-head">
                            <strong>Revision {revision.number}</strong>
                            {index === 0 && <span className="badge">Latest</span>}
                        </div>
                        {revision.note && <p className="piper-revision-note">{revision.note}</p>}
                        <p className="muted piper-small">
                            {revision.author?.name ?? "Someone"}, <Time at={revision.saved_at} />
                            {revision.restored_from !== null && `, restored from revision ${revision.restored_from}`}
                        </p>
                        {naming === revision.number ? (
                            <form
                                className="piper-add-form"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void name(revision.number);
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
                                {index > 0 && (
                                    <button
                                        type="button"
                                        className="button-small"
                                        disabled={busy}
                                        onClick={() => void restore(revision.number)}
                                    >
                                        Restore
                                    </button>
                                )}
                            </div>
                        )}
                    </li>
                ))}
            </ol>
        </aside>
    );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
