import {
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
    type Dispatch,
    type KeyboardEvent,
    type Ref,
    type SetStateAction,
} from "react";
import { MenuButton, usePopover } from "../../components";
import { CodeEditor, type CodeEditorHandle, type EditorKeys, type RunError } from "./CodeEditor";
import type { Attached } from "./complete";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { newCell, type Cell } from "./cells";
import type { PageView } from "./inputs";
import { cellStatus, isTicking, PythonStatus, RunView, useTicking } from "./Output";
import { python, usePython, useRuns, type RunRecord } from "./python";

// A notebook: a script in cells (cells.ts), each run on its own in the notebook's variables, so the cell that loads
// the data runs once and the ones after it as often as they're changed. A cell's output (Output.tsx) is under it, and
// how its last run went beside its name: [3], its number among the notebook's runs. Cells are code or text (Markdown),
// titled or not, and moved, added, and deleted from a cell's menu or with Jupyter's keys: Escape leaves a cell's editor,
// then ↑ ↓ go between cells, A and B add one above and below, D D deletes, M and Y make text and code, Enter edits.

/** What the page can do in the notebook: put a channel (from Data), or an example (from the Reference), into the code. */
export interface NotebookHandle {
    insertChannel: (channel: string, test: string | number | null) => void;
    insertLines: (code: string) => void;
}

interface Props {
    cells: Cell[];
    setCells: Dispatch<SetStateAction<Cell[]>>;
    runs: Record<string, string>; // a cell's (by id) last run
    setRuns: Dispatch<SetStateAction<Record<string, string>>>;
    namespace: string; // its variables' in Python
    datasets: number[]; // the tests attached, the first first
    attached: Attached[]; // and their channels, for the editor's suggestions
    onSave: () => void;
    view?: PageView; // a dataset's or view's page's (its Python, docked): its plots go on the page's
    status?: boolean; // whether its bar says how Python is (the dock says it in its head, where there's room)
    ref?: Ref<NotebookHandle>;
}

type Focus = { id: string; at: "start" | "end" | "cell" };

const going = (run: RunRecord | null) => run?.status === "queued" || run?.status === "running";

/** A failed run's line, and what went wrong (the traceback's last line), to mark in its cell. */
function errorOf(run: RunRecord | null): RunError | null {
    if (!run || run.status !== "error" || run.line === null) {
        return null;
    }
    const message = (run.error ?? "").trim().split("\n").pop() ?? "";
    return { line: run.line, message, code: run.code };
}

function KeysHelp() {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const keys: [string, string][] = [
        ["Shift+Enter", "Run the cell, and go on to the next"],
        ["Ctrl+Enter", "Run the cell"],
        ["Alt+Enter", "Run the cell, and add one after it"],
        ["Ctrl+Space", "Suggestions"],
        ["Ctrl+F", "Find (and replace)"],
        ["Ctrl+/", "Comment the lines, or not"],
        ["Ctrl+S", "Save"],
        ["Esc", "Leave the cell's code, for these:"],
        ["↑ ↓", "The cell before, after"],
        ["A, B", "Add a cell above, below"],
        ["D D", "Delete the cell"],
        ["M, Y", "Make it text, code"],
        ["Enter", "Edit the cell"],
    ];
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className="icon-button"
                aria-label="Keys"
                title="Keys: running cells, moving between them, and the editor's"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <Icon name="keyboard" />
            </button>
            {open && (
                <div className="menu notebook-keys" role="dialog" aria-label="Keys">
                    <dl>
                        {keys.map(([key, what]) => (
                            <div key={key}>
                                <dt>
                                    <kbd>{key}</kbd>
                                </dt>
                                <dd>{what}</dd>
                            </div>
                        ))}
                    </dl>
                    <p className="muted">On a Mac, ⌘ for Ctrl.</p>
                </div>
            )}
        </div>
    );
}

