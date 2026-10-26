import { lazy, Suspense, useCallback, useEffect, useReducer, useState, type DragEvent, type ReactNode } from "react";
import { ApiError } from "../api";
import { Dialog, MenuButton, Notice, Time } from "../components";
import { formatSize, formatTime } from "../format";
import { Link, navigate } from "../router";
import {
    DELIMITERS,
    TIME_FORMATS,
    yorg,
    type Dataset,
    type DatasetDetail,
    type Delimiter,
    type ReadOptions,
    type SavedView,
    type TimeFormat,
} from "./api";
import { dataset as loadDataset, reloadDataset, showDataset, useLoaded } from "./data";
import { forDataset, newLayout, readLayout, reduce, type Layout } from "./layout";
import { FolderPicker } from "../FolderPicker";
import { countIn, folderTree, foldersOf, type Folder } from "../pathTree";
import { formatClock, formatDuration, formatRate, formatValue } from "../scale";
import { dropPlotsFromAddress, plotsInAddress, plotsLink, readPlots } from "./share";
import { Workspace, type ExtraPlot } from "./Workspace";

// Yorg's pages: a dataset's plots and its details, saved views, links to plots, and deleted datasets (the datasets:
// Datasets.tsx).

export const datasetUrl = (id: number): string => `/yorg/datasets/${id}`;
export const aboutUrl = (id: number): string => `/yorg/datasets/${id}/about`;
export const viewUrl = (id: number): string => `/yorg/views/${id}`;

const LAYOUT_KEY = "yorg.layout.";

/** The layout this browser last had for a dataset. */
function storedLayout(id: number): Layout {
    try {
        const stored = window.localStorage.getItem(LAYOUT_KEY + id);
        if (stored) {
            return readLayout(JSON.parse(stored), id);
        }
    } catch {
        // storage blocked, or something unreadable in it: start afresh
    }
    return newLayout(id);
}

/** Where this browser's layout for a dataset puts T0 (null: it has none). */
export function storedT0(id: number): number | null {
    return storedLayout(id).t0;
}

