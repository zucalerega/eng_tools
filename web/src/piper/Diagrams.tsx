import { useEffect, useRef, useState, type DragEvent } from "react";
import { Dialog, Notice, Time } from "../components";
import { MoveDialog, NameDialog } from "../FolderDialogs";
import { pathTo, within } from "../folders";
import { formatSize } from "../format";
import { Link, navigate } from "../router";
import { piper, type Diagram, type DiagramFolder } from "./api";
import { documentOf, emptyDrawing, pageOf, withPage, type Document } from "./drawing";
import { example } from "./example";
import { applyScheme, fluidOf } from "./fluids";
import { readVisio, visioDocument, visioName, type ImportReport } from "./visio";

// The diagrams, in folders, as Yorg's datasets are: a folder's own folders and diagrams, and every diagram when
// searching (by name, folder, description, or a part's tag: PT-101 finds the diagrams it's on). Diagrams and folders
// are moved by dragging them onto a folder (or a folder in the path above), or by choosing them and Move to; chosen
// diagrams are deleted together. Anyone moves any diagram, and makes, renames, and moves folders; only whoever made a
// diagram, or an admin, deletes it, as the server allows.

export const folderUrl = (id: number | null): string => (id === null ? "/piper" : `/piper/folders/${id}`);
const diagramUrl = (id: number, find = ""): string =>
    `/piper/diagrams/${id}${find ? `?find=${encodeURIComponent(find)}` : ""}`;

const DRAGGED = "application/x-piper-move"; // {diagrams: number[], folder: number | null}
const VISIO_FILES = ".vsdx,.vsd,.vdx";
const MAX_LISTED = 8; // diagrams a delete names; past that, how many more

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Asking =
    | { kind: "new-folder" }
    | { kind: "rename"; folder: DiagramFolder }
    | { kind: "delete-folder"; folder: DiagramFolder }
    | { kind: "move" }
    | { kind: "delete-chosen" }
    | { kind: "new-diagram" }
    | null;

