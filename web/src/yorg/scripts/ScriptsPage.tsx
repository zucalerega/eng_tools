import { useEffect, useMemo, useRef, useState, type DragEvent, type SetStateAction } from "react";
import { request } from "../../api";
import { Dialog, Notice } from "../../components";
import type { Dataset } from "../api";
import { FolderPicker } from "../FolderPicker";
import { foldersOf } from "../../pathTree";
import { dataset as loadDataset, useLoaded } from "../data";
import { scriptsApi, type Script } from "./api";
import type { Attached } from "./complete";
import { DataPanel } from "./DataPanel";
import { EXAMPLES } from "./examples";
import { Icon } from "./icons";
import { gatherInputs } from "./inputs";
import { codeOf, joinCells, newCell, parseCells, type Cell } from "./cells";
import { Notebook, type NotebookHandle } from "./Notebook";
import { python, usePython } from "./python";
import { Reference } from "./Reference";
import { keepScript, keptScript, type OpenScript } from "./stored";
import { folderTree, nameOfFile, tidyFolder, type Folder } from "./tree";
import "../models/models.css";
import "./scripts.css";

// Yorg's Python window (Scripts): scripts that pull tests' channels and work them over, with NumPy, SciPy, pandas,
// matplotlib, and CoolProp, run in the browser by the tab's Python (python.ts), which stays open as you come and go,
// gets a script's slow imports ready while you read it, and says what it's doing as it runs (Output.tsx). A script is a
// notebook (Notebook.tsx): cells run one at a time in its variables, so the data loads once. It works on the tests
// attached to it (Data, beside it: DataPanel.tsx), and keeps them. Scripts are kept on the server in folders, for
// everyone (each changed only by whoever saved it, or an admin: another's is saved as a copy), as .py code with a
// "# %%" line starting each cell (cells.ts); .py files upload as scripts and scripts download as them. Beside the
// notebook, its tests (Data) or what the yorg module has (the Reference: Reference.tsx). A dataset's or view's page's
// own Python (docked beside its plots: PythonDock.tsx) opens its notebook here too.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const DATASETS_KEY = "yorg.scripts.datasets"; // the tests attached last, for a new script
const PANEL_KEY = "yorg.scripts.panel"; // what's beside the notebook: its tests (Data), or the Reference
const PREPARE_MS = 600; // how long typing pauses before Python gets a script's imports ready
const DRAGGED_SCRIPT = "application/x-yorg-script"; // a script's id, as it's dragged onto a folder

type Open = OpenScript;

type Asking = { ask: "save-as" } | { ask: "delete" } | { ask: "discard"; then: () => void } | null;

let unsaved = 0;

const newScript = (datasets: number[]): Open => {
    unsaved += 1;
    return {
        id: null,
        example: null,
        name: "New script",
        folder: "",
        cells: [newCell()],
        namespace: `new-${Date.now().toString(36)}-${unsaved}`,
        datasets,
        dirty: false,
    };
};

/** The tests to start with: those a page sent (?dataset=5), or those attached here last. */
function storedDatasets(): number[] {
    const asked = Number(new URLSearchParams(window.location.search).get("dataset"));
    if (Number.isFinite(asked) && asked > 0) {
        return [asked];
    }
    try {
        const found: unknown = JSON.parse(window.localStorage.getItem(DATASETS_KEY) ?? "[]");
        return Array.isArray(found) ? found.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
    } catch {
        return [];
    }
}

function storeDatasets(ids: number[]) {
    try {
        window.localStorage.setItem(DATASETS_KEY, JSON.stringify(ids));
    } catch {
        // storage blocked: they're attached for this visit
    }
}

type Panel = "data" | "reference";

function storedPanel(): Panel {
    try {
        return window.localStorage.getItem(PANEL_KEY) === "reference" ? "reference" : "data";
    } catch {
        return "data";
    }
}

