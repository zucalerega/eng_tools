import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { Dialog, Notice } from "../components";
import { FolderPicker } from "../FolderPicker";
import { formatTime } from "../format";
import { foldersOf } from "../pathTree";
import { navigate, usePathname, useSearch } from "../router";
import { piper, type Diagram, type RevisionDetail, type Scheme } from "./api";
import { monochrome } from "./fluids";
import { Canvas } from "./Canvas";
import { usePalette, withStates } from "./colors";
import { commandsOf, useEditorKeys } from "./commands";
import { DiagramView } from "./DiagramView";
import { readDrawing, type Drawing } from "./drawing";
import { addPart, drawingBox } from "./edit";
import { download, fileName, partsList, pngOf, printDrawing, svgOf } from "./exports";
import { HistoryPanel } from "./History";
import { Inspector } from "./Inspector";
import { LibraryPanel } from "./LibraryPanel";
import { kindOf, presetOf } from "./library/index";
import type { DiagramMeta } from "./library/kinds";
import { useSaving } from "./saving";
import { EditorStore, useEditor } from "./store";
import { channelNames, findChannel, plotLink } from "./testdata";
import { PAPERS, pdfOf, type Sheet } from "./pdf";
import { TestPanel } from "./TestPanel";
import { Toolbar, type ExportKind, type Panel } from "./Toolbar";
import { findOnDrawing } from "./find";
import { PartsPanel } from "./PartsPanel";
import { readers, useTest } from "./useTest";

