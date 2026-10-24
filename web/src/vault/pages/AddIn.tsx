import { useEffect, useState, type FormEvent } from "react";
import { api, type AddIn, type AddInPerson, type SiteSettings } from "../../api";
import { Notice, Time } from "../../components";
import { formatDate } from "../../format";

// Admin > People's add-in tracker: who has Vault's SolidWorks add-in (signed in with it, on which computers and
// versions, and when they last used it), who downloaded its installer, and how many people have it (clients.py); and
// the oldest version that can change the vault.

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
            <OldestVersion newest={addIn.newest} />
        </section>
    );
}

/**
 * The oldest add-in and vault command that can change the vault (clients.refuse_old on the server): older ones can
 * still open and get files, and are told to update. Any can, until an admin sets one, which can be no newer than the
 * installer offered (newest), so every add-in can update to it.
 */
function OldestVersion({ newest }: { newest: string | null }) {
    const [oldest, setOldest] = useState<string | null | undefined>(undefined); // undefined until it's loaded
    const [typed, setTyped] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const show = (site: SiteSettings) => {
        setOldest(site.min_client_version);
        setTyped(site.min_client_version ?? "");
    };
    useEffect(() => {
        api.settings().then(show, (error: Error) => setProblem(error.message));
    }, []);

    async function save(version: string | null) {
        setBusy(true);
        setProblem(null);
        try {
            show(await api.updateSettings({ min_client_version: version }));
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    function submit(event: FormEvent) {
        event.preventDefault();
        void save(typed.trim());
    }

    if (oldest === undefined) {
        return problem ? (
            <p className="muted">Couldn't load the oldest version that can make changes: {problem}</p>
        ) : null;
    }
    return (
        <div className="oldest-version">
            <form className="inline-form" onSubmit={submit}>
                <label className="field">
                    Oldest version that can make changes
                    <input
                        value={typed}
                        placeholder={newest ?? "0.5.4"}
                        onChange={(event) => setTyped(event.target.value)}
                    />
                </label>
                <button
                    type="submit"
                    className="button-primary"
                    disabled={busy || !typed.trim() || typed.trim() === oldest}
                >
                    Save
                </button>
                {oldest && (
                    <button type="button" disabled={busy} onClick={() => void save(null)}>
                        Allow any version
                    </button>
                )}
            </form>
            {problem && <Notice tone="error">{problem}</Notice>}
            <p className="muted tracker-note">
                {oldest
                    ? `Only ${oldest} and newer can check files out and in, or change anything else in the vault. Older add-ins and vault commands can still open and get files, and anything else they try says how to update.`
                    : "Any version can change the vault. When the team needs a release's fixes, set the oldest that can: older add-ins and vault commands can then still open and get files, and anything else they try says how to update."}
            </p>
        </div>
    );
}
