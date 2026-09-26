// Vault paths ("Structures/Fins/Fin.SLDPRT") are case-insensitive and case-preserving, like Windows.

export const pathKey = (path: string): string => path.normalize("NFC").toLowerCase();

export const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The page for a folder: /files/Structures/Fins, or / for the top of the vault. */
export function folderUrl(path: string): string {
    return path ? "/files/" + path.split("/").map(encodeURIComponent).join("/") : "/";
}

export function folderFromUrl(pathname: string): string {
    return pathname
        .replace(/^\/files\/?/, "")
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
