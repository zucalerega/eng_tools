import { useEffect, useState, type DragEvent } from "react";
import { Dialog, Notice, Time } from "../components";
import { MoveDialog, NameDialog } from "../FolderDialogs";
import { pathTo, within } from "../folders";
import { Link } from "../router";
import { yorg, type SavedView, type ViewFolder } from "./api";
import { useDemo } from "../session";

// The saved views, in folders of their own, as the datasets are in theirs (Datasets.tsx): a folder's own folders and
// views, each folder's views the most recently changed first, and every view when searching. Views and folders are
// moved by dragging them onto a folder (or a folder in the path above), or by choosing views and Move to; chosen views
// are deleted together, for good. Only yours can be chosen or dragged (any, for an admin), as the server allows.

export const viewFolderUrl = (id: number | null): string => (id === null ? "/yorg/views" : `/yorg/views/folders/${id}`);
const viewUrl = (id: number): string => `/yorg/views/${id}`;

const DRAGGED = "application/x-yorg-move-views"; // {views: number[], folder: number | null}
const MAX_LISTED = 8; // views a delete names; past that, how many more

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ViewsPage({ folder }: { folder: number | null }) {
    const demo = useDemo(); // the demo: no folders to make
    const [views, setViews] = useState<SavedView[] | null>(null);
    const [folders, setFolders] = useState<ViewFolder[] | null>(null);
    const [datasets, setDatasets] = useState<Map<number, string>>(new Map()); // their names, for the Data column
    const [problem, setProblem] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [dialog, setDialog] = useState<
        | { kind: "new" }
        | { kind: "rename"; folder: ViewFolder }
        | { kind: "delete"; folder: ViewFolder }
        | { kind: "move" }
        | { kind: "delete-chosen" }
        | null
    >(null);
    const [dropping, setDropping] = useState<string | null>(null); // the folder's key a drag is over

    const load = () =>
        Promise.all([yorg.views(), yorg.viewFolders()]).then(
            ([allViews, allFolders]) => {
                setViews(allViews);
                setFolders(allFolders);
            },
            (error: unknown) => setProblem(message(error)),
        );
    useEffect(() => {
        void load();
        yorg.datasets().then(
            (list) => setDatasets(new Map(list.map((one) => [one.id, one.name]))),
            () => {}, // the views still list, without their data's names
        );
    }, []);
    useEffect(() => setSelected(new Set()), [folder]);

    const byId = new Map((folders ?? []).map((one) => [one.id, one] as const));
    const here = folder === null ? null : (byId.get(folder) ?? null);
    const path = pathTo(folder, byId);
    const dataOf = (view: SavedView) => view.datasets.map((id) => datasets.get(id) ?? `deleted (${id})`).join(", ");
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const searching = words.length > 0;
    const allViews = views ?? [];
    const shownViews = searching
        ? allViews.filter((one) =>
              words.every((word) =>
                  [one.name, one.folder, one.description, dataOf(one)].join(" ").toLowerCase().includes(word),
              ),
          )
        : allViews.filter((one) => one.folder_id === folder);
    const shownFolders = searching
        ? (folders ?? []).filter((one) => words.every((word) => one.name.toLowerCase().includes(word)))
        : (folders ?? []).filter((one) => one.parent_id === folder);
    const inside = (id: number) => allViews.filter((one) => within(one.folder_id, id, byId)).length;
    const where = (id: number | null) =>
        id === null
            ? "Views"
            : pathTo(id, byId)
                  .map((one) => one.name)
                  .join(" / ");
    const choosable = shownViews.filter((one) => one.can_change);

    async function act(work: () => Promise<unknown>) {
        setProblem(null);
        try {
            await work();
        } catch (error) {
            setProblem(message(error));
        }
        await load();
    }

    // Dragging views and folders onto a folder: the folder it's over lights up.
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
            const { views: ids, folder: moved } = JSON.parse(event.dataTransfer.getData(DRAGGED)) as {
                views: number[];
                folder: number | null;
            };
            if (moved !== null) {
                if (target !== null && within(target, moved, byId)) {
                    setProblem("A folder can't go inside itself");
                    return;
                }
                void act(() => yorg.moveViewFolder(moved, target));
            } else if (ids.length > 0) {
                void act(() => yorg.moveViews(ids, target));
                setSelected(new Set());
            }
        },
    });
    const dragViews = (event: DragEvent, view: SavedView) => {
        const ids = selected.has(view.id) ? [...selected] : [view.id];
        event.dataTransfer.setData(DRAGGED, JSON.stringify({ views: ids, folder: null }));
        event.dataTransfer.effectAllowed = "move";
    };
    const dragFolder = (event: DragEvent, dragged: ViewFolder) => {
        event.dataTransfer.setData(DRAGGED, JSON.stringify({ views: [], folder: dragged.id }));
        event.dataTransfer.effectAllowed = "move";
    };

    return (
        <section className="yorg-page">
            <div className="page-head">
                <div className="page-title">
                    {/* In a folder, the way there, above its name: each folder on it takes what's dropped on it. */}
                    {here && (
                        <nav className="breadcrumbs" aria-label="Folders">
                            <Link
                                to={viewFolderUrl(null)}
                                className={dropping === "top" ? "yorg-drop-folder" : undefined}
                                {...dropOn(null, "top")}
                            >
                                Views
                            </Link>
                            {path.slice(0, -1).map((one) => (
                                <span key={one.id}>
                                    <span className="separator" aria-hidden="true">
                                        /
                                    </span>
                                    <Link
                                        to={viewFolderUrl(one.id)}
                                        className={dropping === `crumb-${one.id}` ? "yorg-drop-folder" : undefined}
                                        {...dropOn(one.id, `crumb-${one.id}`)}
                                    >
                                        {one.name}
                                    </Link>
                                </span>
                            ))}
                        </nav>
                    )}
                    <h1>{here?.name ?? "Views"}</h1>
                </div>
                <div className="page-actions">
                    {!demo && (
                        <button type="button" onClick={() => setDialog({ kind: "new" })}>
                            New folder
                        </button>
                    )}
                </div>
            </div>
            {folder === null && (
                <p className="lead muted">
                    Plots someone saved: channels, scales, time windows, and markers. Open one, or use it with another
                    test&apos;s data. Make folders to keep a campaign&apos;s views together, and drag views into them.
                </p>
            )}
            {folder !== null && folders !== null && !here && (
                <Notice tone="warning">
                    This folder isn&apos;t there any more. <Link to="/yorg/views">Back to the views</Link>
                </Notice>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
            {views === null && !problem && <p className="muted">Loading…</p>}
            {views !== null && (
                <>
                    <input
                        type="search"
                        className="search"
                        placeholder="Find views, in every folder"
                        aria-label="Find views"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                    />
                    {selected.size > 0 && (
                        <div className="selection-bar" role="status">
                            <span>
                                {selected.size} {selected.size === 1 ? "view" : "views"} chosen
                            </span>
                            <button type="button" className="button-small" onClick={() => setDialog({ kind: "move" })}>
                                Move to…
                            </button>
                            <button
                                type="button"
                                className="button-small"
                                onClick={() => setDialog({ kind: "delete-chosen" })}
                            >
                                Delete…
                            </button>
                            <button type="button" className="button-small" onClick={() => setSelected(new Set())}>
                                Clear
                            </button>
                        </div>
                    )}
                    {shownFolders.length === 0 && shownViews.length === 0 ? (
                        <div className="empty">
                            {searching
                                ? "No view has that."
                                : folder === null
                                  ? "No saved views yet. Plot a dataset the way you want it, then Save view."
                                  : "This folder is empty: drag views onto it, or pick it when you save a view."}
                        </div>
                    ) : (
                        <div className="table-scroll">
                            <table className="table yorg-views" aria-label="Saved views">
                                <thead>
                                    <tr>
                                        <th className="select">
                                            <input
                                                type="checkbox"
                                                aria-label="Choose every view here"
                                                disabled={choosable.length === 0}
                                                checked={
                                                    choosable.length > 0 &&
                                                    choosable.every((one) => selected.has(one.id))
                                                }
                                                onChange={(event) =>
                                                    setSelected(
                                                        new Set(
                                                            event.target.checked ? choosable.map((one) => one.id) : [],
                                                        ),
                                                    )
                                                }
                                            />
                                        </th>
                                        <th>Name</th>
                                        <th>Data</th>
                                        <th>Changed</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {shownFolders.map((one) => (
                                        <tr
                                            key={`folder-${one.id}`}
                                            className={`yorg-folder-row${dropping === `folder-${one.id}` ? " yorg-drop-folder" : ""}`}
                                            draggable={one.can_change}
                                            onDragStart={(event) => dragFolder(event, one)}
                                            {...dropOn(one.id, `folder-${one.id}`)}
                                        >
                                            <td className="select" />
                                            <td>
                                                <Link to={viewFolderUrl(one.id)} className="name yorg-folder-name">
                                                    <span className="file-icon file-icon-folder" aria-hidden="true" />
                                                    {one.name}
                                                </Link>
                                                {searching && one.parent_id !== null && (
                                                    <p className="muted yorg-description">in {where(one.parent_id)}</p>
                                                )}
                                            </td>
                                            <td className="muted">
                                                {inside(one.id) === 1 ? "1 view" : `${inside(one.id)} views`}
                                            </td>
                                            <td>
                                                {one.created_by?.name ?? "—"}
                                                <span className="muted">
                                                    {" · "}
                                                    <Time at={one.created_at} />
                                                </span>
                                            </td>
                                            <td className="row-actions">
                                                {one.can_change && (
                                                    <>
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
                                                            onClick={() => setDialog({ kind: "delete", folder: one })}
                                                        >
                                                            Delete
                                                        </button>
                                                    </>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    {shownViews.map((view) => (
                                        <tr
                                            key={view.id}
                                            draggable={view.can_change}
                                            onDragStart={(event) => dragViews(event, view)}
                                        >
                                            <td className="select">
                                                {view.can_change && (
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`Choose ${view.name}`}
                                                        checked={selected.has(view.id)}
                                                        onChange={(event) => {
                                                            const next = new Set(selected);
                                                            if (event.target.checked) {
                                                                next.add(view.id);
                                                            } else {
                                                                next.delete(view.id);
                                                            }
                                                            setSelected(next);
                                                        }}
                                                    />
                                                )}
                                            </td>
                                            <td>
                                                <Link to={viewUrl(view.id)} className="name">
                                                    {view.name}
                                                </Link>
                                                {searching && (
                                                    <p className="muted yorg-description">in {where(view.folder_id)}</p>
                                                )}
                                                {view.description && (
                                                    <p className="muted yorg-description">{view.description}</p>
                                                )}
                                            </td>
                                            <td>{dataOf(view)}</td>
                                            <td>
                                                {view.updated_by?.name ?? "—"}
                                                <span className="muted">
                                                    {" · "}
                                                    <Time at={view.updated_at} />
                                                </span>
                                            </td>
                                            <td />
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
            {dialog?.kind === "new" && (
                <NameDialog
                    title={here ? `New folder in ${here.name}` : "New folder"}
                    confirm="Make it"
                    onCancel={() => setDialog(null)}
                    onName={async (name) => {
                        await yorg.addViewFolder(name, folder);
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
                        await yorg.renameViewFolder(dialog.folder.id, name);
                        setDialog(null);
                        await load();
                    }}
                />
            )}
            {dialog?.kind === "delete" && (
                <Dialog
                    title={`Delete ${dialog.folder.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() => {
                        const gone = dialog.folder;
                        setDialog(null);
                        void act(() => yorg.removeViewFolder(gone.id));
                    }}
                    onCancel={() => setDialog(null)}
                >
                    <p>Only an empty folder can be deleted: move its views and folders out first.</p>
                </Dialog>
            )}
            {dialog?.kind === "delete-chosen" && (
                <DeleteDialog
                    chosen={allViews.filter((one) => selected.has(one.id))}
                    onCancel={() => setDialog(null)}
                    onDelete={(ids) => {
                        setDialog(null);
                        setSelected(new Set());
                        void act(() => yorg.removeViews(ids));
                    }}
                />
            )}
            {dialog?.kind === "move" && folders && (
                <MoveDialog
                    folders={folders}
                    title={`Move ${selected.size === 1 ? "a view" : `${selected.size} views`}`}
                    top="Views"
                    from={folder}
                    onCancel={() => setDialog(null)}
                    onMove={(target) => {
                        const ids = [...selected];
                        setDialog(null);
                        setSelected(new Set());
                        void act(() => yorg.moveViews(ids, target));
                    }}
                />
            )}
        </section>
    );
}

/** Deleting the views chosen: named, so it's clear what goes. Views aren't kept once deleted; their data is. */
function DeleteDialog({
    chosen,
    onDelete,
    onCancel,
}: {
    chosen: SavedView[];
    onDelete: (ids: number[]) => void;
    onCancel: () => void;
}) {
    const one = chosen.length === 1;
    return (
        <Dialog
            title={`Delete ${one ? chosen[0]!.name : `${chosen.length} views`}?`}
            confirm="Delete"
            danger
            disabled={chosen.length === 0}
            onConfirm={() => onDelete(chosen.map((view) => view.id))}
            onCancel={onCancel}
        >
            <p>
                {one ? "It's" : "They're"} gone for good: a deleted view can&apos;t be restored. The data stays; only{" "}
                {one ? "this view" : "these views"} of it {one ? "goes" : "go"}.
            </p>
            {!one && (
                <ul className="plain" aria-label="Views to delete">
                    {chosen.slice(0, MAX_LISTED).map((view) => (
                        <li key={view.id}>{view.name}</li>
                    ))}
                    {chosen.length > MAX_LISTED && <li className="muted">and {chosen.length - MAX_LISTED} more</li>}
                </ul>
            )}
        </Dialog>
    );
}