// A diagram's page: the editor, the whole window under the top bar. The library's on the left, the drawing in the
// middle, the inspector on the right, and under them, when they're open, the test the drawing's read against and its
// history. A test and the time on its timeline are in the address (?test=5&t=12.5), so a link opens the same moment.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function EditorPage({ id }: { id: number }) {
    const [diagram, setDiagram] = useState<Diagram | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [panel, setPanel] = useState<Panel | null>(null);
    const [looking, setLooking] = useState<RevisionDetail | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [pdfing, setPdfing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [schemes, setSchemes] = useState<Scheme[] | null>(null);
    const store = useMemo(() => new EditorStore(), []);
    const commands = useMemo(() => commandsOf(store), [store]);
    const drawing = useEditor(store, (state) => state.drawing);
    const palette = withStates(usePalette(), drawing);
    const saving = useSaving(store, diagram, setDiagram);
    const fitted = useRef(false);
    const pathname = usePathname();
    const search = new URLSearchParams(useSearch());
    const testParam = Number(search.get("test"));
    const testId = Number.isInteger(testParam) && testParam > 0 ? testParam : null;
    const finding = search.get("find");
    const [time, setTime] = useState(() => Number(search.get("t")) || 0);
    const { reading, problem: testProblem } = useTest(drawing, testId, time);

    useEffect(() => {
        let current = true;
        piper.diagram(id).then(
            (found) => {
                if (current) {
                    store.load(readDrawing(found.drawing));
                    setDiagram(found);
                }
            },
            (error: unknown) => {
                if (current) {
                    setProblem(
                        error instanceof ApiError && error.status === 404
                            ? "There's no such diagram: someone may have deleted it for good, or the link is wrong."
                            : message(error),
                    );
                }
            },
        );
        return () => {
            current = false;
        };
    }, [id, store]);

    // The team's color schemes, for the diagram's panel to take one's colors from.
    useEffect(() => {
        piper.schemes().then(setSchemes, () => setSchemes([]));
    }, []);

    // Opened at the whole drawing, once the canvas has its size.
    useEffect(() => {
        if (diagram && !fitted.current) {
            fitted.current = true;
            commands.fit();
            // Opened from a search (the diagrams' list): at what it found.
            const first = finding ? findOnDrawing(store.getState().drawing, finding)[0] : undefined;
            if (first) {
                commands.show([first.id]);
            }
        }
    }, [diagram, commands, store, finding]);

    // A link to a test opens its panel; the test's start, if the time's not in it.
    useEffect(() => {
        if (testId !== null) {
            setPanel((now) => now ?? "test");
        }
    }, [testId]);
    useEffect(() => {
        const detail = reading?.detail;
        if (detail && detail.t_min !== null && detail.t_max !== null && (time < detail.t_min || time > detail.t_max)) {
            setTime(detail.t_min);
        }
        // Only when a test arrives: the timeline keeps the time in it after that.
    }, [reading?.detail]);

    const editing = diagram !== null && !diagram.deleted_at && looking === null;
    useEditorKeys(store, commands, editing && !renaming);

    if (problem) {
        return <Notice tone="error">{problem}</Notice>;
    }
    if (!diagram) {
        return <p className="muted piper-loading">Loading…</p>;
    }

    const meta: DiagramMeta = {
        name: diagram.name,
        revision: revisionLabel(diagram, diagram.revision, latestRelease(diagram)),
        savedAt: diagram.updated_at,
        by: diagram.created_by?.name ?? "",
    };

    function address(test: number | null, at: number | null) {
        const query = new URLSearchParams(window.location.search);
        if (test === null) {
            query.delete("test");
            query.delete("t");
        } else {
            query.set("test", String(test));
            if (at === null) {
                query.delete("t");
            } else {
                query.set("t", String(Math.round(at * 1000) / 1000));
            }
        }
        const text = query.toString();
        navigate(`${pathname}${text ? `?${text}` : ""}`, { replace: true, exact: true });
    }

    async function plot(channels: string[]) {
        if (testId === null || channels.length === 0) {
            return;
        }
        window.open(await plotLink(testId, channels), "_blank", "noopener");
    }

    async function exportAs(as: ExportKind) {
        const shown = looking ? readDrawing(looking.drawing) : store.getState().drawing;
        try {
            if (as === "pdf") {
                setPdfing(true); // which paper, first
            } else if (as === "svg") {
                const { svg } = await svgOf(shown, meta);
                download(fileName(diagram!.name, "svg"), new Blob([svg], { type: "image/svg+xml" }));
            } else if (as === "png") {
                download(fileName(diagram!.name, "png"), await pngOf(shown, meta));
            } else if (as === "print") {
                await printDrawing(shown, meta);
            } else {
                // A byte-order mark first, so Excel reads it as UTF-8 (µm, Ø).
                download(
                    fileName(`${diagram!.name} parts`, "csv"),
                    new Blob(["﻿", partsList(shown)], { type: "text/csv" }),
                );
            }
        } catch (error) {
            setNotice(`The export didn't work: ${message(error)}`);
        }
    }

    /** A library entry double-clicked: placed in the middle of what's in view. */
    function placeInView(presetId: string) {
        const preset = presetOf(presetId);
        const { view, size, drawing: now } = store.getState();
        if (preset) {
            const at = { x: view.x + size.width / view.zoom / 2, y: view.y + size.height / view.zoom / 2 };
            const added = addPart(now, preset, at);
            store.commit(added.drawing, [added.id]);
        }
    }

    /** A part double-clicked: its tag (or its words) to type. */
    function edit(partId: string) {
        store.select([partId]);
        const part = store.getState().drawing.parts.find((entry) => entry.id === partId);
        const field = part && kindOf(part.kind).text ? "text" : "tag";
        setTimeout(() => {
            const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
                `.piper-inspector [data-piper-field="${field}"]`,
            );
            input?.focus();
            input?.select();
        });
    }

    async function restoreRevision(number: number) {
        const restored = await piper.restoreRevision(diagram!.id, number, diagram!.version);
        setLooking(null);
        saving.adopt(restored);
        setNotice(`Revision ${number} is the drawing again, as revision ${restored.revision}.`);
    }

    const linked = reading
        ? [
              ...new Set(
                  readers(drawing)
                      .flatMap((part) => channelNames(part).map((name) => findChannel(reading.detail, name)?.name))
                      .filter((name) => name !== undefined),
              ),
          ]
        : [];

    return (
        <div className="piper-editor">
            <Toolbar
                diagram={diagram}
                store={store}
                commands={commands}
                status={saving.status}
                problem={saving.problem}
                panel={panel}
                onPanel={(next) => {
                    setPanel(next);
                    if (next !== "history") {
                        setLooking(null);
                    }
                }}
                onRename={() => setRenaming(true)}
                onExport={(as) => void exportAs(as)}
            />
            {saving.status === "changed" && saving.changed && (
                <div className="piper-banner" role="alert">
                    <span>
                        {saving.changed.updated_by?.name ?? "Someone"} saved this diagram at{" "}
                        {formatTime(saving.changed.updated_at)}, after it was opened here. Your changes since aren't
                        saved yet.
                    </span>
                    <button
                        type="button"
                        className="button-small button-primary"
                        onClick={() => void saving.keepMine()}
                    >
                        Keep mine
                    </button>
                    <button
                        type="button"
                        className="button-small"
                        onClick={async () => {
                            try {
                                const copy = await piper.create({
                                    name: `${diagram.name} (my changes)`,
                                    folder: diagram.folder,
                                    description: diagram.description,
                                    drawing: store.getState().drawing,
                                });
                                navigate(`/piper/diagrams/${copy.id}`);
                            } catch (error) {
                                setNotice(`Yours isn't saved as a new diagram: ${message(error)}`);
                            }
                        }}
                    >
                        Save mine as a new diagram
                    </button>
                    <button
                        type="button"
                        className="button-small"
                        onClick={() =>
                            saving.loadTheirs().catch((error: unknown) => {
                                setNotice(`Theirs didn't load: ${message(error)}`);
                            })
                        }
                    >
                        Load theirs
                    </button>
                </div>
            )}
            {diagram.deleted_at && (
                <div className="piper-banner" role="alert">
                    <span>This diagram is deleted: it can be looked at, but not changed.</span>
                    {diagram.can_delete && (
                        <button
                            type="button"
                            className="button-small button-primary"
                            onClick={async () => {
                                try {
                                    setDiagram(await piper.restore(diagram.id));
                                    saving.resume();
                                } catch (error) {
                                    setNotice(`It isn't restored: ${message(error)}`);
                                }
                            }}
                        >
                            Restore it
                        </button>
                    )}
                </div>
            )}
            {notice && (
                <div className="piper-banner piper-banner-info" role="status">
                    <span>{notice}</span>
                    <button type="button" className="piper-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
                        ×
                    </button>
                </div>
            )}
            <div className="piper-body">
                {editing && <LibraryPanel store={store} palette={palette} onPlace={placeInView} />}
                <div className="piper-stage">
                    {editing ? (
                        <Canvas
                            store={store}
                            commands={commands}
                            palette={palette}
                            meta={meta}
                            live={reading?.live ?? null}
                            onEdit={edit}
                        />
                    ) : (
                        <StillDrawing drawing={looking ? readDrawing(looking.drawing) : drawing} meta={meta} />
                    )}
                    {looking && (
                        <div className="piper-banner piper-looking" role="status">
                            <span>
                                Revision {looking.number}
                                {looking.released ? `, Rev ${looking.released}, released` : ""}
                                {looking.note ? ` (${looking.note})` : ""}, by {looking.author?.name ?? "someone"},{" "}
                                {formatTime(looking.saved_at)}
                            </span>
                            <button type="button" className="button-small" onClick={() => setLooking(null)}>
                                Back to the drawing
                            </button>
                        </div>
                    )}
                    {editing && drawing.parts.length === 0 && <EmptyHint />}
                </div>
                {editing && (
                    <Inspector
                        store={store}
                        commands={commands}
                        palette={palette}
                        test={reading}
                        onPlot={(channels) => void plot(channels)}
                        schemes={schemes}
                    />
                )}
                {panel === "history" && (
                    <HistoryPanel
                        diagram={diagram}
                        looking={looking?.number ?? null}
                        onLook={setLooking}
                        onRestore={restoreRevision}
                        onReleased={(release) =>
                            setDiagram(
                                (now) =>
                                    now && { ...now, released: release.letter, released_revision: release.revision },
                            )
                        }
                        onClose={() => {
                            setPanel(null);
                            setLooking(null);
                        }}
                    />
                )}
            </div>
            {panel === "parts" && (
                <PartsPanel
                    store={store}
                    commands={commands}
                    onCsv={() => void exportAs("csv")}
                    onClose={() => setPanel(null)}
                />
            )}
            {panel === "test" && (
                <TestPanel
                    testId={testId}
                    time={time}
                    reading={reading}
                    problem={testProblem}
                    onTest={(test) => {
                        setTime(0);
                        address(test, null);
                    }}
                    onTime={(at, settled) => {
                        setTime(at);
                        if (settled && testId !== null) {
                            address(testId, at);
                        }
                    }}
                    onPlot={() => void plot(linked)}
                    onClose={() => {
                        setPanel(null);
                        address(null, null);
                    }}
                />
            )}
            {pdfing && (
                <PdfDialog
                    onCancel={() => setPdfing(false)}
                    onSave={async (paper, framed, mono) => {
                        const drawn = looking ? readDrawing(looking.drawing) : store.getState().drawing;
                        const shown = mono ? monochrome(drawn) : drawn;
                        const printed = looking
                            ? { ...meta, revision: revisionLabel(diagram, looking.number, looking.released) }
                            : meta;
                        // On a sheet: its title block the sheet's, unless the drawing has its own.
                        const sheet = framed
                            ? {
                                  project: diagram.folder,
                                  diagram: diagram.id,
                                  revisions: await sheetRevisions(diagram.id),
                                  titleBlock: !shown.parts.some((part) => part.kind === "titleblock"),
                              }
                            : null;
                        download(fileName(diagram.name, "pdf"), await pdfOf(shown, printed, paper, sheet));
                        setPdfing(false);
                    }}
                />
            )}
            {renaming && (
                <RenameDialog
                    diagram={diagram}
                    onDone={(changed) => {
                        setRenaming(false);
                        if (changed) {
                            setDiagram(changed);
                        }
                    }}
                />
            )}
        </div>
    );
}

