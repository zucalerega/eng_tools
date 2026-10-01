import { navigate } from "../../router";
import type { Cell } from "./cells";

// What the tab keeps (sessionStorage: a reload keeps it, another tab doesn't see it) of the Python window: the script
// open on the Scripts page and its cells' last runs, to come back to; and each dataset's or view's page's notebook,
// docked beside its plots. The runs themselves are Python's (python.ts), while it stays open.

/** A script open on the Scripts page: a saved one, an example (saved only as a copy), or a new one, as a notebook. */
export interface OpenScript {
    id: string | null; // saved as, if it is
    example: string | null; // the example it is, if it is
    name: string;
    folder: string;
    cells: Cell[];
    namespace: string; // its variables' in Python: a saved script's are its own, found again when it's opened again
    datasets: number[]; // the tests attached, the first first
    dirty: boolean;
    canChange?: boolean; // false: a saved script of someone else's, which Save keeps a copy of (else it's yours to save)
}

/** A notebook's cells, and their last runs (a cell's id: its run's). */
export interface KeptNotebook {
    cells: Cell[];
    runs: Record<string, string>;
}

const SCRIPT_KEY = "yorg.scripts.open";
const pageKey = (page: string) => `yorg.python.${page}`;

function read<T>(key: string, valid: (found: T) => boolean): T | null {
    try {
        const found = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as T | null;
        return found !== null && valid(found) ? found : null;
    } catch {
        return null;
    }
}

function write(key: string, value: unknown): void {
    try {
        window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
        // storage blocked: the page starts afresh next time
    }
}

const hasCells = (cells: unknown): boolean => Array.isArray(cells) && cells.length > 0;

/** The script open when this tab last left the Scripts page, and its cells' last runs. */
export const keptScript = () =>
    read<{ open: OpenScript; runs: Record<string, string> }>(SCRIPT_KEY, (found) => hasCells(found.open?.cells));

export const keepScript = (open: OpenScript, runs: Record<string, string>) => write(SCRIPT_KEY, { open, runs });

/** A page's notebook, as this tab left it ("dataset-5", "view-12"). */
export const keptNotebook = (page: string) => read<KeptNotebook>(pageKey(page), (found) => hasCells(found.cells));

export const keepNotebook = (page: string, notebook: KeptNotebook) => write(pageKey(page), notebook);

/** Open a notebook on the Scripts page, as a new script: its cells, tests, and variables (its namespace) go along. */
export function openInScripts(script: Omit<OpenScript, "id" | "example" | "folder" | "dirty">): void {
    keepScript({ ...script, id: null, example: null, folder: "", dirty: true }, {});
    navigate("/yorg/scripts");
}
