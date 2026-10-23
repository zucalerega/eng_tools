// Vault paths ("Structures/Fins/Fin.SLDPRT") are case-insensitive and case-preserving, like Windows.

export const pathKey = (path: string): string => path.normalize("NFC").toLowerCase();

export const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Where Vault's pages are, as Yorg's are under /yorg. */
export const VAULT = "/vault";

/** Whether a path is one of Vault's pages. */
export const inVault = (pathname: string): boolean => pathname === VAULT || pathname.startsWith(`${VAULT}/`);

/** A page of Vault's as Vault's routes see it, without /vault: /vault/locks is /locks, and /vault is /. */
export const vaultRoute = (pathname: string): string => pathname.slice(VAULT.length) || "/";

// Until October 2026, Vault's pages were the site's own paths (/files/..., /file/5, /locks), and links to them live
// on in bookmarks and messages. They still work: each goes to the same page under /vault.
const MOVED = /^\/(files|file|trash|assemblies|locks|activity|solidworks|admin)(\/|$)/;

/** Where a link from before Vault moved under /vault goes now, or null for any other path. */
export const movedToVault = (pathname: string): string | null => (MOVED.test(pathname) ? VAULT + pathname : null);

/** The page for a folder: /vault/files/Structures/Fins, or /vault for the top of the vault. */
export function folderUrl(path: string): string {
    return path ? `${VAULT}/files/${encoded(path)}` : VAULT;
}

/** The page for a folder's trash: /vault/trash/Structures/Fins, or /vault/trash for the top of the vault's. */
export function trashUrl(path: string): string {
    return path ? `${VAULT}/trash/${encoded(path)}` : `${VAULT}/trash`;
}

/** The folder a folder's route (/files/...) or its trash's (/trash/...) is for (vaultRoute). */
export function folderFromUrl(route: string): string {
    return route
        .replace(/^\/(files|trash)\/?/, "")
        .split("/")
        .filter((part) => part.length > 0)
        .map(decodeURIComponent)
        .join("/");
}

export const fileUrl = (id: number): string => `${VAULT}/file/${id}`;

/** A file in Caliper, the 3D viewer: its latest version (or the one given), in a configuration if one is given. */
export function caliperUrl(id: number, version?: number, configuration?: string): string {
    const query = new URLSearchParams();
    if (version !== undefined) {
        query.set("version", String(version));
    }
    if (configuration) {
        query.set("configuration", configuration);
    }
    return `${VAULT}/caliper/${id}` + (query.size > 0 ? `?${query}` : "");
}

export type Kind = "part" | "assembly" | "drawing" | "model" | "file";

export function kindOf(name: string): Kind {
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    switch (extension) {
        case "sldprt":
            return "part";
        case "sldasm":
            return "assembly";
        case "slddrw":
            return "drawing";
        case "step":
        case "stp":
        case "igs":
        case "iges":
        case "x_t":
            return "model";
        default:
            return "file";
    }
}

/** Whether "Open in SolidWorks" applies: SolidWorks' own files, which the add-in opens. */
export const opensInSolidWorks = (name: string): boolean => ["part", "assembly", "drawing"].includes(kindOf(name));

/** Which of the formats Caliper reads in the browser a file is in, by its name: STEP or IGES; null for others. */
export function cadFormat(name: string): "step" | "iges" | null {
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (extension === "step" || extension === "stp") {
        return "step";
    }
    return extension === "igs" || extension === "iges" ? "iges" : null;
}

/** Which of the files Caliper reads in the browser, as they are, a file is, by its name: STEP, IGES, or STL. */
export function fileFormat(name: string): "step" | "iges" | "stl" | null {
    return cadFormat(name) ?? (name.toLowerCase().endsWith(".stl") ? "stl" : null);
}