function storeLayout(id: number, layout: Layout): void {
    try {
        window.localStorage.setItem(LAYOUT_KEY + id, JSON.stringify(layout));
    } catch {
        // storage blocked or full: the layout lasts as long as the page
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** When a dataset's times start: a date and time, a time of day, or the file's own zero. */
function startOf(dataset: Dataset, utcOffset: number | null = null): string {
    if (dataset.start_epoch === null || dataset.time_kind === "relative") {
        return dataset.t_min === null ? "—" : `${formatValue(dataset.t_min)} s in the file's time`;
    }
    if (dataset.time_kind === "clock") {
        return formatClock(dataset.start_epoch, 0.001);
    }
    const local = new Date((dataset.start_epoch + (utcOffset ?? 0)) * 1000);
    const date = local.toISOString().slice(0, 10);
    return `${date} ${formatClock(dataset.start_epoch + (utcOffset ?? 0), 0.001)}${utcOffset === null ? " UTC" : ""}`;
}

// --- the deleted datasets --------------------------------------------------------------------------------------

export function DeletedPage() {
    const [datasets, setDatasets] = useState<Dataset[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    // Chosen to restore together, as datasets are chosen to move or delete: yours (any, for an admin).
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const load = () => yorg.datasets(true).then(setDatasets, (error: unknown) => setProblem(message(error)));
    useEffect(() => {
        void load();
    }, []);
    const choosable = (datasets ?? []).filter((one) => one.can_change);
    async function restore(ids: number[]) {
        setProblem(null);
        try {
            await yorg.restoreAll(ids);
            ids.forEach((id) => void reloadDataset(id));
            setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
        } catch (error) {
            setProblem(message(error));
        }
        await load();
    }
    return (
        <section className="yorg-page">
            <div className="page-head">
                <h1>Deleted datasets</h1>
                <div className="page-actions">
                    <Link className="button" to="/yorg">
                        Back to the datasets
                    </Link>
                </div>
            </div>
            <p className="lead muted">
                A deleted dataset keeps its file and channels. Restore puts it back in its folder; check several to
                restore them together.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {datasets?.length === 0 && <div className="empty">Nothing's been deleted.</div>}
            {selected.size > 0 && (
                <div className="selection-bar" role="status">
                    <span>
                        {selected.size} {selected.size === 1 ? "dataset" : "datasets"} chosen
                    </span>
                    <button type="button" className="button-small" onClick={() => void restore([...selected])}>
                        Restore
                    </button>
                    <button type="button" className="button-small" onClick={() => setSelected(new Set())}>
                        Clear
                    </button>
                </div>
            )}
            {datasets && datasets.length > 0 && (
                <table className="table" aria-label="Deleted datasets">
                    <thead>
                        <tr>
                            <th className="select">
                                <input
                                    type="checkbox"
                                    aria-label="Choose every deleted dataset"
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
                        {datasets.map((dataset) => (
                            <tr key={dataset.id}>
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
                                <td>{dataset.name}</td>
                                <td>
                                    {dataset.deleted_by?.name ?? "—"}
                                    {dataset.deleted_at && (
                                        <span className="muted">
                                            {" · "}
                                            <Time at={dataset.deleted_at} />
                                        </span>
                                    )}
                                </td>
                                <td className="row-actions">
                                    {dataset.can_change && (
                                        <button
                                            type="button"
                                            className="button-small"
                                            aria-label={`Restore ${dataset.name}`}
                                            onClick={() => void restore([dataset.id])}
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

// --- a dataset's plots ----------------------------------------------------------------------------------------------

export function DatasetPage({ id }: { id: number }) {
    useLoaded();
    const [linked, linkUsed] = useLinkedPlots();
    const loaded = loadDataset(id);
    if (loaded.status === "loading" || linked.status === "reading") {
        return <p className="muted yorg-page">Loading the dataset…</p>;
    }
    if (loaded.status === "failed") {
        return (
            <div className="yorg-page">
                <Notice tone="error">
                    {loaded.error}. <Link to="/yorg">Back to the datasets</Link>
                </Notice>
            </div>
        );
    }
    const detail = loaded.value;
    if (detail.deleted_at) {
        return (
            <div className="yorg-page">
                <Notice tone="warning">
                    {detail.name} is deleted. {detail.can_change ? "Restore it from " : "See "}
                    <Link to="/yorg/deleted">Deleted datasets</Link>.
                </Notice>
            </div>
        );
    }
    if (detail.status !== "ready") {
        return (
            <div className="yorg-page">
                <h1>{detail.name}</h1>
                <Notice tone="error">
                    {detail.status === "reading"
                        ? "The server is still reading this file."
                        : `Yorg couldn't read ${detail.filename}: ${detail.error}`}{" "}
                    <Link to={aboutUrl(id)}>Change how it's read</Link>
                </Notice>
            </div>
        );
    }
    return (
        <DatasetWorkspace key={`${id}/${detail.data_version}`} detail={detail} linked={linked} onLinkUsed={linkUsed} />
    );
}

/** The views saved (by anyone) that plot a dataset, newest first. */
function useViewsOf(dataset: number): SavedView[] {
    const [views, setViews] = useState<SavedView[]>([]);
    useEffect(() => {
        yorg.views().then(
            (all) => setViews(all.filter((view) => view.datasets.includes(dataset))),
            () => setViews([]),
        );
    }, [dataset]);
    return views;
}

// A page's own Python, beside its plots: loaded (with its editor) only when it's opened.
const PythonDock = lazy(() => import("./scripts/PythonDock").then((module) => ({ default: module.PythonDock })));
const PYTHON_KEY = "yorg.python.open"; // whether it's open: for the tab, on every page

function storedOpen(): boolean {
    try {
        return window.sessionStorage.getItem(PYTHON_KEY) === "1";
    } catch {
        return false;
    }
}

/**
 * A dataset's or view's own Python (what's new: in the preview until it's released): a notebook docked beside its
 * plots (scripts/PythonDock.tsx), whose plots go on the page's, under its own; each can be taken off the page.
 */
function usePagePython(page: string, layout: Layout, title: string) {
    const [open, setOpenState] = useState(storedOpen);
    const [plots, setPlots] = useState<ExtraPlot[]>([]);
    const [hidden, setHidden] = useState<Set<string>>(() => new Set());
    const setOpen = (next: boolean) => {
        setOpenState(next);
        try {
            window.sessionStorage.setItem(PYTHON_KEY, next ? "1" : "0");
        } catch {
            // storage blocked: it's open or closed for this page
        }
    };
    const shown = open;
    return {
        button: (
            <button
                type="button"
                aria-pressed={open}
                onClick={() => setOpen(!open)}
                title="Python beside the plots: this page's channels and time in view, and plots of its own on the page"
            >
                Python
            </button>
        ),
        dock: shown ? (
            <Suspense fallback={<aside className="yorg-dock muted">Loading Python…</aside>}>
                <PythonDock
                    page={page}
                    title={title}
                    layout={layout}
                    onPlots={setPlots}
                    onClose={() => setOpen(false)}
                />
            </Suspense>
        ) : undefined,
        extraPlots: shown ? plots.filter((plot) => !hidden.has(plot.id)) : [],
        onRemoveExtra: (id: string) => setHidden(new Set([...hidden, id])),
    };
}

function DatasetWorkspace({
    detail,
    linked,
    onLinkUsed,
}: {
    detail: DatasetDetail;
    linked: Linked;
    onLinkUsed: () => void;
}) {
    // A link's plots, if it brought some (then this browser's for the dataset, as any change is), or this browser's.
    const [layout, dispatch] = useReducer(reduce, detail.id, (id) =>
        linked.status === "ready" ? readLayout(linked.config, id) : storedLayout(id),
    );
    const unreadable = useLinkUsed(linked, onLinkUsed);
    useEffect(() => storeLayout(detail.id, layout), [detail.id, layout]);
    const [saving, setSaving] = useState(false);
    const views = useViewsOf(detail.id);
    const python = usePagePython(`dataset-${detail.id}`, layout, detail.name);
    return (
        <>
            <Workspace
                layout={layout}
                dispatch={dispatch}
                dock={python.dock}
                extraPlots={python.extraPlots}
                onRemoveExtra={python.onRemoveExtra}
                title={
                    <>
                        <h1>{detail.name}</h1>
                        <span className="muted">
                            {detail.channel_count} channels · {formatRate(detail.sample_rate)}
                        </span>
                    </>
                }
                actions={
                    <>
                        {views.length > 0 && (
                            <MenuButton
                                label={`Saved views (${views.length})`}
                                items={views.map((view) => ({
                                    label: `${view.name}, by ${view.created_by?.name ?? "someone"}`,
                                    onSelect: () => navigate(viewUrl(view.id)),
                                }))}
                            />
                        )}
                        <button type="button" onClick={() => setSaving(true)}>
                            Save view
                        </button>
                        <CopyLink layout={layout} />
                        {python.button}
                        <Link className="button" to={aboutUrl(detail.id)}>
                            About
                        </Link>
                    </>
                }
                notice={
                    unreadable || detail.warnings.length > 0 ? (
                        <>
                            {unreadable && <UnreadableLink />}
                            {detail.warnings.length > 0 && (
                                <p className="yorg-warnings muted">
                                    Reading the file: {detail.warnings[0]}
                                    {detail.warnings.length > 1 && ` (and ${detail.warnings.length - 1} more)`}{" "}
                                    <Link to={aboutUrl(detail.id)}>Details</Link>
                                </p>
                            )}
                        </>
                    ) : undefined
                }
            />
            {saving && <SaveViewDialog layout={layout} onClose={() => setSaving(false)} />}
        </>
    );
}

/** The folders views are in (and those they're in), to pick one from. */
function useViewFolders(): string[] {
    const [folders, setFolders] = useState<string[]>([]);
    useEffect(() => {
        yorg.views().then(
            (views) => setFolders(foldersOf(views)),
            () => {},
        );
    }, []);
    return folders;
}

/** Where a view is kept: a folder there is, picked from the list, or a path for a new one ("Hotfires/HF-3"). */
function FolderField({ value, onChange }: { value: string; onChange: (folder: string) => void }) {
    const folders = useViewFolders();
    return (
        <label className="field">
            Folder
            <FolderPicker
                value={value}
                onChange={onChange}
                folders={folders}
                placeholder="None, or a new one, like Hotfires/HF-3"
            />
        </label>
    );
}

function SaveViewDialog({
    layout,
    onClose,
    name = "",
    folder: inFolder = "",
}: {
    layout: Layout;
    onClose: () => void;
    name?: string;
    folder?: string; // a copy's: the view's own
}) {
    const [title, setTitle] = useState(name);
    const [folder, setFolder] = useState(inFolder);
    const [description, setDescription] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            const saved = await yorg.saveView({
                name: title.trim(),
                folder,
                description,
                datasets: layout.datasets.map((ref) => ref.id),
                config: layout,
            });
            navigate(viewUrl(saved.id));
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title="Save this view"
            confirm="Save"
            busy={busy}
            disabled={!title.trim()}
            onConfirm={() => void save()}
            onCancel={onClose}
        >
            <p className="muted">
                Everyone can open a saved view: its plots, channels, scales, time window, and markers. Only you (and
                admins) can change it. To send someone these plots without saving a view, use Copy link.
            </p>
            <label className="field">
                Name
                <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <FolderField value={folder} onChange={setFolder} />
            <label className="field">
                Notes
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/**
 * A view renamed, moved to another folder, or its notes changed. Its plots go as they were saved: changes to them
 * since stay on the page, to save or not.
 */
function RenameViewDialog({
    view,
    meta,
    onDone,
    onClose,
}: {
    view: SavedView;
    meta: ViewMeta;
    onDone: (meta: ViewMeta) => void;
    onClose: () => void;
}) {
    const [name, setName] = useState(meta.name);
    const [folder, setFolder] = useState(meta.folder);
    const [description, setDescription] = useState(meta.description);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            const saved = await yorg.updateView(view.id, {
                name: name.trim(),
                folder,
                description,
                datasets: view.datasets,
                config: view.config,
            });
            onDone({ name: saved.name, folder: saved.folder, description: saved.description });
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title="Rename or move the view"
            confirm="Save"
            busy={busy}
            disabled={!name.trim()}
            onConfirm={() => void save()}
            onCancel={onClose}
        >
            <label className="field">
                Name
                <input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
            </label>
            <FolderField value={folder} onChange={setFolder} />
            <label className="field">
                Notes
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

// --- links to plots -------------------------------------------------------------------------------------------------

const LINK_DELAY_MS = 300; // plots unchanged this long get their link made, ready for a click
const COPIED_MS = 2000; // how long Copy link says it copied

/**
 * Copy link: a link to the plots as they are (share.ts), to send someone without saving a view. It's made once the
 * plots settle, so a click copies at once: Safari lets a page copy only while it's handling the click.
 */
function CopyLink({ layout }: { layout: Layout }) {
    const [made, setMade] = useState<{ layout: Layout; link: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [byHand, setByHand] = useState<{ link: string | null } | null>(null);
    useEffect(() => {
        let current = true;
        const timer = window.setTimeout(() => {
            plotsLink(layout).then(
                (link) => {
                    if (current) {
                        setMade({ layout, link });
                    }
                },
                () => {}, // a click makes it again, and says what's wrong
            );
        }, LINK_DELAY_MS);
        return () => {
            current = false;
            window.clearTimeout(timer);
        };
    }, [layout]);
    useEffect(() => {
        if (!copied) {
            return;
        }
        const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy() {
        let link: string | null = null;
        try {
            link = made?.layout === layout ? made.link : await plotsLink(layout);
            await navigator.clipboard.writeText(link);
            setCopied(true);
        } catch {
            // No clipboard (a site without HTTPS), or the browser said no: it's copied by hand. Or there's no link.
            setByHand({ link });
        }
    }
    return (
        <>
            <button
                type="button"
                onClick={() => void copy()}
                title="A link to these plots as they are, to send to someone: it saves nothing, and whoever opens it can save it as a view"
            >
                {copied ? "Link copied" : "Copy link"}
            </button>
            {byHand && (
                <Dialog
                    title={byHand.link === null ? "Couldn't make a link" : "Copy this link"}
                    cancel="Close"
                    onCancel={() => setByHand(null)}
                >
                    {byHand.link === null ? (
                        <p>This browser can&apos;t make links to plots. Update it, or save a view to share them.</p>
                    ) : (
                        <>
                            <p className="muted">
                                The browser didn&apos;t let Yorg copy it: copy it from here (Ctrl+C, or ⌘C on a Mac). It
                                opens these plots as they are now for whoever follows it, and saves nothing.
                            </p>
                            <label className="field">
                                Link
                                <input
                                    readOnly
                                    autoFocus
                                    value={byHand.link}
                                    onFocus={(event) => event.currentTarget.select()}
                                />
                            </label>
                        </>
                    )}
                </Dialog>
            )}
        </>
    );
}

/** The plots a link to the page brought (?plots=): none, being read, read (a layout's JSON), or unreadable. */
type Linked =
    | { status: "none" }
    | { status: "reading"; text: string }
    | { status: "ready"; config: unknown }
    | { status: "unreadable" };

/**
 * The plots in the page's address when it opened, read for the plots the page makes first, and then used (taken out of
 * the address) once those are made: a reload, or plots made again (a view saved), start from the page's own.
 */
function useLinkedPlots(): [Linked, () => void] {
    const [linked, setLinked] = useState<Linked>(() => {
        const text = plotsInAddress();
        return text === null ? { status: "none" } : { status: "reading", text };
    });
    const text = linked.status === "reading" ? linked.text : null;
    useEffect(() => {
        if (text === null) {
            return;
        }
        let current = true;
        readPlots(text).then(
            (config) => {
                if (current) {
                    setLinked({ status: "ready", config });
                }
            },
            () => {
                if (current) {
                    setLinked({ status: "unreadable" });
                }
            },
        );
        return () => {
            current = false;
        };
    }, [text]);
    const used = useCallback(() => {
        dropPlotsFromAddress();
        setLinked({ status: "none" });
    }, []);
    return [linked, used];
}

/**
 * For the plots a page makes first: once they're made (from a link's plots, or the page's own if those couldn't be
 * read), the link's used. Whether its plots couldn't be read, for the page to say so over these.
 */
function useLinkUsed(linked: Linked, used: () => void): boolean {
    const [unreadable] = useState(linked.status === "unreadable");
    useEffect(() => {
        if (linked.status !== "none") {
            used();
        }
    }, []); // once: plots made again (a view saved) start from the page's own
    return unreadable;
}

function UnreadableLink() {
    return (
        <Notice tone="warning">
            The plots in this link couldn&apos;t be read (was it cut short?), so this is the page without them. Ask
            whoever sent it to copy it again.
        </Notice>
    );
}

// --- about a dataset ------------------------------------------------------------------------------------------------

export function AboutPage({ id }: { id: number }) {
    useLoaded();
    const loaded = loadDataset(id);
    if (loaded.status === "loading") {
        return <p className="muted yorg-page">Loading the dataset…</p>;
    }
    if (loaded.status === "failed") {
        return (
            <div className="yorg-page">
                <Notice tone="error">{loaded.error}</Notice>
            </div>
        );
    }
    return <About key={`${id}/${loaded.value.data_version}/${loaded.value.updated_at}`} detail={loaded.value} />;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt>{label}</dt>
            <dd>{children}</dd>
        </>
    );
}

function About({ detail }: { detail: DatasetDetail }) {
    const [problem, setProblem] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const info = detail.read_info;
    const piece = info.split_from ?? null; // a test split out of another dataset: it has no file of its own
    const change = async (work: () => Promise<unknown>) => {
        setProblem(null);
        try {
            await work();
            await reloadDataset(detail.id);
        } catch (error) {
            setProblem(message(error));
        }
    };
    return (
        <section className="yorg-page yorg-about">
            <div className="page-head">
                <h1>{detail.name}</h1>
                <div className="page-actions">
                    {detail.status === "ready" && !detail.deleted_at && (
                        <Link className="button button-primary" to={datasetUrl(detail.id)}>
                            Plot it
                        </Link>
                    )}
                    {!piece && (
                        <a className="button" href={yorg.sourceUrl(detail.id)} download>
                            Download {detail.filename}
                        </a>
                    )}
                    {detail.can_change &&
                        (detail.deleted_at ? (
                            <button type="button" onClick={() => void change(() => yorg.restore(detail.id))}>
                                Restore
                            </button>
                        ) : (
                            <button type="button" className="button-danger" onClick={() => setDeleting(true)}>
                                Delete
                            </button>
                        ))}
                </div>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            {detail.deleted_at && (
                <Notice tone="warning">
                    Deleted by {detail.deleted_by?.name ?? "someone"} on {formatTime(detail.deleted_at)}.
                </Notice>
            )}
            {detail.status === "failed" && <Notice tone="error">Yorg couldn't read this file: {detail.error}</Notice>}
            {detail.can_change && !detail.deleted_at && (
                <Describe detail={detail} onSave={(change_) => change(() => yorg.update(detail.id, change_))} />
            )}
            {!detail.can_change && detail.description && <p className="yorg-description">{detail.description}</p>}
            <dl className="yorg-facts">
                {piece ? (
                    <Fact label="Split from">
                        <Link to={aboutUrl(piece.dataset)}>{piece.name}</Link>: {formatValue(piece.start)} s to{" "}
                        {formatValue(piece.end)} s
                        {piece.zero !== null ? `, with time from ${formatValue(piece.zero)} s` : ""}{" "}
                        <span className="muted">({formatSize(detail.size)})</span>
                    </Fact>
                ) : (
                    <Fact label="File">
                        {detail.filename} <span className="muted">({formatSize(detail.size)})</span>
                    </Fact>
                )}
                <Fact label="Added">
                    {detail.created_by?.name ?? "—"} on {formatTime(detail.created_at)}
                </Fact>
                {detail.status === "ready" && (
                    <>
                        <Fact label="Rows">
                            {detail.rows.toLocaleString()}, at {formatRate(detail.sample_rate)}
                        </Fact>
                        <Fact label="Starts">{startOf(detail, info.utc_offset ?? null)}</Fact>
                        <Fact label="Length">
                            {detail.t_min !== null && detail.t_max !== null
                                ? formatDuration(detail.t_max - detail.t_min)
                                : "—"}
                        </Fact>
                        <Fact label="Time">
                            {info.time_column ? `${info.time_column}: ` : ""}
                            {TIME_FORMATS[info.time_format ?? "auto"]}
                        </Fact>
                        <Fact label="Layout">
                            {info.delimiter}-separated
                            {info.decimal_comma ? " with decimal commas" : ""}
                            {info.header_row ? `, names in row ${info.header_row}` : ", no names"}
                            {info.units_row ? `, units in row ${info.units_row}` : ""}, data from row{" "}
                            {info.first_data_row}
                        </Fact>
                    </>
                )}
            </dl>
            {detail.warnings.length > 0 && (
                <>
                    <h2>{piece ? "While splitting it" : "While reading it"}</h2>
                    <ul className="yorg-warning-list">
                        {detail.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                        ))}
                    </ul>
                </>
            )}
            {detail.can_change && !detail.deleted_at && !piece && <ReadSettings detail={detail} />}
            {detail.channels.length > 0 && (
                <>
                    <h2>Channels</h2>
                    <div className="table-scroll">
                        <table className="table" aria-label="Channels">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Unit</th>
                                    <th className="numeric">Samples</th>
                                    <th className="numeric">Min</th>
                                    <th className="numeric">Max</th>
                                    <th className="numeric">Mean</th>
                                    <th className="numeric">From (s)</th>
                                    <th className="numeric">To (s)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {detail.channels.map((channel) => {
                                    const value = (at: number | null) =>
                                        at === null
                                            ? "—"
                                            : channel.kind === "state"
                                              ? (channel.labels[at] ?? String(at))
                                              : formatValue(at, channel.decimals);
                                    return (
                                        <tr key={channel.name}>
                                            <td>{channel.name}</td>
                                            <td>
                                                {channel.kind === "state"
                                                    ? `state: ${channel.labels.join(", ")}`
                                                    : channel.unit}
                                            </td>
                                            <td className="numeric">{channel.count.toLocaleString()}</td>
                                            <td className="numeric">{value(channel.min)}</td>
                                            <td className="numeric">{value(channel.max)}</td>
                                            <td className="numeric">
                                                {channel.kind === "state" || channel.mean === null
                                                    ? "—"
                                                    : formatValue(channel.mean)}
                                            </td>
                                            <td className="numeric">
                                                {channel.t_min === null ? "—" : formatValue(channel.t_min)}
                                            </td>
                                            <td className="numeric">
                                                {channel.t_max === null ? "—" : formatValue(channel.t_max)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
            <ViewsOf dataset={detail.id} />
            {detail.events.length > 0 && (
                <>
                    <h2>Events</h2>
                    <ul className="plain">
                        {detail.events.map((event, index) => (
                            <li key={index}>
                                <span className="muted">{formatValue(event.t)} s</span> {event.label}{" "}
                                <span className="muted">({event.channel})</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            {deleting && (
                <Dialog
                    title={`Delete ${detail.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() => {
                        setDeleting(false);
                        void change(() => yorg.remove(detail.id)).then(() => navigate("/yorg"));
                    }}
                    onCancel={() => setDeleting(false)}
                >
                    <p>
                        It goes to Deleted datasets, where you (or an admin) can restore it. Saved views that use it
                        stop showing it until then.
                    </p>
                </Dialog>
            )}
        </section>
    );
}

function ViewsOf({ dataset }: { dataset: number }) {
    const views = useViewsOf(dataset);
    if (views.length === 0) {
        return null;
    }
    return (
        <>
            <h2>Saved views</h2>
            <ul className="plain">
                {views.map((view) => (
                    <li key={view.id}>
                        <Link to={viewUrl(view.id)}>{view.name}</Link>{" "}
                        <span className="muted">
                            by {view.created_by?.name ?? "someone"}, <Time at={view.updated_at} />
                        </span>
                    </li>
                ))}
            </ul>
        </>
    );
}

function Describe({
    detail,
    onSave,
}: {
    detail: DatasetDetail;
    onSave: (change: { name: string; description: string }) => Promise<void>;
}) {
    const [name, setName] = useState(detail.name);
    const [description, setDescription] = useState(detail.description);
    const changed = name.trim() !== detail.name || description !== detail.description;
    return (
        <form
            className="yorg-describe"
            onSubmit={(event) => {
                event.preventDefault();
                if (changed && name.trim()) {
                    void onSave({ name: name.trim(), description });
                }
            }}
        >
            <label className="field">
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
                Notes
                <textarea
                    value={description}
                    placeholder="What test this was, what to look at"
                    onChange={(event) => setDescription(event.target.value)}
                />
            </label>
            <button type="submit" disabled={!changed || !name.trim()}>
                Save
            </button>
        </form>
    );
}

/** How the file is read, to change: which column is time and in what format, where the names are, the delimiter. */
function ReadSettings({ detail }: { detail: DatasetDetail }) {
    const options = detail.read_options;
    const info = detail.read_info;
    const [timeColumn, setTimeColumn] = useState(options.time_column ?? "");
    const [timeFormat, setTimeFormat] = useState<TimeFormat>(options.time_format ?? "auto");
    const [sampleRate, setSampleRate] = useState(options.sample_rate ? String(options.sample_rate) : "");
    const [headerRow, setHeaderRow] = useState(
        options.header_row === null || options.header_row === undefined ? "" : String(options.header_row),
    );
    const [delimiter, setDelimiter] = useState<Delimiter | "">(options.delimiter ?? "");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const columns = [
        ...new Set(
            [info.time_column, ...detail.channels.map((channel) => channel.name)].filter(
                (name): name is string => !!name,
            ),
        ),
    ];
    async function read() {
        const wanted: ReadOptions = {
            time_column: timeColumn || null,
            time_format: timeFormat,
            sample_rate: timeFormat === "rows" && sampleRate ? Number(sampleRate) : null,
            header_row: headerRow === "" ? null : Number(headerRow),
            delimiter: delimiter || null,
        };
        setBusy(true);
        setProblem(null);
        try {
            showDataset(await yorg.read(detail.id, wanted));
        } catch (error) {
            setProblem(
                error instanceof ApiError && error.code === "unreadable"
                    ? `That didn't work: ${error.message}`
                    : message(error),
            );
            setBusy(false);
        }
    }
    return (
        <form
            className="yorg-read"
            aria-label="Read settings"
            onSubmit={(event) => {
                event.preventDefault();
                void read();
            }}
        >
            <h2>Read settings</h2>
            <p className="muted">
                Yorg worked these out from the file. If a channel or the times look wrong, say how to read it, and it's
                read again from the file as it was uploaded.
            </p>
            <div className="inline-form">
                <label className="field">
                    Time column
                    <select value={timeColumn} onChange={(event) => setTimeColumn(event.target.value)}>
                        <option value="">Worked out ({info.time_column ?? "none"})</option>
                        {columns.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    Time is in
                    <select value={timeFormat} onChange={(event) => setTimeFormat(event.target.value as TimeFormat)}>
                        {Object.entries(TIME_FORMATS).map(([value, label]) => (
                            <option key={value} value={value}>
                                {value === "auto"
                                    ? `${label} (${TIME_FORMATS[info.time_format ?? "auto"].toLowerCase()})`
                                    : label}
                            </option>
                        ))}
                    </select>
                </label>
                {timeFormat === "rows" && (
                    <label className="field">
                        Rows per second
                        <input
                            type="number"
                            min="0"
                            step="any"
                            value={sampleRate}
                            placeholder="1"
                            onChange={(event) => setSampleRate(event.target.value)}
                        />
                    </label>
                )}
                <label className="field">
                    Names in row
                    <input
                        type="number"
                        min="0"
                        value={headerRow}
                        placeholder={`${info.header_row ?? "—"} (worked out)`}
                        onChange={(event) => setHeaderRow(event.target.value)}
                    />
                </label>
                <label className="field">
                    Separated by
                    <select value={delimiter} onChange={(event) => setDelimiter(event.target.value as Delimiter | "")}>
                        <option value="">Worked out ({info.delimiter ?? "—"})</option>
                        {Object.entries(DELIMITERS).map(([value, label]) => (
                            <option key={label} value={value}>
                                {label}
                            </option>
                        ))}
                    </select>
                </label>
                <button type="submit" className="button-primary" disabled={busy}>
                    {busy ? "Reading…" : "Read it again"}
                </button>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
        </form>
    );
}

// --- saved views ----------------------------------------------------------------------------------------------------

const CLOSED_KEY = "yorg.views.closed"; // the folders of views shut, by path

function storedClosed(): Set<string> {
    try {
        const found: unknown = JSON.parse(window.localStorage.getItem(CLOSED_KEY) ?? "[]");
        return new Set(Array.isArray(found) ? found.filter((path): path is string => typeof path === "string") : []);
    } catch {
        return new Set();
    }
}

const DRAGGED_VIEW = "application/x-yorg-view"; // a saved view's id, as it's dragged onto a folder

export function ViewsPage() {
    const [views, setViews] = useState<SavedView[] | null>(null);
    const [datasets, setDatasets] = useState<Map<number, string>>(new Map());
    const [problem, setProblem] = useState<string | null>(null);
    const [find, setFind] = useState("");
    const [closed, setClosed] = useState<Set<string>>(storedClosed);
    const [dragging, setDragging] = useState(false); // a view, onto a folder
    const [over, setOver] = useState<string | null>(null); // the folder it's over ("": the top)
    useEffect(() => {
        yorg.views().then(setViews, (error: unknown) => setProblem(message(error)));
        yorg.datasets().then(
            (list) => setDatasets(new Map(list.map((one) => [one.id, one.name]))),
            () => {},
        );
    }, []);

    const dataOf = (view: SavedView) => view.datasets.map((id) => datasets.get(id) ?? `deleted (${id})`).join(", ");
    const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const searching = words.length > 0;
    // In their folders, each folder's the most recently changed first (as they come); found by a word, every folder
    // that has one is open.
    const tree = folderTree(
        (views ?? [])
            .map((view, order) => ({ ...view, order }))
            .filter((view) => {
                const text = [view.name, view.folder, view.description, dataOf(view)].join(" ").toLowerCase();
                return words.every((word) => text.includes(word));
            }),
    );

    function toggle(path: string) {
        const next = new Set(closed);
        if (next.has(path)) {
            next.delete(path);
        } else {
            next.add(path);
        }
        setClosed(next);
        try {
            window.localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
        } catch {
            // storage blocked: they're shut for this visit
        }
    }

    /** A view into a folder ("": out of its folder), as whoever saved it (or an admin) can: its plots stay as saved. */
    async function moveView(id: number, folder: string) {
        const view = views?.find((one) => one.id === id);
        if (!view || view.folder === folder) {
            return;
        }
        setProblem(null);
        try {
            const { name, description, datasets: ids, config } = view;
            await yorg.updateView(id, { name, folder, description, datasets: ids, config });
            setViews(await yorg.views());
        } catch (error) {
            setProblem(message(error));
        }
    }

    /** What a folder (or the top) does with a view dragged onto it. */
    const dropOn = (folder: string) => ({
        onDragOver: (event: DragEvent) => {
            if (event.dataTransfer.types.includes(DRAGGED_VIEW)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(folder);
            }
        },
        onDragLeave: () => setOver((now) => (now === folder ? null : now)),
        onDrop: (event: DragEvent) => {
            if (!event.dataTransfer.types.includes(DRAGGED_VIEW)) {
                return;
            }
            event.preventDefault();
            setOver(null);
            setDragging(false);
            void moveView(Number(event.dataTransfer.getData(DRAGGED_VIEW)), folder);
        },
    });

    function rows(folder: Folder<SavedView>, depth: number): ReactNode[] {
        const indent = (more: number) => ({ paddingLeft: `${depth * 1.25 + more}rem` });
        const shut = !searching && closed.has(folder.path);
        const head = folder.path ? (
            <tr
                key={`folder:${folder.path}`}
                className={`yorg-folder-row${over === folder.path ? " yorg-drop-folder" : ""}`}
                {...dropOn(folder.path)}
            >
                <td colSpan={3} style={indent(0.75)}>
                    <button
                        type="button"
                        className="yorg-view-folder"
                        aria-expanded={!shut}
                        title={folder.path}
                        onClick={() => toggle(folder.path)}
                    >
                        <span className="yorg-view-chevron" aria-hidden="true">
                            {shut ? "▸" : "▾"}
                        </span>
                        <span className="file-icon file-icon-folder" aria-hidden="true" />
                        {folder.name}
                        <span className="muted">{countIn(folder)}</span>
                    </button>
                </td>
            </tr>
        ) : null;
        if (shut) {
            return [head];
        }
        const inner = folder.path ? depth + 1 : depth;
        return [
            head,
            ...folder.folders.flatMap((one) => rows(one, inner)),
            ...folder.items.map((view) => (
                <tr
                    key={view.id}
                    // Yours (or any, for an admin) to drag onto a folder.
                    draggable={view.can_change}
                    title={view.can_change ? "Drag it onto a folder to move it" : undefined}
                    onDragStart={(event) => {
                        event.dataTransfer.setData(DRAGGED_VIEW, String(view.id));
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(true);
                    }}
                    onDragEnd={() => {
                        setDragging(false);
                        setOver(null);
                    }}
                >
                    <td style={{ paddingLeft: `${inner * 1.25 + 0.75}rem` }}>
                        <Link to={viewUrl(view.id)} className="name">
                            {view.name}
                        </Link>
                        {searching && view.folder && <p className="muted yorg-description">in {view.folder}</p>}
                        {view.description && <p className="muted yorg-description">{view.description}</p>}
                    </td>
                    <td>{dataOf(view)}</td>
                    <td>
                        {view.updated_by?.name ?? "—"}
                        <span className="muted">
                            {" · "}
                            <Time at={view.updated_at} />
                        </span>
                    </td>
                </tr>
            )),
        ];
    }

    return (
        <section className="yorg-page">
            <div className="page-head">
                <h1>Views</h1>
            </div>
            <p className="lead muted">
                Plots someone saved: channels, scales, time windows, and markers, in folders. Open one, or use it with
                another test&apos;s data.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {views?.length === 0 && (
                <div className="empty">No saved views yet. Plot a dataset the way you want it, then Save view.</div>
            )}
            {views && views.length > 0 && (
                <>
                    <input
                        className="search"
                        type="search"
                        placeholder="Find a view: its name, folder, notes, or data"
                        aria-label="Find a view"
                        value={find}
                        onChange={(event) => setFind(event.target.value)}
                    />
                    {dragging && (
                        <div className={`yorg-drop-top${over === "" ? " yorg-drop-folder" : ""}`} {...dropOn("")}>
                            Drop here to take it out of its folder
                        </div>
                    )}
                    {searching && tree.items.length === 0 && tree.folders.length === 0 ? (
                        <div className="empty">No view has that.</div>
                    ) : (
                        <table className="table yorg-views" aria-label="Saved views">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Data</th>
                                    <th>Changed</th>
                                </tr>
                            </thead>
                            <tbody>{rows(tree, 0)}</tbody>
                        </table>
                    )}
                </>
            )}
        </section>
    );
}

export function ViewPage({ id }: { id: number }) {
    const [view, setView] = useState<SavedView | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [linked, linkUsed] = useLinkedPlots();
    useEffect(() => {
        yorg.view(id).then(setView, (error: unknown) => setProblem(message(error)));
    }, [id]);
    if (problem) {
        return (
            <div className="yorg-page">
                <Notice tone="error">
                    {problem}. <Link to="/yorg/views">Saved views</Link>
                </Notice>
            </div>
        );
    }
    if (!view || linked.status === "reading") {
        return <p className="muted yorg-page">Loading the view…</p>;
    }
    return (
        <ViewWorkspace
            key={`${view.id}/${view.updated_at}`}
            view={view}
            onSaved={setView}
            linked={linked}
            onLinkUsed={linkUsed}
        />
    );
}

/** What a view's called, where it's kept, and its notes: changed without its plots (RenameViewDialog). */
type ViewMeta = Pick<SavedView, "name" | "folder" | "description">;

function ViewWorkspace({
    view,
    onSaved,
    linked,
    onLinkUsed,
}: {
    view: SavedView;
    onSaved: (view: SavedView) => void;
    linked: Linked;
    onLinkUsed: () => void;
}) {
    // A link's plots, if it brought some: the view, changed (to save, or not).
    const [layout, dispatch] = useReducer(reduce, view, (saved) =>
        readLayout(linked.status === "ready" ? linked.config : saved.config, saved.datasets[0] ?? 0),
    );
    const [savedAs] = useState(() => JSON.stringify(readLayout(view.config, view.datasets[0] ?? 0)));
    const changed = JSON.stringify(layout) !== savedAs;
    const unreadable = useLinkUsed(linked, onLinkUsed);
    // Renamed or moved here, it stays as it is (a page made again would lose changes to its plots not yet saved).
    const [meta, setMeta] = useState<ViewMeta>({ name: view.name, folder: view.folder, description: view.description });
    const [dialog, setDialog] = useState<"copy" | "other" | "delete" | "rename" | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const body = () => ({
        ...meta,
        datasets: layout.datasets.map((ref) => ref.id),
        config: layout,
    });
    async function save() {
        try {
            onSaved(await yorg.updateView(view.id, body()));
        } catch (error) {
            setProblem(message(error));
        }
    }
    const python = usePagePython(`view-${view.id}`, layout, meta.name);
    return (
        <>
            <Workspace
                layout={layout}
                dispatch={dispatch}
                dock={python.dock}
                extraPlots={python.extraPlots}
                onRemoveExtra={python.onRemoveExtra}
                title={
                    <>
                        <h1>{meta.name}</h1>
                        <span className="muted">
                            saved view{meta.folder ? ` in ${meta.folder}` : ""}, by {view.created_by?.name ?? "someone"}
                            {changed ? " · changed" : ""}
                        </span>
                    </>
                }
                notice={
                    unreadable || problem ? (
                        <>
                            {unreadable && <UnreadableLink />}
                            {problem && <Notice tone="error">{problem}</Notice>}
                        </>
                    ) : undefined
                }
                actions={
                    <>
                        {view.can_change ? (
                            <button type="button" disabled={!changed} onClick={() => void save()}>
                                Save
                            </button>
                        ) : (
                            <button type="button" onClick={() => setDialog("copy")}>
                                Save as a new view
                            </button>
                        )}
                        <CopyLink layout={layout} />
                        {python.button}
                        <MoreViewActions
                            canChange={view.can_change}
                            onCopy={() => setDialog("copy")}
                            onRename={() => setDialog("rename")}
                            onOther={() => setDialog("other")}
                            onDelete={() => setDialog("delete")}
                        />
                    </>
                }
            />
            {dialog === "copy" && (
                <SaveViewDialog
                    layout={layout}
                    name={`${meta.name} (copy)`}
                    folder={meta.folder}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog === "rename" && (
                <RenameViewDialog
                    view={view}
                    meta={meta}
                    onDone={(renamed) => {
                        setMeta(renamed);
                        setDialog(null);
                    }}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog === "other" && <OtherDatasetDialog layout={layout} onClose={() => setDialog(null)} />}
            {dialog === "delete" && (
                <Dialog
                    title={`Delete the view ${meta.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() => {
                        setDialog(null);
                        yorg.removeView(view.id).then(
                            () => navigate("/yorg/views"),
                            (error: unknown) => setProblem(message(error)),
                        );
                    }}
                    onCancel={() => setDialog(null)}
                >
                    <p>The data stays; only this view of it goes.</p>
                </Dialog>
            )}
        </>
    );
}

function MoreViewActions({
    canChange,
    onCopy,
    onRename,
    onOther,
    onDelete,
}: {
    canChange: boolean;
    onCopy: () => void;
    onRename: () => void;
    onOther: () => void;
    onDelete: () => void;
}) {
    const items = [
        { label: "Save as a new view…", onSelect: onCopy },
        ...(canChange ? [{ label: "Rename or move…", onSelect: onRename }] : []),
        { label: "Use with another dataset…", onSelect: onOther },
        ...(canChange ? [{ label: "Delete this view…", onSelect: onDelete }] : []),
    ];
    return <MenuButton label="More" items={items} />;
}

/** This view's plots for another dataset: its channels by name, in place of the view's first dataset's. */
function OtherDatasetDialog({ layout, onClose }: { layout: Layout; onClose: () => void }) {
    const [datasets, setDatasets] = useState<Dataset[] | null>(null);
    const [chosen, setChosen] = useState("");
    useEffect(() => {
        yorg.datasets().then(setDatasets, () => setDatasets([]));
    }, []);
    const ready = (datasets ?? []).filter((one) => one.status === "ready");
    return (
        <Dialog
            title="Use this view with another dataset"
            confirm="Open"
            disabled={!chosen}
            onConfirm={() => {
                const id = Number(chosen);
                storeLayout(id, forDataset(layout, id));
                navigate(datasetUrl(id));
            }}
            onCancel={onClose}
        >
            <p className="muted">
                The same plots, with the other dataset's channels of the same names (another test with the same sensors,
                say). It opens as that dataset's plots; save it as a view there if you want to keep it.
            </p>
            <label className="field">
                Dataset
                <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
                    <option value="" disabled>
                        {datasets === null ? "Loading…" : "Choose one"}
                    </option>
                    {ready.map((one) => (
                        <option key={one.id} value={one.id}>
                            {one.name}
                        </option>
                    ))}
                </select>
            </label>
        </Dialog>
    );
}
