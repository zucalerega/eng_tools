import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Account, type Grants, type Role } from "../api";
import { Notice, Time } from "../components";
import { Link } from "../router";
import { atLeast, useVault, type VaultState } from "../store";

// Admins manage accounts; admins and folder leads manage who can do what where.

export function Admin({ section }: { section: "people" | "access" }) {
    const vault = useVault();
    const isAdmin = vault.me?.is_admin ?? false;
    const shown = section === "people" && !isAdmin ? "access" : section;
    return (
        <section>
            <div className="page-head">
                <h1>Admin</h1>
                <nav className="tabs" aria-label="Admin">
                    {isAdmin && (
                        <Link to="/admin" aria-current={shown === "people" ? "page" : undefined}>
                            People
                        </Link>
                    )}
                    <Link to="/admin/access" aria-current={shown === "access" ? "page" : undefined}>
                        Access
                    </Link>
                </nav>
            </div>
            {shown === "people" ? <People /> : <Access vault={vault} />}
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

function People() {
    const vault = useVault();
    const [people, setPeople] = useState<Account[] | null>(null);
    const reload = useCallback(async () => setPeople(await api.users()), []);
    const { problem, busy, run, setProblem } = useAction(reload);
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");

    useEffect(() => {
        reload().catch((error: Error) => setProblem(error.message));
    }, [reload, setProblem]);

    function invite(event: FormEvent) {
        event.preventDefault();
        void run(async () => {
            await api.invite(email.trim(), name.trim());
            setEmail("");
            setName("");
        });
    }

    const sorted = [...(people ?? [])].sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
    );
    return (
        <>
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
                Invited people are active from their first sign-in. Others wait for an admin to approve them.
            </p>
            {people === null ? (
                <p className="muted">Loading…</p>
            ) : (
                <table className="table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Status</th>
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
                                                    run(() => api.updateUser(person.id, { is_admin: !person.is_admin }))
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
            )}
        </>
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
    const reload = useCallback(async () => setGrants(await api.grants(path)), [path]);
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
        void run(() => api.setGrant(path, who === "everyone" ? null : Number(who), role));
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
                                                    run(() => api.setGrant(path, entry.user?.id ?? null, null))
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
