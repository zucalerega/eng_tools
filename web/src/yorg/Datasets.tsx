import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Dialog, Notice, Time } from "../components";
import { formatSize } from "../format";
import { Link, navigate } from "../router";
import { yorg, type DataFolder, type Dataset } from "./api";
import { reloadDataset } from "./data";
import { formatDuration, formatRate } from "./scale";
import { DATA_FILES, UploadDialog } from "./Upload";

// The datasets, in folders: a folder's own datasets and folders, and every dataset when searching. Datasets and
// folders are moved by dragging them onto a folder (or a folder in the path above), or by choosing them and Move to.

export const folderUrl = (id: number | null): string => (id === null ? "/yorg" : `/yorg/folders/${id}`);
const datasetUrl = (id: number): string => `/yorg/datasets/${id}`;
const aboutUrl = (id: number): string => `/yorg/datasets/${id}/about`;

const DRAGGED = "application/x-yorg-move"; // {datasets: number[], folder: number | null}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The folders from the top down to this one. */
function pathTo(id: number | null, byId: ReadonlyMap<number, DataFolder>): DataFolder[] {
    const path: DataFolder[] = [];
    for (
        let at = id === null ? undefined : byId.get(id);
        at;
        at = at.parent_id === null ? undefined : byId.get(at.parent_id)
    ) {
        path.unshift(at);
        if (path.length > 100) {
            break;
        }
    }
    return path;
}

/** Whether folder is inside (or is) another. */
function within(folder: number | null, other: number, byId: ReadonlyMap<number, DataFolder>): boolean {
    return pathTo(folder, byId).some((one) => one.id === other);
}

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
            {dialog?.kind === "move" && folders && (
                <MoveDialog
                    folders={folders}
                    count={selected.size}
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

function NameDialog({
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

/** Choosing a folder to move datasets to: every folder, as a tree. */
function MoveDialog({
    folders,
    count,
    from,
    onMove,
    onCancel,
}: {
    folders: DataFolder[];
    count: number;
    from: number | null;
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
                    className="check yorg-move-choice"
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
            title={`Move ${count === 1 ? "a dataset" : `${count} datasets`}`}
            confirm="Move"
            disabled={chosen === from}
            onConfirm={() => onMove(chosen)}
            onCancel={onCancel}
        >
            <div className="yorg-move" role="radiogroup" aria-label="To">
                <label className="check yorg-move-choice">
                    <input type="radio" name="folder" checked={chosen === null} onChange={() => setChosen(null)} />
                    Datasets (the top)
                </label>
                {rows}
            </div>
        </Dialog>
    );
}
