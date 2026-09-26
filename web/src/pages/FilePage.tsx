import { useEffect, useId, useState } from "react";
import { useAdminMode } from "../admin";
import { api, type FileDetail, type VaultFile } from "../api";
import { Dialog, FileIcon, LockLabel, Notice, OpenInSolidWorks, StatusLabel, Time } from "../components";
import { formatSize } from "../format";
import { NewFileDialog, StartedNotice } from "../newFile";
import { fileUrl, kindOf, parentOf } from "../paths";
import { Link } from "../router";
import { atLeast, roleIn, useStore, useVault } from "../store";
import { parentsOf, StructureTree, UsedVersion } from "../structure";
import { Breadcrumbs } from "./Browse";

type Asking = { action: "release" } | { action: "revert"; version: number } | null;

export function FilePage({ id }: { id: number }) {
    const vault = useVault();
    const store = useStore();
    const adminMode = useAdminMode(vault);
    const live = vault.files.get(id); // kept current by the sync feed
    const [detail, setDetail] = useState<FileDetail | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [asking, setAsking] = useState<Asking>(null);
    const [comment, setComment] = useState("");
    const [busy, setBusy] = useState(false);

    // The history, loaded again whenever the file changes: a check-in, check-out, or revert anywhere.
    const stamp = live ? `${live.version}|${live.checked_out?.user.id ?? ""}|${live.checked_out?.since ?? ""}` : "";
    useEffect(() => {
        let current = true;
        api.file(id).then(
            (loaded) => current && (setDetail(loaded), setProblem(null)),
            (error: Error) => current && setProblem(error.message),
        );
        return () => {
            current = false;
        };
    }, [id, stamp]);

    if (!detail) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    const file = live ?? detail.file;
    const folder = parentOf(file.path);
    const role = roleIn(vault, folder);
    const lock = file.checked_out;
    const holder = lock && lock.user.id !== vault.me?.id ? lock : null; // checked out by someone else
    const canLead = atLeast(role, "lead");
    const canRevert = atLeast(role, "editor") && (!holder || (adminMode && canLead));
    const kind = kindOf(file.name);

    async function act(action: () => Promise<unknown>) {
        setBusy(true);
        try {
            await action();
            setAsking(null);
            setComment("");
            await store.refresh();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
            setAsking(null);
        } finally {
            setBusy(false);
        }
    }

    return (
        <article>
            <Breadcrumbs path={folder} />
            <header className="file-head">
                <h1>
                    <FileIcon name={file.name} />
                    {file.name}
                </h1>
                <p className="muted">
                    v{file.version} · {formatSize(file.size)} · changed <Time at={file.modified_at} /> by{" "}
                    {file.modified_by.name}
                </p>
                {file.deleted_at && <Notice tone="warning">This file was deleted from the vault.</Notice>}
                {lock && (
                    <p>
                        <LockLabel lock={lock} me={vault.me} />
                    </p>
                )}
                <div className="actions">
                    <OpenInSolidWorks path={file.path} />
                    <a className="button" href={api.downloadUrl(file.id)} download>
                        Download
                    </a>
                    {holder && adminMode && canLead && (
                        <button
                            type="button"
                            className="button-danger"
                            onClick={() => setAsking({ action: "release" })}
                        >
                            Release check-out
                        </button>
                    )}
                </div>
            </header>

            {problem && <Notice tone="error">{problem}</Notice>}
            {kind === "drawing" && file.uses.length === 0 && (
                <Notice tone="warning">
                    This drawing isn't linked to the part or assembly it shows. Check it in again from SolidWorks, where
                    Vault records what each drawing shows.
                </Notice>
            )}

            {(kind === "part" || kind === "assembly") && <Drawings model={file} canAdd={atLeast(role, "editor")} />}
            <div className="columns">
                <section>
                    <h2>{kind === "assembly" ? "Contains" : kind === "drawing" ? "Shows" : "Uses"}</h2>
                    <StructureTree
                        file={file}
                        direction="down"
                        empty={`v${file.version} doesn't use other files in the vault.`}
                    />
                </section>
                {kind !== "drawing" && (
                    <section>
                        <h2>Used in</h2>
                        <StructureTree
                            file={file}
                            direction="up"
                            empty={
                                kind === "assembly"
                                    ? "No other assembly uses it: it's a top-level assembly."
                                    : "No assembly uses it."
                            }
                        />
                    </section>
                )}
            </div>

            <h2>History</h2>
            <table className="table history">
                <thead>
                    <tr>
                        <th>Version</th>
                        <th>When</th>
                        <th>Who</th>
                        <th>Comment</th>
                        <th className="numeric">Size</th>
                        <th>
                            <span className="visually-hidden">Actions</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {detail.versions.map((version) => (
                        <tr key={version.number}>
                            <td>v{version.number}</td>
                            <td>
                                <Time at={version.created_at} />
                            </td>
                            <td>
                                {version.author.name}
                                <span className="muted"> on {version.host}</span>
                            </td>
                            <td className="comment">{version.comment || <span className="muted">No comment</span>}</td>
                            <td className="numeric">{formatSize(version.size)}</td>
                            <td className="row-actions">
                                <a
                                    className="button button-small"
                                    href={api.downloadUrl(file.id, version.number)}
                                    download
                                >
                                    Download
                                </a>
                                {canRevert && version.number !== file.version && (
                                    <button
                                        type="button"
                                        className="button-small"
                                        onClick={() => setAsking({ action: "revert", version: version.number })}
                                    >
                                        Revert to v{version.number}
                                    </button>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {asking?.action === "release" && holder && (
                <Dialog
                    title={`Release ${holder.user.name}'s check-out?`}
                    confirm="Release check-out"
                    danger
                    busy={busy}
                    onCancel={() => setAsking(null)}
                    onConfirm={() => act(() => api.releaseCheckouts([file.id]))}
                >
                    <p>
                        {file.name} becomes free for anyone to check out. {holder.user.name}'s changes stay on{" "}
                        {holder.host}: to check them in, they'll have to check it out again.
                    </p>
                </Dialog>
            )}
            {asking?.action === "revert" && (
                <Dialog
                    title={`Revert ${file.name} to v${asking.version}?`}
                    confirm={`Revert to v${asking.version}`}
                    danger={holder !== null}
                    busy={busy}
                    onCancel={() => setAsking(null)}
                    onConfirm={() => act(() => api.revert(file.id, asking.version, comment, holder !== null))}
                >
                    <p>
                        It becomes v{file.version + 1}, with v{asking.version}'s contents and the versions of the files
                        it used then. Nothing is lost: v{file.version} stays in the history.
                    </p>
                    {holder && (
                        <Notice tone="warning">
                            {holder.user.name} has it checked out on {holder.host}. Reverting releases the check-out;
                            their changes stay on their computer.
                        </Notice>
                    )}
                    <label className="field">
                        Why? (shown in the history)
                        <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={5000} />
                    </label>
                </Dialog>
            )}
        </article>
    );
}

/** A part's or assembly's drawings, each with the version of it that it shows, and a way to start one. */
function Drawings({ model, canAdd }: { model: VaultFile; canAdd: boolean }) {
    const vault = useVault();
    const heading = useId();
    const [adding, setAdding] = useState(false);
    const [started, setStarted] = useState<string | null>(null);
    const folder = parentOf(model.path);
    const drawings = parentsOf(vault, model).filter((parent) => kindOf(parent.file.name) === "drawing");
    return (
        <section aria-labelledby={heading}>
            <h2 id={heading}>Drawings</h2>
            {drawings.length === 0 ? (
                <p className="muted">There's no drawing of {model.name} yet.</p>
            ) : (
                <ul className="tree">
                    {drawings.map(({ use, file: drawing }) => (
                        <li key={drawing.id}>
                            <span className="tree-row">
                                <span className="disclosure-space" />
                                <Link to={fileUrl(drawing.id)} className="name">
                                    <FileIcon name={drawing.name} />
                                    {drawing.name}
                                </Link>
                                {parentOf(drawing.path) !== folder && (
                                    <span className="muted">in {parentOf(drawing.path) || "the top folder"}</span>
                                )}
                                <span className="muted">
                                    shows <UsedVersion used={use} user={drawing.name} part={model} />
                                </span>
                                <StatusLabel file={drawing} me={vault.me} />
                                <OpenInSolidWorks path={drawing.path} compact />
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {canAdd && (
                <p>
                    <button type="button" onClick={() => setAdding(true)}>
                        New drawing
                    </button>
                </p>
            )}
            {started && <StartedNotice path={started} onDismiss={() => setStarted(null)} />}
            {adding && (
                <NewFileDialog
                    kind="drawing"
                    folder={folder}
                    model={model}
                    onCancel={() => setAdding(false)}
                    onStart={(path) => (setAdding(false), setStarted(path))}
                />
            )}
        </section>
    );
}
