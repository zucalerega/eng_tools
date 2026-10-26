import { useState, type ReactNode } from "react";
import { Dialog, Notice } from "./components";
import type { TreeFolder } from "./folders";

// What the pages of things in folders (Yorg's datasets, Piper's diagrams) ask: a folder's name, to make or rename one,
// and which folder to move what's chosen to.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A folder's name: a new one's, or a new name for one. Confirmed only once there's a name, and a different one. */
export function NameDialog({
    title,
    confirm,
    initial = "",
    onName,
    onCancel,
}: {
    title: string;
    confirm: string;
    initial?: string;
    onName: (name: string) => Promise<void>;
    onCancel: () => void;
}) {
    const [name, setName] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    return (
        <Dialog
            title={title}
            confirm={confirm}
            busy={busy}
            disabled={!name.trim() || name.trim() === initial}
            onConfirm={() => {
                setBusy(true);
                onName(name.trim()).catch((error: unknown) => {
                    setProblem(message(error));
                    setBusy(false);
                });
            }}
            onCancel={onCancel}
        >
            <label className="field">
                Name
                <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/** Choosing a folder to move what's chosen to: every folder, as a tree, under the top (named as its page is). */
export function MoveDialog({
    folders,
    title,
    top,
    from,
    onMove,
    onCancel,
}: {
    folders: TreeFolder[];
    title: string; // "Move 3 datasets"
    top: string; // the top, by its page's name: "Datasets"
    from: number | null; // the folder they're in, which moving to is no move
    onMove: (folder: number | null) => void;
    onCancel: () => void;
}) {
    const [chosen, setChosen] = useState<number | null>(from);
    const rows: ReactNode[] = [];
    const add = (parent: number | null, depth: number) => {
        for (const one of folders.filter((folder) => folder.parent_id === parent)) {
            rows.push(
                <label
                    key={one.id}
                    className="check folder-move-choice"
                    style={{ paddingLeft: `${0.5 + depth * 1.2}rem` }}
                >
                    <input type="radio" name="folder" checked={chosen === one.id} onChange={() => setChosen(one.id)} />
                    <span className="file-icon file-icon-folder" aria-hidden="true" />
                    {one.name}
                </label>,
            );
            add(one.id, depth + 1);
        }
    };
    add(null, 1);
    return (
        <Dialog
            title={title}
            confirm="Move"
            disabled={chosen === from}
            onConfirm={() => onMove(chosen)}
            onCancel={onCancel}
        >
            <div className="folder-move" role="radiogroup" aria-label="To">
                <label className="check folder-move-choice">
                    <input type="radio" name="folder" checked={chosen === null} onChange={() => setChosen(null)} />
                    {top} (the top)
                </label>
                {rows}
            </div>
        </Dialog>
    );
}
