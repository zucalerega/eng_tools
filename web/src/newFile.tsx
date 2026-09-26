import { useState } from "react";
import type { VaultFile } from "./api";
import { Dialog, Notice, solidWorksLink } from "./components";
import { fileUrl, nameProblem, namedAfter, parentOf, pathKey } from "./paths";
import { Link } from "./router";
import { contentsOf, useVault, type VaultState } from "./store";

// Starting new SolidWorks files from the web app: you name it here, and the add-in on this computer
// makes it (a cvc://new link), saves it in your workspace, and checks it in, checked out to you.

export type NewKind = "part" | "assembly" | "drawing";

const EXTENSIONS: Record<NewKind, string> = { part: ".SLDPRT", assembly: ".SLDASM", drawing: ".SLDDRW" };

const stemOf = (name: string) => (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name);

export function fileAt(vault: VaultState, path: string): VaultFile | undefined {
    const key = pathKey(path);
    return contentsOf(vault, parentOf(path)).files.find((file) => pathKey(file.path) === key);
}

/**
 * Name a new part or assembly in a folder, or a drawing of a part or assembly (in its folder, named after
 * it, as the vault requires). SolidWorks on this computer starts it from your default template, checks
 * it in as version 1, and keeps it checked out to you, so everyone sees it's taken.
 */
export function NewFileDialog({
    kind,
    folder,
    model,
    onCancel,
    onStart,
}: {
    kind: NewKind;
    folder: string;
    model?: VaultFile; // what a new drawing shows
    onCancel: () => void;
    onStart: (path: string) => void;
}) {
    const vault = useVault();
    const [name, setName] = useState(model ? stemOf(model.name) : "");
    const extension = EXTENSIONS[kind];
    const typed = name.trim();
    const fileName = typed.toLowerCase().endsWith(extension.toLowerCase()) ? typed : typed + extension;
    const path = folder ? `${folder}/${fileName}` : fileName;
    const taken = fileAt(vault, path) ?? vault.folders.get(pathKey(path));
    const base = model && stemOf(model.name);
    const problem =
        typed === ""
            ? null
            : (nameProblem(fileName, path) ??
              (taken
                  ? `${taken.path} is already in the vault.`
                  : model && !namedAfter(fileName, model.name)
                    ? `Name it after ${model.name}: "${base}", or "${base}" followed by a space or a symbol, like "${base} - machining".`
                    : null));
    return (
        <Dialog
            title={model ? `New drawing of ${model.name}` : `New ${kind} in ${folder || "the top folder"}`}
            confirm="Start it in SolidWorks"
            link
            confirmHref={
                typed === "" || problem ? undefined : solidWorksLink("new", path, model ? { model: model.path } : {})
            }
            onConfirm={() => onStart(path)}
            onCancel={onCancel}
        >
            <label className="field">
                Name
                <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={kind === "assembly" ? "Fin Can" : "Fin Bracket"}
                    autoFocus
                    aria-invalid={problem !== null}
                />
            </label>
            {problem ? (
                <p className="field-problem" role="alert">
                    {problem}
                </p>
            ) : (
                typed !== "" && <p className="muted">It will be {path}</p>
            )}
            <p className="muted">
                {model
                    ? `SolidWorks on this computer starts it from your default drawing template, with a view of ${model.name}`
                    : `SolidWorks on this computer starts it from your default ${kind} template`}
                , saves it in your Vault workspace, and checks it in as version 1, checked out to you, so everyone sees
                it's yours while you work on it.
            </p>
        </Dialog>
    );
}

/** A new file on its way from SolidWorks on this computer, then there. */
export function StartedNotice({ path, onDismiss }: { path: string; onDismiss: () => void }) {
    const vault = useVault();
    const arrived = fileAt(vault, path);
    return arrived ? (
        <Notice>
            <Link to={fileUrl(arrived.id)}>{arrived.name}</Link> is in the vault, checked out to you. Finish it in
            SolidWorks, then check it in.{" "}
            <button type="button" className="button-small" onClick={onDismiss}>
                OK
            </button>
        </Notice>
    ) : (
        <Notice>
            Starting {path.slice(path.lastIndexOf("/") + 1)} in SolidWorks on this computer. It shows up here once
            SolidWorks has saved it. (This needs the Vault add-in for SolidWorks.){" "}
            <button type="button" className="button-small" onClick={onDismiss}>
                Dismiss
            </button>
        </Notice>
    );
}
