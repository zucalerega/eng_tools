import { useState, type ReactNode } from "react";
import { FolderIcon } from "./components";
import { folderUrl, parentOf, pathKey } from "./paths";
import { Link } from "../router";
import { contentsOf, useVault } from "./store";

/** A folder and the folders above it, as path keys: the way down to it. */
function wayTo(path: string): string[] {
    const keys = [];
    for (let at = path; at !== ""; at = parentOf(at)) {
        keys.push(pathKey(at));
    }
    return keys;
}

/**
 * Every folder you can see, as a tree beside the files, like a file explorer's. The way to the folder
 * you're in opens by itself; you open and close the rest, and it stays as you left it while you move
 * around. Each folder says how many files in it are checked out.
 */
export function FolderTree({ current }: { current: string }) {
    const vault = useVault();
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(wayTo(current)));
    const [shown, setShown] = useState(current);
    if (shown !== current) {
        setShown(current);
        setOpen((was) => new Set([...was, ...wayTo(current)]));
    }
    const toggle = (key: string) =>
        setOpen((was) => {
            const changed = new Set(was);
            if (!changed.delete(key)) {
                changed.add(key);
            }
            return changed;
        });
    const here = pathKey(current);

    const branch = (path: string, depth: number): ReactNode => (
        <ul>
            {contentsOf(vault, path).folders.map((folder) => {
                const key = pathKey(folder.path);
                const inside = contentsOf(vault, folder.path).folders.length > 0;
                const isOpen = inside && open.has(key);
                const out = vault.checkedOut.get(key) ?? 0;
                return (
                    <li key={folder.id}>
                        <span className="tree-node" style={{ paddingLeft: `${depth * 0.9}rem` }}>
                            {inside ? (
                                <button
                                    type="button"
                                    className="disclosure"
                                    aria-expanded={isOpen}
                                    aria-label={`${isOpen ? "Hide" : "Show"} the folders in ${folder.name}`}
                                    onClick={() => toggle(key)}
                                />
                            ) : (
                                <span className="disclosure-space" />
                            )}
                            <Link
                                to={folderUrl(folder.path)}
                                aria-current={key === here ? "page" : undefined}
                                title={folder.path}
                            >
                                <FolderIcon />
                                <span className="tree-name">{folder.name}</span>
                            </Link>
                            {out > 0 && (
                                <span className="tree-out" title={`${out} checked out`}>
                                    {out}
                                </span>
                            )}
                        </span>
                        {isOpen && branch(folder.path, depth + 1)}
                    </li>
                );
            })}
        </ul>
    );

    return (
        <nav className="folder-tree" aria-label="Folder tree">
            <p className="tree-heading">Folders</p>
            <span className="tree-node">
                <span className="disclosure-space" />
                <Link to="/" aria-current={here === "" ? "page" : undefined}>
                    <FolderIcon />
                    <span className="tree-name">Files</span>
                </Link>
            </span>
            {branch("", 1)}
        </nav>
    );
}

/** A folder's pages (its files, its trash): the folder tree on the left, the page beside it. */
export function WithFolderTree({ folder, children }: { folder: string; children: ReactNode }) {
    return (
        <div className="files-layout">
            <FolderTree current={folder} />
            <div className="files-page">{children}</div>
        </div>
    );
}
