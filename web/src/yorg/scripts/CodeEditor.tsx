import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionStatus,
    type Completion,
    type CompletionContext,
    type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { globalCompletion, localCompletionSource, python as pythonLanguage } from "@codemirror/lang-python";
import {
    bracketMatching,
    foldGutter,
    foldKeymap,
    indentOnInput,
    indentUnit,
    syntaxHighlighting,
} from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { Compartment, EditorState, Prec, StateEffect, type Extension } from "@codemirror/state";
import {
    crosshairCursor,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    hoverTooltip,
    keymap,
    lineNumbers,
    placeholder as placeholderText,
    rectangularSelection,
    type Tooltip,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref, type RefObject } from "react";
import { channelCode, completionAt, inString, type Attached } from "./complete";
import { codeHighlight, editorTheme } from "./editorTheme";
import { python, usePython } from "./python";

// A cell's editor (CodeMirror): Python colored as Yorg colors it (editorTheme.ts), line numbers, folding, brackets
// matched and closed, many cursors, find and replace (Ctrl+F), and comments toggled (Ctrl+/). It suggests as you type:
// channels and tests in quotes (complete.ts), what the code names, Python's own words, and, from the notebook's
// running Python (python.ts, with jedi), what its variables have (pt. → t, values, si...); hovering a name says what
// it is, and Python's own reading of the code underlines a syntax error as it's typed, and the line a run failed on.
// A notebook's keys: Shift+Enter runs the cell and goes on, Ctrl+Enter runs it, Alt+Enter runs it and adds one after,
// Escape leaves the editor (for the notebook's keys), and the arrows go on to the cells around at the ends.

/** What the notebook does on its keys, from a cell's editor. */
export interface EditorKeys {
    run: () => void; // Ctrl/Cmd+Enter
    runNext: () => void; // Shift+Enter
    runInsert: () => void; // Alt+Enter
    save: () => void; // Ctrl/Cmd+S
    leave: () => void; // Escape
    up: () => void; // ↑ on the first line: the cell before
    down: () => void; // ↓ on the last line: the cell after
}

/** Where the cell's last run failed: marked while its code is what ran. */
export interface RunError {
    line: number;
    message: string;
    code: string;
}

/** What the notebook can do to a cell's editor. */
export interface CodeEditorHandle {
    focus: (at?: "start" | "end") => void;
    /** A channel, from the Data panel, at the cursor: its name in a string, else the code that takes it. */
    insertChannel: (channel: string, test: string | number | null) => void;
}

interface Props {
    value: string;
    onChange: (value: string) => void;
    label: string;
    kind: "code" | "markdown";
    attached: Attached[]; // the tests attached to the notebook, for their channels' names
    namespace: string | null; // the notebook's, for what its variables have
    error: RunError | null;
    keys: EditorKeys;
    placeholder?: string;
    onFocus?: () => void;
    ref?: Ref<CodeEditorHandle>;
}

/** Jedi's kinds of names, as the editor's list marks them. */
const KINDS: Record<string, string> = {
    module: "namespace",
    class: "class",
    instance: "variable",
    function: "function",
    param: "variable",
    keyword: "keyword",
    property: "property",
    statement: "variable",
    path: "text",
};

interface Syntax {
    line: number;
    column: number;
    end_line: number;
    end_column: number;
    message: string;
}

