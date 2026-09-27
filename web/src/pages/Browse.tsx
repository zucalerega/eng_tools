import { useRef, useState, type DragEvent } from "react";
import { api, type Folder, type Use, type VaultFile } from "../api";
import {
    CHANGED,
    compareNames,
    fileMatcher,
    firstSort,
    isFiltering,
    KINDS,
    NO_FILTERS,
    onlySearching,
    savedSort,
    saveSort,
    searchMatcher,
    sortFiles,
    sortId,
    SORTS,
    STATUSES,
    type ChangedFilter,
    type Filters,
    type Sort,
    type SortKey,
    type StatusFilter,
} from "../browsing";
import { FileIcon, FolderIcon, MenuButton, Notice, OpenInSolidWorks, StatusLabel, Time } from "../components";
import { formatDate, formatSize, formatTime } from "../format";
import { DeleteDialog, MoveDialog, NewFolderDialog, RenameDialog, UploadDialog } from "../manage";
import { NewFileDialog, StartedNotice, type NewKind } from "../newFile";
import { fileUrl, folderUrl, kindOf, parentOf, pathKey, trashUrl, type Kind } from "../paths";
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
    | { dialog: "delete" }
    | null;

/** Rows picked with their checkboxes: folders ("d:" and their path key) and files ("f:" and their id). */
export interface Selection {
    selected: ReadonlySet<string>;
    set: (selected: ReadonlySet<string>) => void;
}

const folderKey = (folder: Folder) => "d:" + pathKey(folder.path);
const fileKey = (file: VaultFile) => "f:" + file.id;

/**
 * A folder: its folders and files, sorted as you like; or, while you search or filter, the files that match
 * in it and every folder in it (or in the whole vault), wherever they are.
 */
export function Browse({ folder }: { folder: string }) {
    const vault = useVault();
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);
    const [everywhere, setEverywhere] = useState(false);
    const [sort, setSort] = useState<Sort>(savedSort);
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
    const sortBy = (chosen: Sort) => {
        setSort(chosen);
        saveSort(chosen);
    };
    const narrow = (change: Partial<Filters>) => setFilters((current) => ({ ...current, ...change }));
    const filtering = isFiltering(filters);
    // Searching and filtering look in this folder and every folder in it, or in the whole vault.
    const within = everywhere || path === "" ? null : pathKey(path) + "/";
    const inScope = (item: { path: string }) => within === null || pathKey(item.path).startsWith(within);
    const scope = [...vault.files.values()].filter(inScope);
    const people = new Map(scope.map((file) => [file.modified_by.id, file.modified_by.name]));
    const found = filtering ? sortFiles(scope.filter(fileMatcher(filters, vault.me)), sort) : null;
    const searched = searchMatcher(filters.search);
    const foundFolders = onlySearching(filters)
        ? [...vault.folders.values()]
              .filter((candidate) => inScope(candidate) && searched(candidate))
              .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
        : [];
    const contents = contentsOf(vault, folder);
    const folders = sort.key === "name" && sort.descending ? [...contents.folders].reverse() : contents.folders;
    const files = sortFiles(contents.files, sort);
    const canAdd = atLeast(roleIn(vault, folder), "editor");
    const pickedFolders = folders.filter((f) => selected.has(folderKey(f)));
    const pickedFileList = files.filter((f) => selected.has(fileKey(f)));
    const picked = pickedFolders.length + pickedFileList.length;
    // Moving, renaming, or deleting a folder takes a lead of it; the server checks, and this says so up front.
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
                    <Link className="button" to={trashUrl(path)} title="What was deleted from this folder">
                        Trash
                    </Link>
                </div>
            </div>
            <div className="filter-bar" role="search" aria-label="Find files">
                <input
                    type="search"
                    className="search"
                    placeholder="Search by name, like fin or *.SLDASM"
                    aria-label="Search files"
                    value={filters.search}
                    onChange={(event) => narrow({ search: event.target.value })}
                />
                {here && (
                    <select
                        aria-label="Where to look"
                        value={everywhere ? "all" : "here"}
                        onChange={(event) => setEverywhere(event.target.value === "all")}
                    >
                        <option value="here">In {here.name}</option>
                        <option value="all">In the whole vault</option>
                    </select>
                )}
                <select
                    aria-label="Kind"
                    value={filters.kind}
                    onChange={(event) => narrow({ kind: event.target.value as Kind | "" })}
                >
                    <option value="">All kinds</option>
                    {KINDS.map(([value, label]) => (
                        <option key={value} value={value}>
                            {label}
                        </option>
                    ))}
                </select>
                <select
                    aria-label="Status"
                    value={filters.status}
                    onChange={(event) => narrow({ status: event.target.value as StatusFilter })}
                >
                    <option value="">Any status</option>
                    {STATUSES.map(([value, label]) => (
                        <option key={value} value={value}>
                            {label}
                        </option>
                    ))}
                </select>
                <select
                    aria-label="Last changed"
                    value={filters.changed}
                    onChange={(event) => narrow({ changed: event.target.value as ChangedFilter })}
                >
                    <option value="">Changed any time</option>
                    {CHANGED.map(([value, label]) => (
                        <option key={value} value={value}>
                            {label}
                        </option>
                    ))}
                </select>
                <select
                    aria-label="Changed by"
                    value={filters.by ?? ""}
                    onChange={(event) => narrow({ by: event.target.value ? Number(event.target.value) : null })}
                >
                    <option value="">Changed by anyone</option>
                    {[...people]
                        .sort((a, b) => compareNames({ name: a[1] }, { name: b[1] }))
                        .map(([id, name]) => (
                            <option key={id} value={id}>
                                Changed by {id === vault.me?.id ? "you" : name}
                            </option>
                        ))}
                </select>
                <select
                    aria-label="Sort"
                    className="sort"
                    value={sortId(sort)}
                    onChange={(event) => sortBy(SORTS.find((each) => sortId(each.sort) === event.target.value)!.sort)}
                >
                    {SORTS.map((each) => (
                        <option key={sortId(each.sort)} value={sortId(each.sort)}>
                            {each.label}
                        </option>
                    ))}
                </select>
                {filtering && (
                    <button type="button" className="button-small" onClick={() => setFilters(NO_FILTERS)}>
                        Clear
                    </button>
                )}
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
                    <button
                        type="button"
                        className="button-danger"
                        onClick={() => setOpen({ dialog: "delete" })}
                        disabled={!foldersMovable}
                        title={foldersMovable ? "To this folder's trash" : "Deleting a folder takes a lead of it"}
                    >
                        Delete…
                    </button>
                    <button type="button" className="button-small" onClick={() => setSelected(new Set())}>
                        Clear
                    </button>
                </div>
            )}
            {found ? (
                <>
                    <p className="muted" role="status">
                        {matchSummary(foundFolders.length, found.length, within === null ? "" : path)}
                    </p>
                    {foundFolders.length + found.length > 0 && (
                        <FileTable
                            folders={foundFolders}
                            files={found.slice(0, MAX_RESULTS)}
                            withPaths
                            sort={sort}
                            onSort={sortBy}
                        />
                    )}
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
                    sort={sort}
                    onSort={sortBy}
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
            {open?.dialog === "delete" && (
                <DeleteDialog files={pickedFileList} folders={pickedFolders} onClose={close} />
            )}
        </section>
    );
}

