import { useRef, useState, type DragEvent } from "react";
import { api, type Folder, type Use, type VaultFile } from "../api";
import { FileIcon, FolderIcon, MenuButton, Notice, OpenInSolidWorks, StatusLabel, Time } from "../components";
import { formatSize } from "../format";
import { MoveDialog, NewFolderDialog, RenameDialog, UploadDialog } from "../manage";
import { NewFileDialog, StartedNotice, type NewKind } from "../newFile";
import { fileUrl, folderUrl, kindOf, parentOf, pathKey } from "../paths";
import { Link } from "../router";
import { atLeast, contentsOf, roleIn, useVault } from "../store";
import { drawingsOf, UsedVersion, usesOf } from "../structure";
import { droppedFiles, pickedFiles, type Picked } from "../upload";

const MAX_RESULTS = 200;

type Open =
    | { dialog: "file"; kind: NewKind }
    | { dialog: "folder" }
    | { dialog: "upload"; picked: Picked[] }
    | { dialog: "move" }
    | { dialog: "rename" }
    | null;

/** Rows picked with their checkboxes: folders ("d:" and their path key) and files ("f:" and their id). */
export interface Selection {
    selected: ReadonlySet<string>;
    set: (selected: ReadonlySet<string>) => void;
}

const folderKey = (folder: Folder) => "d:" + pathKey(folder.path);
const fileKey = (file: VaultFile) => "f:" + file.id;

export function Browse({ folder }: { folder: string }) {
    const vault = useVault();
    const [search, setSearch] = useState("");
    const [open, setOpen] = useState<Open>(null);
    const [started, setStarted] = useState<string | null>(null); // a new file's path, until it's in the vault
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [dropping, setDropping] = useState(false);
    const filesInput = useRef<HTMLInputElement | null>(null);
    const folderInput = useRef<HTMLInputElement | null>(null);
    const here = folder === "" ? null : vault.folders.get(pathKey(folder));
    if (folder !== "" && !here) {
        return (
            <Notice tone="error">
                There's no folder <strong>{folder}</strong> in the vault, or you don't have access to it.{" "}
                <Link to="/">Back to the top</Link>
            </Notice>
        );
    }
    const path = here?.path ?? "";
    const query = search.trim().toLowerCase();
    const found = query
        ? [...vault.files.values()]
              .filter((file) => file.path.toLowerCase().includes(query))
              .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
        : null;
    const { folders, files } = contentsOf(vault, folder);
    const canAdd = atLeast(roleIn(vault, folder), "editor");
    const pickedFolders = folders.filter((f) => selected.has(folderKey(f)));
    const pickedFileList = files.filter((f) => selected.has(fileKey(f)));
    const picked = pickedFolders.length + pickedFileList.length;
    // Moving or renaming a folder takes a lead of it; the server checks, and this says so up front.
    const foldersMovable = pickedFolders.every((f) => atLeast(f.role, "lead"));

    function pick(list: FileList | null, input: HTMLInputElement) {
        if (list && list.length > 0) {
            setOpen({ dialog: "upload", picked: pickedFiles(list) });
        }
        input.value = ""; // so picking the same files again still counts
    }

    // Files or folders dragged in from the computer go up to this folder.
    const drop = {
        onDragOver: (event: DragEvent) => {
            if (canAdd && event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                setDropping(true);
            }
        },
        onDragLeave: (event: DragEvent) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropping(false);
            }
        },
        onDrop: (event: DragEvent) => {
            if (!canAdd) {
                return;
            }
            event.preventDefault();
            setDropping(false);
            void droppedFiles(event.dataTransfer.items).then(
                (dropped) => dropped.length > 0 && setOpen({ dialog: "upload", picked: dropped }),
            );
        },
    };

    const close = () => {
        setOpen(null);
        setSelected(new Set());
    };

    return (
        <section className={dropping ? "drop-target" : undefined} {...drop}>
            <div className="page-head">
                <Breadcrumbs path={path} />
                <div className="page-actions">
                    {canAdd && (
                        <>
                            <MenuButton
                                label="New"
                                primary
                                items={[
                                    { label: "Folder…", onSelect: () => setOpen({ dialog: "folder" }) },
                                    { label: "Part…", onSelect: () => setOpen({ dialog: "file", kind: "part" }) },
                                    {
                                        label: "Assembly…",
                                        onSelect: () => setOpen({ dialog: "file", kind: "assembly" }),
                                    },
                                ]}
                            />
                            <MenuButton
                                label="Upload"
                                items={[
                                    { label: "Files…", onSelect: () => filesInput.current?.click() },
                                    { label: "A folder…", onSelect: () => folderInput.current?.click() },
                                ]}
                            />
                            <input
                                ref={filesInput}
                                type="file"
                                multiple
                                hidden
                                aria-label="Upload files"
                                onChange={(event) => pick(event.target.files, event.target)}
                            />
                            <input
                                ref={(input) => {
                                    folderInput.current = input;
                                    input?.setAttribute("webkitdirectory", ""); // pick a folder, with all that's in it
                                }}
                                type="file"
                                hidden
                                aria-label="Upload a folder"
                                onChange={(event) => pick(event.target.files, event.target)}
                            />
                        </>
                    )}
                    <input
                        type="search"
                        className="search"
                        placeholder={`Search ${vault.files.size} files`}
                        aria-label="Search all files"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </div>
            </div>
            {dropping && (
                <p className="drop-hint">Drop files or folders to upload them to {path || "the top folder"}</p>
            )}
            {started && <StartedNotice path={started} onDismiss={() => setStarted(null)} />}
            {picked > 0 && !found && (
                <div className="selection-bar" role="toolbar" aria-label="Selected">
                    <span>{picked} selected</span>
                    <button
                        type="button"
                        onClick={() => setOpen({ dialog: "move" })}
                        disabled={!foldersMovable}
                        title={foldersMovable ? undefined : "Moving a folder takes a lead of it"}
                    >
                        Move to…
                    </button>
                    <button
                        type="button"
                        onClick={() => setOpen({ dialog: "rename" })}
                        disabled={picked !== 1 || !foldersMovable}
                        title={picked !== 1 ? "Rename one at a time" : undefined}
                    >
                        Rename…
                    </button>
                    <button type="button" className="button-small" onClick={() => setSelected(new Set())}>
                        Clear
                    </button>
                </div>
            )}
            {found ? (
                <>
                    <p className="muted">
                        {found.length === 0
                            ? "No files match."
                            : found.length > MAX_RESULTS
                              ? `Showing ${MAX_RESULTS} of ${found.length} matches.`
                              : `${found.length} ${found.length === 1 ? "match" : "matches"}.`}
                    </p>
                    {found.length > 0 && <FileTable files={found.slice(0, MAX_RESULTS)} withPaths />}
                </>
            ) : folders.length === 0 && files.length === 0 ? (
                <p className="empty">
                    {folder === "" ? "The vault is empty." : "This folder is empty."}
                    {canAdd && " Drop files or folders here to upload them."}
                </p>
            ) : (
                <FileTable
                    folders={folders}
                    files={files}
                    selection={canAdd ? { selected, set: setSelected } : undefined}
                />
            )}
            {open?.dialog === "file" && (
                <NewFileDialog
                    kind={open.kind}
                    folder={path}
                    onCancel={() => setOpen(null)}
                    onStart={(started) => (setOpen(null), setStarted(started))}
                />
            )}
            {open?.dialog === "folder" && <NewFolderDialog folder={path} onClose={() => setOpen(null)} />}
            {open?.dialog === "upload" && (
                <UploadDialog folder={path} picked={open.picked} onClose={() => setOpen(null)} />
            )}
            {open?.dialog === "move" && (
                <MoveDialog from={path} files={pickedFileList} folders={pickedFolders} onClose={close} />
            )}
            {open?.dialog === "rename" && (
                <RenameDialog file={pickedFileList[0]} folder={pickedFolders[0]} onClose={close} />
            )}
        </section>
    );
}