/** What goes at the cursor: Yorg's in strings and after yorg., else the code's names, Python's words, and Python's. */
async function suggest(context: CompletionContext, props: Props): Promise<CompletionResult | null> {
    const code = context.state.doc.toString();
    const ours = completionAt(code, context.pos, props.attached, context.explicit);
    if (ours) {
        return {
            from: ours.from,
            to: ours.to,
            filter: false, // in its own order: the best first
            options: ours.items.map((item) => ({ label: item.label, detail: item.detail, apply: item.insert })),
        };
    }
    const word = context.matchBefore(/[A-Za-z_][\w.]*$|\.$/);
    if (!word && !context.explicit) {
        return null;
    }
    const typed = word?.text ?? "";
    const member = typed.includes(".");
    const from = member ? context.pos - (typed.length - typed.lastIndexOf(".") - 1) : (word?.from ?? context.pos);
    const options = new Map<string, Completion>();
    const line = context.state.doc.lineAt(context.pos);
    const found = await python.service("complete", {
        namespace: props.namespace,
        code,
        line: line.number,
        column: context.pos - line.from,
    });
    if (context.aborted) {
        return null;
    }
    for (const item of Array.isArray(found) ? (found as { label: string; type: string }[]) : []) {
        options.set(item.label, { label: item.label, type: KINDS[item.type] ?? "variable" });
    }
    if (!member) {
        for (const source of [localCompletionSource, globalCompletion]) {
            const result = await source(context);
            for (const option of result?.options ?? []) {
                if (!options.has(option.label)) {
                    options.set(option.label, option);
                }
            }
        }
    }
    return options.size ? { from, options: [...options.values()], validFor: /^\w*$/ } : null;
}

/** What the name under the mouse is (its signature and docstring), from the notebook's Python. */
async function describe(view: EditorView, pos: number, props: Props): Promise<Tooltip | null> {
    const word = view.state.wordAt(pos);
    if (!word) {
        return null;
    }
    const line = view.state.doc.lineAt(word.to);
    const text = await python.service("inspect", {
        namespace: props.namespace,
        code: view.state.doc.toString(),
        line: line.number,
        column: word.to - line.from,
    });
    if (typeof text !== "string" || !text) {
        return null;
    }
    return {
        pos: word.from,
        end: word.to,
        above: true,
        create: () => {
            const dom = document.createElement("div");
            dom.className = "code-doc";
            dom.textContent = text;
            return { dom };
        },
    };
}

/** The cell's problems: the line its last run failed on (while that's its code), and a syntax error as Python sees it. */
async function check(view: EditorView, props: Props): Promise<Diagnostic[]> {
    const doc = view.state.doc;
    const code = doc.toString();
    const found: Diagnostic[] = [];
    const error = props.error;
    if (error && error.code === code && error.line >= 1 && error.line <= doc.lines) {
        const line = doc.line(error.line);
        found.push({ from: line.from, to: line.to, severity: "error", message: error.message, source: "Its last run" });
    }
    const syntax = (await python.service("check", { namespace: null, code, line: 1, column: 0 })) as Syntax | null;
    if (syntax && view.state.doc.toString() === code) {
        const at = (line: number, column: number) => {
            const found = doc.line(Math.min(Math.max(line, 1), doc.lines));
            return Math.min(found.from + Math.max(0, column), found.to);
        };
        let from = at(syntax.line, syntax.column);
        let to = Math.max(from, at(syntax.end_line, syntax.end_column));
        if (to === from) {
            // At a line's end (something missing after it): its last character, underlined, rather than a dot.
            const line = doc.lineAt(from);
            if (from < line.to) {
                to = from + 1;
            } else if (from > line.from) {
                from -= 1;
            }
        }
        found.push({ from, to, severity: "error", message: `Syntax error: ${syntax.message}`, source: "Python" });
    }
    return found;
}

/** Check the code again: its last run failed (or didn't), or Python's up to read it. */
const relint = StateEffect.define<null>();

/** A key's command that does something, and so is the key's (no other command gets it). */
const handled = (action: () => void) => () => {
    action();
    return true;
};