/** "3 folders and 12 files in Motor and the folders in it", or "Nothing matches in the whole vault". */
function matchSummary(folders: number, files: number, within: string): string {
    const where = within ? ` in ${within} and the folders in it` : " in the whole vault";
    const counts = [
        folders > 0 ? `${folders} ${folders === 1 ? "folder" : "folders"}` : "",
        files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : "",
    ].filter((count) => count !== "");
    if (counts.length === 0) {
        return `Nothing matches${where}.`;
    }
    const more = files > MAX_RESULTS ? ` Showing the first ${MAX_RESULTS} files.` : "";
    return `${counts.join(" and ")}${where}.${more}`;
}

/** Vault / Structures / Fins, each a link to its folder; then here, if the page is something in the last one. */
export function Breadcrumbs({ path, here }: { path: string; here?: string }) {
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
            {here && (
                <span>
                    <span className="separator" aria-hidden="true">
                        /
                    </span>
                    <span className="crumb-here">{here}</span>
                </span>
            )}
        </nav>
    );
}

/**
 * Folders and files, with each file's version, whether it's checked in (or who has it), who created it, and
 * who changed it last and when. Assemblies (and drawings) open up to show what they use, level by level,
 * each part with its own status. With a selection, the folders and files (not what they use) get
 * checkboxes; with a sort, the name, date, and size columns sort the table when clicked.
 */
export function FileTable({
    folders = [],
    files,
    withPaths = false,
    selection,
    sort,
    onSort,
}: {
    folders?: Folder[];
    files: VaultFile[];
    withPaths?: boolean;
    selection?: Selection;
    sort?: Sort;
    onSort?: (sort: Sort) => void;
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
    const columns = selection ? 8 : 7;
    // A column that sorts the table: click once to sort by it, again to turn the order around.
    const heading = (label: string, key: SortKey, className?: string) => {
        if (!sort || !onSort) {
            return <th className={className}>{label}</th>;
        }
        const on = sort.key === key;
        return (
            <th className={className} aria-sort={on ? (sort.descending ? "descending" : "ascending") : undefined}>
                <button
                    type="button"
                    className="sort-button"
                    onClick={() => onSort(on ? { key, descending: !sort.descending } : firstSort(key))}
                >
                    {label}
                </button>
            </th>
        );
    };

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
                <td className="name-cell">
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
                <td className="created">
                    <time dateTime={file.created_at} title={formatTime(file.created_at)}>
                        {formatDate(file.created_at)}
                    </time>
                    {file.created_by && ` by ${file.created_by.name}`}
                </td>
                <td className="changed">
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
        <div className="table-scroll">
            <table className="table files" aria-label="Files">
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
                        {heading("Name", "name")}
                        <th>Version</th>
                        <th>Status</th>
                        {heading("Created", "created", "created")}
                        {heading("Last changed", "changed")}
                        {heading("Size", "size", "numeric")}
                        <th>
                            <span className="visually-hidden">Actions</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {folders.map((folder) => {
                        const out = vault.checkedOut.get(pathKey(folder.path)) ?? 0;
                        const label = withPaths ? folder.path : folder.name;
                        return (
                            <tr key={`folder-${folder.id}`}>
                                {pick(folderKey(folder), label)}
                                <td colSpan={2}>
                                    <span className="tree-row">
                                        <span className="disclosure-space" />
                                        <Link to={folderUrl(folder.path)} className="name">
                                            <FolderIcon />
                                            {label}
                                        </Link>
                                    </span>
                                </td>
                                <td colSpan={5}>{out > 0 && <span className="lock">{out} checked out</span>}</td>
                            </tr>
                        );
                    })}
                    {files.flatMap((file) => rows(file, String(file.id), 0, []))}
                </tbody>
            </table>
        </div>
    );
}
