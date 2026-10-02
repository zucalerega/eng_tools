// Vault paths ("Structures/Fins/Fin.SLDPRT") are case-insensitive and case-preserving, like Windows.

export const pathKey = (path: string): string => path.normalize("NFC").toLowerCase();

export const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The page for a folder: /files/Structures/Fins, or / for the top of the vault. */
export function folderUrl(path: string): string {
    return path ? "/files/" + encoded(path) : "/";
}

/** The page for a folder's trash: /trash/Structures/Fins, or /trash for the top of the vault's. */
export function trashUrl(path: string): string {
    return path ? "/trash/" + encoded(path) : "/trash";
}

/** The folder a folder's page (/files/...) or its trash's page (/trash/...) is for. */
export function folderFromUrl(pathname: string): string {
    return pathname
        .replace(/^\/(files|trash)\/?/, "")
        .split("/")
        .filter((part) => part.length > 0)
        .map(decodeURIComponent)
        .join("/");
}

export const fileUrl = (id: number): string => `/file/${id}`;

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

const stem = (name: string) =>
    (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name).normalize("NFC").toLowerCase();

/**
 * Whether a drawing is named after a part or assembly, as the vault requires: Fin.SLDDRW, or
 * "Fin - machining.SLDDRW", for Fin.SLDPRT; not Fin2 or Finish (named_after in the server's paths.py).
 */
export function namedAfter(drawing: string, model: string): boolean {
    const [name, base] = [stem(drawing), stem(model)];
    return name === base || (name.startsWith(base) && !/[\p{L}\p{N}]/u.test(name.charAt(base.length)));
}

const MAX_PATH = 200; // as in server/src/yjsp_server/paths.py, which has the last word
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