function download(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/x-python" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

export function ScriptsPage() {
    useLoaded();
    const state = usePython();
    const [scripts, setScripts] = useState<Script[] | null>(null);
    const [datasets, setDatasets] = useState<Dataset[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    const [open, setOpenScript] = useState<Open>(() => keptScript()?.open ?? newScript(storedDatasets()));
    const [runs, setRuns] = useState<Record<string, string>>(() => keptScript()?.runs ?? {});
    const [asking, setAsking] = useState<Asking>(null);
    const [saveAs, setSaveAs] = useState({ name: "", folder: "" });
    const [search, setSearch] = useState("");
    const [closed, setClosed] = useState<Set<string>>(new Set());
    const [dragging, setDragging] = useState(false); // a script, onto a folder
    const [over, setOver] = useState<string | null>(null); // the folder it's over ("": the top)
    const [panel, setPanelState] = useState<Panel>(storedPanel);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const notebook = useRef<NotebookHandle | null>(null);

    /** Open another script (or another version of this one): the last one's outputs go, unless a run's still on. */
    function setOpen(next: Open) {
        if (next.namespace !== open.namespace || next.cells !== open.cells) {
            for (const run of Object.values(runs)) {
                const record = python.runOf(run);
                if (record && record.status !== "queued" && record.status !== "running") {
                    python.forget(run);
                }
            }
            setRuns({});
        }
        setOpenScript(next);
    }

    /** The cells changed (as the notebook changes them): the script has changes to save. */
    const setCells = (change: SetStateAction<Cell[]>) =>
        setOpenScript((now) => ({
            ...now,
            cells: typeof change === "function" ? change(now.cells) : change,
            dirty: true,
        }));

    const code = useMemo(() => codeOf(open.cells), [open.cells]);

    function setPanel(next: Panel) {
        setPanelState(next);
        try {
            window.localStorage.setItem(PANEL_KEY, next);
        } catch {
            // storage blocked: it's beside the notebook for this visit
        }
    }

    // Python starts when the page opens (unless it's on already, from before), so it's ready by the time a script is.
    useEffect(() => python.acquire(), []);
    useEffect(() => keepScript(open, runs), [open, runs]);

    // While a script's read and edited, Python gets its slow imports ready (CoolProp's takes 20 s to a minute), and the
    // channels it names come from the server: its run needn't wait for either.
    const ready = state.status === "ready";
    useEffect(() => {
        if (!ready) {
            return;
        }
        const timer = window.setTimeout(() => {
            python.prepare(code);
            gatherInputs(code, open.datasets).catch(() => {}); // what's wrong, the run says
        }, PREPARE_MS);
        return () => window.clearTimeout(timer);
    }, [code, open.datasets, ready, state.generation]);

    useEffect(() => {
        Promise.all([scriptsApi.list(), request<Dataset[]>("GET", "/api/yorg/datasets")]).then(
            ([saved, all]) => {
                setScripts(saved);
                setDatasets(all.filter((one) => one.status === "ready"));
            },
            (error) => setProblem(message(error)),
        );
    }, []);

    const tree = useMemo(() => {
        const wanted = search.trim().toLowerCase();
        const all = [
            ...(scripts ?? []).map((one) => ({ ...one, example: false })),
            ...EXAMPLES.map((one) => ({ ...one, example: true })),
        ];
        return folderTree(
            wanted
                ? all.filter(
                      (one) => one.name.toLowerCase().includes(wanted) || one.folder.toLowerCase().includes(wanted),
                  )
                : all,
        );
    }, [scripts, search]);

    const folders = useMemo(() => foldersOf(scripts ?? []), [scripts]); // to pick one from

    function withSaved(then: () => void) {
        if (open.dirty) {
            setAsking({ ask: "discard", then });
        } else {
            then();
        }
    }

    const act = async (action: () => Promise<void>) => {
        setProblem(null);
        try {
            await action();
        } catch (error) {
            setProblem(message(error));
        }
    };

    function openScript(id: string) {
        const example = EXAMPLES.find((one) => one.id === id);
        withSaved(() => {
            if (example) {
                setOpen({
                    id: null,
                    example: example.id,
                    name: example.name,
                    folder: "",
                    cells: parseCells(example.code),
                    namespace: example.id,
                    datasets: open.datasets,
                    dirty: false,
                });
                return;
            }
            void act(async () => {
                const found = await scriptsApi.get(id);
                setOpen({
                    id: found.id,
                    example: null,
                    name: found.name,
                    folder: found.folder,
                    cells: parseCells(found.code ?? ""),
                    namespace: `script-${found.id}`,
                    datasets: found.datasets?.length ? found.datasets : open.datasets,
                    dirty: false,
                    canChange: found.can_change,
                });
            });
        });
    }

    const save = (name: string, folder: string, asNew: boolean) =>
        act(async () => {
            const text = joinCells(open.cells);
            const done =
                asNew || !open.id
                    ? await scriptsApi.add(name, tidyFolder(folder), text, open.datasets)
                    : await scriptsApi.save(open.id, name, tidyFolder(folder), text, open.datasets);
            // The notebook's variables and outputs stay: it's the same notebook, saved.
            setOpenScript({
                ...open,
                id: done.id,
                example: null,
                name: done.name,
                folder: done.folder,
                dirty: false,
                canChange: done.can_change,
            });
            setScripts(await scriptsApi.list());
            setAsking(null);
        });

    /** Save over it if it's yours; else (new, an example, or someone else's) as one of your own. */
    function saveNow() {
        if (open.id && open.canChange !== false) {
            void save(open.name, open.folder, false);
        } else {
            setSaveAs({ name: open.id ? `${open.name} copy` : open.name, folder: open.folder });
            setAsking({ ask: "save-as" });
        }
    }

    async function uploadFiles(files: FileList) {
        const added: Script[] = [];
        for (const file of Array.from(files)) {
            added.push(await scriptsApi.add(nameOfFile(file.name), open.folder, await file.text(), open.datasets));
        }
        setScripts(await scriptsApi.list());
        const last = added[added.length - 1];
        if (last) {
            withSaved(() =>
                setOpen({
                    id: last.id,
                    example: null,
                    name: last.name,
                    folder: last.folder,
                    cells: parseCells(last.code ?? ""),
                    namespace: `script-${last.id}`,
                    datasets: last.datasets ?? open.datasets,
                    dirty: false,
                    canChange: last.can_change,
                }),
            );
        }
    }

    // Every test attached, in order (the first is the one that needs no dataset=), its channels once they've loaded.
    const attached: Attached[] = open.datasets.map((id) => {
        const loaded = loadDataset(id);
        const ready = loaded.status === "ready" ? loaded.value : null;
        return {
            id,
            name: ready?.name ?? datasets.find((one) => one.id === id)?.name ?? `Test ${id}`,
            channels: ready ? ready.channels.map(({ name, unit }) => ({ name, unit })) : [],
        };
    });

    /** A script into a folder ("": out of its folder), as it was saved: whatever's open and not saved stays open. */
    const moveScript = (id: string, folder: string) =>
        act(async () => {
            const found = scripts?.find((one) => one.id === id);
            if (!found || found.folder === folder) {
                return;
            }
            const saved = await scriptsApi.get(id);
            await scriptsApi.save(id, saved.name, folder, saved.code ?? "", saved.datasets ?? []);
            setOpenScript((now) => (now.id === id ? { ...now, folder } : now));
            setScripts(await scriptsApi.list());
        });

    /** What a folder (or the top) does with a script dragged onto it. */
    const dropOn = (folder: string) => ({
        onDragOver: (event: DragEvent) => {
            if (event.dataTransfer.types.includes(DRAGGED_SCRIPT)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(folder);
            }
        },
        onDragLeave: () => setOver((now) => (now === folder ? null : now)),
        onDrop: (event: DragEvent) => {
            if (!event.dataTransfer.types.includes(DRAGGED_SCRIPT)) {
                return;
            }
            event.preventDefault();
            setOver(null);
            setDragging(false);
            void moveScript(event.dataTransfer.getData(DRAGGED_SCRIPT), folder);
        },
    });

    function folderView(folder: Folder<(typeof tree)["items"][number]>, depth: number) {
        const shut = closed.has(folder.path);
        return (
            <li key={folder.path}>
                {folder.path && (
                    <button
                        type="button"
                        className={`scripts-folder${over === folder.path ? " yorg-drop-folder" : ""}`}
                        {...dropOn(folder.path)}
                        style={{ paddingLeft: `${depth * 0.9}rem` }}
                        aria-expanded={!shut}
                        onClick={() => {
                            const next = new Set(closed);
                            if (shut) {
                                next.delete(folder.path);
                            } else {
                                next.add(folder.path);
                            }
                            setClosed(next);
                        }}
                    >
                        {shut ? "▸" : "▾"} {folder.name}
                    </button>
                )}
                {!shut && (
                    <ul>
                        {folder.folders.map((inner) => folderView(inner, depth + (folder.path ? 1 : 0)))}
                        {folder.items.map((item) => {
                            const current = item.example ? open.example === item.id : open.id === item.id;
                            // A script of yours (or any, for an admin) drags onto a folder; the examples stay put.
                            const movable = !item.example && "can_change" in item && item.can_change;
                            return (
                                <li
                                    key={item.id}
                                    draggable={movable}
                                    title={movable ? "Drag it onto a folder to move it" : undefined}
                                    onDragStart={(event) => {
                                        event.dataTransfer.setData(DRAGGED_SCRIPT, item.id);
                                        event.dataTransfer.effectAllowed = "move";
                                        setDragging(true);
                                    }}
                                    onDragEnd={() => {
                                        setDragging(false);
                                        setOver(null);
                                    }}
                                >
                                    <button
                                        type="button"
                                        className={`scripts-item ${current ? "scripts-current" : ""}`}
                                        style={{ paddingLeft: `${(depth + (folder.path ? 1 : 0)) * 0.9 + 0.4}rem` }}
                                        aria-current={current ? "true" : undefined}
                                        onClick={() => openScript(item.id)}
                                    >
                                        {item.name}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </li>
        );
    }

    return (
        <section className="yorg-page scripts-page">
            <div className="page-head">
                <h1>Scripts</h1>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            <div className="scripts-layout">
                <aside className="scripts-side scripts-pane" aria-label="Scripts">
                    <div className="pane-head">
                        <input
                            className="scripts-search"
                            type="search"
                            placeholder="Find a script"
                            aria-label="Find a script"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                        <button
                            type="button"
                            className="icon-button"
                            aria-label="New script"
                            title="A new script"
                            onClick={() => withSaved(() => setOpen(newScript(open.datasets)))}
                        >
                            <Icon name="plus" />
                        </button>
                        <button
                            type="button"
                            className="icon-button"
                            aria-label="Upload .py files"
                            title="Upload .py files, each as a script"
                            onClick={() => fileInput.current?.click()}
                        >
                            <Icon name="upload" />
                        </button>
                        <input
                            ref={fileInput}
                            type="file"
                            accept=".py,text/x-python,text/plain"
                            multiple
                            hidden
                            aria-label="Python files"
                            onChange={(event) => {
                                const files = event.target.files;
                                if (files?.length) {
                                    void act(() => uploadFiles(files));
                                }
                                event.target.value = "";
                            }}
                        />
                    </div>
                    <div className="pane-body">
                        {dragging && (
                            <div className={`yorg-drop-top${over === "" ? " yorg-drop-folder" : ""}`} {...dropOn("")}>
                                Drop here: no folder
                            </div>
                        )}
                        {scripts === null ? (
                            <p className="muted">Loading…</p>
                        ) : (
                            <ul className="scripts-tree">{folderView(tree, 0)}</ul>
                        )}
                    </div>
                </aside>
                <div className="scripts-main">
                    <div className="pane-head scripts-file">
                        <input
                            className="scripts-name"
                            aria-label="Name"
                            value={open.name}
                            maxLength={120}
                            onChange={(event) => setOpen({ ...open, name: event.target.value, dirty: true })}
                        />
                        <label
                            className="scripts-path"
                            title="Its folder: one there is, or a new one, like Hotfires/Injector"
                        >
                            <Icon name="folder" />
                            <FolderPicker
                                value={open.folder}
                                folders={folders}
                                onChange={(folder) => setOpen({ ...open, folder, dirty: true })}
                            />
                        </label>
                        <div className="scripts-file-actions">
                            {open.dirty && (
                                <span
                                    className="scripts-dirty"
                                    role="img"
                                    aria-label="Changes not saved"
                                    title="Changes not saved"
                                />
                            )}
                            {open.example && (
                                <span className="scripts-badge" title="Save as… keeps a copy of your own">
                                    Example
                                </span>
                            )}
                            {open.id && open.canChange === false && (
                                <span
                                    className="scripts-badge"
                                    title="Only whoever saved it, or an admin, changes it: Save keeps a copy of your own"
                                >
                                    Someone else&apos;s
                                </span>
                            )}
                            <button
                                type="button"
                                className="button-small"
                                disabled={open.id !== null && !open.dirty}
                                title="Ctrl+S"
                                onClick={saveNow}
                            >
                                Save
                            </button>
                            <button
                                type="button"
                                className="button-small"
                                onClick={() => {
                                    setSaveAs({ name: open.id ? `${open.name} copy` : open.name, folder: open.folder });
                                    setAsking({ ask: "save-as" });
                                }}
                            >
                                Save as…
                            </button>
                            <button
                                type="button"
                                className="icon-button"
                                aria-label="Download .py"
                                title="Download it, as a .py file"
                                onClick={() => download(`${open.name}.py`, joinCells(open.cells))}
                            >
                                <Icon name="download" />
                            </button>
                            {open.id && open.canChange !== false && (
                                <button
                                    type="button"
                                    className="icon-button icon-danger"
                                    aria-label="Delete…"
                                    title="Delete the script"
                                    onClick={() => setAsking({ ask: "delete" })}
                                >
                                    <Icon name="trash" />
                                </button>
                            )}
                        </div>
                    </div>
                    <Notebook
                        key={open.namespace}
                        ref={notebook}
                        cells={open.cells}
                        setCells={setCells}
                        runs={runs}
                        setRuns={setRuns}
                        namespace={open.namespace}
                        datasets={open.datasets}
                        attached={attached}
                        onSave={saveNow}
                    />
                </div>
                <div className="scripts-panel scripts-pane">
                    <div className="pane-head scripts-switch" role="group" aria-label="Beside the script">
                        <button type="button" aria-pressed={panel === "data"} onClick={() => setPanel("data")}>
                            Data
                        </button>
                        <button
                            type="button"
                            aria-pressed={panel === "reference"}
                            onClick={() => setPanel("reference")}
                        >
                            <Icon name="book" />
                            Reference
                        </button>
                    </div>
                    <div className="pane-body">
                        {panel === "data" ? (
                            <DataPanel
                                datasets={datasets}
                                attached={open.datasets}
                                onChange={(ids) => {
                                    storeDatasets(ids);
                                    setOpen({ ...open, datasets: ids, dirty: open.id !== null || open.dirty });
                                }}
                                onChannel={(channel, test) => notebook.current?.insertChannel(channel, test)}
                            />
                        ) : (
                            <Reference onInsert={(lines) => notebook.current?.insertLines(lines)} />
                        )}
                    </div>
                </div>
            </div>

            {asking?.ask === "save-as" && (
                <Dialog
                    title="Save the script"
                    confirm="Save"
                    disabled={saveAs.name.trim() === ""}
                    onConfirm={() => void save(saveAs.name.trim(), saveAs.folder, true)}
                    onCancel={() => setAsking(null)}
                >
                    <label className="field">
                        Name
                        <input
                            value={saveAs.name}
                            maxLength={120}
                            onChange={(event) => setSaveAs({ ...saveAs, name: event.target.value })}
                            autoFocus
                        />
                    </label>
                    <label className="field">
                        Folder
                        <FolderPicker
                            value={saveAs.folder}
                            folders={folders}
                            placeholder="None, or a new one, like Hotfires/Injector"
                            onChange={(folder) => setSaveAs({ ...saveAs, folder })}
                        />
                    </label>
                </Dialog>
            )}
            {asking?.ask === "delete" && open.id && (
                <Dialog
                    title={`Delete ${open.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() =>
                        void act(async () => {
                            await scriptsApi.remove(open.id!);
                            setScripts(await scriptsApi.list());
                            setOpen(newScript(open.datasets));
                            setAsking(null);
                        })
                    }
                    onCancel={() => setAsking(null)}
                >
                    <p>It&apos;s gone for everyone.</p>
                </Dialog>
            )}
            {asking?.ask === "discard" && (
                <Dialog
                    title="Leave your changes?"
                    confirm="Leave them"
                    danger
                    onConfirm={() => {
                        const then = asking.then;
                        setAsking(null);
                        then();
                    }}
                    onCancel={() => setAsking(null)}
                >
                    <p>{open.name} has changes that aren&apos;t saved.</p>
                </Dialog>
            )}
        </section>
    );
}
