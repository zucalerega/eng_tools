import type { VaultFile } from "./api";
import { parentOf } from "./paths";
import { atLeast, roleIn, type VaultState } from "./store";

// Checking files out and in from the web app, to change them without SolidWorks' Vault tab. A check-out
// here belongs to the web app, as one from SolidWorks belongs to its computer; checking in uploads the
// changed file. The Vault tab in SolidWorks offers to move a web check-out to its computer when you start
// changing the file there.

/** What the web app calls itself where a computer's name goes (the add-in's Workspace.WebHost). */
export const WEB_HOST = "web";

/** Where a check-out is: "in the web app", or "on ALICE-PC". */
export const on = (host: string): string => (host === WEB_HOST ? "in the web app" : `on ${host}`);

/** Whether you can check a file out here: it's in the vault, nobody has it, and you can edit its folder. */
export const canCheckOut = (vault: VaultState, file: VaultFile): boolean =>
    !file.checked_out && !file.deleted_at && atLeast(roleIn(vault, parentOf(file.path)), "editor");

/** Whether a file is checked out to you, here in the web app. */
export const checkedOutHere = (vault: VaultState, file: VaultFile): boolean =>
    file.checked_out?.user.id === vault.me?.id && file.checked_out?.host === WEB_HOST;

/**
 * What a new version checked in here keeps using, by vault path. The web app can't read SolidWorks files,
 * so an assembly's new version records no parts; but a drawing has to stay linked to what it shows, which
 * it keeps from its latest version.
 */
export function keptReferences(vault: VaultState, drawing: VaultFile): string[] {
    return drawing.uses
        .map((use) => vault.files.get(use.file_id))
        .filter((used) => used !== undefined && !used.deleted_at)
        .map((used) => used!.path);
}
