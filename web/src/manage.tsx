import { useState } from "react";
import { api, type Folder, type VaultFile } from "./api";
import { Dialog, Notice } from "./components";
import { formatSize } from "./format";
import { fileAt } from "./newFile";
import { nameProblem, parentOf, pathKey } from "./paths";
import { atLeast, roleIn, useStore, useVault } from "./store";
import { planUpload, upload, type Picked } from "./upload";

// Organizing the vault from the web app: new folders, uploads, moving, and renaming. The server checks
// every one (who may, and that SolidWorks still finds what assemblies use); these dialogs catch what
// they can first, and say what the server said otherwise. Every client picks the change up by syncing.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const extension = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "");

/** Run one change against the server, then fetch the vault again so the page shows it. */
function useChange(onDone: () => void) {
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
            onConfirm={() => run(() => api.createFolder(path))}
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
 * files go up. They're checked in together, as version 1 of each.
 */
export function UploadDialog({ folder, picked, onClose }: { folder: string; picked: Picked[]; onClose: () => void }) {
    const vault = useVault();
    const [plan] = useState(() => planUpload(vault, folder, picked)); // as it was when the files were picked
    const [comment, setComment] = useState("");
    const [progress, setProgress] = useState<{ done: number; current: string } | null>(null);
    const { busy, problem, run } = useChange(onClose);
    const count = plan.ready.length;
    const size = plan.ready.reduce((total, { file }) => total + file.size, 0);
    return (
        <Dialog
            title={`Upload to ${folder || "the top folder"}`}
            confirm={count === 1 ? "Upload 1 file" : `Upload ${count} files`}
            busy={busy}
            disabled={count === 0}
            onConfirm={() => run(() => upload(plan.ready, comment, (done, current) => setProgress({ done, current })))}
            onCancel={onClose}
        >
            {count > 0 ? (
                <p>
                    {count === 1 ? "1 file" : `${count} files`}, {formatSize(size)}, each checked in as version 1.
                </p>
            ) : (
                <p>There's nothing here that can be uploaded.</p>
            )}
            {plan.assemblies > 0 && (
                <Notice tone="warning">
                    The web app can't read which parts an assembly uses. Check each one in once from SolidWorks (check
                    it out, then in), and Vault records its parts.
                </Notice>
            )}
            {plan.skipped.length > 0 && (
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
                    api.move(
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
            onConfirm={() => run(() => api.rename(file ? { file: file.id } : { folder: folder!.path }, typed))}
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