const PAPER = "piper.paper"; // the paper last chosen for a PDF, in this browser
const SHEET = "piper.sheet"; // and whether it was on a sheet ("no": it wasn't)
const MONO = "piper.mono"; // and whether it was in black and white ("yes": it was)

function remembered(key: string, fallback: string): string {
    try {
        return window.localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

/**
 * A PDF of the drawing: on which paper (turned to the drawing's way), or at the drawing's own size; and on a drawing
 * sheet (a border with its zones, a title block, and the named revisions), as a P&ID from Visio is, or bare.
 */
function PdfDialog({
    onSave,
    onCancel,
}: {
    onSave: (paper: string, sheet: boolean, mono: boolean) => Promise<void>;
    onCancel: () => void;
}) {
    const [paper, setPaper] = useState(() => remembered(PAPER, "tabloid"));
    const [sheet, setSheet] = useState(() => remembered(SHEET, "yes") !== "no");
    const [mono, setMono] = useState(() => remembered(MONO, "no") === "yes");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            window.localStorage.setItem(PAPER, paper);
            window.localStorage.setItem(SHEET, sheet ? "yes" : "no");
            window.localStorage.setItem(MONO, mono ? "yes" : "no");
        } catch {
            // storage blocked: the choices last this once
        }
        try {
            await onSave(paper, sheet, mono);
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog title="Save as PDF" confirm="Save PDF" busy={busy} onConfirm={() => void save()} onCancel={onCancel}>
            <label className="field">
                Paper
                <select value={paper} onChange={(event) => setPaper(event.target.value)}>
                    {PAPERS.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="check">
                <input type="checkbox" checked={sheet} onChange={(event) => setSheet(event.target.checked)} />
                On a drawing sheet: a border with its zones, a title block, and the named revisions
            </label>
            <label className="check">
                <input type="checkbox" checked={mono} onChange={(event) => setMono(event.target.checked)} />
                In black and white, for a printer without color: lines in ink, normally closed valves filled, normally
                open ones left white
            </label>
            <p className="muted piper-small">
                The drawing's fitted on the page, turned its way, in the light colors as on paper. Its lines and words
                stay sharp at any size, and its tags can be searched.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/** The diagram's latest revision's letter, if that's the one released. */
const latestRelease = (diagram: Diagram): string | null =>
    diagram.released && diagram.released_revision === diagram.revision ? diagram.released : null;

/**
 * A revision as its title block writes it (DiagramMeta.revision): a released one's letter ("B"), else its number, and
 * if it's after the diagram's latest release, which ("7 (after B)").
 */
function revisionLabel(diagram: Diagram, number: number, letter: string | null | undefined): string {
    if (letter) {
        return letter;
    }
    const after = diagram.released && number > (diagram.released_revision ?? 0) ? ` (after ${diagram.released})` : "";
    return `${number}${after}`;
}

/**
 * What a sheet lists in its revisions block, the latest first: the diagram's releases, each with its letter, what it
 * was for, when, and who approved it; or, before it has any, its named revisions.
 */
async function sheetRevisions(id: number): Promise<Sheet["revisions"]> {
    const day = (at: string) => new Date(at).toLocaleDateString("en-CA");
    const released = (await piper.releases(id)).filter((release) => release.state === "released");
    if (released.length > 0) {
        return released.map((release) => ({
            rev: release.letter ?? "",
            note: release.note,
            date: release.decided_at ? day(release.decided_at) : "",
            by: release.approvals.map((approval) => approval.approver.name).join(", "),
        }));
    }
    return (await piper.revisions(id))
        .filter((revision) => revision.note)
        .map((revision) => ({
            rev: String(revision.number),
            note: revision.note,
            date: day(revision.saved_at),
            by: revision.author?.name ?? "",
        }));
}

/** A drawing to look at, not change: a revision from the history, or a deleted diagram. */
function StillDrawing({ drawing, meta }: { drawing: Drawing; meta: DiagramMeta }) {
    const palette = withStates(usePalette(), drawing);
    const box = drawingBox(drawing) ?? { x0: -200, y0: -150, x1: 200, y1: 150 };
    return (
        <svg
            className="piper-canvas piper-still"
            role="img"
            aria-label="Drawing"
            viewBox={`${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`}
        >
            <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} fill={palette.paper} />
            <DiagramView drawing={drawing} palette={palette} meta={meta} />
        </svg>
    );
}

function EmptyHint() {
    return (
        <div className="piper-empty">
            <h2>An empty diagram</h2>
            <ol>
                <li>Drag parts here from the library on the left (or click one, then click here).</li>
                <li>Drag from a part's port (the dots that show on it) to another to draw a line.</li>
                <li>Drop a valve on a line to put it in the line.</li>
                <li>Select anything to name it and say what it is, on the right.</li>
            </ol>
        </div>
    );
}

/** The folders diagrams are in (and those they're in), to pick one from. */
function useFolders(): string[] {
    const [folders, setFolders] = useState<string[]>([]);
    useEffect(() => {
        piper.diagrams().then(
            (diagrams) => setFolders(foldersOf(diagrams)),
            () => {}, // none to pick from: a path can still be typed
        );
    }, []);
    return folders;
}

function RenameDialog({ diagram, onDone }: { diagram: Diagram; onDone: (changed: Diagram | null) => void }) {
    const [name, setName] = useState(diagram.name);
    const [folder, setFolder] = useState(diagram.folder);
    const folders = useFolders();
    const [description, setDescription] = useState(diagram.description);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            onDone(await piper.change(diagram.id, { name: name.trim(), folder, description }));
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title="Rename, move, or describe"
            confirm="Save"
            busy={busy}
            disabled={!name.trim()}
            onConfirm={() => void save()}
            onCancel={() => onDone(null)}
        >
            <label className="field">
                Name
                <input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
                Folder
                <FolderPicker
                    value={folder}
                    onChange={setFolder}
                    folders={folders}
                    placeholder="None, or a new one, like Vespula/GSE"
                />
            </label>
            <label className="field">
                Description
                <textarea
                    value={description}
                    rows={3}
                    maxLength={5000}
                    onChange={(event) => setDescription(event.target.value)}
                />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}
