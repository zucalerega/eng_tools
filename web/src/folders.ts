// Folders of their own (Yorg's datasets', Piper's diagrams'): each in another, or at the top (parent_id null), as the
// server lists them. The way down to one, for its breadcrumbs, and whether one is inside another, so nothing is moved
// into itself. (Folders that are only paths, as Yorg's views' are, are pathTree.ts'.)

export interface TreeFolder {
    id: number;
    parent_id: number | null;
    name: string;
}

/** The folders from the top down to this one (none, for the top). */
export function pathTo<T extends TreeFolder>(id: number | null, byId: ReadonlyMap<number, T>): T[] {
    const path: T[] = [];
    for (
        let at = id === null ? undefined : byId.get(id);
        at;
        at = at.parent_id === null ? undefined : byId.get(at.parent_id)
    ) {
        path.unshift(at);
        if (path.length > 100) {
            break;
        }
    }
    return path;
}

/** Whether a folder is inside (or is) another. */
export function within(folder: number | null, other: number, byId: ReadonlyMap<number, TreeFolder>): boolean {
    return pathTo(folder, byId).some((one) => one.id === other);
}
