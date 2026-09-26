import { useState } from "react";
import { api, type Folder, type Use, type VaultFile } from "../api";
import { FileIcon, FolderIcon, Notice, OpenInSolidWorks, StatusLabel, Time } from "../components";
import { formatSize } from "../format";
import { NewFileDialog, StartedNotice, type NewKind } from "../newFile";
import { fileUrl, folderUrl, kindOf, parentOf, pathKey } from "../paths";
import { Link } from "../router";
import { atLeast, contentsOf, roleIn, useVault } from "../store";
import { drawingsOf, UsedVersion, usesOf } from "../structure";

const MAX_RESULTS = 200;

export function Browse({ folder }: { folder: string }) {
    const vault = useVault();
    const [search, setSearch] = useState("");
    const [creating, setCreating] = useState<NewKind | null>(null);
    const [started, setStarted] = useState<string | null>(null); // a new file's path, until it's in the vault
    const here = folder === "" ? null : vault.folders.get(pathKey(folder));
    if (folder !== "" && !here) {
        return (
            <Notice tone="error">
                There's no folder <strong>{folder}</strong> in the vault, or you don't have access to it.{" "}
                <Link to="/">Back to the top</Link>
            </Notice>
        );
    }
    const query = search.trim().toLowerCase();
    const found = query
        ? [...vault.files.values()]
              .filter((file) => file.path.toLowerCase().includes(query))
              .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
        : null;
    const { folders, files } = contentsOf(vault, folder);
    const canAdd = atLeast(roleIn(vault, folder), "editor");
    return (
        <section>
            <div className="page-head">
                <Breadcrumbs path={here?.path ?? ""} />
                <div className="page-actions">
                    {canAdd && (
                        <>
                            <button type="button" onClick={() => setCreating("part")}>
                                New part
                            </button>
                            <button type="button" onClick={() => setCreating("assembly")}>
                                New assembly
                            </button>
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
            {started && <StartedNotice path={started} onDismiss={() => setStarted(null)} />}
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
                <p className="empty">{folder === "" ? "The vault is empty." : "This folder is empty."}</p>
            ) : (
                <FileTable key={folder} folders={folders} files={files} />
            )}
            {creating && (
                <NewFileDialog
                    kind={creating}
                    folder={here?.path ?? ""}
                    onCancel={() => setCreating(null)}
                    onStart={(path) => (setCreating(null), setStarted(path))}
                />
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
 * up to show what they use, level by level, each part with its own status.
 */
export function FileTable({
    folders = [],
    files,
    withPaths = false,
}: {
    folders?: Folder[];
    files: VaultFile[];
    withPaths?: boolean;
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
                            <td colSpan={6}>
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
