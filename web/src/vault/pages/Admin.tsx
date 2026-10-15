import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
    api,
    type Account,
    type SiteSettings,
    type Storage,
    type WhitelistAdded,
    type WhitelistEntry,
} from "../../api";
import { type Grants, type Role, vaultApi } from "../api";
import { formatDate, formatDuration, formatSize, formatTime } from "../../format";
import { Dialog, Notice, Time } from "../../components";
import { Link } from "../../router";
import { VAULT } from "../paths";
import { atLeast, useVault, type VaultState } from "../store";
import { AddInTracker } from "./AddIn";
import { ServerLoad } from "./Load";
import { SiteUsage } from "./Usage";

// Admins manage accounts and who can make one; admins and folder leads manage who can do what where.

export function Admin({ section }: { section: "people" | "whitelist" | "access" }) {
    const vault = useVault();
    const isAdmin = vault.me?.is_admin ?? false;
    const shown = section !== "access" && !isAdmin ? "access" : section;
    return (
        <section>
            <div className="page-head">
                <h1>Admin</h1>
                <nav className="tabs" aria-label="Admin">
                    {isAdmin && (
                        <Link to={`${VAULT}/admin`} aria-current={shown === "people" ? "page" : undefined}>
                            People
                        </Link>
                    )}
                    {isAdmin && (
                        <Link to={`${VAULT}/admin/whitelist`} aria-current={shown === "whitelist" ? "page" : undefined}>
                            Whitelist
                        </Link>
                    )}
                    <Link to={`${VAULT}/admin/access`} aria-current={shown === "access" ? "page" : undefined}>
                        Vault Access
                    </Link>
                </nav>
            </div>
            {shown === "people" ? <People /> : shown === "whitelist" ? <Whitelist /> : <Access vault={vault} />}
        </section>
    );
}

