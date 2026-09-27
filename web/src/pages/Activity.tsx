import { useEffect, useState, type ReactNode } from "react";
import { api, type VaultEvent } from "../api";
import { Notice, Time } from "../components";
import { formatDay } from "../format";
import { fileUrl, folderUrl, parentOf, trashUrl } from "../paths";
import { Link } from "../router";
import { useVault } from "../store";

const PAGE = 50;

interface Feed {
    events: VaultEvent[]; // newest first
    more: boolean; // whether there are older events to load
}

/** The newest page on top of what's shown, unless events came in faster than a page: then just the newest. */
function withNewest(newest: VaultEvent[], feed: Feed | null): Feed {
    const oldest = newest.at(-1)?.id;
    if (!feed || oldest === undefined || !feed.events.some((event) => event.id <= oldest)) {
        return { events: newest, more: newest.length === PAGE };
    }
    return { events: [...newest, ...feed.events.filter((event) => event.id < oldest)], more: feed.more };
}

export function Activity() {
    const vault = useVault();
    const [feed, setFeed] = useState<Feed | null>(null);
    const [problem, setProblem] = useState<string | null>(null);

    // The newest events, loaded again whenever something in the vault changes.
    useEffect(() => {
        let current = true;
        api.activity({ limit: PAGE }).then(
            (newest) => current && setFeed((shown) => withNewest(newest, shown)),
            (error: Error) => current && setProblem(error.message),
        );
        return () => {
            current = false;
        };
    }, [vault.revision]);

    async function loadOlder() {
        try {
            const older = await api.activity({ before: feed?.events.at(-1)?.id, limit: PAGE });
            setFeed((shown) => ({ events: [...(shown?.events ?? []), ...older], more: older.length === PAGE }));
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
    }

    if (feed === null) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    const { events, more } = feed;
    const days = new Map<string, VaultEvent[]>();
    for (const event of events) {
        const day = formatDay(event.at);
        days.set(day, [...(days.get(day) ?? []), event]);
    }
    return (
        <section>
            <h1>Activity</h1>
            {problem && <Notice tone="error">{problem}</Notice>}
            {events.length === 0 && <p className="empty">Nothing has happened yet.</p>}
            {[...days].map(([day, dayEvents]) => (
                <section key={day} className="day">
                    <h2>{day}</h2>
                    <ul className="feed">
                        {dayEvents.map((event) => (
                            <li key={event.id}>
                                <span className="feed-text">{describe(event)}</span>
                                <Time at={event.at} />
                                {event.comment && <blockquote>{event.comment}</blockquote>}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
            {more && events.length > 0 && (
                <button type="button" onClick={loadOlder}>
                    Show older
                </button>
            )}
        </section>
    );
}

function describe(event: VaultEvent): ReactNode {
    const who = event.user?.name ?? "Someone";
    const detail = event.detail;
    const text = (key: string) => (detail[key] === undefined || detail[key] === null ? "" : String(detail[key]));
    const path = text("path");
    const file = event.file_id ? <Link to={fileUrl(event.file_id)}>{path}</Link> : <strong>{path}</strong>;
    const place = path ? <Link to={folderUrl(path)}>{path}</Link> : "the whole vault";
    switch (event.action) {
        case "add":
            return (
                <>
                    {who} added {file}
                </>
            );
        case "checkin":
            return (
                <>
                    {who} checked in {file} v{text("number")}
                </>
            );
        case "revert":
            return (
                <>
                    {who} reverted {file} to v{text("reverted_to")}, making v{text("number")}
                </>
            );
        case "checkout":
            return (
                <>
                    {who} checked out {file} on {text("host")}
                </>
            );
        case "undo_checkout":
            return detail.unchanged ? (
                <>
                    {who} checked in {file} without changes
                </>
            ) : (
                <>
                    {who} undid their check-out of {file}
                </>
            );
        case "break_lock":
            return (
                <>
                    {who} released {text("holder")}'s check-out of {file}
                </>
            );
        case "delete":
            return (
                <>
                    {who} deleted {file}
                </>
            );
        case "restore":
            return (
                <>
                    {who} restored {file}
                </>
            );
        case "delete_folder": {
            const count = Number(detail.files ?? 0);
            return (
                <>
                    {who} deleted the folder <Link to={trashUrl(parentOf(path))}>{path}</Link>
                    {count > 0 && (count === 1 ? " and the file in it" : ` and the ${count} files in it`)}
                </>
            );
        }
        case "restore_folder":
            return (
                <>
                    {who} restored the folder {place}
                </>
            );
        case "move":
            return (
                <>
                    {who} moved {text("moved_from")} to {file}
                </>
            );
        case "rename":
            return (
                <>
                    {who} renamed {text("moved_from")} to {file}
                </>
            );
        case "move_folder":
            return (
                <>
                    {who} moved the folder {text("moved_from")} to {place}
                </>
            );
        case "rename_folder":
            return (
                <>
                    {who} renamed the folder {text("moved_from")} to {place}
                </>
            );
        case "create_folder":
            return (
                <>
                    {who} created the folder {place}
                </>
            );
        case "grant":
            return detail.role ? (
                <>
                    {who} made {text("principal")} {text("role")} of {place}
                </>
            ) : (
                <>
                    {who} removed {text("principal")}'s access to {place}
                </>
            );
        case "invite_user":
            return (
                <>
                    {who} invited {text("email")}
                </>
            );
        case "update_user":
            return (
                <>
                    {who} changed {text("email")}'s account
                    {detail.status ? ` (${text("status")})` : ""}
                    {detail.is_admin === true ? " (made admin)" : detail.is_admin === false ? " (admin removed)" : ""}
                </>
            );
        default:
            return (
                <>
                    {who}: {event.action} {path}
                </>
            );
    }
}