function extensions(latest: RefObject<Props>, label: Compartment): Extension[] {
    const code = latest.current.kind === "code";
    const keys = () => latest.current.keys;
    return [
        label.of(EditorView.contentAttributes.of({ "aria-label": latest.current.label })),
        code ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : EditorView.lineWrapping,
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        syntaxHighlighting(codeHighlight),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        code
            ? [
                  pythonLanguage(),
                  autocompletion({ override: [(context) => suggest(context, latest.current)], icons: true }),
                  hoverTooltip((view, pos) => describe(view, pos, latest.current), { hoverTime: 450 }),
                  linter((view) => check(view, latest.current), {
                      delay: 700,
                      needsRefresh: (update) =>
                          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(relint))),
                  }),
              ]
            : [],
        latest.current.placeholder ? placeholderText(latest.current.placeholder) : [],
        Prec.high(
            keymap.of([
                { key: "Shift-Enter", run: handled(() => keys().runNext()) },
                { key: "Mod-Enter", run: handled(() => keys().run()) },
                { key: "Alt-Enter", run: handled(() => keys().runInsert()) },
                { key: "Mod-s", preventDefault: true, run: handled(() => keys().save()) },
                {
                    key: "Escape",
                    run: (view) => {
                        if (completionStatus(view.state) !== null || searchPanelOpen(view.state)) {
                            return false; // Escape closes those first
                        }
                        keys().leave();
                        return true;
                    },
                },
                {
                    key: "ArrowUp",
                    run: (view) => {
                        const { main } = view.state.selection;
                        if (!main.empty || view.state.doc.lineAt(main.head).number !== 1) {
                            return false;
                        }
                        keys().up();
                        return true;
                    },
                },
                {
                    key: "ArrowDown",
                    run: (view) => {
                        const { main } = view.state.selection;
                        if (!main.empty || view.state.doc.lineAt(main.head).number !== view.state.doc.lines) {
                            return false;
                        }
                        keys().down();
                        return true;
                    },
                },
                { key: "Mod-/", run: toggleComment },
            ]),
        ),
        keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
        ]),
        editorTheme,
        EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                latest.current.onChange(update.state.doc.toString());
            }
        }),
        EditorView.domEventHandlers({
            focus: () => {
                latest.current.onFocus?.();
            },
        }),
    ];
}

export function CodeEditor(props: Props) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const label = useRef(new Compartment());
    const latest = useRef(props);
    latest.current = props;

    // Made once for each kind (a cell turned from code to text gets an editor for text).
    useLayoutEffect(() => {
        const made = new EditorView({
            state: EditorState.create({ doc: latest.current.value, extensions: extensions(latest, label.current) }),
            parent: host.current!,
        });
        view.current = made;
        return () => {
            made.destroy();
            view.current = null;
        };
    }, [props.kind]);

    // What the code is, from outside (a script opened again, a cell cleared): in the editor, unless it's there already.
    useEffect(() => {
        const current = view.current;
        if (current && current.state.doc.toString() !== props.value) {
            current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: props.value } });
        }
    }, [props.value]);

    useEffect(() => {
        view.current?.dispatch({
            effects: label.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": props.label })),
        });
    }, [props.label]);

    // A run that failed (or a new one), or Python up to read the code: the cell checked again.
    const failed = props.error ? `${props.error.line}\n${props.error.message}\n${props.error.code}` : "";
    const ready = usePython().status === "ready";
    useEffect(() => {
        if (props.kind === "code") {
            view.current?.dispatch({ effects: relint.of(null) });
        }
    }, [failed, ready, props.kind]);

    useImperativeHandle(props.ref, () => ({
        focus(at) {
            const current = view.current;
            if (!current) {
                return;
            }
            current.focus();
            if (at) {
                current.dispatch({ selection: { anchor: at === "start" ? 0 : current.state.doc.length } });
            }
        },
        insertChannel(channel, test) {
            const current = view.current;
            if (!current) {
                return;
            }
            const head = current.state.selection.main.head;
            const text = inString(current.state.doc.toString(), head) ? channel : channelCode(channel, test);
            current.dispatch({ ...current.state.replaceSelection(text), userEvent: "input" });
            current.focus();
        },
    }));

    return <div className="code-editor" ref={host} />;
}
