import { createContext, useContext, useSyncExternalStore } from "react";
import { api, ApiError, signIn, type Account, type Folder, type Role, type Sync, type VaultFile } from "./api";
import { parentOf, pathKey } from "./paths";

// The vault as this browser sees it: every folder and file you can see, kept current through the
// same sync feed the CLI and the add-in use. Browsing and searching need no further requests.

export interface Contents {
    folders: Folder[];
    files: VaultFile[];
}

export interface VaultState {
    status: "loading" | "ready" | "failed";
    error: string | null; // the last sync's problem; a ready vault keeps showing what it had
    me: Account | null;
    rootRole: Role | null; // your role at the top of the vault
    folders: ReadonlyMap<string, Folder>; // by path key
    files: ReadonlyMap<number, VaultFile>; // by id
    children: ReadonlyMap<string, Contents>; // by the path key of the folder they're in ("" is the top)
    usedBy: ReadonlyMap<number, VaultFile[]>; // by id: the files whose latest version uses it, by name
    checkedOut: ReadonlyMap<string, number>; // by folder path key: files checked out in it, at any depth
    revision: number; // goes up whenever anything you can see changes
}

const NOTHING: Contents = { folders: [], files: [] };

export class VaultStore {
    private state: VaultState = {
        status: "loading",
        error: null,
        me: null,
        rootRole: null,
        folders: new Map(),
        files: new Map(),
        children: new Map(),
        usedBy: new Map(),
        checkedOut: new Map(),
        revision: 0,
    };
    private readonly listeners = new Set<() => void>();
    private cursor = 0; // the server's seq at the last sync
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running = false;
    private pending: Promise<void> | null = null;

    constructor(private readonly pollMs = 3000) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getState = (): VaultState => this.state;

    /** Load the vault, then keep it current while the page is open and visible. */
    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        document.addEventListener("visibilitychange", this.catchUp);
        void this.load();
    }

    stop(): void {
        this.running = false;
        clearTimeout(this.timer);
        document.removeEventListener("visibilitychange", this.catchUp);
    }

    /** Fetch what changed, now: after this page changed something, say. */
    refresh(): Promise<void> {
        this.pending ??= this.sync().finally(() => (this.pending = null));
        return this.pending;
    }

    private catchUp = () => {
        if (!document.hidden) {
            void this.refresh();
        }
    };

    private async load() {
        await this.refresh();
        this.poll();
    }

    private poll() {
        clearTimeout(this.timer);
        if (!this.running) {
            return;
        }
        this.timer = setTimeout(async () => {
            if (!document.hidden) {
                await this.refresh();
            }
            this.poll();
        }, this.pollMs);
    }

    private async sync() {
        try {
            if (!this.state.me) {
                this.set({ me: await api.me() });
            }
            const changes = await api.sync(this.cursor);
            // Your role at the top isn't in the feed; it only changes when permissions do (a full sync).
            const rootRole = changes.full ? (await api.folder("")).folder.role : this.state.rootRole;
            this.apply(changes, rootRole);
        } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
                signIn(); // signed out in another tab, or the session expired
                return;
            }
            this.set({
                status: this.state.status === "ready" ? "ready" : "failed",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private apply(changes: Sync, rootRole: Role | null) {
        this.cursor = changes.seq;
        const unchanged = !changes.full && changes.folders.length === 0 && changes.files.length === 0;
        if (unchanged && this.state.status === "ready") {
            if (this.state.error) {
                this.set({ error: null });
            }
            return;
        }
        const folders = new Map(changes.full ? [] : this.state.folders);
        const files = new Map(changes.full ? [] : this.state.files);
        for (const folder of changes.folders) {
            folders.set(pathKey(folder.path), folder);
        }
        for (const file of changes.files) {
            if (file.deleted_at) {
                files.delete(file.id);
            } else {
                files.set(file.id, file);
            }
        }
        this.set({
            status: "ready",
            error: null,
            rootRole,
            folders,
            files,
            ...index(folders, files),
            revision: this.state.revision + 1,
        });
    }

    private set(change: Partial<VaultState>) {
        this.state = { ...this.state, ...change };
        this.listeners.forEach((listener) => listener());
    }
}

const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

// What each folder holds, where each file is used, and where things are checked out: worked out once
// per change, so pages never search the whole vault while they draw.
function index(
    folders: ReadonlyMap<string, Folder>,
    files: ReadonlyMap<number, VaultFile>,
): Pick<VaultState, "children" | "usedBy" | "checkedOut"> {
    const children = new Map<string, Contents>();
    const inFolder = (path: string) => {
        const key = pathKey(path);
        let found = children.get(key);
        if (!found) {
            found = { folders: [], files: [] };
            children.set(key, found);
        }
        return found;
    };
    const usedBy = new Map<number, VaultFile[]>();
    const checkedOut = new Map<string, number>();
    folders.forEach((folder) => inFolder(parentOf(folder.path)).folders.push(folder));
    files.forEach((file) => {
        inFolder(parentOf(file.path)).files.push(file);
        for (const use of file.uses) {
            const parents = usedBy.get(use.file_id);
            if (parents) {
                parents.push(file);
            } else {
                usedBy.set(use.file_id, [file]);
            }
        }
        if (file.checked_out) {
            for (let folder = parentOf(file.path); folder !== ""; folder = parentOf(folder)) {
                const key = pathKey(folder);
                checkedOut.set(key, (checkedOut.get(key) ?? 0) + 1);
            }
        }
    });
    children.forEach((contents) => {
        contents.folders.sort(byName);
        contents.files.sort(byName);
    });
    usedBy.forEach((parents) => parents.sort(byName));
    return { children, usedBy, checkedOut };
}

export const StoreContext = createContext<VaultStore | null>(null);

export function useStore(): VaultStore {
    const store = useContext(StoreContext);
    if (!store) {
        throw new Error("useStore needs a StoreContext");
    }
    return store;
}

export function useVault(): VaultState {
    const store = useStore();
    return useSyncExternalStore(store.subscribe, store.getState);
}

/** The folders and files in a folder ("" for the top of the vault). */
export const contentsOf = (vault: VaultState, path: string): Contents => vault.children.get(pathKey(path)) ?? NOTHING;

/** Your role in a folder ("" for the top of the vault). */
export function roleIn(vault: VaultState, folderPath: string): Role | null {
    return folderPath === "" ? vault.rootRole : (vault.folders.get(pathKey(folderPath))?.role ?? null);
}

/** The folder at a path, or, if it isn't in the vault (it's in the trash), the nearest one above it that is. */
export function nearestFolder(vault: VaultState, folderPath: string): string {
    let path = folderPath;
    while (path !== "" && !vault.folders.has(pathKey(path))) {
        path = parentOf(path);
    }
    return path;
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, lead: 3, admin: 4 };

export const atLeast = (role: Role | null, needed: Role): boolean => role !== null && RANK[role] >= RANK[needed];