export function DiagramsPage({ folder }: { folder: number | null }) {
    const [diagrams, setDiagrams] = useState<Diagram[] | null>(null);
    const [folders, setFolders] = useState<DiagramFolder[] | null>(null);
    const [found, setFound] = useState<Diagram[] | null>(null); // what a search found, in every folder
    const [filter, setFilter] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [dialog, setDialog] = useState<Asking>(null);
    const [importing, setImporting] = useState<File | null>(null); // a Visio drawing picked, or dropped on the page
    const [dropping, setDropping] = useState<string | null>(null); // what a drag is over: "files", or a folder's key
    const picker = useRef<HTMLInputElement>(null);
    const words = filter.trim();
    const searching = words !== "";

    const load = () =>
        Promise.all([piper.diagrams(), piper.folders()]).then(
            ([allDiagrams, allFolders]) => {
                setDiagrams(allDiagrams);
                setFolders(allFolders);
            },
            (error: unknown) => setProblem(message(error)),
        );
    useEffect(() => {
        void load();
    }, []);
    useEffect(() => setSelected(new Set()), [folder]);

    // What's found is the server's to say, since it looks in the drawings' tags: asked once typing pauses.
    useEffect(() => {
        if (!searching) {
            setFound(null);
            return;
        }
        let current = true;
        const timer = setTimeout(() => {
            piper.diagrams({ q: words }).then(
                (list) => current && setFound(list),
                (error: unknown) => current && setProblem(message(error)),
            );
        }, 250);
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [words, searching, diagrams]);

    const byId = new Map((folders ?? []).map((one) => [one.id, one] as const));
    const here = folder === null ? null : (byId.get(folder) ?? null);
    const path = pathTo(folder, byId);
    const lower = words.toLowerCase().split(/\s+/).filter(Boolean);
    const allDiagrams = diagrams ?? [];
    const shownDiagrams = searching ? (found ?? []) : allDiagrams.filter((one) => (one.folder_id ?? null) === folder);
    const shownFolders = searching
        ? (folders ?? []).filter((one) => lower.every((word) => one.name.toLowerCase().includes(word)))
        : (folders ?? []).filter((one) => one.parent_id === folder);
    const inside = (id: number) => allDiagrams.filter((one) => within(one.folder_id ?? null, id, byId)).length;
    const where = (id: number | null | undefined) => (id ? (byId.get(id)?.path ?? "Diagrams") : "Diagrams");
    const chosen = allDiagrams.filter((one) => selected.has(one.id));
    const theirs = chosen.filter((one) => !one.can_delete);

    async function act(work: () => Promise<unknown>) {
        setProblem(null);
        try {
            await work();
        } catch (error) {
            setProblem(message(error));
        }
        await load();
    }

    async function duplicate(diagram: Diagram) {
        setProblem(null);
        try {
            const original = await piper.diagram(diagram.id);
            const copy = await piper.create({
                name: `${diagram.name} copy`,
                folder_id: diagram.folder_id ?? null,
                description: diagram.description,
                drawing: original.drawing,
            });
            navigate(diagramUrl(copy.id));
        } catch (error) {
            setProblem(message(error));
        }
    }

    // Dragging: a Visio drawing from the computer (imported here), or diagrams and folders onto a folder.
    const moving = (event: DragEvent) => event.dataTransfer.types.includes(DRAGGED);
    const dropOn = (target: number | null, key: string) => ({
        onDragOver: (event: DragEvent) => {
            if (moving(event)) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setDropping(key);
            }
        },
        onDragLeave: () => setDropping((current) => (current === key ? null : current)),
        onDrop: (event: DragEvent) => {
            if (!moving(event)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setDropping(null);
            const { diagrams: ids, folder: moved } = JSON.parse(event.dataTransfer.getData(DRAGGED)) as {
                diagrams: number[];
                folder: number | null;
            };
            if (moved !== null) {
                if (target !== null && within(target, moved, byId)) {
                    setProblem("A folder can't go inside itself");
                    return;
                }
                void act(() => piper.changeFolder(moved, { parent_id: target }));
            } else if (ids.length > 0) {
                void act(() => piper.moveAll(ids, target));
                setSelected(new Set());
            }
        },
    });
    const dragDiagrams = (event: DragEvent, diagram: Diagram) => {
        const ids = selected.has(diagram.id) ? [...selected] : [diagram.id];
        event.dataTransfer.setData(DRAGGED, JSON.stringify({ diagrams: ids, folder: null }));
        event.dataTransfer.effectAllowed = "move";
    };
    const dragFolder = (event: DragEvent, dragged: DiagramFolder) => {
        event.dataTransfer.setData(DRAGGED, JSON.stringify({ diagrams: [], folder: dragged.id }));
        event.dataTransfer.effectAllowed = "move";
    };
    const choose = (id: number, on: boolean) => {
        const next = new Set(selected);
        if (on) {
            next.add(id);
        } else {
            next.delete(id);
        }
        setSelected(next);
    };

    const files = (event: DragEvent) => event.dataTransfer.types.includes("Files");
    return (
        <section
            className={`piper-diagrams${dropping === "files" ? " drop-target" : ""}`}
            onDragOver={(event) => {
                if (files(event)) {
                    event.preventDefault();
                    setDropping("files");
                }
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDropping((current) => (current === "files" ? null : current));
                }
            }}
            onDrop={(event) => {
                const file = event.dataTransfer.files[0];
                if (files(event) && file) {
                    event.preventDefault();
                    setDropping(null);
                    setImporting(file);
                }
            }}
        >
            <div className="page-head">
                <div className="page-title">
                    {/* In a folder, the way there, above its name: each folder on it takes what's dropped on it. */}
                    {here && (
                        <nav className="breadcrumbs" aria-label="Folders">
                            <Link
                                to={folderUrl(null)}
                                className={dropping === "top" ? "piper-drop-folder" : undefined}
                                {...dropOn(null, "top")}
                            >
                                Diagrams
                            </Link>
                            {path.slice(0, -1).map((one) => (
                                <span key={one.id}>
                                    <span className="separator" aria-hidden="true">
                                        /
                                    </span>
                                    <Link
                                        to={folderUrl(one.id)}
                                        className={dropping === `crumb-${one.id}` ? "piper-drop-folder" : undefined}
                                        {...dropOn(one.id, `crumb-${one.id}`)}
                                    >
                                        {one.name}
                                    </Link>
                                </span>
                            ))}
                        </nav>
                    )}
                    <h1>{here?.name ?? "Diagrams"}</h1>
                </div>
                <div className="page-actions">
                    <button type="button" onClick={() => picker.current?.click()}>
                        Import Visio…
                    </button>
                    <input
                        ref={picker}
                        type="file"
                        accept={VISIO_FILES}
                        hidden
                        aria-label="Visio drawing to import"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) {
                                setImporting(file);
                            }
                        }}
                    />
                    <button type="button" onClick={() => setDialog({ kind: "new-folder" })}>
                        New folder
                    </button>
                    <button type="button" className="button-primary" onClick={() => setDialog({ kind: "new-diagram" })}>
                        New diagram
                    </button>
                </div>
            </div>
            {folder === null && (
                <p className="muted piper-lead">
                    The team's P&IDs: its test stands, the vehicle's feed system, the GSE. Everyone can open and change
                    them, and every change is kept in a diagram's history. Make folders to keep a system's diagrams
                    together, and drag diagrams into them; drop a Visio drawing anywhere on this page to import it.
                </p>
            )}
            {folder !== null && folders !== null && !here && (
                <Notice tone="warning">
                    This folder isn't there any more. <Link to="/piper">Back to the diagrams</Link>
                </Notice>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
            {diagrams === null && !problem && <p className="muted">Loading…</p>}
            {diagrams !== null && (
                <>
                    <input
                        type="search"
                        className="search"
                        placeholder="Find diagrams in every folder, or a part's tag"
                        aria-label="Find diagrams"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                    />
                    {selected.size > 0 && (
                        <div className="selection-bar" role="status">
                            <span>
                                {selected.size} {selected.size === 1 ? "diagram" : "diagrams"} chosen
                            </span>
                            <button type="button" className="button-small" onClick={() => setDialog({ kind: "move" })}>
                                Move to…
                            </button>
                            <button
                                type="button"
                                className="button-small"
                                disabled={theirs.length > 0}
                                title={
                                    theirs.length > 0
                                        ? `Only whoever made a diagram, or an admin, deletes it: ${theirs[0]!.name} isn't yours`
                                        : undefined
                                }
                                onClick={() => setDialog({ kind: "delete-chosen" })}
                            >
                                Delete…
                            </button>
                            <button type="button" className="button-small" onClick={() => setSelected(new Set())}>
                                Clear
                            </button>
                        </div>
                    )}
                    {shownFolders.length === 0 && shownDiagrams.length === 0 ? (
                        <div className="empty">
                            {searching
                                ? found === null
                                    ? "Looking…"
                                    : "No diagram has that."
                                : folder === null
                                  ? "No diagrams yet. Make the first with New diagram, or import one from Visio."
                                  : "This folder is empty: make a diagram here, or drag diagrams onto it."}
                        </div>
                    ) : (
                        <div className="table-scroll">
                            <table className="table piper-list" aria-label="Diagrams">
                                <thead>
                                    <tr>
                                        <th className="select">
                                            <input
                                                type="checkbox"
                                                aria-label="Choose every diagram here"
                                                disabled={shownDiagrams.length === 0}
                                                checked={
                                                    shownDiagrams.length > 0 &&
                                                    shownDiagrams.every((one) => selected.has(one.id))
                                                }
                                                onChange={(event) =>
                                                    setSelected(
                                                        new Set(
                                                            event.target.checked
                                                                ? shownDiagrams.map((one) => one.id)
                                                                : [],
                                                        ),
                                                    )
                                                }
                                            />
                                        </th>
                                        <th>Name</th>
                                        <th className="numeric">Parts</th>
                                        <th>Fluids</th>
                                        <th>Changed</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {shownFolders.map((one) => (
                                        <tr
                                            key={`folder-${one.id}`}
                                            className={`piper-folder-row${dropping === `folder-${one.id}` ? " piper-drop-folder" : ""}`}
                                            draggable
                                            onDragStart={(event) => dragFolder(event, one)}
                                            {...dropOn(one.id, `folder-${one.id}`)}
                                        >
                                            <td className="select" />
                                            <td>
                                                <Link to={folderUrl(one.id)} className="name folder-name">
                                                    <span className="file-icon file-icon-folder" aria-hidden="true" />
                                                    {one.name}
                                                </Link>
                                                {searching && one.parent_id !== null && (
                                                    <p className="muted piper-description">in {where(one.parent_id)}</p>
                                                )}
                                            </td>
                                            <td className="numeric muted" colSpan={2}>
                                                {inside(one.id) === 1 ? "1 diagram" : `${inside(one.id)} diagrams`}
                                            </td>
                                            <td>
                                                {one.created_by?.name ?? "—"}
                                                <span className="muted">
                                                    {" · "}
                                                    <Time at={one.created_at} />
                                                </span>
                                            </td>
                                            <td className="row-actions">
                                                <button
                                                    type="button"
                                                    className="button-small"
                                                    aria-label={`Rename ${one.name}`}
                                                    onClick={() => setDialog({ kind: "rename", folder: one })}
                                                >
                                                    Rename
                                                </button>
                                                <button
                                                    type="button"
                                                    className="button-small"
                                                    aria-label={`Delete ${one.name}`}
                                                    onClick={() => setDialog({ kind: "delete-folder", folder: one })}
                                                >
                                                    Delete
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {shownDiagrams.map((diagram) => (
                                        <tr
                                            key={diagram.id}
                                            draggable
                                            onDragStart={(event) => dragDiagrams(event, diagram)}
                                        >
                                            <td className="select">
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Choose ${diagram.name}`}
                                                    checked={selected.has(diagram.id)}
                                                    onChange={(event) => choose(diagram.id, event.target.checked)}
                                                />
                                            </td>
                                            <td>
                                                {/* Found by a search: it opens at what was found (a tag on it, PT-101). */}
                                                <Link
                                                    to={diagramUrl(diagram.id, searching ? words : "")}
                                                    className="name"
                                                >
                                                    {diagram.name}
                                                </Link>
                                                {diagram.released && (
                                                    <span className="badge piper-badge-released">
                                                        Rev {diagram.released}
                                                    </span>
                                                )}
                                                {searching && (
                                                    <p className="muted piper-description">
                                                        in {where(diagram.folder_id)}
                                                    </p>
                                                )}
                                                {diagram.description && (
                                                    <p className="muted piper-description">{diagram.description}</p>
                                                )}
                                            </td>
                                            <td className="numeric">
                                                {diagram.parts}
                                                {(diagram.pages ?? 1) > 1 && (
                                                    <span className="muted piper-small" title="On its pages">
                                                        {" "}
                                                        on {diagram.pages}
                                                    </span>
                                                )}
                                            </td>
                                            <td>
                                                <span className="piper-chips">
                                                    {diagram.fluids.slice(0, 5).map((id) => (
                                                        <Fluid key={id} id={id} />
                                                    ))}
                                                </span>
                                            </td>
                                            <td>
                                                {diagram.updated_by?.name ?? "—"}
                                                <span className="muted">
                                                    {" · "}
                                                    <Time at={diagram.updated_at} />
                                                </span>
                                            </td>
                                            <td className="row-actions">
                                                <button
                                                    type="button"
                                                    className="button-small"
                                                    aria-label={`Duplicate ${diagram.name}`}
                                                    onClick={() => void duplicate(diagram)}
                                                >
                                                    Duplicate
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
            <p className="muted piper-foot">
                <Link to="/piper/deleted">Deleted diagrams</Link>
            </p>
            {importing && (
                <ImportDialog
                    file={importing}
                    folder={here}
                    onDone={(made) => {
                        setImporting(null);
                        if (made.length > 0) {
                            void load();
                        }
                    }}
                />
            )}
            {dialog?.kind === "new-diagram" && (
                <NewDialog
                    folder={here}
                    onDone={(made) => {
                        setDialog(null);
                        if (made) {
                            navigate(diagramUrl(made.id));
                        }
                    }}
                />
            )}
            {dialog?.kind === "new-folder" && (
                <NameDialog
                    title={here ? `New folder in ${here.name}` : "New folder"}
                    confirm="Make it"
                    onCancel={() => setDialog(null)}
                    onName={async (name) => {
                        await piper.addFolder(name, folder);
                        setDialog(null);
                        await load();
                    }}
                />
            )}
            {dialog?.kind === "rename" && (
                <NameDialog
                    title={`Rename ${dialog.folder.name}`}
                    confirm="Rename"
                    initial={dialog.folder.name}
                    onCancel={() => setDialog(null)}
                    onName={async (name) => {
                        await piper.changeFolder(dialog.folder.id, { name });
                        setDialog(null);
                        await load();
                    }}
                />
            )}
            {dialog?.kind === "delete-folder" && (
                <Dialog
                    title={`Delete ${dialog.folder.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() => {
                        const gone = dialog.folder;
                        setDialog(null);
                        void act(() => piper.removeFolder(gone.id));
                    }}
                    onCancel={() => setDialog(null)}
                >
                    <p>
                        Only an empty folder can be deleted: move its diagrams and folders out first. Deleted diagrams
                        that were in it go to the folder it's in.
                    </p>
                </Dialog>
            )}
            {dialog?.kind === "delete-chosen" && (
                <DeleteDialog
                    chosen={chosen}
                    onCancel={() => setDialog(null)}
                    onDelete={(ids) => {
                        setDialog(null);
                        setSelected(new Set());
                        void act(() => piper.removeAll(ids));
                    }}
                />
            )}
            {dialog?.kind === "move" && folders && (
                <MoveDialog
                    folders={folders}
                    title={`Move ${selected.size === 1 ? "a diagram" : `${selected.size} diagrams`}`}
                    top="Diagrams"
                    from={folder}
                    onCancel={() => setDialog(null)}
                    onMove={(target) => {
                        const ids = [...selected];
                        setDialog(null);
                        setSelected(new Set());
                        void act(() => piper.moveAll(ids, target));
                    }}
                />
            )}
        </section>
    );
}

/** The deleted diagrams: each kept, history and all, to restore in its folder; several restored together. */
export function DeletedPage() {
    const [diagrams, setDiagrams] = useState<Diagram[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    // Chosen to restore together, as diagrams are chosen to move or delete: yours (any, for an admin).
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const load = () =>
        piper.diagrams({ deleted: true }).then(setDiagrams, (error: unknown) => setProblem(message(error)));
    useEffect(() => {
        void load();
    }, []);
    const choosable = (diagrams ?? []).filter((one) => one.can_delete);
    async function restore(ids: number[]) {
        setProblem(null);
        try {
            await piper.restoreAll(ids);
            setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
        } catch (error) {
            setProblem(message(error));
        }
        await load();
    }
    return (
        <section className="piper-diagrams">
            <div className="page-head">
                <h1 className="page-title">Deleted diagrams</h1>
                <div className="page-actions">
                    <Link className="button" to="/piper">
                        Back to the diagrams
                    </Link>
                </div>
            </div>
            <p className="muted piper-lead">
                A deleted diagram keeps everything, history and all. Restore puts it back in its folder (whoever made
                it, or an admin); check several to restore them together.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {diagrams === null && !problem && <p className="muted">Loading…</p>}
            {diagrams?.length === 0 && <div className="empty">Nothing's been deleted.</div>}
            {selected.size > 0 && (
                <div className="selection-bar" role="status">
                    <span>
                        {selected.size} {selected.size === 1 ? "diagram" : "diagrams"} chosen
                    </span>
                    <button type="button" className="button-small" onClick={() => void restore([...selected])}>
                        Restore
                    </button>
                    <button type="button" className="button-small" onClick={() => setSelected(new Set())}>
                        Clear
                    </button>
                </div>
            )}
            {diagrams && diagrams.length > 0 && (
                <table className="table" aria-label="Deleted diagrams">
                    <thead>
                        <tr>
                            <th className="select">
                                <input
                                    type="checkbox"
                                    aria-label="Choose every deleted diagram"
                                    disabled={choosable.length === 0}
                                    checked={choosable.length > 0 && choosable.every((one) => selected.has(one.id))}
                                    onChange={(event) =>
                                        setSelected(new Set(event.target.checked ? choosable.map((one) => one.id) : []))
                                    }
                                />
                            </th>
                            <th>Name</th>
                            <th>Deleted</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {diagrams.map((diagram) => (
                            <tr key={diagram.id}>
                                <td className="select">
                                    {diagram.can_delete && (
                                        <input
                                            type="checkbox"
                                            aria-label={`Choose ${diagram.name}`}
                                            checked={selected.has(diagram.id)}
                                            onChange={(event) => {
                                                const next = new Set(selected);
                                                if (event.target.checked) {
                                                    next.add(diagram.id);
                                                } else {
                                                    next.delete(diagram.id);
                                                }
                                                setSelected(next);
                                            }}
                                        />
                                    )}
                                </td>
                                <td>
                                    <Link to={diagramUrl(diagram.id)} className="name">
                                        {diagram.name}
                                    </Link>
                                    {diagram.folder && <p className="muted piper-description">in {diagram.folder}</p>}
                                </td>
                                <td>
                                    {diagram.deleted_by?.name ?? "—"}
                                    {diagram.deleted_at && (
                                        <span className="muted">
                                            {" · "}
                                            <Time at={diagram.deleted_at} />
                                        </span>
                                    )}
                                </td>
                                <td className="row-actions">
                                    {diagram.can_delete && (
                                        <button
                                            type="button"
                                            className="button-small"
                                            aria-label={`Restore ${diagram.name}`}
                                            onClick={() => void restore([diagram.id])}
                                        >
                                            Restore
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}

/** Deleting the diagrams chosen: named, so it's clear what goes, and to Deleted diagrams, where they can come back. */
function DeleteDialog({
    chosen,
    onDelete,
    onCancel,
}: {
    chosen: Diagram[];
    onDelete: (ids: number[]) => void;
    onCancel: () => void;
}) {
    const one = chosen.length === 1;
    return (
        <Dialog
            title={`Delete ${one ? chosen[0]!.name : `${chosen.length} diagrams`}?`}
            confirm="Delete"
            danger
            disabled={chosen.length === 0}
            onConfirm={() => onDelete(chosen.map((diagram) => diagram.id))}
            onCancel={onCancel}
        >
            <p>
                {one ? "It goes" : "They go"} to <Link to="/piper/deleted">Deleted diagrams</Link>, history and all,
                where whoever made {one ? "it" : "them"}, or an admin, can restore {one ? "it" : "them"}.
            </p>
            {!one && (
                <ul className="plain" aria-label="Diagrams to delete">
                    {chosen.slice(0, MAX_LISTED).map((diagram) => (
                        <li key={diagram.id}>{diagram.name}</li>
                    ))}
                    {chosen.length > MAX_LISTED && <li className="muted">and {chosen.length - MAX_LISTED} more</li>}
                </ul>
            )}
        </Dialog>
    );
}

/** A fluid's chip: its label, in its color. Standard fluids are known here; a diagram's own say their id. */
function Fluid({ id }: { id: string }) {
    const fluid = fluidOf(emptyDrawing(), id);
    return (
        <span className="piper-chip" style={fluid ? { borderColor: fluid.color, color: fluid.color } : undefined}>
            {fluid?.label ?? id}
        </span>
    );
}

/** A new diagram's drawing in the team's default color scheme, if it has one (Schemes): all its pages share it. */
async function inTeamColors(document: Document): Promise<Document> {
    try {
        const team = (await piper.schemes()).find((scheme) => scheme.is_default);
        return team ? withPage(document, 0, applyScheme(pageOf(document, 0), team)) : document;
    } catch {
        return document; // the schemes out of reach: Piper's own colors
    }
}

/** A new diagram, in the folder it's made in (null: the top): empty, or the example to change or learn from. */
function NewDialog({ folder, onDone }: { folder: DiagramFolder | null; onDone: (made: Diagram | null) => void }) {
    const [name, setName] = useState("");
    const [start, setStart] = useState<"blank" | "example">("blank");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function create() {
        setBusy(true);
        try {
            onDone(
                await piper.create({
                    name: name.trim(),
                    folder_id: folder?.id ?? null,
                    drawing: await inTeamColors(documentOf(start === "example" ? example() : emptyDrawing())),
                }),
            );
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title={folder ? `New diagram in ${folder.name}` : "New diagram"}
            confirm="Make it"
            busy={busy}
            disabled={!name.trim()}
            onConfirm={() => void create()}
            onCancel={() => onDone(null)}
        >
            <label className="field">
                Name
                <input
                    autoFocus
                    value={name}
                    maxLength={200}
                    placeholder="Vespula feed system"
                    onChange={(event) => setName(event.target.value)}
                />
            </label>
            <fieldset className="piper-start">
                <legend>Start with</legend>
                <label className="check">
                    <input type="radio" name="start" checked={start === "blank"} onChange={() => setStart("blank")} />
                    An empty drawing
                </label>
                <label className="check">
                    <input
                        type="radio"
                        name="start"
                        checked={start === "example"}
                        onChange={() => setStart("example")}
                    />
                    An example: a pressure-fed engine's feed system, to change or to learn from
                </label>
            </fieldset>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/**
 * A Visio drawing imported: a diagram, with its pages as Visio had them, in the folder it's imported in, made in this
 * browser (visio.ts) and saved as any diagram is. What became of each page's shapes is said after.
 */
function ImportDialog({
    file: picked,
    folder,
    onDone,
}: {
    file: File; // picked with Import Visio, or dropped on the page
    folder: DiagramFolder | null; // the folder it goes in (null: the top)
    onDone: (made: Diagram[]) => void;
}) {
    const [file, setFile] = useState(picked);
    const other = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [made, setMade] = useState<{ diagram: Diagram; pages: { page: string; report: ImportReport }[] } | null>(
        null,
    );

    async function run() {
        setBusy(true);
        setProblem(null);
        try {
            const pages = await readVisio(file, file.name);
            const diagram = await piper.create({
                name: visioName(file.name),
                folder_id: folder?.id ?? null,
                description: `Imported from ${file.name}`,
                drawing: await inTeamColors(visioDocument(pages)),
            });
            setMade({ diagram, pages: pages.map(({ page, report }) => ({ page, report })) });
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }

    if (made) {
        return (
            <Dialog title="Imported" cancel="Close" onCancel={() => onDone([made.diagram])} wide>
                <p>
                    <Link to={`/piper/diagrams/${made.diagram.id}`} onClick={() => onDone([made.diagram])}>
                        {made.diagram.name}
                    </Link>
                    {made.pages.length > 1 && <span className="muted">, with {made.pages.length} pages</span>}
                </p>
                <ul className="piper-imported">
                    {made.pages.map(({ page, report }, index) => (
                        <li key={index}>
                            {made.pages.length > 1 && <strong>{page}</strong>}
                            <span className="muted">
                                {" "}
                                {[
                                    `${report.parts} ${report.parts === 1 ? "part" : "parts"}`,
                                    `${report.lines} ${report.lines === 1 ? "line" : "lines"}`,
                                    report.notes > 0 && `${report.notes} ${report.notes === 1 ? "note" : "notes"}`,
                                ]
                                    .filter(Boolean)
                                    .join(", ")}
                            </span>
                            {report.boxes.length > 0 && (
                                <p className="piper-small">
                                    Kept as boxes, since Piper has no part for them:{" "}
                                    {[...new Set(report.boxes)].join(", ")}. Replace them with parts from the library,
                                    or keep them.
                                </p>
                            )}
                            {report.dropped > 0 && (
                                <p className="piper-small">
                                    {report.dropped === 1 ? "A connector" : `${report.dropped} connectors`} joined
                                    nothing, and {report.dropped === 1 ? "was" : "were"} left out.
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            </Dialog>
        );
    }
    return (
        <Dialog
            title="Import a Visio drawing"
            confirm="Import"
            busy={busy}
            onConfirm={() => void run()}
            onCancel={() => onDone([])}
        >
            <div className="piper-import-file">
                <span className="file-icon file-icon-visio" data-letter="V" aria-hidden="true" />
                <span className="piper-import-name">
                    <strong>{file.name}</strong>
                    <span className="muted">{formatSize(file.size)}</span>
                </span>
                <button type="button" className="button-small" disabled={busy} onClick={() => other.current?.click()}>
                    Choose another…
                </button>
                <input
                    ref={other}
                    type="file"
                    accept={VISIO_FILES}
                    hidden
                    aria-label="Another Visio drawing"
                    onChange={(event) => {
                        const chosen = event.target.files?.[0];
                        event.target.value = "";
                        if (chosen) {
                            setFile(chosen);
                            setProblem(null);
                        }
                    }}
                />
            </div>
            <p className="muted piper-small">
                It becomes a diagram {folder ? `in ${folder.name}` : "at the top"}, its pages as Visio has them. Visio's
                P&ID shapes become Piper's parts (tagged with their text), connectors become lines between them, and
                colored lines keep their colors as fluids to name. Visio 2013 and on save .vsdx files; save an older
                .vsd as one first.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}
