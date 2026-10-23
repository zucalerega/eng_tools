import { useEffect, useState } from "react";
import { type UserRef } from "../../api";
import { type Folder, type Listing, type VaultFile, vaultApi } from "../api";
import { Notice, Time } from "../../components";
import { FileIcon, FileTitle, FolderIcon } from "../components";
import { formatSize } from "../../format";
import { fileUrl, folderUrl } from "../paths";
import { Link } from "../../router";
import { atLeast, roleIn, useStore, useVault } from "../store";
import { Breadcrumbs } from "./Browse";

/**
 * What was deleted from a folder: whole folders (with everything in them) and files, each of which can be
 * brought back where it was, history and all. Restoring a file takes editor access here; a folder, a lead
 * of it, as deleting it did.
 */
export function Trash({ folder }: { folder: string }) {
    const vault = useVault();
    const store = useStore();
    const [trash, setTrash] = useState<Listing | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Loaded again whenever the vault changes: something deleted or restored, here or anywhere.
    useEffect(() => {
        let current = true;
        vaultApi.trash(folder).then(
            (loaded) => current && (setTrash(loaded), setProblem(null)),
            (error: Error) => current && setProblem(error.message),
        );
        return () => {
            current = false;
        };
    }, [folder, vault.revision]);

    async function restore(action: () => Promise<unknown>) {
        setBusy(true);
        setProblem(null);
        try {
            await action();
            await store.refresh();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    const canRestoreFiles = atLeast(roleIn(vault, folder), "editor");
    const deleted = (at: string | null | undefined, by: UserRef | null | undefined) =>
        at ? (
            <>
                <Time at={at} />
                {by && ` by ${by.name}`}
            </>
        ) : null;
    const button = (label: string, allowed: boolean, why: string, action: () => Promise<unknown>) => (
        <button
            type="button"
            className="button-small"
            aria-label={label}
            disabled={busy || !allowed}
            title={allowed ? undefined : why}
            onClick={() => restore(action)}
        >
            Restore
        </button>
    );

    return (
        <section>
            <div className="page-head">
                <div className="page-title">
                    <Breadcrumbs path={folder} />
                    <h1>Trash</h1>
                </div>
                <div className="page-actions">
                    <Link className="button" to={folderUrl(folder)}>
                        Back to {folder ? "the folder" : "the vault"}
                    </Link>
                </div>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            {!trash ? (
                !problem && <p className="muted">Loading…</p>
            ) : trash.folders.length === 0 && trash.files.length === 0 ? (
                <p className="empty">Nothing has been deleted from {folder || "the top of the vault"}.</p>
            ) : (
                <>
                    <p className="muted">
                        Restoring puts things back where they were, with their history. A folder comes back with
                        everything deleted along with it.
                    </p>
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Version</th>
                                <th>Deleted</th>
                                <th className="numeric">Size</th>
                                <th>
                                    <span className="visually-hidden">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {trash.folders.map((gone: Folder) => (
                                <tr key={`folder-${gone.id}`}>
                                    <td>
                                        <span className="name">
                                            <FolderIcon />
                                            {gone.name}
                                        </span>
                                    </td>
                                    <td />
                                    <td>{deleted(gone.deleted_at, gone.deleted_by)}</td>
                                    <td />
                                    <td className="row-actions">
                                        {button(
                                            `Restore ${gone.name}`,
                                            atLeast(gone.role, "lead"),
                                            "Restoring a folder takes a lead of it",
                                            () => vaultApi.restoreFolder(gone.id),
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {trash.files.map((gone: VaultFile) => (
                                <tr key={gone.id}>
                                    <td>
                                        <Link to={fileUrl(gone.id)} className="name">
                                            <FileIcon name={gone.name} />
                                            {gone.name}
                                        </Link>{" "}
                                        <FileTitle file={gone} />
                                    </td>
                                    <td>v{gone.version}</td>
                                    <td>{deleted(gone.deleted_at, gone.deleted_by)}</td>
                                    <td className="numeric">{formatSize(gone.size)}</td>
                                    <td className="row-actions">
                                        <a
                                            className="button button-small"
                                            href={vaultApi.downloadUrl(gone.id)}
                                            download
                                        >
                                            Download
                                        </a>
                                        {button(
                                            `Restore ${gone.name}`,
                                            canRestoreFiles,
                                            "Restoring files takes editor access here",
                                            () => vaultApi.restore(gone.id),
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}
        </section>
    );
}
