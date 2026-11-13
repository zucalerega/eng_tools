import { useEffect, useRef, useState } from "react";
import { requestBytes } from "../../api";
import { Notice, usePopover } from "../../components";
import { formatTime } from "../../format";
import { Link, navigate, useSearch } from "../../router";
import { vaultApi, type DrawingView, type FileDetail } from "../api";
import { FileIcon, OpenInSolidWorks } from "../components";
import { caliperUrl, fileUrl, sheetFormat } from "../paths";
import { readDxf, type Drawing, type Geometry } from "./dxf";
import { useBelowTopBar } from "./layout";
import { UNITS } from "./measure";
import { MeasurePanel } from "./MeasurePanel";
import type { Units } from "./model";
import { SheetView } from "./sheet";
import { SourceDot, SOURCE_NAMES } from "./Sources";
import { measureOneOnSheet, measureTwoOnSheet } from "./sheetMeasure";
import "./caliper.css";

// Caliper for flat files, at /vault/caliper/<file id>?version= as the 3D view is. A SolidWorks drawing shows the PDF of
// its sheets that Vault for SolidWorks made when it checked the drawing in, in the browser's own PDF viewer; or else
// the pictures of them SolidWorks saved in the file, which the server reads. A DXF file is read in the browser, and
// drawn to pan, zoom, and measure, its layers shown or hidden.

export function DrawingPage({ id }: { id: number }) {
    const params = new URLSearchParams(useSearch());
    const askedVersion = Number(params.get("version")) || null;
    const [detail, setDetail] = useState<FileDetail | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    // The version shown, once it's loaded: for the header's link to its PDF, where it came from, and its models.
    const [shown, setShown] = useState<DrawingView | null>(null);
    const pdf = shown?.pdf != null;
    const page = useRef<HTMLDivElement>(null);
    useBelowTopBar(page);

    useEffect(() => {
        let current = true;
        vaultApi.file(id).then(
            (loaded) => current && setDetail(loaded),
            (error: Error) => current && setProblem(error.message),
        );
        return () => {
            current = false;
        };
    }, [id]);

    if (problem) {
        return (
            <div className="caliper-page-message">
                <Notice tone="error">{problem}</Notice>
            </div>
        );
    }
    if (!detail) {
        return <p className="muted caliper-page-message">Loading…</p>;
    }
    const file = detail.file;
    const format = sheetFormat(file.name);
    const version = askedVersion ?? file.version;
    return (
        <div className="caliper" ref={page}>
            <header className="caliper-head">
                <h1>
                    <FileIcon name={file.name} />
                    <Link to={fileUrl(file.id)} title="This file's page: its history, what it uses, where it's used">
                        {file.name}
                    </Link>
                </h1>
                <label className="caliper-choice">
                    Version
                    <select
                        value={version}
                        onChange={(event) => navigate(caliperUrl(file.id, Number(event.target.value)))}
                    >
                        {detail.versions.map((v) => (
                            <option key={v.number} value={v.number}>
                                v{v.number}
                                {v.number === file.version ? " (latest)" : ""}
                            </option>
                        ))}
                    </select>
                </label>
                {format === "drawing" && shown && <SheetsSource drawing={shown} />}
                <span className="caliper-head-actions">
                    <OpenInSolidWorks path={file.path} />
                    {format === "drawing" && pdf && (
                        <a
                            className="button"
                            href={vaultApi.drawingPdfUrl(file.id, version)}
                            target="_blank"
                            rel="noreferrer"
                            title="The PDF in a tab of its own: to print it, or see it bigger"
                        >
                            Open PDF
                        </a>
                    )}
                    <a className="button" href={vaultApi.downloadUrl(file.id, version)} download>
                        Download
                    </a>
                </span>
            </header>
            {format === "drawing" && shown && version === file.version && <ChangedModels drawing={shown} />}
            {format === "drawing" ? (
                <DrawingSheets key={version} fileId={file.id} name={file.name} version={version} loaded={setShown} />
            ) : format === "dxf" ? (
                <DxfView key={version} fileId={file.id} version={version} />
            ) : (
                <div className="caliper-page-message">
                    <Notice tone="info">
                        {file.name} isn't a drawing or a DXF file.{" "}
                        <Link to={caliperUrl(file.id)}>Open it in Caliper</Link>
                    </Notice>
                </div>
            )}
        </div>
    );
}

