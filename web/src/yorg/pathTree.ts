// Folders that are paths of their own ("Hotfires/HF-3"), not the datasets' folders: saved views', and the Python
// window's scripts'. The server tidies a path as tidyFolder does (yorg/schemas.py, FolderPath).

/** A folder: what's in it, then its folders. */
export interface Folder<T> {
    name: string; // its last part ("Injector")
    path: string; // all of it ("Hotfires/Injector"; "" at the top)
    items: T[];
    folders: Folder<T>[];
}

/** Things with folder paths ("Hotfires/Injector"), in a tree of folders, each sorted (by order, then name). */
export function folderTree<T extends { name: string; folder: string; order?: number }>(items: T[]): Folder<T> {
    const top: Folder<T> = { name: "", path: "", items: [], folders: [] };
    const byPath = new Map<string, Folder<T>>([["", top]]);
    const folderOf = (path: string): Folder<T> => {
        const found = byPath.get(path);
        if (found) {
            return found;
        }
        const cut = path.lastIndexOf("/");
        const parent = folderOf(cut < 0 ? "" : path.slice(0, cut));
        const made: Folder<T> = { name: cut < 0 ? path : path.slice(cut + 1), path, items: [], folders: [] };
        parent.folders.push(made);
        byPath.set(path, made);
        return made;
    };
    for (const item of items) {
        folderOf(item.folder).items.push(item);
    }
    // In their own order if they have one (the examples), then by name.
    const byName = (a: { name: string; order?: number }, b: { name: string; order?: number }) =>
        (a.order ?? Infinity) - (b.order ?? Infinity) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const sort = (folder: Folder<T>) => {
        folder.items.sort(byName);
        folder.folders.sort(byName);
        folder.folders.forEach(sort);
    };
    sort(top);
    return top;
}

/** A folder path as it's kept: forward slashes, no empty or padded parts (as the server tidies it). */
export function tidyFolder(path: string): string {
    return path
        .replace(/\\/g, "/")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)
        .join("/");
}
