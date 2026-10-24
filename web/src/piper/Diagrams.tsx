import { useEffect, useState, type ReactNode } from "react";
import { Dialog, Notice, Time } from "../components";
import { folderTree, foldersOf, tidyFolder, type Folder } from "../pathTree";
import { Link, navigate } from "../router";
import { piper, type Diagram } from "./api";
import { emptyDrawing } from "./drawing";
import { example } from "./example";
import { fluidOf } from "./fluids";
import { readVisio, type ImportReport } from "./visio";

// The diagrams, in their folders: each folder's the most recently changed first. Find looks in their names, folders,
// descriptions, and the tags of their parts and lines (PT-101 finds the diagrams it's on).

const CLOSED = "piper.folders.closed"; // the folders shut in this browser

function storedClosed(): Set<string> {
    try {
        return new Set(JSON.parse(window.localStorage.getItem(CLOSED) ?? "[]") as string[]);
    } catch {
        return new Set();
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function DiagramsPage({ deleted = false }: { deleted?: boolean }) {
    const [diagrams, setDiagrams] = useState<Diagram[] | null>(null);
    const [found, setFound] = useState<Diagram[] | null>(null);
    const [find, setFind] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState<File | boolean>(false); // a file dropped on the page, or true to choose one
    const [dropping, setDropping] = useState(false);
    const [deleting, setDeleting] = useState<Diagram | null>(null);
    const [closed, setClosed] = useState<Set<string>>(storedClosed);
    const words = find.trim();

    const load = () => piper.diagrams({ deleted }).then(setDiagrams, (error: unknown) => setProblem(message(error)));
    useEffect(() => {
        void load();
        // Listed again only when the page is opened for the other list.
    }, [deleted]);

    // What's found is the server's to say, since it looks in the drawings' tags: asked once typing pauses.
    useEffect(() => {
        if (!words) {
            setFound(null);
            return;
        }
        let current = true;
        const timer = setTimeout(() => {
            piper.diagrams({ q: words, deleted }).then(
                (list) => current && setFound(list),
                (error: unknown) => current && setProblem(message(error)),
            );
        }, 250);
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [words, deleted]);

    const shown = words ? found : diagrams;
    const searching = words !== "";
    const tree = shown ? folderTree(shown.map((diagram, order) => ({ ...diagram, order }))) : null;

    function toggle(path: string) {
        const next = new Set(closed);
        if (next.has(path)) {
            next.delete(path);
        } else {
            next.add(path);
        }
        setClosed(next);
        try {
            window.localStorage.setItem(CLOSED, JSON.stringify([...next]));
        } catch {
            // storage blocked: shut for this visit
        }
    }

    async function duplicate(diagram: Diagram) {
        setProblem(null);
        try {
            const original = await piper.diagram(diagram.id);
            const copy = await piper.create({
                name: `${diagram.name} copy`,
                folder: diagram.folder,
                description: diagram.description,
                drawing: original.drawing,
            });
            navigate(`/piper/diagrams/${copy.id}`);
        } catch (error) {
            setProblem(message(error));
        }
    }

    async function restore(diagram: Diagram) {
        setProblem(null);
        try {
            await piper.restore(diagram.id);
            await load();
            setFound((now) => now?.filter((entry) => entry.id !== diagram.id) ?? null);
        } catch (error) {
            setProblem(message(error));
        }
    }

    function rows(folder: Folder<Diagram>, depth: number): ReactNode[] {
        const shut = !searching && closed.has(folder.path);
        const head = folder.path ? (
            <tr key={`folder:${folder.path}`} className="piper-folder-row">
                <td colSpan={4} style={{ paddingLeft: `${depth * 1.25 + 0.75}rem` }}>
                    <button
                        type="button"
                        className="piper-folder"
                        aria-expanded={!shut}
                        onClick={() => toggle(folder.path)}
                    >
                        <span aria-hidden="true">{shut ? "▸" : "▾"}</span>
                        <span className="file-icon file-icon-folder" aria-hidden="true" />
                        {folder.name}
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
            ...folder.items.map((diagram) => (
                <tr key={diagram.id}>
                    <td style={{ paddingLeft: `${inner * 1.25 + 0.75}rem` }}>
                        <Link to={`/piper/diagrams/${diagram.id}`} className="name">
                            {diagram.name}
                        </Link>
                        {diagram.description && <span className="muted piper-description">{diagram.description}</span>}
                    </td>
                    <td className="numeric">{diagram.parts}</td>
                    <td>
                        <span className="piper-chips">
                            {diagram.fluids.slice(0, 5).map((id) => (
                                <Fluid key={id} id={id} />
                            ))}
                        </span>
                    </td>
                    <td>
                        <span className="muted">
                            {diagram.updated_by?.name ?? "Someone"},{" "}
                            <Time at={deleted && diagram.deleted_at ? diagram.deleted_at : diagram.updated_at} />
                        </span>
                        <span className="row-actions">
                            {deleted ? (
                                diagram.can_delete && (
                                    <button
                                        type="button"
                                        className="button-small"
                                        onClick={() => void restore(diagram)}
                                    >
                                        Restore
                                    </button>
                                )
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        className="button-small"
                                        onClick={() => void duplicate(diagram)}
                                    >
                                        Duplicate
                                    </button>
                                    {diagram.can_delete && (
                                        <button
                                            type="button"
                                            className="button-small"
                                            onClick={() => setDeleting(diagram)}
                                        >
                                            Delete…
                                        </button>
                                    )}
                                </>
                            )}
                        </span>
                    </td>
                </tr>
            )),
        ];
    }

    return (
        <section
            className={`piper-diagrams${dropping ? " piper-dropping" : ""}`}
            // A Visio drawing dropped anywhere on the page is imported, as Import Visio does.
            onDragOver={(event) => {
                if (!deleted && event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    setDropping(true);
                }
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDropping(false);
                }
            }}
            onDrop={(event) => {
                const file = event.dataTransfer.files[0];
                setDropping(false);
                if (!deleted && file) {
                    event.preventDefault();
                    setImporting(file);
                }
            }}
        >
            <div className="page-head">
                <h1 className="page-title">{deleted ? "Deleted diagrams" : "Diagrams"}</h1>
                {!deleted && (
                    <div className="page-actions">
                        <button type="button" onClick={() => setImporting(true)}>
                            Import Visio…
                        </button>
                        <button type="button" className="button-primary" onClick={() => setCreating(true)}>
                            New diagram
                        </button>
                    </div>
                )}
            </div>
            <p className="muted piper-lead">
                {deleted
                    ? "Deleted diagrams keep everything, history and all: whoever made one, or an admin, can restore it."
                    : "The team's P&IDs: its test stands, the vehicle's feed system, the GSE. Everyone can open and change them, and every change is kept in a diagram's history."}
            </p>
            <input
                type="search"
                className="search"
                placeholder="Find diagrams by name, folder, or a part's tag"
                aria-label="Find diagrams"
                value={find}
                onChange={(event) => setFind(event.target.value)}
            />
            {problem && <Notice tone="error">{problem}</Notice>}
            {shown === null ? (
                <p className="muted">Loading…</p>
            ) : shown.length === 0 ? (
                <p className="empty">
                    {searching
                        ? "No diagram has that."
                        : deleted
                          ? "No diagrams are deleted."
                          : "No diagrams yet. Make the first with New diagram."}
                </p>
            ) : (
                <div className="table-scroll">
                    <table className="table" aria-label="Diagrams">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th className="numeric">Parts</th>
                                <th>Fluids</th>
                                <th>{deleted ? "Deleted" : "Changed"}</th>
                            </tr>
                        </thead>
                        <tbody>{tree && rows(tree, 0)}</tbody>
                    </table>
                </div>
            )}
            <p className="piper-foot">
                {deleted ? <Link to="/piper">All diagrams</Link> : <Link to="/piper/deleted">Deleted diagrams</Link>}
            </p>
            {importing !== false && (
                <ImportDialog
                    file={importing === true ? null : importing}
                    folders={foldersOf(diagrams ?? [])}
                    onDone={(made) => {
                        setImporting(false);
                        if (made.length > 0) {
                            void load();
                        }
                    }}
                />
            )}
            {creating && (
                <NewDialog
                    folders={foldersOf(diagrams ?? [])}
                    onDone={(made) => {
                        setCreating(false);
                        if (made) {
                            navigate(`/piper/diagrams/${made.id}`);
                        }
                    }}
                />
            )}
            {deleting && (
                <DeleteDialog
                    diagram={deleting}
                    onDone={(gone) => {
                        setDeleting(null);
                        if (gone) {
                            setDiagrams((now) => now?.filter((entry) => entry.id !== gone.id) ?? null);
                            setFound((now) => now?.filter((entry) => entry.id !== gone.id) ?? null);
                        }
                    }}
                />
            )}
        </section>
    );
}

/** A fluid's chip: its label, in its color. Standard fluids are known here; a diagram's own say their id. */
function Fluid({ id }: { id: string }) {
    const fluid = fluidOf({ format: 1, parts: [], lines: [], fluids: [], style: { no: "", nc: "" } }, id);
    return (
        <span className="piper-chip" style={fluid ? { borderColor: fluid.color, color: fluid.color } : undefined}>
            {fluid?.label ?? id}
        </span>
    );
}

function NewDialog({ folders, onDone }: { folders: string[]; onDone: (made: Diagram | null) => void }) {
    const [name, setName] = useState("");
    const [folder, setFolder] = useState("");
    const [start, setStart] = useState<"blank" | "example">("blank");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function create() {
        setBusy(true);
        try {
            onDone(
                await piper.create({
                    name: name.trim(),
                    folder: tidyFolder(folder),
                    drawing: start === "example" ? example() : emptyDrawing(),
                }),
            );
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title="New diagram"
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
            <label className="field">
                Folder
                <input
                    value={folder}
                    list="piper-folders"
                    maxLength={300}
                    placeholder="Vespula/GSE (empty: at the top)"
                    onChange={(event) => setFolder(event.target.value)}
                />
                <datalist id="piper-folders">
                    {folders.map((path) => (
                        <option key={path} value={path} />
                    ))}
                </datalist>
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

function DeleteDialog({ diagram, onDone }: { diagram: Diagram; onDone: (gone: Diagram | null) => void }) {
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    return (
        <Dialog
            title={`Delete ${diagram.name}?`}
            confirm="Delete"
            danger
            busy={busy}
            onConfirm={async () => {
                setBusy(true);
                try {
                    onDone(await piper.remove(diagram.id));
                } catch (error) {
                    setProblem(message(error));
                    setBusy(false);
                }
            }}
            onCancel={() => onDone(null)}
        >
            <p>It goes to Deleted diagrams, with its history, until whoever made it, or an admin, restores it.</p>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/**
 * A Visio drawing imported: each of its pages a diagram, in a folder, made in this browser (visio.ts) and saved as any
 * diagram is. What became of each page's shapes is said after.
 */
function ImportDialog({
    file: dropped,
    folders,
    onDone,
}: {
    file: File | null;
    folders: string[];
    onDone: (made: Diagram[]) => void;
}) {
    const [file, setFile] = useState<File | null>(dropped);
    const [folder, setFolder] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [made, setMade] = useState<{ diagram: Diagram; report: ImportReport }[] | null>(null);

    async function run() {
        if (!file) {
            return;
        }
        setBusy(true);
        setProblem(null);
        try {
            const pages = await readVisio(file, file.name);
            const results: { diagram: Diagram; report: ImportReport }[] = [];
            for (const page of pages) {
                const diagram = await piper.create({
                    name: page.name,
                    folder: tidyFolder(folder),
                    description: `Imported from ${file.name}`,
                    drawing: page.drawing,
                });
                results.push({ diagram, report: page.report });
            }
            setMade(results);
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }

    if (made) {
        return (
            <Dialog title="Imported" cancel="Close" onCancel={() => onDone(made.map((entry) => entry.diagram))} wide>
                <ul className="piper-imported">
                    {made.map(({ diagram, report }) => (
                        <li key={diagram.id}>
                            <Link
                                to={`/piper/diagrams/${diagram.id}`}
                                onClick={() => onDone(made.map((entry) => entry.diagram))}
                            >
                                {diagram.name}
                            </Link>
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
            disabled={!file}
            onConfirm={() => void run()}
            onCancel={() => onDone([])}
        >
            <p className="muted piper-small">
                Each page becomes a diagram. Visio's P&ID shapes become Piper's parts (tagged with their text),
                connectors become lines between them, and colored lines keep their colors as fluids to name. Visio 2013
                and on save .vsdx files; save an older .vsd as one first.
            </p>
            <label className="field">
                Visio drawing
                <input
                    type="file"
                    accept=".vsdx,.vsd,.vdx"
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
            </label>
            {file && <p className="piper-small">{file.name}</p>}
            <label className="field">
                Folder
                <input
                    value={folder}
                    list="piper-import-folders"
                    maxLength={300}
                    placeholder="Vespula/GSE (empty: at the top)"
                    onChange={(event) => setFolder(event.target.value)}
                />
                <datalist id="piper-import-folders">
                    {folders.map((path) => (
                        <option key={path} value={path} />
                    ))}
                </datalist>
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}