/**
 * Where a drawing's sheets come from, in the page's head: the PDF Vault for SolidWorks made, as SolidWorks prints the
 * drawing; or the pictures SolidWorks saved in the file. Opened, what that means, and who made the PDF when.
 */
function SheetsSource({ drawing }: { drawing: DrawingView }) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const label = drawing.pdf ? SOURCE_NAMES.solidworks : "Pictures saved in the file";
    return (
        <div className="popover caliper-source" ref={within}>
            <button
                type="button"
                className="caliper-source-button"
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={`Where it came from: ${label}`}
                title="Where these sheets came from, and what that means"
                onClick={() => setOpen(!open)}
            >
                <SourceDot source={drawing.pdf ? "solidworks" : "saved_view"} mark />
                {label}
            </button>
            {open && (
                <div className="menu menu-left caliper-source-about" role="dialog" aria-label="Where it came from">
                    {drawing.pdf ? (
                        <>
                            <p>
                                The drawing as SolidWorks prints it: Vault for SolidWorks saved this PDF of its sheets
                                from SolidWorks when v{drawing.version} was checked in.
                            </p>
                            <p>{`Made by ${drawing.pdf.created_by.name}, ${formatTime(drawing.pdf.created_at)}.`}</p>
                        </>
                    ) : (
                        <p>
                            The small pictures of its sheets SolidWorks saves in the file, enough to see what's on them
                            but too small to read. Make PDF, in SolidWorks on the Vault tab, makes the whole drawing.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * The models a drawing's latest version shows that were checked in again since: SolidWorks draws its views from their
 * latest versions as it opens it, so what Caliper shows, made at the drawing's check-in, may be of older shapes.
 */
function ChangedModels({ drawing }: { drawing: DrawingView }) {
    const changed = (drawing.models ?? []).filter((model) => model.latest_version > model.version);
    if (changed.length === 0) {
        return null;
    }
    const one = changed.length === 1;
    return (
        <Notice tone="warning">
            <p>
                <strong>{one ? "Its model has" : "Its models have"} changed since this drawing was checked in.</strong>{" "}
                SolidWorks draws the drawing's views from the latest versions when it opens it, so these sheets may show
                older shapes. Open the drawing in SolidWorks and check it in again to bring them up to date.
            </p>
            <ul>
                {changed.map((model) => (
                    <li key={model.file_id}>
                        <Link to={caliperUrl(model.file_id)}>{model.path}</Link>
                        {`: v${model.version} here, now v${model.latest_version}`}
                    </li>
                ))}
            </ul>
        </Notice>
    );
}

/** Whether this browser shows PDFs in a page: phones' often don't (Chrome on Android downloads them). */
const showsPdfs = (): boolean => (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false;

/** A SolidWorks drawing's version: its PDF, or the pictures of its sheets SolidWorks saved in it. */
function DrawingSheets({
    fileId,
    name,
    version,
    loaded,
}: {
    fileId: number;
    name: string;
    version: number;
    loaded(drawing: DrawingView | null): void;
}) {
    const [drawing, setDrawing] = useState<DrawingView | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [sheet, setSheet] = useState(0);

    useEffect(() => {
        let current = true;
        vaultApi.drawing(fileId, version).then(
            (found) => {
                if (current) {
                    setDrawing(found);
                    loaded(found);
                }
            },
            (error: Error) => current && setProblem(error.message),
        );
        return () => {
            current = false;
            loaded(null);
        };
    }, [fileId, version, loaded]);

    if (problem) {
        return (
            <div className="caliper-page-message">
                <Notice tone="error">{problem}</Notice>
            </div>
        );
    }
    if (!drawing) {
        return <p className="muted caliper-page-message">Loading the drawing…</p>;
    }
    if (drawing.pdf && showsPdfs()) {
        return (
            <section className="caliper-stage caliper-sheets" aria-label="Drawing">
                <iframe
                    className="caliper-pdf"
                    title={`${name} v${version}`}
                    src={vaultApi.drawingPdfUrl(fileId, version)}
                />
            </section>
        );
    }
    const pictured = drawing.sheets.some((s) => s.picture);
    const chosen = drawing.sheets[sheet] ?? drawing.sheets[0];
    const sheetName = (index: number) => drawing.sheets[index]?.name || `Sheet ${index + 1}`;
    return (
        <section className="caliper-stage caliper-sheets" aria-label="Drawing">
            <div className="caliper-sheets-note">
                {drawing.pdf ? (
                    <Notice tone="info">
                        This browser doesn't show PDFs in a page.{" "}
                        <a href={vaultApi.drawingPdfUrl(fileId, version)} target="_blank" rel="noreferrer">
                            Open the drawing's PDF
                        </a>{" "}
                        to read it; {pictured ? "below are" : "SolidWorks saved no"} pictures of its sheets.
                    </Notice>
                ) : (
                    <Notice tone="info">
                        {pictured ? (
                            <p>
                                These are the pictures of its sheets SolidWorks saved in v{version}: enough to see
                                what's on them, too small to read.
                            </p>
                        ) : (
                            <>
                                <p>
                                    v{version} of {name} has no PDF, nor pictures of its sheets that Caliper can show.
                                </p>
                                {drawing.unreadable && <p>{drawing.unreadable}</p>}
                            </>
                        )}
                        <p>
                            Vault for SolidWorks saves the whole drawing as a PDF when it checks it in, and Caliper
                            shows that. For a version from before, open the drawing in SolidWorks and click Make PDF on
                            the Vault tab.
                        </p>
                    </Notice>
                )}
            </div>
            {drawing.sheets.length > 1 && (
                <div className="caliper-sheet-tabs" role="tablist" aria-label="Sheets">
                    {drawing.sheets.map((_, i) => (
                        <button
                            key={i}
                            type="button"
                            role="tab"
                            aria-selected={i === sheet}
                            className={i === sheet ? "caliper-on" : undefined}
                            onClick={() => setSheet(i)}
                        >
                            {sheetName(i)}
                        </button>
                    ))}
                </div>
            )}
            {chosen?.picture && (
                <figure className="caliper-sheet-picture">
                    <img
                        src={vaultApi.sheetPictureUrl(fileId, version, drawing.sheets.indexOf(chosen) + 1)}
                        alt={`${sheetName(drawing.sheets.indexOf(chosen))} of ${name} v${version}, as SolidWorks pictured it`}
                    />
                </figure>
            )}
            {chosen && !chosen.picture && pictured && (
                <p className="muted caliper-page-message">SolidWorks saved no picture of {sheetName(sheet)}.</p>
            )}
        </section>
    );
}

/** A DXF file's version, read in the browser and drawn: its layers beside it, to show and hide. */
function DxfView({ fileId, version }: { fileId: number; version: number }) {
    const container = useRef<HTMLDivElement>(null);
    const view = useRef<SheetView | null>(null);
    const [drawing, setDrawing] = useState<Drawing | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [noCanvas, setNoCanvas] = useState(false);
    const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
    const [measuring, setMeasuring] = useState(false);
    const [picks, setPicks] = useState<Geometry[]>([]);
    const [hovering, setHovering] = useState<Geometry | null>(null);
    const [units, setUnits] = useState<Units>("mm");
    const mm = drawing?.mmPerUnit ?? 1;

    // The file, read here.
    useEffect(() => {
        let current = true;
        requestBytes(vaultApi.downloadUrl(fileId, version))
            .then((bytes) => {
                const read = readDxf(new Uint8Array(bytes));
                if (current) {
                    setDrawing(read);
                    // Layers the file has off or frozen start hidden, as AutoCAD would show them.
                    setHidden(new Set(read.layers.flatMap((layer, i) => (layer.shown ? [] : [i]))));
                    setUnits(read.units);
                }
            })
            .catch((error: Error) => current && setFailure(error.message));
        return () => {
            current = false;
        };
    }, [fileId, version]);

    // The view, once there's somewhere to draw it.
    useEffect(() => {
        if (!container.current) {
            return;
        }
        let created: SheetView;
        try {
            created = new SheetView(container.current, {
                hover: setHovering,
                pick: (picked) => setPicks((previous) => (previous.length >= 2 ? [picked] : [...previous, picked])),
            });
        } catch {
            setNoCanvas(true);
            return;
        }
        view.current = created;
        return () => {
            created.dispose();
            view.current = null;
        };
    }, []);

    useEffect(() => {
        if (drawing) {
            view.current?.setDrawing(drawing);
        }
    }, [drawing]);
    useEffect(() => view.current?.setHiddenLayers(hidden), [hidden]);
    useEffect(() => view.current?.setMeasuring(measuring), [measuring]);
    useEffect(() => view.current?.setPicked(picks), [picks]);
    useEffect(() => {
        const [first, second] = picks;
        const measurement =
            first && second
                ? measureTwoOnSheet(first, second, units, mm)
                : first
                  ? measureOneOnSheet(first, units, mm)
                  : null;
        const line = measurement?.line;
        view.current?.setAnnotation(line ? { line, text: measurement.readings[0]?.value ?? "" } : null);
    }, [picks, units, mm]);

    // F to fit, Esc to let go of what's picked, then of measuring.
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest("input, select, textarea, [contenteditable]") || event.metaKey || event.ctrlKey) {
                return;
            }
            if (event.key === "f" || event.key === "F") {
                view.current?.fit();
            } else if (event.key === "Escape") {
                if (picks.length > 0) {
                    setPicks([]);
                } else {
                    setMeasuring(false);
                }
            }
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [picks]);

    const toggle = (layer: number) =>
        setHidden((previous) => {
            const changed = new Set(previous);
            if (!changed.delete(layer)) {
                changed.add(layer);
            }
            return changed;
        });
    const layers = drawing
        ? drawing.layers.map((layer, i) => ({ ...layer, i })).filter((layer) => layer.count > 0)
        : [];
    const left = drawing ? Object.entries(drawing.left) : [];

    return (
        <div className="caliper-body">
            <aside className="caliper-side" aria-label="Layers">
                <div className="caliper-side-head">
                    <h2>Layers</h2>
                    <button
                        type="button"
                        className="button-small"
                        disabled={hidden.size === 0}
                        onClick={() => setHidden(new Set())}
                    >
                        Show all
                    </button>
                </div>
                {drawing && drawing.mmPerUnit === null && (
                    <p className="caliper-side-note muted">
                        The file doesn't say what its units are, so they're taken as mm.
                    </p>
                )}
                {drawing?.space === "paper" && (
                    <p className="caliper-side-note muted">
                        Its model space is empty, so this is the layout it was saved with.
                    </p>
                )}
                {left.length > 0 && (
                    <p className="caliper-side-note muted">
                        Not shown: {left.map(([type, count]) => `${count} ${type}`).join(", ")}.
                    </p>
                )}
                <ul className="caliper-layers" aria-label="Layers of the drawing">
                    {layers.map((layer) => (
                        <li key={layer.i}>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    aria-label={`Show ${layer.name}`}
                                    checked={!hidden.has(layer.i)}
                                    onChange={() => toggle(layer.i)}
                                />
                                <span
                                    className="caliper-swatch"
                                    style={layer.color ? { background: layer.color } : undefined}
                                    aria-hidden="true"
                                />
                                <span className="caliper-layer-name">{layer.name}</span>
                                <span className="muted">{layer.count}</span>
                            </label>
                        </li>
                    ))}
                </ul>
            </aside>
            <section className="caliper-stage caliper-sheet-stage" aria-label="Drawing">
                <div className="caliper-viewport" ref={container} />
                {!noCanvas && (
                    <div className="caliper-toolbar" role="toolbar" aria-label="View">
                        <button type="button" title="Zoom to show it all (F)" onClick={() => view.current?.fit()}>
                            Fit
                        </button>
                        <button
                            type="button"
                            aria-pressed={measuring}
                            className={measuring ? "caliper-on" : undefined}
                            title="Measure lines, arcs, circles, and corners (Esc to stop)"
                            onClick={() => {
                                setMeasuring(!measuring);
                                setPicks([]);
                            }}
                        >
                            Measure
                        </button>
                        <label className="caliper-units">
                            <span className="visually-hidden">Units</span>
                            <select value={units} onChange={(event) => setUnits(event.target.value as Units)}>
                                {UNITS.map((unit) => (
                                    <option key={unit}>{unit}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                )}
                {noCanvas && (
                    <div className="caliper-stage-message">
                        <Notice tone="warning">
                            This browser isn't drawing here (no canvas), so Caliper can't show the drawing. Its layers
                            are listed beside it.
                        </Notice>
                    </div>
                )}
                {failure && (
                    <div className="caliper-stage-message">
                        <Notice tone="error">{failure}</Notice>
                    </div>
                )}
                {!drawing && !failure && (
                    <p className="caliper-loading-model" role="status">
                        Reading the file…
                    </p>
                )}
                {measuring && (
                    <MeasurePanel
                        hovering={hovering}
                        picked={picks}
                        units={units}
                        clear={() => setPicks([])}
                        one={(geometry, shown) => measureOneOnSheet(geometry, shown, mm)}
                        two={(first, second, shown) => measureTwoOnSheet(first, second, shown, mm)}
                        hint="Click a line, an arc, a circle, or a corner. Click a second to measure between them; a third starts over."
                    />
                )}
            </section>
        </div>
    );
}
