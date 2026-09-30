import { useEffect, useMemo, useRef, useState } from "react";
import { request } from "../../api";
import { Dialog, Notice } from "../../components";
import type { Dataset } from "../api";
import { readHandoff, starterScript } from "../analysis";
import { dataset as loadDataset, useLoaded } from "../data";
import { scriptsApi, type Script } from "./api";
import type { Attached } from "./complete";
import { DataPanel } from "./DataPanel";
import { Editor, type EditorHandle } from "./Editor";
import { EXAMPLES } from "./examples";
import { gatherInputs } from "./inputs";
import { isTicking, PythonStatus, RunView, useTicking } from "./Output";
import { python, usePython, useRun } from "./python";
import { folderTree, nameOfFile, tidyFolder, type Folder } from "./tree";
import "../models/models.css";
import "./scripts.css";

// Yorg's Python window (Scripts, in the preview while it's tried out): scripts that pull tests' channels and work them
// over, with NumPy, SciPy, pandas, matplotlib, and CoolProp, run in the browser by the tab's Python (python.ts), which
// stays open as you come and go, gets a script's slow imports ready while you read it, and says what it's doing as it
// runs (Output.tsx). A script works on the tests attached to it (Data, beside it: DataPanel.tsx), and keeps them.
// Scripts are kept on the server in folders, for every admin; .py files upload as scripts and scripts download as them.
// A dataset's or view's page opens a script on what it had (analysis.ts).

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const DATASETS_KEY = "yorg.scripts.datasets"; // the tests attached last, for a new script
const OPEN_KEY = "yorg.scripts.open"; // for this tab: the script open and its last run, to come back to
const PREPARE_MS = 600; // how long typing pauses before Python gets a script's imports ready

/** What's open in the editor: a saved script, an example (saved only as a copy), or a new one. */
interface Open {
    id: string | null; // saved as, if it is
    example: string | null; // the example it is, if it is
    name: string;
    folder: string;
    code: string;
    datasets: number[]; // the tests attached, the first first
    dirty: boolean;
}

type Asking = { ask: "save-as" } | { ask: "delete" } | { ask: "discard"; then: () => void } | null;

const newScript = (datasets: number[]): Open => ({
    id: null,
    example: null,
    name: "New script",
    folder: "",
    code: "# Your analysis. Click a channel under Data to put it in, or type its name in quotes.\n",
    datasets,
    dirty: false,
});

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

/** The script open when this tab last left the page, and its last run (whose output Python still has). */
function remembered(): { open: Open; run: string | null } | null {
    try {
        const found = JSON.parse(window.sessionStorage.getItem(OPEN_KEY) ?? "null") as {
            open?: Open;
            run?: string | null;
        } | null;
        return found?.open && typeof found.open.code === "string" ? { open: found.open, run: found.run ?? null } : null;
    } catch {
        return null;
    }
}

