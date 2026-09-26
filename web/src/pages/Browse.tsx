import { useState } from "react";
import { api, type Folder, type VaultFile } from "../api";
import { FileIcon, FolderIcon, LockLabel, Notice, OpenInSolidWorks, Time } from "../components";
import { formatSize } from "../format";
import { fileUrl, folderUrl, pathKey } from "../paths";
import { Link } from "../router";
import { contentsOf, useVault } from "../store";

const MAX_RESULTS = 200;

export function Browse({ folder }: { folder: string }) {
    const vault = useVault();
    const [search, setSearch] = useState("");
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
    return (
        <section>
            <div className="page-head">
                <Breadcrumbs path={here?.path ?? ""} />
                <input
                    type="search"
                    className="search"
                    placeholder={`Search ${vault.files.size} files`}
                    aria-label="Search all files"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
            </div>
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
                <FileTable folders={folders} files={files} />
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
    return (
        <table className="table files">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Version</th>
                    <th>Checked out</th>
                    <th>Last change</th>
                    <th className="numeric">Size</th>
                    <th>
                        <span className="visually-hidden">Actions</span>
                    </th>
                </tr>
            </thead>
            <tbody>
                {folders.map((folder) => (
                    <tr key={`folder-${folder.id}`}>
                        <td colSpan={6}>
                            <Link to={folderUrl(folder.path)} className="name">
                                <FolderIcon />
                                {folder.name}
                            </Link>
                        </td>
                    </tr>
                ))}
                {files.map((file) => (
                    <tr key={file.id}>
                        <td>
                            <Link to={fileUrl(file.id)} className="name">
                                <FileIcon name={file.name} />
                                {withPaths ? file.path : file.name}
                            </Link>
                        </td>
                        <td>v{file.version}</td>
                        <td>{file.checked_out && <LockLabel lock={file.checked_out} me={vault.me} short />}</td>
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
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
