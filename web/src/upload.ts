import { api } from "./api";
import { kindOf, nameProblem, parentOf, pathKey } from "./paths";
import { contentsOf, type VaultState } from "./store";

// Uploading files and whole folders from the browser: each file's contents go up once (the server
// skips contents it has), then they're all checked in together, as one version each.

/** A file picked or dropped, with where it sits under what was picked (Folder/Sub/Part.SLDPRT). */
export interface Picked {
    file: File;
    relative: string;
}

export interface UploadPlan {
    ready: { file: File; path: string }[];
    skipped: { path: string; reason: string }[];
    assemblies: number; // uploaded without their parts recorded (see the dialog)
}

// Like the CLI and the add-in: files that are never version-controlled.
const IGNORED = /^(~\$.*|.*\.tmp|thumbs\.db|desktop\.ini|\.ds_store)$/i;

/** What an upload into a folder would add, and what it leaves out, and why. */
export function planUpload(vault: VaultState, folder: string, picked: Picked[]): UploadPlan {
    const plan: UploadPlan = { ready: [], skipped: [], assemblies: 0 };
    const seen = new Set<string>();
    for (const { file, relative } of picked) {
        const names = relative.split("/").filter((name) => name.length > 0);
        const path = [folder, ...names].filter((part) => part.length > 0).join("/");
        const name = names[names.length - 1] ?? file.name;
        if (IGNORED.test(name)) {
            continue; // temporary and system files: nobody wants these in the vault
        }
        const problem = names.map((part) => nameProblem(part, path)).find((found) => found !== null);
        const key = pathKey(path);
        const reason =
            problem ??
            (kindOf(name) === "drawing"
                ? "Drawings are checked in from SolidWorks, so they stay linked to the part or assembly they show."
                : contentsOf(vault, parentOf(path)).files.some((existing) => pathKey(existing.path) === key)
                  ? "It's in the vault already. To change it, check it out and in from SolidWorks."
                  : vault.folders.has(key)
                    ? "There's a folder with that name."
                    : seen.has(key)
                      ? "It's in this upload twice."
                      : null);
        if (reason) {
            plan.skipped.push({ path, reason });
            continue;
        }
        seen.add(key);
        plan.ready.push({ file, path });
        if (kindOf(name) === "assembly") {
            plan.assemblies += 1;
        }
    }
    return plan;
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

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload the files' contents (those the server doesn't have yet), then check them all in as one check-in,
 * all or nothing. progress hears which file is going up.
 */
export async function upload(
    ready: UploadPlan["ready"],
    comment: string,
    progress: (done: number, current: string) => void,
): Promise<void> {
    const items = [];
    for (const [index, { file, path }] of ready.entries()) {
        progress(index, path);
        const data = new Uint8Array(await file.arrayBuffer());
        const hash = await sha256(data);
        if (!(await api.hasBlob(hash))) {
            await api.uploadBlob(hash, data);
        }
        items.push({ path, sha256: hash, size: data.length, references: [] });
    }
    progress(ready.length, "");
    await api.checkin({ comment: comment.trim() || "Uploaded in the web app", host: "web", items });
}
