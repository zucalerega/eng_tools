import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Feedback, type FeedbackList } from "./api";
import { Notice, Time } from "./components";
import { Markdown } from "./markdown";

// Bug reports and feature requests (feedback.py on the server). Anyone signed in sends them from Help, beside the page
// they're on, and sees what's become of theirs there. Claude looks at each for the site's owner, who approves one on
// Admin > Requests to have Claude Code build it; any admin can decline one, or mark it done, with a reply.

const STATUS: Record<Feedback["status"], string> = {
    new: "Waiting for the owner",
    approved: "Approved: Claude Code is building it",
    declined: "Declined",
    done: "Done",
};
const KIND: Record<Feedback["kind"], string> = { bug: "Bug", feature: "Feature" };
const LOOKING_EVERY_MS = 4_000; // how often the admins' list looks again while Claude is looking at one

/** Help's Requests tab: send a bug report or a feature request, and see your own. */
export function FeedbackPane({ page }: { page: string }) {
    const [mine, setMine] = useState<Feedback[] | null>(null);
    const [kind, setKind] = useState<Feedback["kind"]>("bug");
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    useEffect(() => {
        api.myFeedback().then(setMine, (error: Error) => setProblem(error.message));
    }, []);

    async function send(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setProblem(null);
        setSent(false);
        try {
            const item = await api.sendFeedback({ kind, title, body, page });
            setMine((now) => [item, ...(now ?? [])]);
            setTitle("");
            setBody("");
            setSent(true);
        } catch (error) {
            setProblem((error as Error).message);
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="feedback-pane">
            <p className="muted">
                Found a bug, or want something the site doesn&apos;t do? Tell the site&apos;s owner. Claude looks at it
                first, and the owner decides whether Claude Code builds it. Not sure it&apos;s a bug? Ask Claude first.
            </p>
            <form className="feedback-form" onSubmit={(event) => void send(event)}>
                <div className="segmented" role="group" aria-label="What it is">
                    {(["bug", "feature"] as const).map((each) => (
                        <button key={each} type="button" aria-pressed={kind === each} onClick={() => setKind(each)}>
                            {each === "bug" ? "Bug report" : "Feature request"}
                        </button>
                    ))}
                </div>
                <label className="field">
                    Title
                    <input
                        value={title}
                        maxLength={200}
                        placeholder={
                            kind === "bug" ? "Check-in drops a part's references" : "Sort Yorg's tests by date"
                        }
                        onChange={(event) => setTitle(event.target.value)}
                    />
                </label>
                <label className="field">
                    {kind === "bug" ? "What happened, and what you expected" : "What you'd like, and what it's for"}
                    <textarea
                        rows={5}
                        maxLength={10_000}
                        value={body}
                        placeholder={
                            kind === "bug"
                                ? "What you did, step by step, what happened (the error's words, if there was one), and what should have."
                                : "What you're trying to do, and how the site could help."
                        }
                        onChange={(event) => setBody(event.target.value)}
                    />
                </label>
                <div className="feedback-send">
                    <button
                        type="submit"
                        className="button-primary button-small"
                        disabled={busy || !title.trim() || !body.trim()}
                    >
                        Send
                    </button>
                    <span className="muted">
                        With the page you&apos;re on. It goes to Anthropic for Claude to read.
                    </span>
                </div>
            </form>
            {problem && <Notice tone="error">{problem}</Notice>}
            {sent && <Notice tone="info">Sent. You&apos;ll see what becomes of it here.</Notice>}
            {mine && mine.length > 0 && (
                <section aria-labelledby="mine-title">
                    <h3 id="mine-title" className="feedback-mine-title">
                        Your requests
                    </h3>
                    <ul className="feedback-mine">
                        {mine.map((item) => (
                            <li key={item.id}>
                                <span className="badge">{KIND[item.kind]}</span> {item.title}
                                <div className="muted">
                                    {STATUS[item.status]} · <Time at={item.created_at} />
                                </div>
                                {item.reply && <p className="feedback-reply">{item.reply}</p>}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

/** Admin > Requests: every request, with Claude's look at each, to approve (the owner), decline, or mark done. */
export function FeedbackAdmin() {
    const [list, setList] = useState<FeedbackList | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [shown, setShown] = useState<"open" | "all">("open");
    const reload = useCallback(async () => {
        try {
            setList(await api.allFeedback());
            setProblem(null);
        } catch (error) {
            setProblem((error as Error).message);
        }
    }, []);
    useEffect(() => {
        void reload();
    }, [reload]);
    // While Claude is looking at one, until it's done.
    const looking = list?.requests.some((item) => item.looking) ?? false;
    useEffect(() => {
        if (!looking) {
            return;
        }
        const timer = setTimeout(() => void reload(), LOOKING_EVERY_MS);
        return () => clearTimeout(timer);
    }, [looking, list, reload]);

    if (!list) {
        return problem ? <Notice tone="error">{problem}</Notice> : null;
    }
    const open = list.requests.filter((item) => item.status === "new" || item.status === "approved");
    const items = shown === "open" ? open : list.requests;
    return (
        <>
            {problem && <Notice tone="error">{problem}</Notice>}
            <div className="setting">
                <p className="muted">
                    Bug reports and feature requests people sent from Help, with Claude&apos;s look at each from the
                    help. Approving one has Claude Code build it, on the owner&apos;s Claude account, and open a draft
                    pull request to review; declining or finishing one tells whoever sent it, with your reply.
                </p>
                {!list.can_approve && list.why_not_approve && <p className="muted">{list.why_not_approve}.</p>}
            </div>
            <div className="segmented feedback-shown" role="group" aria-label="Show">
                <button type="button" aria-pressed={shown === "open"} onClick={() => setShown("open")}>
                    Open ({open.length})
                </button>
                <button type="button" aria-pressed={shown === "all"} onClick={() => setShown("all")}>
                    All ({list.requests.length})
                </button>
            </div>
            {items.length === 0 ? (
                <p className="muted">{shown === "open" ? "No open requests." : "No one has sent a request yet."}</p>
            ) : (
                items.map((item) => (
                    <FeedbackItem key={item.id} item={item} canApprove={list.can_approve} reload={reload} />
                ))
            )}
        </>
    );
}

function FeedbackItem({
    item,
    canApprove,
    reload,
}: {
    item: Feedback;
    canApprove: boolean;
    reload: () => Promise<void>;
}) {
    const [reply, setReply] = useState("");
    const [note, setNote] = useState("");
    const [approving, setApproving] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const sender = item.sender?.name ?? "Someone";

    async function run(action: () => Promise<unknown>) {
        setBusy(true);
        setProblem(null);
        try {
            await action();
            setReply("");
            setApproving(false);
            await reload();
        } catch (error) {
            setProblem((error as Error).message);
        } finally {
            setBusy(false);
        }
    }
    const heading = `feedback-${item.id}`;
    return (
        <article className="feedback-item" aria-labelledby={heading}>
            <header className="feedback-item-head">
                <span className="badge">{KIND[item.kind]}</span>
                <h3 id={heading}>
                    #{item.id} {item.title}
                </h3>
                <span className={`feedback-status feedback-${item.status}`}>{STATUS[item.status]}</span>
            </header>
            <p className="muted feedback-from">
                {sender} · <Time at={item.created_at} />
                {item.page && <> · from {item.page}</>}
            </p>
            <p className="feedback-body">{item.body}</p>
            <section className="feedback-look" aria-label="Claude's look">
                <h4>Claude&apos;s look</h4>
                {item.looking ? (
                    <p className="chat-thinking">Claude is looking at it…</p>
                ) : item.evaluation ? (
                    <Markdown source={item.evaluation} />
                ) : (
                    <p className="muted">{item.evaluation_problem ?? "Claude hasn't looked at it."}</p>
                )}
                {item.evaluation_problem && item.evaluation && (
                    <p className="muted">Its last look didn&apos;t finish: {item.evaluation_problem}</p>
                )}
                {!item.looking && (item.evaluation_problem || !item.evaluation) && item.status === "new" && (
                    <button
                        type="button"
                        className="button-small"
                        disabled={busy}
                        onClick={() => void run(() => api.lookAgain(item.id))}
                    >
                        Ask Claude to look again
                    </button>
                )}
            </section>
            {item.session_url && (
                <p>
                    <a href={item.session_url} target="_blank" rel="noreferrer">
                        Claude Code&apos;s session
                    </a>
                    {item.note && <span className="muted"> · Your note: {item.note}</span>}
                </p>
            )}
            {(item.status === "declined" || item.status === "done") && (
                <p className="muted">
                    {STATUS[item.status]}
                    {item.decided_by && <> by {item.decided_by.name}</>}
                    {item.decided_at && (
                        <>
                            , <Time at={item.decided_at} />
                        </>
                    )}
                    {item.reply && <>: “{item.reply}”</>}
                </p>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
            {approving ? (
                <div className="feedback-actions">
                    <label className="field">
                        A note for Claude Code (optional)
                        <textarea rows={2} maxLength={2_000} value={note} onChange={(e) => setNote(e.target.value)} />
                    </label>
                    <div className="feedback-buttons">
                        <button
                            type="button"
                            className="button-primary button-small"
                            disabled={busy}
                            onClick={() => void run(() => api.approveFeedback(item.id, note))}
                        >
                            Start Claude Code
                        </button>
                        <button type="button" className="button-small" onClick={() => setApproving(false)}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                (item.status === "new" || item.status === "approved") && (
                    <div className="feedback-actions">
                        <label className="field">
                            Reply to {sender}
                            <textarea
                                rows={2}
                                maxLength={2_000}
                                value={reply}
                                onChange={(e) => setReply(e.target.value)}
                            />
                        </label>
                        <div className="feedback-buttons">
                            {item.status === "new" && canApprove && (
                                <button
                                    type="button"
                                    className="button-primary button-small"
                                    disabled={busy}
                                    onClick={() => setApproving(true)}
                                >
                                    Approve…
                                </button>
                            )}
                            {item.status === "new" && (
                                <button
                                    type="button"
                                    className="button-small"
                                    disabled={busy || !reply.trim()}
                                    onClick={() => void run(() => api.declineFeedback(item.id, reply))}
                                >
                                    Decline
                                </button>
                            )}
                            <button
                                type="button"
                                className="button-small"
                                disabled={busy}
                                onClick={() => void run(() => api.finishFeedback(item.id, reply))}
                            >
                                Mark done
                            </button>
                        </div>
                    </div>
                )
            )}
        </article>
    );
}
