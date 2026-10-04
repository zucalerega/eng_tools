import { useEffect, useEffectEvent, useState } from "react";
import { ApiError } from "../api";
import { type Folder, type VaultFile, vaultApi } from "./api";
import { Dialog, Notice } from "../components";
import { formatSize } from "../format";
import { fileAt } from "./newFile";
import { nameProblem, parentOf, pathKey } from "./paths";
import { atLeast, roleIn, useStore, useVault } from "./store";
import {
    asTheyAre,
    isZip,
    planUpload,
    unzipped,
    upload,
    type Picked,
    type Skipped,
    type Source,
    type UploadPlan,
} from "./upload";

// Organizing the vault from the web app: new folders, uploads, moving, renaming, and deleting. The
// server checks every one (who may, and that SolidWorks still finds what assemblies use); these dialogs
// catch what they can first, and say what the server said otherwise. Every client picks the change up
// by syncing.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const extension = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "");

/** Run one change against the server, then fetch the vault again so the page shows it. */
export function useChange(onDone: () => void) {
    const store = useStore();
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function run(change: () => Promise<unknown>) {
        setBusy(true);
        setProblem(null);
        try {
            await change();
            await store.refresh();
            onDone();
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }
    return { busy, problem, run };
}

export function NewFolderDialog({ folder, onClose }: { folder: string; onClose: () => void }) {
    const vault = useVault();
    const [name, setName] = useState("");
    const { busy, problem, run } = useChange(onClose);
    const typed = name.trim();
    const path = folder ? `${folder}/${typed}` : typed;
    const invalid =
        typed === ""
            ? null
            : (nameProblem(typed, path) ??
              (vault.folders.has(pathKey(path)) || fileAt(vault, path) ? `${path} is taken.` : null));
    return (
        <Dialog
            title={`New folder in ${folder || "the top folder"}`}
            confirm="Create folder"
            busy={busy}
            disabled={typed === "" || invalid !== null}
            onConfirm={() => run(() => vaultApi.createFolder(path))}
            onCancel={onClose}
        >
            <label className="field">
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            {invalid && (
                <p className="field-problem" role="alert">
                    {invalid}
                </p>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/**
 * What an upload will add (and leave out, and why), a comment for the history, and progress while the
 * files go up. They're checked in together, as version 1 of each, or the next version of files checked out
 * here. A zip goes up as the files in it, where it is, unless you say to upload the zip itself.
 */
export function UploadDialog({ folder, picked, onClose }: { folder: string; picked: Picked[]; onClose: () => void }) {
    const vault = useVault();
    const zips = picked.filter(({ relative }) => isZip(relative));
    const [unzip, setUnzip] = useState(true);
    // Planned against the vault as it was when the files were picked: as they are, and unzipped (once
    // the zips have been read).
    const [asIs] = useState(() => planUpload(vault, folder, asTheyAre(picked)));
    const [opened, setOpened] = useState<UploadPlan | null>(null);
    const [opening, setOpening] = useState<string | null>(null);
    const [comment, setComment] = useState("");
    const [progress, setProgress] = useState<{ done: number; current: string } | null>(null);
    const { busy, problem, run } = useChange(onClose);
    const planned = useEffectEvent((sources: Source[], skipped: Skipped[]) =>
        planUpload(vault, folder, sources, skipped),
    );
    useEffect(() => {
        if (!picked.some(({ relative }) => isZip(relative))) {
            return;
        }
        let current = true;
        void unzipped(picked, (relative) => current && setOpening(relative)).then(({ sources, skipped }) => {
            if (current) {
                setOpened(planned(sources, skipped));
                setOpening(null);
            }
        });
        return () => {
            current = false;
        };
    }, [picked]);
    const plan = zips.length > 0 && unzip ? opened : asIs;
    const count = plan?.ready.length ?? 0;
    const size = plan?.ready.reduce((total, { source }) => total + source.size, 0) ?? 0;
    return (
        <Dialog
            title={`Upload to ${folder || "the top folder"}`}
            confirm={count === 1 ? "Upload 1 file" : `Upload ${count} files`}
            busy={busy}
            disabled={count === 0}
            onConfirm={() =>
                plan && run(() => upload(plan.ready, comment, (done, current) => setProgress({ done, current })))
            }
            onCancel={onClose}
        >
            {zips.length > 0 && (
                <label className="check">
                    <input
                        type="checkbox"
                        checked={unzip}
                        disabled={busy}
                        onChange={(event) => setUnzip(event.target.checked)}
                    />
                    {zips.length === 1
                        ? `Unzip ${zips[0]!.file.name} and upload what's in it`
                        : `Unzip the ${zips.length} zip files and upload what's in them`}
                </label>
            )}
            {!plan ? (
                <p className="muted" role="status">
                    Opening {opening ?? "the zip"}…
                </p>
            ) : count > 0 ? (
                <p>{uploadSummary(count, plan.updates, size)}</p>
            ) : (
                <p>There's nothing here that can be uploaded.</p>
            )}
            {plan && count > 0 && (
                <details className="skipped">
                    <summary>Where they go</summary>
                    <ul className="plain upload-list">
                        {plan.ready.map(({ path }) => (
                            <li key={path}>{path}</li>
                        ))}
                    </ul>
                </details>
            )}
            {plan && plan.assemblies > 0 && (
                <Notice tone="warning">
                    The web app can't read which parts an assembly uses. Check each one in once from SolidWorks (check
                    it out, then in), and Vault records its parts.
                </Notice>
            )}
            {plan && plan.skipped.length > 0 && (
                <details className="skipped">
                    <summary>
                        {plan.skipped.length === 1 ? "1 file left out" : `${plan.skipped.length} files left out`}
                    </summary>
                    <ul className="plain">
                        {plan.skipped.map(({ path, reason }) => (
                            <li key={path}>
                                <span>{path}</span>
                                <span className="muted">{reason}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
            {count > 0 && (
                <label className="field">
                    What is it? (shown in each file's history)
                    <input
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                        placeholder="Uploaded in the web app"
                        maxLength={5000}
                    />
                </label>
            )}
            {busy && progress && (
                <p className="muted" role="status">
                    {progress.done < count
                        ? `Uploading ${progress.done + 1} of ${count}: ${progress.current}`
                        : "Checking in…"}
                </p>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

// "2 files, 3 MB, each checked in as version 1", with files checked out here, going in as their next version, apart.
function uploadSummary(count: number, updates: number, size: number): string {
    const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);
    const added = count - updates;
    if (updates === 0) {
        return `${files(added)}, ${formatSize(size)}, each checked in as version 1.`;
    }
    const checkedOut = `${files(updates)} you have checked out here, as ${updates === 1 ? "its" : "their"} next version`;
    return added === 0
        ? `${checkedOut}: ${formatSize(size)}.`
        : `${files(added)} as version 1, and ${checkedOut}: ${formatSize(size)} in all.`;
}

/** Move files and folders into another folder you can add files to. */
export function MoveDialog({
    from,
    files,
    folders,
    onClose,
}: {
    from: string;
    files: VaultFile[];
    folders: Folder[];
    onClose: () => void;
}) {
    const vault = useVault();
    const [filter, setFilter] = useState("");
    const [to, setTo] = useState<string | null>(null);
    const { busy, problem, run } = useChange(onClose);
    const moving = folders.map((folder) => pathKey(folder.path));
    const inside = (path: string) => moving.some((key) => pathKey(path) === key || pathKey(path).startsWith(key + "/"));
    const wanted = filter.trim().toLowerCase();
    const choices = ["", ...[...vault.folders.values()].map((folder) => folder.path)]
        .filter((path) => atLeast(roleIn(vault, path), "editor") && pathKey(path) !== pathKey(from) && !inside(path))
        .filter((path) => (path || "the top folder").toLowerCase().includes(wanted))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const what =
        files.length + folders.length === 1
            ? (files[0]?.name ?? folders[0]!.name)
            : `${files.length + folders.length} items`;
    return (
        <Dialog
            title={`Move ${what}`}
            confirm={to === null ? "Move" : `Move to ${to || "the top folder"}`}
            busy={busy}
            disabled={to === null}
            onConfirm={() =>
                to !== null &&
                run(() =>
                    vaultApi.move(
                        files.map((file) => file.id),
                        folders.map((folder) => folder.path),
                        to,
                    ),
                )
            }
            onCancel={onClose}
        >
            <input
                type="search"
                className="folder-filter"
                placeholder="Find a folder"
                aria-label="Find a folder"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                autoFocus
            />
            <div className="folder-choices" role="radiogroup" aria-label="Move to">
                {choices.length === 0 ? (
                    <p className="muted">No folder you can move these to matches.</p>
                ) : (
                    choices.map((path) => (
                        <label key={path} className="check">
                            <input type="radio" name="to" checked={to === path} onChange={() => setTo(path)} />
                            {path || "The top folder"}
                        </label>
                    ))
                )}
            </div>
            <p className="muted">
                Files SolidWorks assemblies use stay with them: into their folder, or with their whole folder. Vault
                says so if a move would lose one, and every computer's copies follow.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/** Rename a file (keeping its type) or a folder, where it is. */
export function RenameDialog({ file, folder, onClose }: { file?: VaultFile; folder?: Folder; onClose: () => void }) {
    const vault = useVault();
    const current = file?.name ?? folder?.name ?? "";
    const [name, setName] = useState(current);
    const { busy, problem, run } = useChange(onClose);
    const typed = name.trim();
    const parent = parentOf(file?.path ?? folder?.path ?? "");
    const path = parent ? `${parent}/${typed}` : typed;
    const same = pathKey(typed) === pathKey(current);
    const invalid =
        typed === "" || typed === current
            ? null
            : (nameProblem(typed, path) ??
              (file && extension(typed) !== extension(current)
                  ? `Keep the ${extension(current) || "same"} ending: it says what kind of file it is.`
                  : !same && (vault.folders.has(pathKey(path)) || fileAt(vault, path))
                    ? `${path} is taken.`
                    : null));
    return (
        <Dialog
            title={`Rename ${current}`}
            confirm="Rename"
            busy={busy}
            disabled={typed === "" || typed === current || invalid !== null}
            onConfirm={() => run(() => vaultApi.rename(file ? { file: file.id } : { folder: folder!.path }, typed))}
            onCancel={onClose}
        >
            <label className="field">
                New name
                <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            {invalid && (
                <p className="field-problem" role="alert">
                    {invalid}
                </p>
            )}
            {file && (
                <p className="muted">
                    A file that assemblies or drawings use keeps its name: SolidWorks finds it by name. Rename those in
                    SolidWorks.
                </p>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

const MAX_LISTED = 5;

/**
 * Delete files, and folders with everything in them. They go to the trash of the folder they were in,
 * where anyone who can edit there can bring them back, history and all. If files that stay still use
 * some of them (SolidWorks would miss those), it says so first, and deleting them takes a second yes.
 */
export function DeleteDialog({
    files,
    folders,
    onClose,
}: {
    files: VaultFile[];
    folders: Folder[];
    onClose: () => void;
}) {
    const vault = useVault();
    const [force, setForce] = useState(false);
    const { busy, problem, run } = useChange(onClose);
    const home = parentOf((files[0] ?? folders[0])?.path ?? "");
    const under = folders.map((folder) => pathKey(folder.path) + "/");
    const inFolders = [...vault.files.values()].filter((file) =>
        under.some((prefix) => pathKey(file.path).startsWith(prefix)),
    );
    const going = new Map([...files, ...inFolders].map((file) => [file.id, file]));
    const inUse = [...going.values()].flatMap((file) =>
        (vault.usedBy.get(file.id) ?? []).filter((user) => !going.has(user.id)).map((user) => ({ file, user })),
    );
    const taken = [...going.values()].filter((file) => file.checked_out && file.checked_out.user.id !== vault.me?.id);
    const anyway = force || inUse.length > 0;
    const one = files.length + folders.length === 1;
    const what = one ? (files[0]?.name ?? folders[0]!.name) : `${files.length + folders.length} items`;
    return (
        <Dialog
            title={`Delete ${what}?`}
            confirm={anyway ? "Delete anyway" : "Delete"}
            danger
            busy={busy}
            disabled={taken.length > 0}
            onConfirm={() =>
                run(async () => {
                    try {
                        await vaultApi.delete(
                            files.map((file) => file.id),
                            folders.map((folder) => folder.path),
                            anyway,
                        );
                    } catch (error) {
                        if (error instanceof ApiError && error.code === "in_use") {
                            setForce(true); // used by files this page hadn't heard of yet: now it's a second yes
                        }
                        throw error;
                    }
                })
            }
            onCancel={onClose}
        >
            <p>
                {one ? "It goes" : "They go"} to the trash in {home || "the top folder"}, where anyone who can edit
                there can bring {one ? "it" : "them"} back, history and all.
                {inFolders.length > 0 &&
                    (inFolders.length === 1
                        ? ` The file in ${folders.length === 1 ? "the folder" : "these folders"} goes too.`
                        : ` The ${inFolders.length} files in ${folders.length === 1 ? "the folder" : "these folders"} go too.`)}
            </p>
            {inUse.length > 0 && (
                <Notice tone="warning">
                    Files that stay use {inUse.length === 1 ? "one of these" : "some of these"}, and SolidWorks would
                    miss {inUse.length === 1 ? "it" : "them"}:
                    <ul className="plain in-use">
                        {inUse.slice(0, MAX_LISTED).map(({ file, user }) => (
                            <li key={`${file.id}/${user.id}`}>
                                {file.name} is used by {user.path}
                            </li>
                        ))}
                        {inUse.length > MAX_LISTED && <li>and {inUse.length - MAX_LISTED} more</li>}
                    </ul>
                </Notice>
            )}
            {taken.map((file) => (
                <Notice key={file.id} tone="error">
                    {file.checked_out!.user.name} has {file.path} checked out on {file.checked_out!.host}: it can't be
                    deleted until it's checked in.
                </Notice>
            ))}
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}
