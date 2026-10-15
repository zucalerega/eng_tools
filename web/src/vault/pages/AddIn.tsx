import { useEffect, useState } from "react";
import { api, type AddIn, type AddInPerson } from "../../api";
import { Time } from "../../components";
import { formatDate } from "../../format";

// Admin > People's add-in tracker: who has Vault's SolidWorks add-in (signed in with it, on which computers and
// versions, and when they last used it), who downloaded its installer, and how many people have it (clients.py).

const INSTALLER = "Vault-Setup.exe";

export function AddInTracker() {
    const [addIn, setAddIn] = useState<AddIn | null>(null);
    const [newest, setNewest] = useState<string | null>(null); // the installer's version, offered now
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        api.addIn().then(setAddIn, (error: Error) => setProblem(error.message));
        api.downloads().then(
            (files) => setNewest(files.find((file) => file.name === INSTALLER)?.version ?? null),
            () => {}, // without it, versions just aren't compared
        );
    }, []);
    if (problem) {
        return <p className="muted">Couldn't load who has the add-in: {problem}</p>;
    }
    if (!addIn) {
        return null;
    }
    const versions = (person: AddInPerson) => [...new Set(person.computers.map((c) => c.version ?? "?"))].sort();
    const current =
        newest === null ? null : addIn.people.filter((p) => p.computers.some((c) => c.version === newest)).length;
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
                    <dt>On the newest{newest ? ` (${newest})` : ""}</dt>
                    <dd>{current ?? "–"}</dd>
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
                                <th>Signed in on</th>
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
                                        <td>
                                            {person.computers.length ? (
                                                person.computers.map((c) => c.name).join(", ")
                                            ) : (
                                                <span className="muted">not yet</span>
                                            )}
                                        </td>
                                        <td>
                                            {versions(person).map((version) => (
                                                <span
                                                    key={version}
                                                    className={
                                                        newest !== null && version !== newest
                                                            ? "badge status-pending"
                                                            : "badge"
                                                    }
                                                    title={
                                                        newest !== null && version !== newest
                                                            ? `Older than ${newest}: it offers itself the update`
                                                            : undefined
                                                    }
                                                >
                                                    {version}
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
                Have it: signed in with the add-in on a computer, and used it in the last 90 days.{" "}
                {addIn.counting_since
                    ? `Downloads are counted since ${formatDate(addIn.counting_since)}.`
                    : "Downloads are counted from now on."}
            </p>
        </section>
    );
}