export function Notebook(props: Props) {
    const { cells, setCells, runs, setRuns, namespace, datasets, attached, onSave, view, status = true, ref } = props;
    const state = usePython();
    const records = useRuns(cells.map((cell) => runs[cell.id]));
    const now = useTicking(isTicking(state, ...records));
    const [selected, setSelected] = useState<string | null>(cells[0]?.id ?? null);
    const [writing, setWriting] = useState<Set<string>>(() => new Set()); // text cells being edited
    const [, refocus] = useState(0);
    const editors = useRef(new Map<string, CodeEditorHandle>());
    const sections = useRef(new Map<string, HTMLElement>());
    const focusing = useRef<Focus | null>(null);
    const lastWritten = useRef<string | null>(null); // the code cell a channel from Data goes into
    const deleting = useRef<{ id: string; at: number } | null>(null); // D pressed once

    // The editors' suggestions come from Python, once it's otherwise free.
    useEffect(() => python.wantTools(), []);

    // Once a change is on the page, what it asked to be focused.
    useLayoutEffect(() => {
        const wanted = focusing.current;
        if (!wanted) {
            return;
        }
        focusing.current = null;
        if (wanted.at === "cell") {
            sections.current.get(wanted.id)?.focus();
        } else {
            editors.current.get(wanted.id)?.focus(wanted.at);
        }
    });

    function focus(id: string, at: Focus["at"]) {
        focusing.current = { id, at };
        setSelected(id);
        refocus((count) => count + 1);
    }

    function write(id: string, writingIt: boolean) {
        setWriting((now) => {
            const next = new Set(now);
            if (writingIt) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    }

    /** A new cell at index, being written in. */
    function insert(index: number, kind: Cell["kind"] = "code") {
        const cell = newCell(kind);
        setCells((now) => [...now.slice(0, index), cell, ...now.slice(index)]);
        if (kind === "markdown") {
            write(cell.id, true);
        }
        focus(cell.id, "start");
    }

    function change(id: string, change: Partial<Cell>) {
        setCells((now) => now.map((cell) => (cell.id === id ? { ...cell, ...change } : cell)));
    }

    /** Let a cell's last run go (and its output), unless it's going. */
    function clearRun(id: string) {
        const run = runs[id];
        if (run && !going(python.runOf(run) ?? null)) {
            python.forget(run);
            setRuns((now) => {
                const next = { ...now };
                delete next[id];
                return next;
            });
        }
    }

    function remove(id: string) {
        const index = cells.findIndex((cell) => cell.id === id);
        clearRun(id);
        const rest = cells.filter((cell) => cell.id !== id);
        const next = rest[Math.min(index, rest.length - 1)];
        if (next) {
            setCells(rest);
            focus(next.id, "cell");
        } else {
            const cell = newCell();
            setCells([cell]);
            focus(cell.id, "start");
        }
    }

    function move(id: string, by: -1 | 1) {
        setCells((now) => {
            const index = now.findIndex((cell) => cell.id === id);
            const to = index + by;
            if (index < 0 || to < 0 || to >= now.length) {
                return now;
            }
            const next = [...now];
            [next[index], next[to]] = [next[to]!, next[index]!];
            return next;
        });
    }

    function convert(id: string, kind: Cell["kind"]) {
        if (kind === "markdown") {
            clearRun(id);
            write(id, true);
        }
        change(id, { kind });
    }

    /** Run cells (code ones; in their order), as one: if one fails, those after it don't run. */
    function run(ids: string[]) {
        const wanted = cells.filter((cell) => ids.includes(cell.id));
        const batch = wanted.length > 1 ? `batch-${namespace}-${Date.now()}` : undefined;
        const started: Record<string, string> = {};
        for (const cell of wanted) {
            if (cell.kind !== "code") {
                write(cell.id, false);
                continue;
            }
            const before = runs[cell.id];
            if (before && going(python.runOf(before) ?? null)) {
                continue; // it's on already
            }
            if (before) {
                python.forget(before);
            }
            started[cell.id] = python.run({ code: cell.source, datasets, namespace, batch, view });
        }
        setRuns((now) => ({ ...now, ...started }));
    }

    /** Run a cell, then stay, go on to the next (a new one at the end), or add one after it. */
    function runCell(id: string, then: "stay" | "next" | "insert") {
        const index = cells.findIndex((cell) => cell.id === id);
        if (index < 0) {
            return;
        }
        run([id]);
        if (then === "insert") {
            insert(index + 1);
        } else if (then === "next") {
            const next = cells[index + 1];
            if (next) {
                focus(next.id, next.kind === "code" ? "start" : "cell");
            } else {
                insert(index + 1);
            }
        }
    }

    const codeIds = (from = 0, to = cells.length) =>
        cells.slice(from, to).flatMap((cell) => (cell.kind === "code" ? [cell.id] : []));

    function stop(id: string) {
        const run = runs[id];
        if (run) {
            python.stop(run);
        }
    }

    function clearOutputs() {
        for (const cell of cells) {
            clearRun(cell.id);
        }
    }

    function keysOf(id: string): EditorKeys {
        const index = cells.findIndex((cell) => cell.id === id);
        return {
            run: () => runCell(id, "stay"),
            runNext: () => runCell(id, "next"),
            runInsert: () => runCell(id, "insert"),
            save: onSave,
            leave: () => {
                write(id, false);
                focus(id, "cell");
            },
            up: () => {
                const before = cells[index - 1];
                if (before) {
                    focus(before.id, before.kind === "code" ? "end" : "cell");
                }
            },
            down: () => {
                const after = cells[index + 1];
                if (after) {
                    focus(after.id, after.kind === "code" ? "start" : "cell");
                }
            },
        };
    }

    /** Jupyter's keys, on a cell that has the notebook's attention (not in its editor). */
    function onCellKey(event: KeyboardEvent<HTMLElement>, cell: Cell, index: number) {
        if (event.target !== event.currentTarget) {
            return; // in its editor, or one of its fields: theirs
        }
        const modifier = event.ctrlKey || event.metaKey;
        const key = event.key;
        if (key === "Enter" && event.shiftKey) {
            runCell(cell.id, "next");
        } else if (key === "Enter" && modifier) {
            runCell(cell.id, "stay");
        } else if (key === "Enter") {
            write(cell.id, true);
            focus(cell.id, "end");
        } else if (modifier && key.toLowerCase() === "s") {
            onSave();
        } else if (modifier || event.altKey) {
            return;
        } else if (key === "ArrowUp" || key === "k") {
            const before = cells[index - 1];
            if (before) {
                focus(before.id, "cell");
            }
        } else if (key === "ArrowDown" || key === "j") {
            const after = cells[index + 1];
            if (after) {
                focus(after.id, "cell");
            }
        } else if (key === "a") {
            insert(index);
        } else if (key === "b") {
            insert(index + 1);
        } else if (key === "m") {
            convert(cell.id, "markdown");
        } else if (key === "y") {
            convert(cell.id, "code");
        } else if (key === "d") {
            const last = deleting.current;
            if (last && last.id === cell.id && Date.now() - last.at < 800) {
                deleting.current = null;
                remove(cell.id);
            } else {
                deleting.current = { id: cell.id, at: Date.now() };
            }
        } else {
            return;
        }
        event.preventDefault();
    }

    /** The code cell to put things in: the one last written in, else the first. */
    function target(): string | undefined {
        const last = lastWritten.current;
        return last && cells.some((cell) => cell.id === last && cell.kind === "code")
            ? last
            : cells.find((cell) => cell.kind === "code")?.id;
    }

    useImperativeHandle(ref, () => ({
        insertChannel(channel, test) {
            const id = target();
            if (id) {
                editors.current.get(id)?.insertChannel(channel, test);
            }
        },
        insertLines(code) {
            const editor = editors.current.get(target() ?? "");
            if (editor) {
                editor.insertLines(code);
                return;
            }
            // No code cell to put it in: a new one, at the end.
            const cell = newCell("code", code);
            setCells((now) => [...now, cell]);
            focus(cell.id, "end");
        },
    }));

    const anyGoing = records.some(going);
    const selectedIndex = Math.max(
        0,
        cells.findIndex((cell) => cell.id === selected),
    );
    return (
        <div className="notebook">
            <div className="notebook-bar" role="toolbar" aria-label="Notebook">
                <div className="split-button">
                    <button
                        type="button"
                        className="button-primary"
                        onClick={() => run(codeIds())}
                        title="Run every cell, top to bottom: one that fails stops those after it"
                    >
                        <Icon name="play" />
                        Run all
                    </button>
                    <MenuButton
                        label=""
                        name="More runs"
                        primary
                        align="left"
                        items={[
                            { label: "Run the cells above", onSelect: () => run(codeIds(0, selectedIndex)) },
                            { label: "Run this cell and those below", onSelect: () => run(codeIds(selectedIndex)) },
                            {
                                label: "Restart Python, and run all",
                                onSelect: () => {
                                    python.restart();
                                    run(codeIds());
                                },
                            },
                        ]}
                    />
                </div>
                <span className="bar-gap" aria-hidden="true" />
                <button type="button" onClick={() => insert(selectedIndex + 1)} title="A code cell after this one (B)">
                    + Code
                </button>
                <button
                    type="button"
                    onClick={() => insert(selectedIndex + 1, "markdown")}
                    title="A text cell after this one: Markdown"
                >
                    + Text
                </button>
                <span className="bar-gap" aria-hidden="true" />
                <button type="button" onClick={clearOutputs} disabled={anyGoing} title="Clear every cell's output">
                    Clear outputs
                </button>
                <KeysHelp />
                {status && <PythonStatus python={state} now={now} onRestart={() => python.restart()} />}
            </div>
            {cells.map((cell, index) => {
                const record = records[index] ?? null;
                const number = index + 1;
                const name = `Cell ${number}${cell.title ? `: ${cell.title}` : ""}`;
                const code = cell.kind === "code";
                const editing = code || writing.has(cell.id);
                const stale = record !== null && record.status !== "queued" && record.generation < state.generation;
                return (
                    <section
                        key={cell.id}
                        ref={(element) => {
                            if (element) {
                                sections.current.set(cell.id, element);
                            } else {
                                sections.current.delete(cell.id);
                            }
                        }}
                        className={`cell cell-${cell.kind} ${selected === cell.id ? "cell-selected" : ""} ${going(record) ? "cell-going" : ""}`}
                        aria-label={name}
                        tabIndex={-1}
                        onFocus={() => setSelected(cell.id)}
                        onKeyDown={(event) => onCellKey(event, cell, index)}
                    >
                        <div className="cell-head">
                            {code ? (
                                <span
                                    className="cell-count"
                                    title="The how-manyth run of the notebook's cells this was"
                                >
                                    [{going(record) ? "*" : (record?.count ?? " ")}]
                                </span>
                            ) : (
                                <span className="cell-count cell-kind">Text</span>
                            )}
                            {code &&
                                (going(record) ? (
                                    <button
                                        type="button"
                                        className="cell-run cell-stop"
                                        aria-label={`Stop cell ${number}`}
                                        title={
                                            record?.status === "running"
                                                ? "Stop it: Python starts again, without the notebook's variables"
                                                : "Don't run it after all"
                                        }
                                        onClick={() => stop(cell.id)}
                                    >
                                        ■
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="cell-run"
                                        aria-label={`Run cell ${number}`}
                                        title="Run it (Shift+Enter: and go on)"
                                        onClick={() => runCell(cell.id, "stay")}
                                    >
                                        ▶
                                    </button>
                                ))}
                            {!code && (
                                <button
                                    type="button"
                                    className="button-small"
                                    onClick={() => {
                                        write(cell.id, !editing);
                                        if (!editing) {
                                            focus(cell.id, "end");
                                        }
                                    }}
                                >
                                    {editing ? "Done" : "Edit"}
                                </button>
                            )}
                            <input
                                className="cell-title"
                                value={cell.title}
                                placeholder={code ? "A title for the cell" : "A title"}
                                aria-label={`Cell ${number}'s title`}
                                maxLength={120}
                                onChange={(event) => change(cell.id, { title: event.target.value.replace(/\n/g, " ") })}
                            />
                            {record && (
                                <span className={`cell-status cell-status-${record.status}`}>
                                    {cellStatus(record, now)}
                                    {stale && " · before Python started again"}
                                </span>
                            )}
                            <MenuButton
                                label="⋯"
                                name={`Cell ${number}'s actions`}
                                items={[
                                    { label: "Add a code cell above", onSelect: () => insert(index) },
                                    { label: "Add a code cell below", onSelect: () => insert(index + 1) },
                                    { label: "Add a text cell below", onSelect: () => insert(index + 1, "markdown") },
                                    ...(index > 0 ? [{ label: "Move up", onSelect: () => move(cell.id, -1) }] : []),
                                    ...(index < cells.length - 1
                                        ? [{ label: "Move down", onSelect: () => move(cell.id, 1) }]
                                        : []),
                                    code
                                        ? { label: "Make it text", onSelect: () => convert(cell.id, "markdown") }
                                        : { label: "Make it code", onSelect: () => convert(cell.id, "code") },
                                    ...(record && !going(record)
                                        ? [{ label: "Clear its output", onSelect: () => clearRun(cell.id) }]
                                        : []),
                                    { label: "Delete", onSelect: () => remove(cell.id) },
                                ]}
                            />
                        </div>
                        {editing ? (
                            <CodeEditor
                                ref={(handle) => {
                                    if (handle) {
                                        editors.current.set(cell.id, handle);
                                    } else {
                                        editors.current.delete(cell.id);
                                    }
                                }}
                                value={cell.source}
                                onChange={(source) => change(cell.id, { source })}
                                label={`${name}: ${code ? "code" : "text"}`}
                                kind={cell.kind}
                                attached={attached}
                                namespace={namespace}
                                error={stale ? null : errorOf(record)}
                                keys={keysOf(cell.id)}
                                placeholder={
                                    code
                                        ? "Python. Shift+Enter runs it; a channel's name in quotes loads it."
                                        : "Text, in Markdown: # a heading, **bold**, - a list"
                                }
                                onFocus={() => {
                                    setSelected(cell.id);
                                    if (code) {
                                        lastWritten.current = cell.id;
                                    }
                                }}
                            />
                        ) : (
                            <div
                                className="cell-markdown"
                                onDoubleClick={() => {
                                    write(cell.id, true);
                                    focus(cell.id, "end");
                                }}
                            >
                                {cell.source.trim() ? (
                                    <Markdown source={cell.source} />
                                ) : (
                                    <p className="muted">Empty text: double-click it to write.</p>
                                )}
                            </div>
                        )}
                        {code && record && (
                            <div className={`cell-output ${stale ? "cell-stale" : ""}`}>
                                <RunView
                                    run={record}
                                    python={state}
                                    now={now}
                                    compact
                                    plotsOnPage={view !== undefined}
                                />
                            </div>
                        )}
                    </section>
                );
            })}
            <div className="notebook-end">
                <button type="button" onClick={() => insert(cells.length)}>
                    + Code
                </button>
                <button type="button" onClick={() => insert(cells.length, "markdown")}>
                    + Text
                </button>
            </div>
        </div>
    );
}