export function Breadcrumbs({ path }: { path: string }) {
    const parts = path ? path.split("/") : [];
    return (
        <nav className="breadcrumbs" aria-label="Folders">
            <Link to="/">Vault</Link>
            {parts.map((part, index) => {
                const sub = parts.slice(0, index + 1).join("/");
                return (
                    <span key={sub}>
                        <span className="separator" aria-hidden="true">
                            /
                        </span>
                        <Link to={folderUrl(sub)}>{part}</Link>
                    </span>
                );
            })}
        </nav>
    );
}

/**
 * Folders and files, with each file's version and whether it's checked in. Assemblies (and drawings) open
 * up to show what they use, level by level, each part with its own status. With a selection, the folders
 * and files (not what they use) get checkboxes.
 */
export function FileTable({
    folders = [],
    files,
    withPaths = false,
    selection,
}: {
    folders?: Folder[];
    files: VaultFile[];
    withPaths?: boolean;
    selection?: Selection;
}) {
    const vault = useVault();
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const toggle = (key: string) =>
        setOpen((current) => {
            const changed = new Set(current);
            if (!changed.delete(key)) {
                changed.add(key);
            }
            return changed;
        });
    const everything = [...folders.map(folderKey), ...files.map(fileKey)];
    const all =
        selection !== undefined && everything.length > 0 && everything.every((key) => selection.selected.has(key));
    const pick = (key: string, label: string) =>
        selection && (
            <td className="select">
                <input
                    type="checkbox"
                    aria-label={`Select ${label}`}
                    checked={selection.selected.has(key)}
                    onChange={() => {
                        const changed = new Set(selection.selected);
                        if (!changed.delete(key)) {
                            changed.add(key);
                        }
                        selection.set(changed);
                    }}
                />
            </td>
        );
    const columns = selection ? 7 : 6;

    // A file's row, then (when it's open) the rows of what it uses, indented under it.
    const rows = (file: VaultFile, key: string, depth: number, trail: number[], used?: Use, user?: VaultFile) => {
        // A file can't use itself, but a vault might say one does: don't follow a file already on the way.
        const below = trail.includes(file.id) ? [] : usesOf(vault, file);
        const isOpen = below.length > 0 && open.has(key);
        const folder = parentOf(file.path);
        const drawings = drawingsOf(vault, file);
        const unlinked = kindOf(file.name) === "drawing" && file.uses.length === 0;
        const label = withPaths && depth === 0 ? file.path : file.name;
        const result = [
            <tr key={key} className={depth > 0 ? "used-row" : undefined}>
                {depth === 0 ? pick(fileKey(file), label) : selection && <td className="select" />}
                <td>
                    <span className="tree-row" style={{ paddingLeft: `${depth * 1.4}rem` }}>
                        {below.length > 0 ? (
                            <button
                                type="button"
                                className="disclosure"
                                aria-expanded={isOpen}
                                aria-label={`${isOpen ? "Hide" : "Show"} what ${label} uses`}
                                onClick={() => toggle(key)}
                            />
                        ) : (
                            <span className="disclosure-space" />
                        )}
                        <Link to={fileUrl(file.id)} className="name">
                            <FileIcon name={file.name} />
                            {label}
                        </Link>
                        {user && folder !== parentOf(user.path) && (
                            <span className="muted">in {folder || "the top folder"}</span>
                        )}
                        {drawings.map((drawing) => (
                            <Link key={drawing.id} to={fileUrl(drawing.id)} className="tag" title={drawing.path}>
                                Drawing
                            </Link>
                        ))}
                        {unlinked && (
                            <span className="tag tag-warning" title="Check it in again from SolidWorks to link it">
                                Not linked to a part or assembly
                            </span>
                        )}
                    </span>
                </td>
                <td>{used && user ? <UsedVersion used={used} user={user.name} part={file} /> : `v${file.version}`}</td>
                <td>
                    <StatusLabel file={file} me={vault.me} />
                </td>
                <td>
                    <Time at={file.modified_at} /> by {file.modified_by.name}
                </td>
                <td className="numeric">{formatSize(file.size)}</td>
                <td className="row-actions">
                    <OpenInSolidWorks path={file.path} compact />
                    <a className="button button-small" href={api.downloadUrl(file.id)} download>
                        Download
                    </a>
                </td>
            </tr>,
        ];
        if (isOpen) {
            for (const { use, file: child } of below) {
                const childKey = `${key}/${use.file_id}`;
                if (child) {
                    result.push(...rows(child, childKey, depth + 1, [...trail, file.id], use, file));
                } else {
                    result.push(
                        <tr key={childKey} className="used-row">
                            <td colSpan={columns}>
                                <span className="tree-row" style={{ paddingLeft: `${(depth + 1) * 1.4}rem` }}>
                                    <span className="disclosure-space" />
                                    <Link to={fileUrl(use.file_id)} className="muted">
                                        A file deleted from the vault
                                    </Link>
                                </span>
                            </td>
                        </tr>,
                    );
                }
            }
        }
        return result;
    };

    return (
        <table className="table files">
            <thead>
                <tr>
                    {selection && (
                        <th className="select">
                            <input
                                type="checkbox"
                                aria-label="Select everything here"
                                checked={all}
                                onChange={() => selection.set(new Set(all ? [] : everything))}
                            />
                        </th>
                    )}
                    <th>Name</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Last change</th>
                    <th className="numeric">Size</th>
                    <th>
                        <span className="visually-hidden">Actions</span>
                    </th>
                </tr>
            </thead>
            <tbody>
                {folders.map((folder) => {
                    const out = vault.checkedOut.get(pathKey(folder.path)) ?? 0;
                    return (
                        <tr key={`folder-${folder.id}`}>
                            {pick(folderKey(folder), folder.name)}
                            <td colSpan={2}>
                                <span className="tree-row">
                                    <span className="disclosure-space" />
                                    <Link to={folderUrl(folder.path)} className="name">
                                        <FolderIcon />
                                        {folder.name}
                                    </Link>
                                </span>
                            </td>
                            <td colSpan={4}>{out > 0 && <span className="lock">{out} checked out</span>}</td>
                        </tr>
                    );
                })}
                {files.flatMap((file) => rows(file, String(file.id), 0, []))}
            </tbody>
        </table>
    );
}
