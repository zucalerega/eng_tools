import type { Account } from "../api";
import type { VaultFile } from "./api";
import { kindOf, type Kind } from "./paths";

// Finding files, as a file explorer does: search by name, filters (kind, status, when it was last changed,
// and by whom), and sorting by name, date, or size.

export type SortKey = "name" | "created" | "changed" | "size";

export interface Sort {
    key: SortKey;
    descending: boolean;
}

export const SORTS: { label: string; sort: Sort }[] = [
    { label: "Name, A to Z", sort: { key: "name", descending: false } },
    { label: "Name, Z to A", sort: { key: "name", descending: true } },
    { label: "Newest changes first", sort: { key: "changed", descending: true } },
    { label: "Oldest changes first", sort: { key: "changed", descending: false } },
    { label: "Newest files first", sort: { key: "created", descending: true } },
    { label: "Oldest files first", sort: { key: "created", descending: false } },
    { label: "Largest first", sort: { key: "size", descending: true } },
    { label: "Smallest first", sort: { key: "size", descending: false } },
];

export const sortId = (sort: Sort) => `${sort.key}-${sort.descending ? "down" : "up"}`;

/** A column's first sort: names A to Z, dates newest first, sizes largest first. */
export const firstSort = (key: SortKey): Sort => ({ key, descending: key !== "name" });

export const KINDS: [Kind, string][] = [
    ["part", "Parts"],
    ["assembly", "Assemblies"],
    ["drawing", "Drawings"],
    ["model", "3D models"],
    ["file", "Other files"],
];

export type StatusFilter = "" | "in" | "out" | "mine" | "others";

export const STATUSES: [StatusFilter, string][] = [
    ["in", "Checked in"],
    ["out", "Checked out"],
    ["mine", "Checked out to you"],
    ["others", "Checked out to others"],
];

export type ChangedFilter = "" | "today" | "week" | "month" | "year" | "older";

export const CHANGED: [ChangedFilter, string][] = [
    ["today", "Changed today"],
    ["week", "Changed past week"],
    ["month", "Changed past month"],
    ["year", "Changed past year"],
    ["older", "Unchanged for a year"],
];

export interface Filters {
    search: string;
    kind: Kind | "";
    status: StatusFilter;
    changed: ChangedFilter;
    by: number | null; // who last changed it
}

export const NO_FILTERS: Filters = { search: "", kind: "", status: "", changed: "", by: null };

/** Whether anything narrows the view: then it lists matches from every folder in scope, not a folder's contents. */
export const isFiltering = (filters: Filters): boolean =>
    filters.search.trim() !== "" ||
    filters.kind !== "" ||
    filters.status !== "" ||
    filters.changed !== "" ||
    filters.by !== null;

/** Whether only the search is set, which folders can match too (the other filters are about files). */
export const onlySearching = (filters: Filters): boolean =>
    isFiltering({ ...filters, search: "" }) === false && filters.search.trim() !== "";

/**
 * What a search matches: names containing it, or with * and ? in it, names like it (*.SLDASM, Fin??.SLDPRT);
 * with a / in it, the path (Motor/Grain).
 */
export function searchMatcher(search: string): (item: { name: string; path: string }) => boolean {
    const wanted = search.trim().toLowerCase();
    if (wanted === "") {
        return () => true;
    }
    const field = (item: { name: string; path: string }) =>
        (wanted.includes("/") ? item.path : item.name).toLowerCase();
    if (/[*?]/.test(wanted)) {
        const pattern = [...wanted]
            .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
            .join("");
        const like = new RegExp(`^${pattern}$`, "u");
        return (item) => like.test(field(item));
    }
    return (item) => field(item).includes(wanted);
}

const DAY = 86_400_000;

function changedAsWanted(modified: number, filter: ChangedFilter, now: number): boolean {
    switch (filter) {
        case "":
            return true;
        case "today":
            return modified >= new Date(now).setHours(0, 0, 0, 0);
        case "week":
            return modified >= now - 7 * DAY;
        case "month":
            return modified >= now - 30 * DAY;
        case "year":
            return modified >= now - 365 * DAY;
        case "older":
            return modified < now - 365 * DAY;
    }
}

/** Whether a file passes the filters (the search included). */
export function fileMatcher(filters: Filters, me: Account | null, now = Date.now()): (file: VaultFile) => boolean {
    const searched = searchMatcher(filters.search);
    return (file) => {
        const lock = file.checked_out;
        const status =
            filters.status === "" ||
            (filters.status === "in" && !lock) ||
            (filters.status === "out" && lock !== null) ||
            (filters.status === "mine" && lock !== null && lock.user.id === me?.id) ||
            (filters.status === "others" && lock !== null && lock.user.id !== me?.id);
        return (
            status &&
            searched(file) &&
            (filters.kind === "" || kindOf(file.name) === filters.kind) &&
            (filters.by === null || file.modified_by.id === filters.by) &&
            changedAsWanted(new Date(file.modified_at).getTime(), filters.changed, now)
        );
    };
}

export const compareNames = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

const time = (iso: string) => new Date(iso).getTime();

/** Files in order; ties (and everything, sorting by name) by name. */
export function sortFiles(files: VaultFile[], sort: Sort): VaultFile[] {
    const by: Record<SortKey, (a: VaultFile, b: VaultFile) => number> = {
        name: compareNames,
        created: (a, b) => time(a.created_at) - time(b.created_at),
        changed: (a, b) => time(a.modified_at) - time(b.modified_at),
        size: (a, b) => a.size - b.size,
    };
    const direction = sort.descending ? -1 : 1;
    return [...files].sort((a, b) => direction * by[sort.key](a, b) || compareNames(a, b));
}

const SORT_KEY = "vault.sort";

/** The sort you chose last, in this browser: it applies in every folder. */
export function savedSort(): Sort {
    try {
        const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as Sort | null;
        if (saved && SORTS.some(({ sort }) => sortId(sort) === sortId(saved))) {
            return saved;
        }
    } catch {
        // no storage here (a private window, say), or something else in it: the default
    }
    return SORTS[0]!.sort;
}

export function saveSort(sort: Sort): void {
    try {
        localStorage.setItem(SORT_KEY, JSON.stringify(sort));
    } catch {
        // it just won't be remembered
    }
}