function useAction(reload: () => Promise<void>) {
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const run = async (action: () => Promise<unknown>) => {
        setBusy(true);
        setProblem(null);
        try {
            await action();
            await reload();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };
    return { problem, busy, run, setProblem };
}

const STATUS_ORDER = { pending: 0, invited: 1, active: 2, disabled: 3 };
// What the list of people can be sorted by: the status column (who needs an admin first), or a column's header.
type PeopleSort = { key: "status" | "joined" | "active" | "time"; descending: boolean };
const PEOPLE_SORTS: Record<PeopleSort["key"], (a: Account, b: Account) => number> = {
    status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
    joined: (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    // Who's on now is the most recent; who's never been on, the least.
    active: (a, b) => lastOn(a) - lastOn(b),
    time: (a, b) => (a.site_seconds ?? 0) - (b.site_seconds ?? 0),
};
const lastOn = (person: Account) =>
    person.active_now ? Infinity : person.last_active_at ? Date.parse(person.last_active_at) : -Infinity;
const PEOPLE_REFRESH_MS = 30_000; // how often the list of people is fetched again, for who's on now

function People() {
    const vault = useVault();
    const [people, setPeople] = useState<Account[] | null>(null);
    const reload = useCallback(async () => setPeople(await api.users()), []);
    const { problem, busy, run, setProblem } = useAction(reload);
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [sort, setSort] = useState<PeopleSort>({ key: "status", descending: false });

    useEffect(() => {
        reload().catch((error: Error) => setProblem(error.message));
    }, [reload, setProblem]);

    // Who's on changes as people come and go: look again every so often while the page is in view.
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                reload().catch(() => {}); // the next try, or the next action, says what's wrong
            }
        }, PEOPLE_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [reload]);

    function invite(event: FormEvent) {
        event.preventDefault();
        void run(async () => {
            await api.invite(email.trim(), name.trim());
            setEmail("");
            setName("");
        });
    }

    const sorted = [...(people ?? [])].sort(
        (a, b) => (sort.descending ? -1 : 1) * PEOPLE_SORTS[sort.key](a, b) || a.name.localeCompare(b.name),
    );
    // A column that sorts the list: click once to sort by it (newest or most first, for dates and time), again to
    // turn the order around.
    const heading = (label: string, key: PeopleSort["key"]) => {
        const on = sort.key === key;
        return (
            <th aria-sort={on ? (sort.descending ? "descending" : "ascending") : undefined}>
                <button
                    type="button"
                    className="sort-button"
                    onClick={() =>
                        setSort(on ? { key, descending: !sort.descending } : { key, descending: key !== "status" })
                    }
                >
                    {label}
                </button>
            </th>
        );
    };
    const onNow = sorted.filter((person) => person.active_now).length;
    return (
        <>
            <div className="dashboard">
                <SiteUsage />
                <ServerLoad />
                <AddInTracker />
                <DiskSpace />
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            <form className="inline-form" onSubmit={invite}>
                <label className="field">
                    Invite by email
                    <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
                </label>
                <label className="field">
                    Name (optional)
                    <input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <button type="submit" className="button-primary" disabled={busy}>
                    Invite
                </button>
            </form>
            <p className="muted">
                Invited people are active from their first sign-in, and can be given access before then. Someone without
                a Georgia Tech account signs in with Google, once invited by their Google address.
            </p>
            {people === null ? (
                <p className="muted">Loading…</p>
            ) : (
                <>
                    <p className="people-counts">
                        <span>
                            <strong>{people.length}</strong> {people.length === 1 ? "person" : "people"}
                        </span>
                        <span className={onNow > 0 ? "active-now" : "muted"}>
                            <strong>{onNow}</strong> active now
                        </span>
                    </p>
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Email</th>
                                {heading("Status", "status")}
                                {heading("Joined", "joined")}
                                {heading("Last active", "active")}
                                {heading("Time on site", "time")}
                                <th>Last sign-in</th>
                                <th>
                                    <span className="visually-hidden">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.map((person) => {
                                const me = person.id === vault.me?.id;
                                return (
                                    <tr key={person.id}>
                                        <td>
                                            {person.name}
                                            {person.is_admin && <span className="badge">admin</span>}
                                        </td>
                                        <td>{person.email}</td>
                                        <td>
                                            <span className={`status status-${person.status}`}>
                                                {person.status === "pending" ? "waiting for approval" : person.status}
                                            </span>
                                        </td>
                                        <td>
                                            <time dateTime={person.created_at} title={formatTime(person.created_at)}>
                                                {formatDate(person.created_at)}
                                            </time>
                                        </td>
                                        <td>
                                            {person.active_now ? (
                                                <span className="active-now">active now</span>
                                            ) : person.last_active_at ? (
                                                <Time at={person.last_active_at} />
                                            ) : (
                                                <span className="muted">never</span>
                                            )}
                                        </td>
                                        <td title="Time with the web app open">
                                            {person.site_seconds ? (
                                                formatDuration(person.site_seconds)
                                            ) : (
                                                <span className="muted">none</span>
                                            )}
                                        </td>
                                        <td>
                                            {person.last_login_at ? (
                                                <Time at={person.last_login_at} />
                                            ) : (
                                                <span className="muted">never</span>
                                            )}
                                        </td>
                                        <td className="row-actions">
                                            {person.status === "pending" && (
                                                <button
                                                    type="button"
                                                    className="button-small button-primary"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        run(() => api.updateUser(person.id, { status: "active" }))
                                                    }
                                                >
                                                    Approve
                                                </button>
                                            )}
                                            {person.status === "disabled" && (
                                                <button
                                                    type="button"
                                                    className="button-small"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        run(() => api.updateUser(person.id, { status: "active" }))
                                                    }
                                                >
                                                    Enable
                                                </button>
                                            )}
                                            {!me && person.status === "active" && (
                                                <button
                                                    type="button"
                                                    className="button-small"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        run(() =>
                                                            api.updateUser(person.id, { is_admin: !person.is_admin }),
                                                        )
                                                    }
                                                >
                                                    {person.is_admin ? "Remove admin" : "Make admin"}
                                                </button>
                                            )}
                                            {!me && person.status !== "disabled" && (
                                                <button
                                                    type="button"
                                                    className="button-small button-danger"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        run(() => api.updateUser(person.id, { status: "disabled" }))
                                                    }
                                                >
                                                    Disable
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </>
            )}
        </>
    );
}