function remember(open: Open, run: string | null) {
    try {
        window.sessionStorage.setItem(OPEN_KEY, JSON.stringify({ open, run }));
    } catch {
        // storage blocked: the page starts afresh next time
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
    const [open, setOpen] = useState<Open>(() => remembered()?.open ?? newScript(storedDatasets()));
    const [runId, setRunId] = useState<string | null>(() => remembered()?.run ?? null);
    const run = useRun(runId);
    const [asking, setAsking] = useState<Asking>(null);
    const [saveAs, setSaveAs] = useState({ name: "", folder: "" });
    const [search, setSearch] = useState("");
    const [closed, setClosed] = useState<Set<string>>(new Set());
    const fileInput = useRef<HTMLInputElement | null>(null);
    const editor = useRef<EditorHandle | null>(null);
    const now = useTicking(isTicking(state, run));

    // Python starts when the page opens (unless it's on already, from before), so it's ready by the time a script is.
    useEffect(() => python.acquire(), []);
    useEffect(() => remember(open, runId), [open, runId]);

    // While a script's read and edited, Python gets its slow imports ready (CoolProp's takes 20 s to a minute), and the
    // channels it names come from the server: its run needn't wait for either.
    const ready = state.status === "ready";
    useEffect(() => {
        if (!ready) {
            return;
        }
        const timer = window.setTimeout(() => {
            python.prepare(open.code);
            gatherInputs(open.code, open.datasets).catch(() => {}); // what's wrong, the run says
        }, PREPARE_MS);
        return () => window.clearTimeout(timer);
    }, [open.code, open.datasets, ready, state.generation]);

    useEffect(() => {
        Promise.all([scriptsApi.list(), request<Dataset[]>("GET", "/api/yorg/datasets")]).then(
            ([saved, all]) => {
                setScripts(saved);
                const ready = all.filter((one) => one.status === "ready");
                setDatasets(ready);
                // From a dataset's or view's page: a script on what it had. Taken from the address, so going back to
                // it later finds the script as it's been changed, not started over.
                const handoff = readHandoff(window.location.search);
                if (handoff) {
                    const names = Object.fromEntries(ready.map((one) => [one.id, one.name]));
                    setOpen({
                        ...newScript(handoff.datasets.filter((id) => id in names)),
                        name: `From ${handoff.title || "a view"}`,
                        code: starterScript(handoff, names),
                        dirty: true,
                    });
                    window.history.replaceState(null, "", window.location.pathname);
                }
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
                    code: example.code,
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
                    code: found.code ?? "",
                    datasets: found.datasets?.length ? found.datasets : open.datasets,
                    dirty: false,
                });
            });
        });
    }

    const save = (name: string, folder: string, asNew: boolean) =>
        act(async () => {
            const done =
                asNew || !open.id
                    ? await scriptsApi.add(name, tidyFolder(folder), open.code, open.datasets)
                    : await scriptsApi.save(open.id, name, tidyFolder(folder), open.code, open.datasets);
            setOpen({ ...open, id: done.id, example: null, name: done.name, folder: done.folder, dirty: false });
            setScripts(await scriptsApi.list());
            setAsking(null);
        });

    function saveNow() {
        if (open.id) {
            void save(open.name, open.folder, false);
        } else {
            setSaveAs({ name: open.name, folder: open.folder });
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
                    code: last.code ?? "",
                    datasets: last.datasets ?? open.datasets,
                    dirty: false,
                }),
            );
        }
    }

    const running = run?.status === "queued" || run?.status === "running";

    /** Run the script: now, or once Python's started and done with what's before it (the output says which). */
    function start() {
        if (running) {
            return;
        }
        if (runId) {
            python.forget(runId); // its output goes, figures and all
        }
        setRunId(python.run({ code: open.code, datasets: open.datasets }));
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

    function folderView(folder: Folder<(typeof tree)["items"][number]>, depth: number) {
        const shut = closed.has(folder.path);
        return (
            <li key={folder.path}>
                {folder.path && (
                    <button
                        type="button"
                        className="scripts-folder"
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
                            return (
                                <li key={item.id}>
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
                <div>
                    <h1>Scripts</h1>
                    <p className="muted dev-powered">
                        Python 3.14 in your browser (Pyodide), with NumPy, SciPy, pandas, matplotlib, and CoolProp
                    </p>
                </div>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            <div className="scripts-layout">
                <aside className="scripts-side" aria-label="Scripts">
                    <div className="scripts-side-actions">
                        <button type="button" onClick={() => withSaved(() => setOpen(newScript(open.datasets)))}>
                            New
                        </button>
                        <button type="button" onClick={() => fileInput.current?.click()}>
                            Upload .py…
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
                    <input
                        className="scripts-search"
                        type="search"
                        placeholder="Find a script"
                        aria-label="Find a script"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                    {scripts === null ? (
                        <p className="muted">Loading…</p>
                    ) : (
                        <ul className="scripts-tree">{folderView(tree, 0)}</ul>
                    )}
                </aside>
                <div className="scripts-main">
                    <div className="scripts-bar">
                        <label className="field">
                            Name
                            <input
                                value={open.name}
                                maxLength={120}
                                onChange={(event) => setOpen({ ...open, name: event.target.value, dirty: true })}
                            />
                        </label>
                        <label className="field">
                            Folder
                            <input
                                value={open.folder}
                                maxLength={300}
                                placeholder="Hotfires/Injector"
                                onChange={(event) => setOpen({ ...open, folder: event.target.value, dirty: true })}
                            />
                        </label>
                    </div>
                    <div className="scripts-actions">
                        {running ? (
                            <button
                                type="button"
                                className="button-danger"
                                onClick={() => runId && python.stop(runId)}
                                title={
                                    run?.status === "running"
                                        ? "Stop it: Python starts again, without what it's imported"
                                        : "Don't run it after all"
                                }
                            >
                                Stop
                            </button>
                        ) : (
                            <button type="button" className="button-primary" title="Ctrl+Enter" onClick={start}>
                                Run
                            </button>
                        )}
                        <button
                            type="button"
                            disabled={open.id !== null && !open.dirty}
                            title="Ctrl+S"
                            onClick={saveNow}
                        >
                            Save
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setSaveAs({ name: open.id ? `${open.name} copy` : open.name, folder: open.folder });
                                setAsking({ ask: "save-as" });
                            }}
                        >
                            Save as…
                        </button>
                        <button type="button" onClick={() => download(`${open.name}.py`, open.code)}>
                            Download .py
                        </button>
                        {open.id && (
                            <button
                                type="button"
                                className="button-danger"
                                onClick={() => setAsking({ ask: "delete" })}
                            >
                                Delete…
                            </button>
                        )}
                        <PythonStatus python={state} now={now} onRestart={() => python.restart()} />
                        {open.example && <span className="muted">An example: Save as… keeps a copy of your own</span>}
                    </div>
                    <Editor
                        ref={editor}
                        label="Code"
                        attached={attached}
                        code={open.code}
                        errorLine={run?.status === "error" && run.code === open.code ? run.line : null}
                        onChange={(code) => setOpen({ ...open, code, dirty: true })}
                        onRun={start}
                        onSave={saveNow}
                    />
                    <section className="scripts-output" aria-label="Output">
                        {run ? (
                            <RunView run={run} python={state} now={now} />
                        ) : (
                            <p className="muted">
                                What the script prints, plots (yorg.plot, matplotlib), and saves (yorg.download) shows
                                here.
                            </p>
                        )}
                    </section>
                </div>
                <DataPanel
                    datasets={datasets}
                    attached={open.datasets}
                    onChange={(ids) => {
                        storeDatasets(ids);
                        setOpen({ ...open, datasets: ids, dirty: open.id !== null || open.dirty });
                    }}
                    onChannel={(channel, test) => editor.current?.insertChannel(channel, test)}
                />
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
                        <input
                            value={saveAs.folder}
                            maxLength={300}
                            placeholder="Hotfires/Injector"
                            onChange={(event) => setSaveAs({ ...saveAs, folder: event.target.value })}
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
