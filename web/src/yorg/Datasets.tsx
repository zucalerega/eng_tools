import { useEffect, useRef, useState, type DragEvent } from "react";
import { Dialog, Notice, Time } from "../components";
import { MoveDialog, NameDialog } from "../FolderDialogs";
import { pathTo, within } from "../folders";
import { formatSize } from "../format";
import { Link, navigate } from "../router";
import { yorg, type DataFolder, type Dataset } from "./api";
import { reloadDataset } from "./data";
import { formatDuration, formatRate } from "./scale";
import { DATA_FILES, UploadDialog } from "./Upload";

// The datasets, in folders: a folder's own datasets and folders, and every dataset when searching. Datasets and
// folders are moved by dragging them onto a folder (or a folder in the path above), or by choosing them and Move to;
// chosen datasets are deleted together. Only yours can be chosen (any, for an admin), as the server allows.

export const folderUrl = (id: number | null): string => (id === null ? "/yorg" : `/yorg/folders/${id}`);
const datasetUrl = (id: number): string => `/yorg/datasets/${id}`;
const aboutUrl = (id: number): string => `/yorg/datasets/${id}/about`;

const DRAGGED = "application/x-yorg-move"; // {datasets: number[], folder: number | null}
const MAX_LISTED = 8; // datasets a delete names; past that, how many more

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function DatasetsPage({ folder }: { folder: number | null }) {
    const [datasets, setDatasets] = useState<Dataset[] | null>(null);
    const [folders, setFolders] = useState<DataFolder[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [uploading, setUploading] = useState<File[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [dialog, setDialog] = useState<
        | { kind: "new" }
        | { kind: "rename"; folder: DataFolder }
        | { kind: "delete"; folder: DataFolder }
        | { kind: "move" }
        | { kind: "delete-chosen" }
        | null
    >(null);
    const [dropping, setDropping] = useState<string | null>(null); // what a drag is over: "files", or a folder's key
    const picker = useRef<HTMLInputElement>(null);

    const load = () =>
        Promise.all([yorg.datasets(), yorg.folders()]).then(
            ([allDatasets, allFolders]) => {
                setDatasets(allDatasets);
                setFolders(allFolders);
            },
            (error: unknown) => setProblem(message(error)),
        );
    useEffect(() => {
        void load();
    }, []);
    useEffect(() => setSelected(new Set()), [folder]);

    const byId = new Map((folders ?? []).map((one) => [one.id, one] as const));
    const here = folder === null ? null : (byId.get(folder) ?? null);
    const path = pathTo(folder, byId);
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const searching = words.length > 0;
    const allDatasets = datasets ?? [];
    const shownDatasets = searching
        ? allDatasets.filter((one) =>
              words.every((word) => `${one.name} ${one.filename} ${one.description}`.toLowerCase().includes(word)),
          )
        : allDatasets.filter((one) => one.folder_id === folder);
    const shownFolders = searching
        ? (folders ?? []).filter((one) => words.every((word) => one.name.toLowerCase().includes(word)))
        : (folders ?? []).filter((one) => one.parent_id === folder);
    const inside = (id: number) => allDatasets.filter((one) => within(one.folder_id, id, byId)).length;
    const where = (id: number | null) =>
        id === null
            ? "Datasets"
            : pathTo(id, byId)
                  .map((one) => one.name)
                  .join(" / ");
    const choosable = shownDatasets.filter((one) => one.can_change);

    async function act(work: () => Promise<unknown>) {
        setProblem(null);
        try {
            await work();
        } catch (error) {
            setProblem(message(error));
        }
        await load();
    }

    // Dragging: files from the computer (to upload here), or datasets and folders onto a folder.
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
            const { datasets: ids, folder: moved } = JSON.parse(event.dataTransfer.getData(DRAGGED)) as {
                datasets: number[];
                folder: number | null;
            };
            if (moved !== null) {
                if (target !== null && within(target, moved, byId)) {
                    setProblem("A folder can't go inside itself");
                    return;
                }
                void act(() => yorg.moveFolder(moved, target));
            } else if (ids.length > 0) {
                void act(() => yorg.move(ids, target).then(() => ids.forEach((id) => void reloadDataset(id))));
                setSelected(new Set());
            }
        },
    });
    const dragDatasets = (event: DragEvent, dataset: Dataset) => {
        const ids = selected.has(dataset.id) ? [...selected] : [dataset.id];
        event.dataTransfer.setData(DRAGGED, JSON.stringify({ datasets: ids, folder: null }));
        event.dataTransfer.effectAllowed = "move";
    };
    const dragFolder = (event: DragEvent, dragged: DataFolder) => {
        event.dataTransfer.setData(DRAGGED, JSON.stringify({ datasets: [], folder: dragged.id }));
        event.dataTransfer.effectAllowed = "move";
    };

    const files = (event: DragEvent) => event.dataTransfer.types.includes("Files");
    return (
        <section
            className={`yorg-page${dropping === "files" ? " drop-target" : ""}`}
            onDragOver={(event) => {
                if (files(event)) {
                    event.preventDefault();
                    setDropping("files");
                }
            }}
            onDragLeave={() => setDropping((current) => (current === "files" ? null : current))}
            onDrop={(event) => {
                if (files(event)) {
                    event.preventDefault();
                    setDropping(null);
                    setUploading([...event.dataTransfer.files]);
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
                                className={dropping === "top" ? "yorg-drop-folder" : undefined}
                                {...dropOn(null, "top")}
                            >
                                Datasets
                            </Link>
                            {path.slice(0, -1).map((one) => (
                                <span key={one.id}>
                                    <span className="separator" aria-hidden="true">
                                        /
                                    </span>
                                    <Link
                                        to={folderUrl(one.id)}
                                        className={dropping === `crumb-${one.id}` ? "yorg-drop-folder" : undefined}
                                        {...dropOn(one.id, `crumb-${one.id}`)}
                                    >
                                        {one.name}
                                    </Link>
                                </span>
                            ))}
                        </nav>
                    )}
                    <h1>{here?.name ?? "Datasets"}</h1>
                </div>
                <div className="page-actions">
                    <Link className="button" to="/yorg/views">
                        Saved views
                    </Link>
                    <button type="button" onClick={() => setDialog({ kind: "new" })}>
                        New folder
                    </button>
                    <button type="button" className="button-primary" onClick={() => picker.current?.click()}>
                        Upload data
                    </button>
                    <input
                        ref={picker}
                        type="file"
                        accept={DATA_FILES}
                        multiple
                        hidden
                        aria-label="Files to upload"
                        onChange={(event) => {
                            const picked = [...(event.target.files ?? [])];
                            event.target.value = "";
                            if (picked.length > 0) {
                                setUploading(picked);
                            }
                        }}
                    />
                </div>
            </div>
            {folder === null && (
                <p className="lead muted">
                    Upload a CSV from a test (pressures, temperatures, loads, valve states: a column each, and a column
                    of times) and plot its channels together on one time axis. Drop files anywhere on this page, too;
                    make folders to keep a campaign's tests together, and drag datasets into them.
                </p>
            )}
            {folder !== null && folders !== null && !here && (
                <Notice tone="warning">
                    This folder isn't there any more. <Link to="/yorg">Back to the test data</Link>
                </Notice>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
            {datasets === null && !problem && <p className="muted">Loading…</p>}
            {datasets !== null && (
                <>
                    <input
                        type="search"
                        className="search"
                        placeholder="Find datasets, in every folder"
                        aria-label="Find datasets"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                    />
                    {selected.size > 0 && (
                        <div className="selection-bar" role="status">
                            <span>
                                {selected.size} {selected.size === 1 ? "dataset" : "datasets"} chosen
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
                    {shownFolders.length === 0 && shownDatasets.length === 0 ? (
                        <div className="empty">
                            {searching
                                ? "Nothing matches."
                                : folder === null
                                  ? "No test data yet. Upload a CSV file to start."
                                  : "This folder is empty: upload data here, or drag datasets onto it."}
                        </div>
                    ) : (
                        <div className="table-scroll">
                            <table className="table yorg-datasets" aria-label="Datasets">
                                <thead>
                                    <tr>
                                        <th className="select">
                                            <input
                                                type="checkbox"
                                                aria-label="Choose every dataset here"
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
                                        <th className="numeric">Channels</th>
                                        <th className="numeric">Length</th>
                                        <th className="numeric">Rate</th>
                                        <th className="numeric">Size</th>
                                        <th>Added</th>
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
                                                <Link to={folderUrl(one.id)} className="name yorg-folder-name">
                                                    <span className="file-icon file-icon-folder" aria-hidden="true" />
                                                    {one.name}
                                                </Link>
                                                {searching && one.parent_id !== null && (
                                                    <p className="muted yorg-description">in {where(one.parent_id)}</p>
                                                )}
                                            </td>
                                            <td className="numeric muted" colSpan={4}>
                                                {inside(one.id) === 1 ? "1 dataset" : `${inside(one.id)} datasets`}
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
                                    {shownDatasets.map((dataset) => (
                                        <tr
                                            key={dataset.id}
                                            draggable={dataset.can_change}
                                            onDragStart={(event) => dragDatasets(event, dataset)}
                                        >
                                            <td className="select">
                                                {dataset.can_change && (
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`Choose ${dataset.name}`}
                                                        checked={selected.has(dataset.id)}
                                                        onChange={(event) => {
                                                            const next = new Set(selected);
                                                            if (event.target.checked) {
                                                                next.add(dataset.id);
                                                            } else {
                                                                next.delete(dataset.id);
                                                            }
                                                            setSelected(next);
                                                        }}
                                                    />
                                                )}
                                            </td>
                                            <td>
                                                <Link to={datasetUrl(dataset.id)} className="name">
                                                    {dataset.name}
                                                </Link>
                                                {dataset.status === "failed" && (
                                                    <span
                                                        className="tag tag-warning"
                                                        title={dataset.error ?? undefined}
                                                    >
                                                        Couldn't be read
                                                    </span>
                                                )}
                                                {dataset.status === "reading" && <span className="tag">Reading</span>}
                                                {searching && (
                                                    <p className="muted yorg-description">
                                                        in {where(dataset.folder_id)}
                                                    </p>
                                                )}
                                                {dataset.description && (
                                                    <p className="muted yorg-description">{dataset.description}</p>
                                                )}
                                            </td>
                                            <td className="numeric">{dataset.channel_count}</td>
                                            <td className="numeric">
                                                {dataset.t_min !== null && dataset.t_max !== null
                                                    ? formatDuration(dataset.t_max - dataset.t_min)
                                                    : "—"}
                                            </td>
                                            <td className="numeric">{formatRate(dataset.sample_rate)}</td>
                                            <td className="numeric">{formatSize(dataset.size)}</td>
                                            <td>
                                                {dataset.created_by?.name ?? "—"}
                                                <span className="muted">
                                                    {" · "}
                                                    <Time at={dataset.created_at} />
                                                </span>
                                            </td>
                                            <td className="row-actions">
                                                <Link className="button button-small" to={aboutUrl(dataset.id)}>
                                                    About
                                                </Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
            <p className="muted yorg-foot">
                <Link to="/yorg/deleted">Deleted datasets</Link>
            </p>
            {uploading && (
                <UploadDialog
                    files={uploading}
                    folder={folder}
                    onClose={() => {
                        setUploading(null);
                        void load();
                    }}
                    onDone={(done) => {
                        setUploading(null);
                        if (done.length === 1 && done[0]!.status === "ready") {
                            navigate(datasetUrl(done[0]!.id));
                        } else {
                            void load();
                        }
                    }}
                />
            )}
            {dialog?.kind === "new" && (
                <NameDialog
                    title={here ? `New folder in ${here.name}` : "New folder"}
                    confirm="Make it"
                    onCancel={() => setDialog(null)}
                    onName={async (name) => {
                        await yorg.addFolder(name, folder);
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
                        await yorg.renameFolder(dialog.folder.id, name);
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
                        void act(() => yorg.removeFolder(gone.id));
                    }}
                    onCancel={() => setDialog(null)}
                >
                    <p>
                        Only an empty folder can be deleted: move its datasets and folders out first. Deleted datasets
                        that were in it go to the folder it's in.
                    </p>
                </Dialog>
            )}
            {dialog?.kind === "delete-chosen" && (
                <DeleteDialog
                    chosen={allDatasets.filter((one) => selected.has(one.id))}
                    onCancel={() => setDialog(null)}
                    onDelete={(ids) => {
                        setDialog(null);
                        setSelected(new Set());
                        void act(() => yorg.removeAll(ids).then(() => ids.forEach((id) => void reloadDataset(id))));
                    }}
                />
            )}
            {dialog?.kind === "move" && folders && (
                <MoveDialog
                    folders={folders}
                    title={`Move ${selected.size === 1 ? "a dataset" : `${selected.size} datasets`}`}
                    top="Datasets"
                    from={folder}
                    onCancel={() => setDialog(null)}
                    onMove={(target) => {
                        const ids = [...selected];
                        setDialog(null);
                        setSelected(new Set());
                        void act(() => yorg.move(ids, target).then(() => ids.forEach((id) => void reloadDataset(id))));
                    }}
                />
            )}
        </section>
    );
}

/** Deleting the datasets chosen: named, so it's clear what goes, and to Deleted datasets, where they can come back. */
function DeleteDialog({
    chosen,
    onDelete,
    onCancel,
}: {
    chosen: Dataset[];
    onDelete: (ids: number[]) => void;
    onCancel: () => void;
}) {
    const one = chosen.length === 1;
    return (
        <Dialog
            title={`Delete ${one ? chosen[0]!.name : `${chosen.length} datasets`}?`}
            confirm="Delete"
            danger
            disabled={chosen.length === 0}
            onConfirm={() => onDelete(chosen.map((dataset) => dataset.id))}
            onCancel={onCancel}
        >
            <p>
                {one ? "It goes" : "They go"} to <Link to="/yorg/deleted">Deleted datasets</Link>, where you can restore{" "}
                {one ? "it" : "them"}: everything is kept.
            </p>
            {!one && (
                <ul className="plain" aria-label="Datasets to delete">
                    {chosen.slice(0, MAX_LISTED).map((dataset) => (
                        <li key={dataset.id}>{dataset.name}</li>
                    ))}
                    {chosen.length > MAX_LISTED && <li className="muted">and {chosen.length - MAX_LISTED} more</li>}
                </ul>
            )}
        </Dialog>
    );
}
