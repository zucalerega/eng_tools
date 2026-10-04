import { useState, type ReactNode } from "react";
import type { Use, VaultFile } from "./api";
import { FileIcon, StatusLabel } from "./components";
import { fileUrl, kindOf, parentOf } from "./paths";
import { Link } from "../router";
import { useVault, type VaultState } from "./store";

// How files fit together, from the sync feed: what an assembly uses (its parts and sub-assemblies; a
// drawing, its model), and where a file is used, up to the top-level assemblies.

/** A link between two files: one uses the other, at this version. file is null if it was deleted since. */
export interface Used {
    use: Use;
    file: VaultFile | null;
}

const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** What a file's latest version uses, by name; deleted files last. */
export function usesOf(vault: VaultState, file: VaultFile): Used[] {
    const found = file.uses.map((use) => ({ use, file: vault.files.get(use.file_id) ?? null }));
    return found.sort((a, b) => (a.file && b.file ? byName(a.file, b.file) : a.file ? -1 : b.file ? 1 : 0));
}

/** A file that uses another (always in the vault: the sync feed only has live files). */
export interface Parent extends Used {
    file: VaultFile;
}

/** The files whose latest version uses this one, by name, with the version of it each one uses. */
export function parentsOf(vault: VaultState, file: VaultFile): Parent[] {
    return (vault.usedBy.get(file.id) ?? []).map((parent) => ({
        use: parent.uses.find((use) => use.file_id === file.id) ?? { file_id: file.id, version: file.version },
        file: parent,
    }));
}

/** Where a file is used, other than in its drawings: the assemblies it's in (or a part derived from it). */
export const usedIn = (vault: VaultState, file: VaultFile): Parent[] =>
    parentsOf(vault, file).filter((parent) => kindOf(parent.file.name) !== "drawing");

/** The drawings of a part or assembly: drawings whose latest version shows it. */
export const drawingsOf = (vault: VaultState, file: VaultFile): VaultFile[] =>
    (vault.usedBy.get(file.id) ?? []).filter((parent) => kindOf(parent.name) === "drawing");

/** Assemblies that no other assembly uses (a drawing of one doesn't count), by path. */
export function topAssemblies(vault: VaultState): VaultFile[] {
    return [...vault.files.values()]
        .filter(
            (file) =>
                kindOf(file.name) === "assembly" &&
                !(vault.usedBy.get(file.id) ?? []).some((parent) => kindOf(parent.name) === "assembly"),
        )
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
}

/** "v1", or "v1 (now v3)" when the used file has moved on since the one using it was checked in. */
export function UsedVersion({ used, user, part }: { used: Use; user: string; part: VaultFile | null }) {
    if (!part || part.version === used.version) {
        return <>v{used.version}</>;
    }
    return (
        <span
            title={`${user} was checked in with v${used.version} of ${part.name}; its latest version is v${part.version}`}
        >
            v{used.version} <span className="muted">(now v{part.version})</span>
        </span>
    );
}

/**
 * A file's structure in one direction, as a tree: what it uses, level by level ("down"), or the
 * assemblies it's in, up to the top-level ones ("up"; drawings are listed on their own). Every file in
 * it says whether it's checked in.
 */
export function StructureTree({
    file,
    direction,
    empty,
}: {
    file: VaultFile;
    direction: "down" | "up";
    empty: string;
}) {
    const vault = useVault();
    const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null); // null until you open or close one
    const next = direction === "down" ? usesOf : usedIn;
    const first = next(vault, file);
    if (first.length === 0) {
        return <p className="muted">{empty}</p>;
    }

    // Rows with more below them, by key: the file ids along the way from this file. A file can't use
    // itself, but a vault might still say one does, so a file already on the way isn't followed again.
    const expandable: string[] = [];
    const walk = (items: Used[], path: string, trail: number[]) => {
        for (const { file: child } of items) {
            const below = child && !trail.includes(child.id) ? next(vault, child) : [];
            if (child && below.length > 0) {
                expandable.push(`${path}/${child.id}`);
                walk(below, `${path}/${child.id}`, [...trail, child.id]);
            }
        }
    };
    walk(first, "", [file.id]);
    // Where-used chains are short, so they start open, up to the top; an assembly can have hundreds of parts.
    const open = chosen ?? new Set(direction === "up" ? expandable : []);
    const allOpen = expandable.every((key) => open.has(key));
    const toggle = (key: string) => {
        const changed = new Set(open);
        if (!changed.delete(key)) {
            changed.add(key);
        }
        setChosen(changed);
    };

    const branch = (items: Used[], parent: VaultFile, path: string, trail: number[]): ReactNode => (
        <ul className="tree">
            {items.map(({ use, file: child }) => {
                const key = `${path}/${child ? child.id : use.file_id}`; // up the tree, use names the file below
                if (!child) {
                    return (
                        <li key={key}>
                            <span className="tree-row">
                                <span className="disclosure-space" />
                                <Link to={fileUrl(use.file_id)} className="muted">
                                    A file deleted from the vault
                                </Link>
                            </span>
                        </li>
                    );
                }
                const below = trail.includes(child.id) ? [] : next(vault, child);
                const isOpen = below.length > 0 && open.has(key);
                const folder = parentOf(child.path);
                return (
                    <li key={key}>
                        <span className="tree-row">
                            {below.length > 0 ? (
                                <button
                                    type="button"
                                    className="disclosure"
                                    aria-expanded={isOpen}
                                    aria-label={
                                        direction === "down"
                                            ? `${isOpen ? "Hide" : "Show"} what ${child.name} uses`
                                            : `${isOpen ? "Hide" : "Show"} where ${child.name} is used`
                                    }
                                    onClick={() => toggle(key)}
                                />
                            ) : (
                                <span className="disclosure-space" />
                            )}
                            <Link to={fileUrl(child.id)} className="name">
                                <FileIcon name={child.name} />
                                {child.name}
                            </Link>
                            {folder !== parentOf(parent.path) && (
                                <span className="muted">in {folder || "the top folder"}</span>
                            )}
                            <span className="muted">
                                {direction === "down" ? (
                                    <UsedVersion used={use} user={parent.name} part={child} />
                                ) : (
                                    <>
                                        uses <UsedVersion used={use} user={child.name} part={parent} />
                                    </>
                                )}
                            </span>
                            <StatusLabel file={child} me={vault.me} />
                        </span>
                        {isOpen && branch(below, child, key, [...trail, child.id])}
                    </li>
                );
            })}
        </ul>
    );

    return (
        <>
            {expandable.length > 0 && (
                <button
                    type="button"
                    className="button-small tree-toggle"
                    onClick={() => setChosen(new Set(allOpen ? [] : expandable))}
                >
                    {allOpen ? "Collapse all" : "Expand all"}
                </button>
            )}
            {branch(first, file, "", [file.id])}
        </>
    );
}
