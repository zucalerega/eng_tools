// The Python window's bookkeeping, apart from the page: scripts arranged in their folders, and the channels a script
// names (so they're loaded before it runs).

/** A folder of scripts: its own, then its folders'. */
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

/** The strings a script has in quotes ("PT-TANK", 'FM-OX'), which may name channels. */
export function quoted(code: string): Set<string> {
    const found = new Set<string>();
    const pattern = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
    for (const match of code.matchAll(pattern)) {
        found.add(match[1] ?? match[2] ?? "");
    }
    return found;
}

/** The channels of a test that a script names in quotes: those to load before it runs. */
export function namedChannels(code: string, channels: string[]): string[] {
    const strings = quoted(code);
    return channels.filter((name) => strings.has(name));
}

/**
 * The channels to load before a script runs, of the tests attached to it (dataset: a test's id): those it names in
 * quotes, of the first test, and of another test the script names too (dataset="Hotfire 4", or by its id: dataset=12).
 */
export function channelsToLoad(
    code: string,
    attached: { id: number; name: string; channels: string[] }[],
): { dataset: number; channel: string }[] {
    const strings = quoted(code);
    const named = (test: { id: number; name: string }) =>
        strings.has(test.name) ||
        strings.has(String(test.id)) ||
        new RegExp(`dataset\\s*=\\s*${test.id}(?![\\w.])`).test(code);
    return attached.flatMap((test, index) =>
        index === 0 || named(test)
            ? test.channels.filter((name) => strings.has(name)).map((channel) => ({ dataset: test.id, channel }))
            : [],
    );
}

/**
 * The modules a script imports (import a.b, from a.b import c), each once, in order. Read line by line, not parsed:
 * good enough to know what to get ready ahead of a run (the worker parses the code itself before importing anything).
 */
export function importsOf(code: string): string[] {
    const found = new Set<string>();
    for (const line of code.split("\n")) {
        for (const statement of line.replace(/#.*$/, "").split(";")) {
            const plain = /^\s*import\s+(.+)$/.exec(statement);
            if (plain) {
                for (const part of plain[1]!.split(",")) {
                    const name = /^\s*([A-Za-z_][\w.]*)/.exec(part)?.[1];
                    if (name) {
                        found.add(name);
                    }
                }
                continue;
            }
            const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(statement);
            if (from) {
                found.add(from[1]!);
            }
        }
    }
    return [...found];
}

/** The packages a script imports (the first part of each import's name): scipy for scipy.signal. */
export function topImports(code: string): string[] {
    return [...new Set(importsOf(code).map((name) => name.split(".")[0]!))];
}

// Packages slow enough to import that Python imports them ahead of a run (as yorg.py's _WARM has them), and that do
// nothing on import but get ready.
const WARM = new Set(["numpy", "scipy", "pandas", "matplotlib", "CoolProp", "sympy"]);

/** The slow imports a script has, which Python can get ready before it runs (sorted: the same set, the same list). */
export function slowImports(code: string): string[] {
    return importsOf(code)
        .filter((name) => WARM.has(name.split(".")[0]!))
        .sort();
}

/** A script's name from its file's ("tank blowdown.py" is "tank blowdown"). */
export function nameOfFile(filename: string): string {
    return filename.replace(/\.py$/i, "").trim() || "Script";
}
