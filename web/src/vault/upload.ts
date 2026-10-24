import { type VaultFile, vaultApi } from "./api";
import { keptReferences, on, WEB_HOST } from "./checkouts";
import { kindOf, nameProblem, parentOf, partNumberOf, pathKey, takesANumber } from "./paths";
import { contentsOf, type VaultState } from "./store";
import { readZip } from "../zip";

// Uploading files and whole folders from the browser: each file's contents go up once (the server
// skips contents it has), then they're all checked in together, as one version each. A .zip can go up
// as the files in it, where it was, with the folders in it (like Windows' Extract Here). Files you have
// checked out in the web app go in as their next version: that's checking them in.

/** A file picked or dropped, with where it sits under what was picked (Folder/Sub/Part.SLDPRT). */
export interface Picked {
    file: File;
    relative: string;
}

/** A file to upload: one picked or dropped, or one in a zip that was. */
export interface Source {
    relative: string;
    size: number;
    read: () => Promise<Uint8Array<ArrayBuffer>>;
}

export interface Skipped {
    path: string;
    reason: string;
}

export interface UploadPlan {
    ready: { source: Source; path: string; references: string[] }[]; // references: what a drawing shows
    skipped: Skipped[];
    assemblies: number; // uploaded without their parts recorded (see the dialog)
    updates: number; // new versions of files checked out here
}

// Like the CLI and the add-in: files that are never version-controlled.
const IGNORED = /^(~\$.*|.*\.tmp|thumbs\.db|desktop\.ini|\.ds_store)$/i;

export const isZip = (name: string): boolean => /\.zip$/i.test(name);

/** Picked files, to upload as they are. */
export const asTheyAre = (picked: Picked[]): Source[] =>
    picked.map(({ file, relative }) => ({
        relative,
        size: file.size,
        read: async () => new Uint8Array(await file.arrayBuffer()),
    }));

/**
 * Picked files, with the files in each .zip in its place instead. Zips that can't be read, and files in
 * them that can't, are left out, saying why. opening hears which zip is being read.
 */
