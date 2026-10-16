import { useEffect, useState } from "react";
import { api, type AddIn, type AddInPerson } from "../../api";
import { Time } from "../../components";
import { formatDate } from "../../format";

// Admin > People's add-in tracker: who has Vault's SolidWorks add-in (signed in with it, on which computers and
// versions, and when they last used it), who downloaded its installer, and how many people have it (clients.py).

/** The versions someone's add-ins are on, each once (null: not known yet), and whether it's older than the newest. */
function versions(person: AddInPerson): [string | null, boolean][] {
    const found = new Map(person.computers.map((c) => [c.version, c.outdated]));
    return [...found].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""));
}

/** How many computers someone has the add-in on, without naming them: a computer's name is often the owner's own. */
function computers(person: AddInPerson) {
    const used = person.computers.filter((c) => c.in_use).length;
    const idle = person.computers.length - used;
    if (!person.computers.length) return <span className="muted">not yet</span>;
    return (
        <>
            {used}
            {idle > 0 && (
                <span className="muted" title="Not used in the last 90 days">
                    {" "}
                    (+{idle} idle)
                </span>
            )}
        </>
    );
}

export function AddInTracker() {
    const [addIn, setAddIn] = useState<AddIn | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        api.addIn().then(setAddIn, (error: Error) => setProblem(error.message));
    }, []);
    if (problem) {
        return <p className="muted">Couldn't load who has the add-in: {problem}</p>;
    }
    if (!addIn) {
        return null;
    }
    return (
        <section className="tracker addin" aria-labelledby="addin-title">
            <div className="tracker-head">
                <h2 id="addin-title">SolidWorks add-in</h2>
            </div>
            <dl className="stat-tiles">
                <div>
                    <dt>Have it</dt>
                    <dd>{addIn.have_it}</dd>
                </div>
                <div>
                    <dt>Used it this week</dt>
                    <dd>{addIn.this_week}</dd>
                </div>
                <div>
                    <dt>Downloaded it</dt>
                    <dd>{addIn.downloaded}</dd>
                </div>
                <div>
                    <dt>On the newest{addIn.newest ? ` (${addIn.newest})` : ""}</dt>
                    <dd>{addIn.newest ? addIn.on_newest : "–"}</dd>
                </div>
            </dl>
            {addIn.people.length === 0 ? (
                <p className="muted">No one has signed in with the add-in or downloaded it yet.</p>
            ) : (
                <div className="addin-list">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Computers</th>
                                <th>Version</th>
                                <th>Last used</th>
                                <th>Downloaded</th>
                            </tr>
                        </thead>
                        <tbody>
                            {addIn.people.map((person) => {
                                const used = person.computers
                                    .map((c) => c.last_used_at ?? c.signed_in_at)
                                    .sort()
                                    .at(-1);
                                return (
                                    <tr key={person.user.id}>
                                        <td>{person.user.name}</td>
                                        <td>{computers(person)}</td>
                                        <td>
                                            {versions(person).map(([version, outdated]) => (
                                                <span
                                                    key={version ?? "?"}
                                                    className={outdated ? "badge status-pending" : "badge"}
                                                    title={
                                                        version === null
                                                            ? "Not known yet: it shows once the add-in next talks to the server"
                                                            : outdated
                                                              ? `Older than ${addIn.newest}: it offers itself the update`
                                                              : undefined
                                                    }
                                                >
                                                    {version ?? "?"}
                                                </span>
                                            ))}
                                        </td>
                                        <td>{used ? <Time at={used} /> : <span className="muted">never</span>}</td>
                                        <td>
                                            {person.downloaded_at ? (
                                                <time dateTime={person.downloaded_at}>
                                                    {formatDate(person.downloaded_at)}
                                                    {person.downloaded_version && ` (${person.downloaded_version})`}
                                                </time>
                                            ) : (
                                                <span className="muted">–</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="muted tracker-note">
                Have it: signed in with the add-in on a computer, and used it there in the last 90 days. Computers are
                counted, not named.{" "}
                {addIn.counting_since
                    ? `Downloads are counted since ${formatDate(addIn.counting_since)}.`
                    : "Downloads are counted from now on."}
            </p>
        </section>
    );
}
