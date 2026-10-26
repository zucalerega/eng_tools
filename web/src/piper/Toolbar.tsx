import type { ReactNode } from "react";
import { MenuButton } from "../components";
import { Link } from "../router";
import type { Diagram } from "./api";
import type { Commands } from "./commands";
import { FindBox } from "./FindBox";
import type { SaveStatus } from "./saving";
import { useEditor, type EditorStore } from "./store";

// The editor's bar: where the diagram is and whether it's saved, then undo and redo, the tools, the zoom, and the
// panels (test data, history), exports, and Help.

const ICONS: Record<string, ReactNode> = {
    undo: <path d="M6 4 2.5 7.5 6 11M3 7.5h7a3.5 3.5 0 0 1 0 7H8" />,
    redo: <path d="m10 4 3.5 3.5L10 11m3-3.5H6a3.5 3.5 0 0 0 0 7h2" />,
    select: <path d="M3.5 2.5v10l3-2.8 2 4.3 1.8-.8-2-4.2H12z" />,
    line: (
        <>
            <path d="M3 13V6.5h10" />
            <circle cx={3} cy={13} r={1.6} />
            <circle cx={13} cy={6.5} r={1.6} />
        </>
    ),
    minus: <path d="M4 8h8" />,
    plus: <path d="M4 8h8M8 4v8" />,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
    return (
        <svg
            viewBox="0 0 16 16"
            width={16}
            height={16}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {ICONS[name]}
        </svg>
    );
}

export type ExportKind = "pdf" | "svg" | "png" | "print" | "csv";

const STATUS: Record<SaveStatus, string> = {
    saved: "Saved",
    saving: "Saving…",
    unsaved: "Not saved yet",
    offline: "Not saved",
    changed: "Someone else saved it",
    deleted: "Deleted: not saved",
};

/** The panels the editor opens beside or under the drawing. */
export type Panel = "test" | "history" | "parts";

export function Toolbar({
    diagram,
    store,
    commands,
    status,
    problem,
    panel,
    onPanel,
    onRename,
    onExport,
}: {
    diagram: Diagram;
    store: EditorStore;
    commands: Commands;
    status: SaveStatus;
    problem: string | null;
    panel: Panel | null;
    onPanel: (panel: Panel | null) => void;
    onRename: () => void;
    onExport: (as: ExportKind) => void;
}) {
    const { canUndo, canRedo, tool, view } = useEditor(store, (state) => state);
    const folders = diagram.folder ? diagram.folder.split("/") : [];
    return (
        <div className="piper-toolbar">
            <nav className="piper-where" aria-label="Where">
                <Link to="/piper">Diagrams</Link>
                {folders.map((folder, index) => (
                    <span key={index} className="muted">
                        {" / "}
                        {folder}
                    </span>
                ))}
                <span className="muted"> / </span>
                <button type="button" className="piper-name" title="Rename, move, or describe it" onClick={onRename}>
                    {diagram.name}
                </button>
                {diagram.released && (
                    <span
                        className={`badge piper-release-badge${
                            diagram.released_revision === diagram.revision ? " piper-badge-released" : ""
                        }`}
                        title={`Rev ${diagram.released} is revision ${diagram.released_revision}: History has its releases`}
                    >
                        {diagram.released_revision === diagram.revision
                            ? `Rev ${diagram.released}, released`
                            : `Draft after Rev ${diagram.released}`}
                    </span>
                )}
                <span
                    className={`piper-status piper-status-${status}`}
                    role="status"
                    title={status === "offline" ? (problem ?? undefined) : undefined}
                >
                    {STATUS[status]}
                    {status === "offline" && `: ${problem ?? "trying again…"}`}
                </span>
            </nav>
            <div className="piper-tools" role="toolbar" aria-label="Tools">
                <button
                    type="button"
                    aria-label="Undo"
                    title="Undo (Ctrl+Z)"
                    disabled={!canUndo}
                    onClick={() => commands.undo()}
                >
                    <Icon name="undo" />
                </button>
                <button
                    type="button"
                    aria-label="Redo"
                    title="Redo (Ctrl+Shift+Z)"
                    disabled={!canRedo}
                    onClick={() => commands.redo()}
                >
                    <Icon name="redo" />
                </button>
                <span className="piper-separator" />
                <button
                    type="button"
                    aria-label="Select"
                    title="Select and move (V)"
                    aria-pressed={tool.mode === "select"}
                    onClick={() => store.setTool({ mode: "select" })}
                >
                    <Icon name="select" />
                </button>
                <button
                    type="button"
                    aria-label="Draw lines"
                    title="Draw lines (L): from a port, a line, or anywhere"
                    aria-pressed={tool.mode === "line"}
                    onClick={() => store.setTool(tool.mode === "line" ? { mode: "select" } : { mode: "line" })}
                >
                    <Icon name="line" />
                </button>
                <span className="piper-separator" />
                <button type="button" aria-label="Zoom out" title="Zoom out (-)" onClick={() => commands.zoomBy(0.8)}>
                    <Icon name="minus" />
                </button>
                <button
                    type="button"
                    className="piper-zoom"
                    title="Fit the drawing in view (0)"
                    onClick={() => commands.fit()}
                >
                    {Math.round(view.zoom * 100)}%
                </button>
                <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => commands.zoomBy(1.25)}>
                    <Icon name="plus" />
                </button>
                <span className="piper-separator" />
                <FindBox store={store} commands={commands} />
                <button
                    type="button"
                    aria-pressed={panel === "parts"}
                    title="Every part, by what it is, with its specs"
                    onClick={() => onPanel(panel === "parts" ? null : "parts")}
                >
                    Parts
                </button>
                <button
                    type="button"
                    aria-pressed={panel === "test"}
                    onClick={() => onPanel(panel === "test" ? null : "test")}
                >
                    Test data
                </button>
                <button
                    type="button"
                    aria-pressed={panel === "history"}
                    onClick={() => onPanel(panel === "history" ? null : "history")}
                >
                    History
                </button>
                <MenuButton
                    label="Export"
                    items={[
                        { label: "PDF…", onSelect: () => onExport("pdf") },
                        { label: "SVG image", onSelect: () => onExport("svg") },
                        { label: "PNG image", onSelect: () => onExport("png") },
                        { label: "Print…", onSelect: () => onExport("print") },
                        { label: "Parts list (CSV)", onSelect: () => onExport("csv") },
                    ]}
                />
                <Link to="/piper/help" className="button piper-help-link">
                    Help
                </Link>
            </div>
        </div>
    );
}