export async function unzipped(
    picked: Picked[],
    opening: (relative: string) => void = () => {},
): Promise<{ sources: Source[]; skipped: Skipped[] }> {
    const sources: Source[] = [];
    const skipped: Skipped[] = [];
    for (const one of picked) {
        if (!isZip(one.relative)) {
            sources.push(...asTheyAre([one]));
            continue;
        }
        opening(one.relative);
        const folder = parentOf(one.relative);
        const inside = (path: string) => (folder ? `${folder}/${path}` : path);
        try {
            const zip = await readZip(one.file, one.file.name);
            for (const entry of zip.entries) {
                sources.push({ relative: inside(entry.path), size: entry.size, read: entry.read });
            }
            skipped.push(...zip.skipped.map(({ path, reason }) => ({ path: inside(path), reason })));
        } catch (error) {
            skipped.push({ path: one.relative, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return { sources, skipped };
}

/** What an upload into a folder would add, and what it leaves out, and why. */
export function planUpload(vault: VaultState, folder: string, sources: Source[], skipped: Skipped[] = []): UploadPlan {
    const at = (relative: string) => [folder, ...relative.split("/")].filter((part) => part.length > 0).join("/");
    const plan: UploadPlan = {
        ready: [],
        skipped: skipped.map(({ path, reason }) => ({ path: at(path), reason })),
        assemblies: 0,
        updates: 0,
    };
    const seen = new Set<string>();
    for (const source of sources) {
        const names = source.relative.split("/").filter((name) => name.length > 0);
        const path = at(source.relative);
        const name = names[names.length - 1] ?? "";
        if (IGNORED.test(name)) {
            continue; // temporary and system files: nobody wants these in the vault
        }
        const problem = names.map((part) => nameProblem(part, path)).find((found) => found !== null);
        const key = pathKey(path);
        const existing = contentsOf(vault, parentOf(path)).files.find((file) => pathKey(file.path) === key);
        const references = existing && kindOf(name) === "drawing" ? keptReferences(vault, existing) : [];
        const reason =
            problem ??
            (existing
                ? whyNotCheckedIn(vault, existing.checked_out, name, references)
                : kindOf(name) === "drawing"
                  ? "Drawings are checked in from SolidWorks, so they stay linked to the part or assembly they show."
                  : vault.folders.has(key)
                    ? "There's a folder with that name."
                    : null) ??
            (seen.has(key) ? "It's in this upload twice." : null);
        if (reason) {
            plan.skipped.push({ path, reason });
            continue;
        }
        seen.add(key);
        plan.ready.push({ source, path, references });
        if (existing) {
            plan.updates += 1;
        }
        if (kindOf(name) === "assembly") {
            plan.assemblies += 1;
        }
    }
    return plan;
}

// Why a file already in the vault can't go in as its next version, or null if it's checked out to you here.
function whyNotCheckedIn(
    vault: VaultState,
    lock: VaultFile["checked_out"],
    name: string,
    references: string[],
): string | null {
    if (!lock) {
        return "It's in the vault already. To change it, check it out (on its page, or in SolidWorks), then upload it.";
    }
    if (lock.user.id !== vault.me?.id) {
        return `${lock.user.name} has it checked out ${on(lock.host)}.`;
    }
    if (lock.host !== WEB_HOST) {
        return `It's checked out to you ${on(lock.host)}: check it in there.`;
    }
    if (kindOf(name) === "drawing" && references.length === 0) {
        return "This drawing isn't linked to what it shows, so check it in from SolidWorks.";
    }
    return null;
}

/** The files in what was dropped: files, and folders with everything in them. */
export async function droppedFiles(items: DataTransferItemList): Promise<Picked[]> {
    const entries = [...items].map((item) => item.webkitGetAsEntry()).filter((entry) => entry !== null);
    const picked: Picked[] = [];
    const visit = async (entry: FileSystemEntry): Promise<void> => {
        if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) =>
                (entry as FileSystemFileEntry).file(resolve, reject),
            );
            picked.push({ file, relative: entry.fullPath.replace(/^\/+/, "") });
            return;
        }
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // A folder's entries come in batches; an empty batch means that's all.
        for (;;) {
            const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
                reader.readEntries(resolve, reject),
            );
            if (batch.length === 0) {
                return;
            }
            for (const child of batch) {
                await visit(child);
            }
        }
    };
    for (const entry of entries) {
        await visit(entry);
    }
    return picked;
}

/** What an <input type="file"> picked: with a folder picked, each file's place in it. */
export const pickedFiles = (files: FileList): Picked[] =>
    [...files].map((file) => ({ file, relative: file.webkitRelativePath || file.name }));

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload the files' contents (those the server doesn't have yet), then check them all in as one check-in,
 * all or nothing. progress hears which file is going up. vendor: the parts, assemblies, STEP and STL files among
 * them without part numbers are vendors' parts, which keep their vendors' names.
 */
export async function upload(
    ready: UploadPlan["ready"],
    comment: string,
    progress: (done: number, current: string) => void,
    vendor = false,
): Promise<void> {
    const items = [];
    for (const [index, { source, path, references }] of ready.entries()) {
        progress(index, path);
        const data = await source.read();
        const hash = await sha256(data);
        if (!(await vaultApi.hasBlob(hash))) {
            await vaultApi.uploadBlob(hash, data);
        }
        const vendors = vendor && unnumbered(path) ? { vendor: true } : {};
        items.push({
            path,
            sha256: hash,
            size: data.length,
            references: references.map((used) => ({ path: used })),
            ...vendors,
        });
    }
    progress(ready.length, "");
    await vaultApi.checkin({ comment: comment.trim() || "Uploaded in the web app", host: WEB_HOST, items });
}

/** Whether a file going up is a part, an assembly, or a STEP or STL file without a part number: one that needs a
number once they're required (docs/vault.md, "Part numbers"), unless it's a vendor's part. */
export const unnumbered = (path: string): boolean =>
    takesANumber(path) && partNumberOf(path.slice(path.lastIndexOf("/") + 1)) === null;
