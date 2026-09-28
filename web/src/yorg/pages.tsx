import { useEffect, useReducer, useState, type ReactNode } from "react";
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
import { formatClock, formatDuration, formatRate, formatValue } from "./scale";
import { Workspace } from "./Workspace";

// Yorg's pages: a dataset's plots and its details, saved views, and deleted datasets (the datasets: Datasets.tsx).

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
    const load = () => yorg.datasets(true).then(setDatasets, (error: unknown) => setProblem(message(error)));
    useEffect(() => {
        void load();
    }, []);
    async function restore(dataset: Dataset) {
        try {
            await yorg.restore(dataset.id);
            void reloadDataset(dataset.id);
            await load();
        } catch (error) {
            setProblem(message(error));
        }
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
            {problem && <Notice tone="error">{problem}</Notice>}
            {datasets?.length === 0 && <div className="empty">Nothing's been deleted.</div>}
            {datasets && datasets.length > 0 && (
                <table className="table" aria-label="Deleted datasets">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Deleted</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {datasets.map((dataset) => (
                            <tr key={dataset.id}>
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
                                            onClick={() => void restore(dataset)}
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
    const loaded = loadDataset(id);
    if (loaded.status === "loading") {
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
    return <DatasetWorkspace key={`${id}/${detail.data_version}`} detail={detail} />;
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

function DatasetWorkspace({ detail }: { detail: DatasetDetail }) {
    const [layout, dispatch] = useReducer(reduce, detail.id, storedLayout);
    useEffect(() => storeLayout(detail.id, layout), [detail.id, layout]);
    const [saving, setSaving] = useState(false);
    const views = useViewsOf(detail.id);
    return (
        <>
            <Workspace
                layout={layout}
                dispatch={dispatch}
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
                        <Link className="button" to={aboutUrl(detail.id)}>
                            About
                        </Link>
                    </>
                }
                notice={
                    detail.warnings.length > 0 ? (
                        <p className="yorg-warnings muted">
                            Reading the file: {detail.warnings[0]}
                            {detail.warnings.length > 1 && ` (and ${detail.warnings.length - 1} more)`}{" "}
                            <Link to={aboutUrl(detail.id)}>Details</Link>
                        </p>
                    ) : undefined
                }
            />
            {saving && <SaveViewDialog layout={layout} onClose={() => setSaving(false)} />}
        </>
    );
}

function SaveViewDialog({ layout, onClose, name = "" }: { layout: Layout; onClose: () => void; name?: string }) {
    const [title, setTitle] = useState(name);
    const [description, setDescription] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            const saved = await yorg.saveView({
                name: title.trim(),
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
                admins) can change it.
            </p>
            <label className="field">
                Name
                <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="field">
                Notes
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
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
                    <a className="button" href={yorg.sourceUrl(detail.id)} download>
                        Download {detail.filename}
                    </a>
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
                <Fact label="File">
                    {detail.filename} <span className="muted">({formatSize(detail.size)})</span>
                </Fact>
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
                    <h2>While reading it</h2>
                    <ul className="yorg-warning-list">
                        {detail.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                        ))}
                    </ul>
                </>
            )}
            {detail.can_change && !detail.deleted_at && <ReadSettings detail={detail} />}
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

export function ViewsPage() {
    const [views, setViews] = useState<SavedView[] | null>(null);
    const [datasets, setDatasets] = useState<Map<number, string>>(new Map());
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        yorg.views().then(setViews, (error: unknown) => setProblem(message(error)));
        yorg.datasets().then(
            (list) => setDatasets(new Map(list.map((one) => [one.id, one.name]))),
            () => {},
        );
    }, []);
    return (
        <section className="yorg-page">
            <div className="page-head">
                <h1>Saved views</h1>
            </div>
            <p className="lead muted">
                Plots someone saved: channels, scales, time windows, and markers. Open one, or use it with another
                test's data.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {views?.length === 0 && (
                <div className="empty">No saved views yet. Plot a dataset the way you want it, then Save view.</div>
            )}
            {views && views.length > 0 && (
                <table className="table" aria-label="Saved views">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Data</th>
                            <th>Changed</th>
                        </tr>
                    </thead>
                    <tbody>
                        {views.map((view) => (
                            <tr key={view.id}>
                                <td>
                                    <Link to={viewUrl(view.id)} className="name">
                                        {view.name}
                                    </Link>
                                    {view.description && <p className="muted yorg-description">{view.description}</p>}
                                </td>
                                <td>{view.datasets.map((id) => datasets.get(id) ?? `deleted (${id})`).join(", ")}</td>
                                <td>
                                    {view.updated_by?.name ?? "—"}
                                    <span className="muted">
                                        {" · "}
                                        <Time at={view.updated_at} />
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}

export function ViewPage({ id }: { id: number }) {
    const [view, setView] = useState<SavedView | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
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
    if (!view) {
        return <p className="muted yorg-page">Loading the view…</p>;
    }
    return <ViewWorkspace key={`${view.id}/${view.updated_at}`} view={view} onSaved={setView} />;
}

function ViewWorkspace({ view, onSaved }: { view: SavedView; onSaved: (view: SavedView) => void }) {
    const [layout, dispatch] = useReducer(reduce, view, (saved) => readLayout(saved.config, saved.datasets[0] ?? 0));
    const [savedAs] = useState(() => JSON.stringify(readLayout(view.config, view.datasets[0] ?? 0)));
    const changed = JSON.stringify(layout) !== savedAs;
    const [dialog, setDialog] = useState<"copy" | "other" | "delete" | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const body = () => ({
        name: view.name,
        description: view.description,
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
    return (
        <>
            <Workspace
                layout={layout}
                dispatch={dispatch}
                title={
                    <>
                        <h1>{view.name}</h1>
                        <span className="muted">
                            saved view, by {view.created_by?.name ?? "someone"}
                            {changed ? " · changed" : ""}
                        </span>
                    </>
                }
                notice={problem ? <Notice tone="error">{problem}</Notice> : undefined}
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
                        <MoreViewActions
                            canChange={view.can_change}
                            onCopy={() => setDialog("copy")}
                            onOther={() => setDialog("other")}
                            onDelete={() => setDialog("delete")}
                        />
                    </>
                }
            />
            {dialog === "copy" && (
                <SaveViewDialog layout={layout} name={`${view.name} (copy)`} onClose={() => setDialog(null)} />
            )}
            {dialog === "other" && <OtherDatasetDialog layout={layout} onClose={() => setDialog(null)} />}
            {dialog === "delete" && (
                <Dialog
                    title={`Delete the view ${view.name}?`}
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
    onOther,
    onDelete,
}: {
    canChange: boolean;
    onCopy: () => void;
    onOther: () => void;
    onDelete: () => void;
}) {
    const items = [
        { label: "Save as a new view…", onSelect: onCopy },
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
