import { useState } from "react";
import { useAdminMode } from "../admin";
import { api, type VaultFile } from "../api";
import { Dialog, FileIcon, Notice, Time } from "../components";
import { fileUrl, parentOf } from "../paths";
import { Link } from "../router";
import { atLeast, roleIn, useStore, useVault } from "../store";

export function Locks() {
    const vault = useVault();
    const store = useStore();
    const adminMode = useAdminMode(vault);
    const [onlyMine, setOnlyMine] = useState(false);
    const [releasing, setReleasing] = useState<VaultFile | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    const locked = [...vault.files.values()]
        .filter((file) => file.checked_out && (!onlyMine || file.checked_out.user.id === vault.me?.id))
        .sort((a, b) => (a.checked_out!.since < b.checked_out!.since ? -1 : 1));

    async function release(file: VaultFile) {
        setBusy(true);
        try {
            await api.releaseCheckouts([file.id]);
            await store.refresh();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
            setReleasing(null);
        }
    }

    return (
        <section>
            <div className="page-head">
                <h1>Checked out</h1>
                <label className="check">
                    <input type="checkbox" checked={onlyMine} onChange={(event) => setOnlyMine(event.target.checked)} />{" "}
                    Only mine
                </label>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            {locked.length === 0 ? (
                <p className="empty">{onlyMine ? "You don't have anything checked out." : "Nothing is checked out."}</p>
            ) : (
                <table className="table">
                    <thead>
                        <tr>
                            <th>File</th>
                            <th>By</th>
                            <th>On</th>
                            <th>Since</th>
                            <th>
                                <span className="visually-hidden">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {locked.map((file) => {
                            const lock = file.checked_out!;
                            const mine = lock.user.id === vault.me?.id;
                            return (
                                <tr key={file.id}>
                                    <td>
                                        <Link to={fileUrl(file.id)} className="name">
                                            <FileIcon name={file.name} />
                                            {file.path}
                                        </Link>
                                    </td>
                                    <td>{mine ? "You" : lock.user.name}</td>
                                    <td>{lock.host}</td>
                                    <td>
                                        <Time at={lock.since} />
                                    </td>
                                    <td className="row-actions">
                                        {adminMode && !mine && atLeast(roleIn(vault, parentOf(file.path)), "lead") && (
                                            <button
                                                type="button"
                                                className="button-small button-danger"
                                                onClick={() => setReleasing(file)}
                                            >
                                                Release
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {releasing?.checked_out && (
                <Dialog
                    title={`Release ${releasing.checked_out.user.name}'s check-out?`}
                    confirm="Release check-out"
                    danger
                    busy={busy}
                    onCancel={() => setReleasing(null)}
                    onConfirm={() => release(releasing)}
                >
                    <p>
                        {releasing.name} becomes free for anyone to check out. {releasing.checked_out.user.name}'s
                        changes stay on {releasing.checked_out.host}: to check them in, they'll have to check it out
                        again.
                    </p>
                </Dialog>
            )}
        </section>
    );
}
