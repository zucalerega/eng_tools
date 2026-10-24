import { useState } from "react";
import { useAdminMode } from "../admin";
import { type VaultFile, vaultApi } from "../api";
import { CheckinDialog, UndoCheckoutDialog } from "../checkin";
import { WEB_HOST } from "../checkouts";
import { Dialog, Notice, Time } from "../../components";
import { FileName } from "../components";
import { parentOf } from "../paths";
import { atLeast, roleIn, useStore, useVault } from "../store";

export function Locks() {
    const vault = useVault();
    const store = useStore();
    const adminMode = useAdminMode(vault);
    const [onlyMine, setOnlyMine] = useState(false);
    const [releasing, setReleasing] = useState<VaultFile | null>(null);
    const [mineAsking, setMineAsking] = useState<{ action: "checkin" | "undo"; file: VaultFile } | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    const locked = [...vault.files.values()]
        .filter((file) => file.checked_out && (!onlyMine || file.checked_out.user.id === vault.me?.id))
        .sort((a, b) => (a.checked_out!.since < b.checked_out!.since ? -1 : 1));

    // Your own check-out here, in the web app: nothing to lose, so no asking first.
    async function undoHere(file: VaultFile) {
        setBusy(true);
        try {
            await vaultApi.releaseCheckouts([file.id]);
            await store.refresh();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    async function release(file: VaultFile) {
        setBusy(true);
        try {
            await vaultApi.releaseCheckouts([file.id]);
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
                                        <FileName file={file} label={file.path} />
                                    </td>
                                    <td>{mine ? "You" : lock.user.name}</td>
                                    <td>{lock.host === WEB_HOST ? "The web app" : lock.host}</td>
                                    <td>
                                        <Time at={lock.since} />
                                    </td>
                                    <td className="row-actions">
                                        {mine && lock.host === WEB_HOST && (
                                            <button
                                                type="button"
                                                className="button-small"
                                                onClick={() => setMineAsking({ action: "checkin", file })}
                                            >
                                                Check in…
                                            </button>
                                        )}
                                        {mine && (
                                            <button
                                                type="button"
                                                className="button-small"
                                                disabled={busy}
                                                onClick={() =>
                                                    lock.host === WEB_HOST
                                                        ? undoHere(file)
                                                        : setMineAsking({ action: "undo", file })
                                                }
                                            >
                                                Undo check-out
                                            </button>
                                        )}
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
            {mineAsking?.action === "checkin" && (
                <CheckinDialog file={mineAsking.file} onClose={() => setMineAsking(null)} />
            )}
            {mineAsking?.action === "undo" && (
                <UndoCheckoutDialog files={[mineAsking.file]} onClose={() => setMineAsking(null)} />
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