const LOW_ON_SPACE = 0.1; // of the disk free, or less: say so

// How full the server's disk is, and how much of it is Vault's and Yorg's: measured when the page opens.
function DiskSpace() {
    const [storage, setStorage] = useState<Storage | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        api.storage().then(setStorage, (error: Error) => setProblem(error.message));
    }, []);
    if (problem) {
        return <p className="muted">Couldn't measure the server's disk: {problem}</p>;
    }
    if (!storage) {
        return null;
    }
    const used = storage.total - storage.free;
    const parts = [
        { key: "vault", label: "Vault", bytes: storage.vault, about: "Every version of every file" },
        { key: "yorg", label: "Yorg", bytes: storage.yorg, about: "Test data, scripts, and models" },
        {
            key: "other",
            label: "Everything else",
            bytes: Math.max(0, used - storage.vault - storage.yorg),
            about: `The system, the database (${formatSize(storage.database)}), and its backups`,
        },
        { key: "free", label: "Free", bytes: storage.free, about: "What the server can still write" },
    ];
    const low = storage.free <= storage.total * LOW_ON_SPACE;
    return (
        <div className="storage">
            <div className="storage-head">
                <h2>Storage</h2>
                <span>
                    {formatSize(used)} of {formatSize(storage.total)} used (
                    {Math.round((used / Math.max(storage.total, 1)) * 100)}%)
                </span>
                {low && <span className="storage-low">Running out of space</span>}
            </div>
            {/* The legend below says the same in words. */}
            <div className="storage-bar" aria-hidden="true">
                {parts
                    .filter((part) => part.bytes > 0)
                    .map((part) => (
                        <span
                            key={part.key}
                            className={`storage-${part.key}`}
                            style={{ flexGrow: part.bytes / Math.max(storage.total, 1) }}
                            title={`${part.label}: ${formatSize(part.bytes)}`}
                        />
                    ))}
            </div>
            <ul className="storage-legend">
                {parts.map((part) => (
                    <li key={part.key} title={part.about}>
                        <span className={`storage-swatch storage-${part.key}`} aria-hidden="true" />
                        {part.label} <strong>{formatSize(part.bytes)}</strong>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The email addresses in a file's text, once each: a roster's CSV has them in a column, quoted or not. */
function emailsIn(text: string): string[] {
    const found = text.match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? [];
    return [...new Set(found.map((email) => email.toLowerCase()))];
}

const FOUND_SHOWN = 8; // of a file's emails, listed before adding them

// Who can make an account: the whitelist's switch, and the Georgia Tech emails on it, typed in or from a file.
function Whitelist() {
    const [site, setSite] = useState<SiteSettings | null>(null);
    const [entries, setEntries] = useState<WhitelistEntry[] | null>(null);
    const [waiting, setWaiting] = useState(0); // accounts left waiting for approval from before
    const reload = useCallback(async () => {
        const [settings, listed, people] = await Promise.all([api.settings(), api.whitelist(), api.users()]);
        setSite(settings);
        setEntries(listed);
        setWaiting(people.filter((person) => person.status === "pending").length);
    }, []);
    const { problem, busy, run, setProblem } = useAction(reload);
    const [opening, setOpening] = useState(false); // asking before the whitelist goes off
    const [email, setEmail] = useState("");
    const [file, setFile] = useState<{ name: string; emails: string[] } | null>(null); // asking before adding them
    const [added, setAdded] = useState<WhitelistAdded | null>(null);
    const [filter, setFilter] = useState("");
    const picker = useRef<HTMLInputElement>(null);

    useEffect(() => {
        reload().catch((error: Error) => setProblem(error.message));
    }, [reload, setProblem]);

    const add = (emails: string[], then?: () => void) =>
        run(async () => {
            setAdded(null);
            setAdded(await api.addToWhitelist(emails));
            then?.();
        });

    function addTyped(event: FormEvent) {
        event.preventDefault();
        void add([email.trim()], () => setEmail(""));
    }

    async function read(picked: File) {
        setAdded(null);
        setProblem(null);
        const emails = emailsIn(await picked.text());
        if (emails.length === 0) {
            setProblem(`There are no email addresses in ${picked.name}.`);
        } else {
            setFile({ name: picked.name, emails });
        }
    }

    const wanted = filter.trim().toLowerCase();
    const shown = (entries ?? []).filter(
        (entry) => !wanted || entry.email.includes(wanted) || !!entry.account?.name.toLowerCase().includes(wanted),
    );
    const joined = (entries ?? []).filter((entry) => entry.account?.status === "active").length;
    return (
        <>
            {problem && <Notice tone="error">{problem}</Notice>}
            {site && (
                <div className="setting">
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={site.whitelist}
                            disabled={busy}
                            onChange={(event) => {
                                if (event.target.checked) {
                                    void run(() => api.updateSettings({ whitelist: true }));
                                } else {
                                    setOpening(true);
                                }
                            }}
                        />
                        Whitelist
                    </label>
                    {site.whitelist ? (
                        <p className="muted">
                            On: only the emails below, and people invited on the People tab, can make an account, by
                            signing in with Georgia Tech. Anyone else who signs in is turned away, and told to ask an
                            admin.
                        </p>
                    ) : (
                        <p className="muted">
                            Off: anyone with a Georgia Tech account can make one by signing in. They get what Everyone
                            has on the Vault Access tab, and Yorg's test data.
                        </p>
                    )}
                    <p className="muted">Google signs in only to accounts made before: it makes no new ones.</p>
                </div>
            )}
            {opening && (
                <Dialog
                    title="Turn the whitelist off?"
                    confirm="Turn it off"
                    danger
                    busy={busy}
                    onCancel={() => setOpening(false)}
                    onConfirm={() =>
                        void run(() => api.updateSettings({ whitelist: false })).then(() => setOpening(false))
                    }
                >
                    <p>
                        Anyone with a Georgia Tech account will be able to join by signing in. They'll get what Everyone
                        has on the Vault Access tab, and Yorg's test data.
                    </p>
                    {waiting > 0 && (
                        <p>
                            {waiting === 1 ? "The person" : `The ${waiting} people`} waiting for approval will be
                            approved now.
                        </p>
                    )}
                </Dialog>
            )}
            <form className="inline-form" onSubmit={addTyped}>
                <label className="field">
                    Add a Georgia Tech email
                    <input
                        type="email"
                        required
                        placeholder="gburdell3@gatech.edu"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                    />
                </label>
                <button type="submit" className="button-primary" disabled={busy}>
                    Add
                </button>
                <button type="button" disabled={busy} onClick={() => picker.current?.click()}>
                    Upload a CSV…
                </button>
                <input
                    ref={picker}
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/plain"
                    hidden
                    aria-label="File of emails"
                    onChange={(event) => {
                        const picked = event.target.files?.[0];
                        event.target.value = "";
                        if (picked) {
                            read(picked).catch((error: Error) => setProblem(error.message));
                        }
                    }}
                />
            </form>
            <p className="muted">
                A team roster's CSV, or any file with the emails in it: its Georgia Tech addresses go on. Taking an
                email off doesn't change an account it already made; disable that on the People tab.
            </p>
            {added && <Added result={added} />}
            {file && (
                <Dialog
                    title={`Add the emails in ${file.name}?`}
                    confirm={file.emails.length === 1 ? "Add it" : `Add all ${file.emails.length}`}
                    busy={busy}
                    onCancel={() => setFile(null)}
                    onConfirm={() => {
                        setFile(null);
                        void add(file.emails);
                    }}
                >
                    <p>
                        {file.emails.length === 1
                            ? "It has 1 email address:"
                            : `It has ${file.emails.length} email addresses${file.emails.length > FOUND_SHOWN ? ", like these" : ""}:`}
                    </p>
                    <ul className="found-emails">
                        {file.emails.slice(0, FOUND_SHOWN).map((found) => (
                            <li key={found}>{found}</li>
                        ))}
                    </ul>
                    {file.emails.length > FOUND_SHOWN && (
                        <p className="muted">and {file.emails.length - FOUND_SHOWN} more.</p>
                    )}
                    <p className="muted">Any that aren't Georgia Tech addresses are left off.</p>
                </Dialog>
            )}
            {entries === null ? (
                <p className="muted">Loading…</p>
            ) : entries.length === 0 ? (
                <p className="muted">No emails on the whitelist yet.</p>
            ) : (
                <>
                    <div className="whitelist-head">
                        <p className="people-counts">
                            <span>
                                <strong>{entries.length}</strong> {entries.length === 1 ? "email" : "emails"}
                            </span>
                            <span>
                                <strong>{joined}</strong> joined
                            </span>
                        </p>
                        <input
                            type="search"
                            placeholder="Find an email or name"
                            aria-label="Find on the whitelist"
                            value={filter}
                            onChange={(event) => setFilter(event.target.value)}
                        />
                    </div>
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Email</th>
                                <th>Account</th>
                                <th>Added</th>
                                <th>
                                    <span className="visually-hidden">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((entry) => (
                                <tr key={entry.id}>
                                    <td>{entry.email}</td>
                                    <td>
                                        {entry.account ? (
                                            <>
                                                {entry.account.name}
                                                {entry.account.status !== "active" && (
                                                    <span className={`badge status-${entry.account.status}`}>
                                                        {entry.account.status === "pending"
                                                            ? "waiting for approval"
                                                            : entry.account.status}
                                                    </span>
                                                )}
                                            </>
                                        ) : (
                                            <span className="muted">not yet</span>
                                        )}
                                    </td>
                                    <td>
                                        <time dateTime={entry.added_at} title={formatTime(entry.added_at)}>
                                            {formatDate(entry.added_at)}
                                        </time>
                                    </td>
                                    <td className="row-actions">
                                        <button
                                            type="button"
                                            className="button-small"
                                            aria-label={`Remove ${entry.email}`}
                                            disabled={busy}
                                            onClick={() => {
                                                setAdded(null);
                                                void run(() => api.removeFromWhitelist(entry.id));
                                            }}
                                        >
                                            Remove
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {shown.length === 0 && <p className="muted">Nothing on the whitelist matches “{filter.trim()}”.</p>}
                </>
            )}
        </>
    );
}

/** What putting emails on the whitelist did: which went on, which were on it already, and which it left off. */
function Added({ result }: { result: WhitelistAdded }) {
    const { added, already, not_georgia_tech: others } = result;
    return (
        <Notice tone={others.length > 0 ? "warning" : "info"}>
            {added.length > 0 && <p>{added.length === 1 ? `Added ${added[0]}.` : `Added ${added.length} emails.`}</p>}
            {already.length > 0 && (
                <p>
                    {already.length === 1
                        ? `${already[0]} was on the whitelist already.`
                        : `${already.length} were on the whitelist already.`}
                </p>
            )}
            {others.length > 0 && (
                <p>
                    {others.length === 1
                        ? `Left off ${others[0]}, which isn't a Georgia Tech address`
                        : `Left off ${others.length} addresses that aren't Georgia Tech's: ${others.join(", ")}`}
                    . Only GT accounts can make an account; to let someone in by another address, invite them on the
                    People tab, and they sign in with Google.
                </p>
            )}
        </Notice>
    );
}

const ROLES: Role[] = ["viewer", "editor", "lead"];
const ROLE_HELP: Record<Role, string> = {
    viewer: "browse, download, see history",
    editor: "also check out, check in, add, delete, revert",
    lead: "also release or take over others' check-outs, and change access here",
    admin: "everything",
};

function Access({ vault }: { vault: VaultState }) {
    // The folders you can change access to: where you're a lead (admins everywhere).
    const manageable = [
        ...(atLeast(vault.rootRole, "lead") ? [""] : []),
        ...[...vault.folders.values()]
            .filter((folder) => atLeast(folder.role, "lead"))
            .map((folder) => folder.path)
            .sort((a, b) => a.localeCompare(b)),
    ];
    const [path, setPath] = useState(manageable[0] ?? "");
    const [grants, setGrants] = useState<Grants | null>(null);
    const [people, setPeople] = useState<Account[]>([]);
    const [who, setWho] = useState("everyone");
    const [role, setRole] = useState<Role>("viewer");
    const reload = useCallback(async () => setGrants(await vaultApi.grants(path)), [path]);
    const { problem, busy, run, setProblem } = useAction(reload);

    useEffect(() => {
        reload().catch((error: Error) => setProblem(error.message));
    }, [reload, setProblem]);
    useEffect(() => {
        api.users().then(
            (all) => setPeople(all.filter((person) => person.status === "active" || person.status === "invited")),
            () => setPeople([]),
        );
    }, []);

    if (manageable.length === 0) {
        return <p className="empty">You can't change access anywhere: that takes an admin or a folder lead.</p>;
    }
    const label = (folder: string) => folder || "The whole vault";

    function grant(event: FormEvent) {
        event.preventDefault();
        void run(() => vaultApi.setGrant(path, who === "everyone" ? null : Number(who), role));
    }

    return (
        <>
            {problem && <Notice tone="error">{problem}</Notice>}
            <label className="field">
                Folder
                <select value={path} onChange={(event) => setPath(event.target.value)}>
                    {manageable.map((folder) => (
                        <option key={folder} value={folder}>
                            {label(folder)}
                        </option>
                    ))}
                </select>
            </label>
            {grants && (
                <table className="table">
                    <thead>
                        <tr>
                            <th>Who</th>
                            <th>Role</th>
                            <th>Set on</th>
                            <th>
                                <span className="visually-hidden">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {grants.grants.length === 0 && (
                            <tr>
                                <td colSpan={4} className="muted">
                                    Nobody has access here yet, except admins.
                                </td>
                            </tr>
                        )}
                        {grants.grants.map((entry) => {
                            const here = entry.folder === grants.folder.path;
                            return (
                                <tr key={`${entry.folder}|${entry.user?.id ?? "everyone"}`}>
                                    <td>{entry.user ? `${entry.user.name} (${entry.user.email})` : "Everyone"}</td>
                                    <td title={ROLE_HELP[entry.role]}>{entry.role}</td>
                                    <td>{here ? "this folder" : `${label(entry.folder)} (above)`}</td>
                                    <td className="row-actions">
                                        {here && (
                                            <button
                                                type="button"
                                                className="button-small"
                                                disabled={busy}
                                                onClick={() =>
                                                    run(() => vaultApi.setGrant(path, entry.user?.id ?? null, null))
                                                }
                                            >
                                                Remove
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            <form className="inline-form" onSubmit={grant}>
                <label className="field">
                    Give
                    <select value={who} onChange={(event) => setWho(event.target.value)}>
                        <option value="everyone">Everyone</option>
                        {people.map((person) => (
                            <option key={person.id} value={person.id}>
                                {person.name} ({person.email})
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    the role
                    <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                        {ROLES.map((option) => (
                            <option key={option} value={option}>
                                {option}: {ROLE_HELP[option]}
                            </option>
                        ))}
                    </select>
                </label>
                <button type="submit" className="button-primary" disabled={busy}>
                    Set access on {label(path)}
                </button>
            </form>
        </>
    );
}