/** Whether Caliper shows a file: SolidWorks parts and assemblies (from their 3D models), and STEP, IGES, and STL files. */
export const opensInCaliper = (name: string): boolean =>
    ["part", "assembly"].includes(kindOf(name)) || fileFormat(name) !== null;

const stem = (name: string) =>
    (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name).normalize("NFC").toLowerCase();

/** "Fin" for "Fin.SLDPRT": a name without its type, as a file's title starts out (stem, in the server's paths.py). */
export const stemOf = (name: string): string =>
    name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name;

/** A file's title where it says more than its name does: someone named it, or its name is a part number. */
export const titleBeside = (file: { name: string; title: string }): string | null =>
    file.title && pathKey(file.title) !== pathKey(stemOf(file.name)) ? file.title : null;

// Part numbers, as the server's vault/numbers.py has them (it has the last word, and the same test cases): a number,
// its kind, then the end of the name or a symbol or a space before more ("00000123-001 - machining").
const NUMBERED = /^(\d{8})-(\d{3})(?![0-9A-Za-z])/;
// McMaster-Carr's part numbers, which their files are named by: 91251A463, "91251A463_Socket Head Screw".
const MCMASTER = /^\d{4,5}[A-Za-z]\d{1,4}(?![0-9A-Za-z])/;
// The files that take numbers of their own, as against being named after one.
const HOLDERS = [".sldprt", ".sldasm", ".step", ".stp", ".stl"];

/** The part number a file's name starts with (00000123-001), and whether the name is that alone; null for none. */
export function partNumberOf(name: string): { number: string; exact: boolean } | null {
    const stemmed = stemOf(name);
    const found = NUMBERED.exec(stemmed);
    return found ? { number: found[0], exact: found[0].length === stemmed.length } : null;
}

/** Whether a file is named as a vendor names its parts (McMaster-Carr's numbers): such a file keeps its name. */
export const vendorsName = (name: string): boolean => MCMASTER.test(stemOf(name));

/** Whether a file's type takes a number of its own: a part, an assembly, or a STEP or STL file. */
export const takesANumber = (name: string): boolean => HOLDERS.some((type) => name.toLowerCase().endsWith(type));

/** Whether a file is named by a part number of its own (a part's, an assembly's), which never changes. */
export const keepsItsName = (name: string): boolean => partNumberOf(name) !== null && takesANumber(name);

/**
 * Whether a drawing is named after a part or assembly, as the vault requires: Fin.SLDDRW, or
 * "Fin - machining.SLDDRW", for Fin.SLDPRT; not Fin2 or Finish (named_after in the server's paths.py).
 */
export function namedAfter(drawing: string, model: string): boolean {
    const [name, base] = [stem(drawing), stem(model)];
    return name === base || (name.startsWith(base) && !/[\p{L}\p{N}]/u.test(name.charAt(base.length)));
}

const MAX_PATH = 200; // as in server/src/yjsp_server/vault/paths.py, which has the last word
const RESERVED = new Set(["CON", "PRN", "AUX", "NUL", ..."123456789".split("").flatMap((n) => [`COM${n}`, `LPT${n}`])]);

/** What's wrong with a new file's name and path, for the vault and for Windows, or null if nothing is. */
export function nameProblem(name: string, path: string): string | null {
    if (name.trim() === "") {
        return "Give it a name.";
    }
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
        return "A name can't contain < > : \" / \\ | ? or *.";
    }
    if (name !== name.trim() || name.endsWith(".")) {
        return "A name can't start or end with a space, or end with a dot.";
    }
    if (RESERVED.has(name.split(".")[0]!.toUpperCase())) {
        return `${name} is a name Windows keeps for itself.`;
    }
    if (name.startsWith("~$")) {
        return "Names starting with ~$ are for SolidWorks' temporary files.";
    }
    if (path.normalize("NFC").length > MAX_PATH) {
        return `The whole path, ${path}, is longer than ${MAX_PATH} characters. Use a shorter name.`;
    }
    return null;
}
